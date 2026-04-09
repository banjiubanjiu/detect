#!/usr/bin/env python3
"""
条目老化 (T5) — 清理 latest.json 中超过 RETENTION_DAYS 的 item

为什么需要:
  latest.json 只增不删, 当前 1430 items / 1.6MB, 日增 ~100-200 条.
  不做老化 → 半年后 10MB+, 前端 fetch 变慢, CI 脚本全量扫描变慢,
  tag_criticality LLM 成本线性增长.

策略:
  - cutoff = today(UTC) - RETENTION_DAYS
  - 删掉每个 conflict/category/items[] 里 date < cutoff 的 item
  - 没有 date 的 item 不删 (保守)
  - 清理后重算 stats (total_items / sources / date_range)
  - 打印清理报告

CI 位置: health_report → prune → snapshot → notify → validate → commit
  prune 在 snapshot 之前, 让归档也反映清理后的干净状态.
"""

import json
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
LATEST_JSON = PROJECT_ROOT / "data" / "latest.json"

RETENTION_DAYS = 30


def recount_stats(data):
    """Rebuild stats.total_items / stats.sources / stats.date_range from items."""
    total = 0
    sources = Counter()
    min_date = "9999"
    max_date = ""
    for c in data.get("conflicts", {}).values():
        for cat in c.get("categories", {}).values():
            for it in cat.get("items", []):
                total += 1
                sources[it.get("source", "unknown")] += 1
                d = (it.get("date") or "")[:10]
                if d:
                    if d < min_date:
                        min_date = d
                    if d > max_date:
                        max_date = d
    data["stats"] = {
        "total_items": total,
        "sources": dict(sources),
        "date_range": {
            "from": min_date if min_date != "9999" else "",
            "to": max_date,
        },
    }


def main():
    dry_run = "--dry-run" in sys.argv

    if not LATEST_JSON.exists():
        print(f"ERROR: {LATEST_JSON} not found", file=sys.stderr)
        return 1

    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=RETENTION_DAYS)).isoformat()
    print(f"═══ 条目老化  cutoff={cutoff} (>{RETENTION_DAYS}d) ═══\n")

    with open(LATEST_JSON, encoding="utf-8") as f:
        data = json.load(f)

    total_removed = 0
    removed_ids = []
    for cid, c in data.get("conflicts", {}).items():
        for catk, cat in c.get("categories", {}).items():
            items = cat.get("items", [])
            before = len(items)
            kept = []
            for it in items:
                d = (it.get("date") or "")[:10]
                if d and d < cutoff:
                    removed_ids.append(it.get("id", "?"))
                else:
                    kept.append(it)
            cat["items"] = kept
            removed = before - len(kept)
            if removed:
                total_removed += removed
                print(f"  {cid}/{catk}: -{removed} ({before} → {len(kept)})")

    if total_removed == 0:
        print("无过期条目 ✓")
        return 0

    print(f"\n共清理 {total_removed} 条 item 副本 (unique ids: {len(set(removed_ids))})")

    if dry_run:
        print("[dry-run] 不写回")
        return 0

    recount_stats(data)
    data["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds") + "Z"

    with open(LATEST_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    s = data["stats"]
    print(f"✓ 写回 {LATEST_JSON.relative_to(PROJECT_ROOT)}")
    print(f"  stats: {s['total_items']} items, range {s['date_range']['from']} → {s['date_range']['to']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
