#!/usr/bin/env python3
"""
NATO Admiralty Code (#2) — 双维信息评级

标准:
  来源可靠性 (A-F):
    A = 完全可靠 (权威机构/智库, tier t1)
    B = 通常可靠 (主流媒体/通讯社, tier t2)
    C = 相当可靠 (结构化数据库, GDELT)
    D = 不常可靠 (社交媒体/社区, tier t3)
    F = 无法判断 (未知来源)

  内容准确度 (1-6):
    1 = 由其他来源确认 (cluster_bias_count>=2 或 cluster_size>=3)
    2 = 很可能为真 (cluster_size==2, 或 t1 单源)
    3 = 可能为真 (t2 单源)
    4 = 真伪存疑 (t3 单源)
    5 = 不太可能 (未使用, 保留给 LLM 评估)
    6 = 无法判断 (无法识别来源)

组合: admiralty_code = 来源字母 + 准确度数字, e.g. "A1" / "B3" / "D4"

为什么 heuristic 而不是 LLM:
  零额外成本, 利用已有的 source_credibility.json + cluster_corroboration
  数据. v1 作为自动基线, 后续可用 LLM 精调内容维度 (检测内部矛盾/夸大表述).

CI 位置: cluster_corroboration 之后 (依赖 cluster 数据), tag_criticality 之前.
"""

import json
import re
import sys
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
LATEST_JSON = DATA_DIR / "latest.json"
CRED_JSON = DATA_DIR / "source_credibility.json"

# tier → Admiralty source reliability letter
TIER_TO_SOURCE = {
    "t1": "A",  # 权威机构 / 智库
    "t2": "B",  # 主流媒体 / 通讯社
    "t3": "D",  # 社交媒体 / 社区
}


def get_domain(url):
    if not url:
        return ""
    m = re.match(r"https?://(?:www\.)?([^/]+)", url)
    return m.group(1).lower() if m else ""


def lookup_tier(item, cred_domains):
    """Resolve item to credibility tier using domain lookup + source fallback."""
    d = get_domain(item.get("url", ""))

    # Try exact domain match
    if d in cred_domains:
        return cred_domains[d].get("tier", "t3")
    # Strip subdomain: english.nv.ua → nv.ua
    parts = d.split(".")
    if len(parts) > 2:
        parent = ".".join(parts[-2:])
        if parent in cred_domains:
            return cred_domains[parent].get("tier", "t3")

    # Source-specific fallback
    source = item.get("source", "")
    if source == "gdelt":
        return "gdelt"
    if source in ("x", "youtube", "reddit"):
        return "t3"
    return "unknown"


def compute_source_letter(tier):
    """tier → A/B/C/D/F"""
    if tier == "gdelt":
        return "C"
    return TIER_TO_SOURCE.get(tier, "F")


def compute_info_number(tier, cluster_size, cluster_bias_count):
    """Compute content accuracy rating 1-6."""
    size = cluster_size or 0
    bias = cluster_bias_count or 0

    # Multi-source confirmed
    if bias >= 2 or size >= 3:
        return 1  # confirmed by other sources
    if size == 2:
        return 2  # probably true (2 independent sources)

    # Single source — tier determines baseline confidence
    if tier == "t1":
        return 2  # authority single-source = probably true
    if tier in ("t2", "gdelt"):
        return 3  # mainstream = possibly true
    if tier == "t3":
        return 4  # social media = doubtfully true
    return 6  # unknown = cannot be judged


def main():
    dry_run = "--dry-run" in sys.argv

    if not LATEST_JSON.exists():
        print(f"ERROR: {LATEST_JSON} not found", file=sys.stderr)
        return 1

    with open(LATEST_JSON, encoding="utf-8") as f:
        latest = json.load(f)

    cred_domains = {}
    if CRED_JSON.exists():
        with open(CRED_JSON, encoding="utf-8") as f:
            cred_data = json.load(f)
        cred_domains = cred_data.get("domains", {})
    else:
        print("  [warn] source_credibility.json not found, all sources → F6")

    print(f"═══ Admiralty Code  {datetime.now().strftime('%Y-%m-%d %H:%M')} ═══\n")

    # Collect unique items + compute codes
    seen = set()
    id_to_code = {}
    stats = {"A": 0, "B": 0, "C": 0, "D": 0, "F": 0}
    info_stats = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0}

    for cid, c in latest.get("conflicts", {}).items():
        for cat in c.get("categories", {}).values():
            for it in cat.get("items", []):
                iid = it.get("id")
                if not iid or iid in seen:
                    continue
                seen.add(iid)

                tier = lookup_tier(it, cred_domains)
                source_letter = compute_source_letter(tier)
                info_number = compute_info_number(
                    tier, it.get("cluster_size"), it.get("cluster_bias_count")
                )
                code = f"{source_letter}{info_number}"
                id_to_code[iid] = (source_letter, info_number, code)
                stats[source_letter] = stats.get(source_letter, 0) + 1
                info_stats[info_number] = info_stats.get(info_number, 0) + 1

    print(f"  unique items: {len(id_to_code)}")
    print(f"  source distribution: {' '.join(f'{k}:{v}' for k, v in sorted(stats.items()) if v)}")
    print(f"  info distribution:   {' '.join(f'{k}:{v}' for k, v in sorted(info_stats.items()) if v)}")

    if dry_run:
        # Show some samples
        print("\n  samples:")
        samples = list(id_to_code.items())[:10]
        for iid, (s, i, code) in samples:
            print(f"    {code}  {iid[:25]}")
        print(f"\n[dry-run] not writing")
        return 0

    # Apply codes to all item copies
    updated = 0
    for c in latest.get("conflicts", {}).values():
        for cat in c.get("categories", {}).values():
            for it in cat.get("items", []):
                iid = it.get("id")
                entry = id_to_code.get(iid)
                if not entry:
                    continue
                source_letter, info_number, code = entry
                if it.get("admiralty_code") != code:
                    it["admiralty_source"] = source_letter
                    it["admiralty_info"] = info_number
                    it["admiralty_code"] = code
                    updated += 1

    print(f"\n  updated {updated} item copies")

    with open(LATEST_JSON, "w", encoding="utf-8") as f:
        json.dump(latest, f, ensure_ascii=False, indent=2)
    print(f"✓ 写回 {LATEST_JSON.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
