#!/usr/bin/env python3
"""
关键事件分级 (BLUF) - 给每条 item 打 criticality 标签

为什么需要：
  当前 latest.json 有 960 条 item 平铺展示，"重大转折"和"长尾分析"视觉权重相同。
  情报产品的核心是 BLUF (Bottom Line Up Front)，访客应该 30 秒内看到当天最关键的事。

打标策略：
  - 每个冲突一次 LLM 调用 (9 次)，让 LLM 在上下文里做相对判断
  - 每次喂最近 50 条 (按 date 倒序)，按 unique ID 去重
  - LLM 返回 critical (1-3 条) + notable (5-10 条) 的 ID 列表
  - 其余默认 background
  - 写回时所有同 ID 副本一起更新 (一篇文章的 criticality 不依赖归类)

幂等：
  - 已标 criticality 的 item 不重复花钱
  - 仅当某冲突有 >= 5 条未标条目时才调 LLM (避免小批量浪费)
  - 失败时不污染数据：JSON 解析失败 → 该冲突的所有 item 默认 background

成本估算：
  - 每次调用 ~3.5K token (50 条 × 70 字符标题 + prompt 框架)
  - 9 次/天 × ~3.5K token ≈ 31K token/天
  - Gemini 2.0 Flash $0.10/M input → ~$0.003/天，月 $0.10
"""

import json
import os
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
LATEST_JSON = PROJECT_ROOT / "data" / "latest.json"

CRITICAL_LIMIT = 3      # 每冲突最多 critical 条数
NOTABLE_LIMIT = 10      # 每冲突最多 notable 条数
TOP_N_PER_CONFLICT = 50 # 每冲突喂给 LLM 最近 N 条
MIN_BATCH_TO_TAG = 5    # 未标条目少于此数则跳过整个冲突
VALID_LABELS = {"critical", "notable", "background"}


def get_api_key():
    """Same pattern as briefing.py — env var first, fallback to last30days config."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        env_file = Path.home() / ".config" / "last30days" / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("OPENROUTER_API_KEY="):
                    key = line.split("=", 1)[1].strip()
                    break
    return key


def llm_call(system_prompt, user_prompt, max_tokens=800, timeout=90, retries=2):
    """OpenRouter chat completion. Returns text or None on failure. Retries on timeout/network errors."""
    api_key = get_api_key()
    if not api_key:
        print("  [错误] 无 OPENROUTER_API_KEY", file=sys.stderr)
        return None

    payload = json.dumps({
        "model": "google/gemini-2.0-flash-001",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.2,  # low for consistency
    }).encode("utf-8")

    for attempt in range(retries + 1):
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "ConflictTracker/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                result = json.loads(resp.read().decode())
            return result["choices"][0]["message"]["content"].strip()
        except Exception as e:
            if attempt < retries:
                print(f"  [LLM 重试 {attempt + 1}/{retries}] {e}", file=sys.stderr)
                time.sleep(2 ** attempt)  # exponential backoff
            else:
                print(f"  [LLM 失败] {e}", file=sys.stderr)
    return None


SYSTEM_PROMPT = """你是一位资深军事与国际关系分析师，为"战况追踪"情报平台做关键事件筛选。

你的任务：从一组报道中挑出今日最关键的几条，按 BLUF (Bottom Line Up Front) 原则分级。

分级标准：
- critical (最多3条): 重大转折、伤亡事件、政策决定、军事行动直接结果。读者必须知道。
  例: 大规模空袭、停火协议、领导人决定、战线突破、关键人物死亡
- notable (5-10条): 实质性进展、有信号意义的动态、新出现的趋势。读者应该了解。
  例: 武器援助宣布、外交访问、经济制裁、地区局势变化
- 其余 (默认 background): 背景分析、舆论评论、历史回顾、重复报道、单一来源未验证传闻

输出格式 (严格 JSON, 无任何其他文字):
{"critical": ["id1", "id2"], "notable": ["id3", "id4", "id5"]}

只输出 JSON。ID 必须来自下方列表。critical 不超过 3 条，notable 不超过 10 条。"""


def build_prompt(conflict_name, items):
    """Build user prompt with item list."""
    lines = []
    for it in items:
        iid = it["id"]
        date = it.get("date", "")
        title = it.get("title", "")[:80]
        cat = it.get("_category", "")
        summary = (it.get("summary") or "")[:120]
        lines.append(f"[{iid}] ({date}, {cat}) {title}\n  {summary}")
    return f"""冲突: {conflict_name}

报道列表:
{chr(10).join(lines)}

请按上述标准选出 critical 和 notable，输出 JSON。"""


def parse_llm_response(text):
    """Extract critical/notable ID lists from LLM response. Returns (critical, notable) tuple of sets."""
    if not text:
        return set(), set()
    # Strip markdown code fences if present
    text = text.strip()
    if text.startswith("```"):
        # Remove ```json or ``` line and trailing ```
        lines = text.split("\n")
        if len(lines) >= 3:
            text = "\n".join(lines[1:-1])
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object in text
        import re
        m = re.search(r'\{.*\}', text, re.DOTALL)
        if not m:
            return set(), set()
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return set(), set()

    critical = set(data.get("critical", []) or [])
    notable = set(data.get("notable", []) or [])
    # Enforce limits (LLM may overshoot)
    critical = set(list(critical)[:CRITICAL_LIMIT])
    # notable doesn't include critical
    notable = (notable - critical)
    notable = set(list(notable)[:NOTABLE_LIMIT])
    return critical, notable


def collect_items_for_conflict(conflict_data):
    """Get up to TOP_N items for a conflict, deduplicated by id, sorted by date desc."""
    seen_ids = set()
    items = []
    for catk, cat in conflict_data.get("categories", {}).items():
        for it in cat.get("items", []):
            iid = it.get("id")
            if not iid or iid in seen_ids:
                continue
            seen_ids.add(iid)
            # Stash category for prompt context
            items.append({**it, "_category": catk})
    # Sort by date desc, fallback empty string sorts last
    items.sort(key=lambda x: x.get("date") or "", reverse=True)
    return items[:TOP_N_PER_CONFLICT]


def apply_tags(latest, id_to_label):
    """Write criticality back to all item copies sharing the same ID."""
    updated = 0
    for c in latest.get("conflicts", {}).values():
        for cat in c.get("categories", {}).values():
            for it in cat.get("items", []):
                iid = it.get("id")
                if iid and iid in id_to_label:
                    new_label = id_to_label[iid]
                    if it.get("criticality") != new_label:
                        it["criticality"] = new_label
                        updated += 1
                elif "criticality" not in it:
                    # Default any untagged item to background
                    it["criticality"] = "background"
                    updated += 1
    return updated


def tag_conflict(cid, conflict_data):
    """Tag one conflict. Returns (id_to_label dict, stats tuple)."""
    items = collect_items_for_conflict(conflict_data)
    if not items:
        return {}, (0, 0, 0, "no items")

    # Skip if already mostly tagged
    untagged = [it for it in items if "criticality" not in it]
    if len(untagged) < MIN_BATCH_TO_TAG:
        return {}, (0, 0, 0, f"only {len(untagged)} untagged, skip")

    name = conflict_data.get("name", cid)
    prompt = build_prompt(name, items)

    response = llm_call(SYSTEM_PROMPT, prompt)
    if not response:
        return {}, (0, 0, 0, "LLM failed")

    critical, notable = parse_llm_response(response)
    if not critical and not notable:
        return {}, (0, 0, 0, "parse failed")

    # Build id → label map. critical wins over notable. Others in this batch → background.
    id_to_label = {}
    item_ids_in_batch = {it["id"] for it in items}
    for iid in critical:
        if iid in item_ids_in_batch:
            id_to_label[iid] = "critical"
    for iid in notable:
        if iid in item_ids_in_batch:
            id_to_label[iid] = "notable"
    for iid in item_ids_in_batch:
        if iid not in id_to_label:
            id_to_label[iid] = "background"

    return id_to_label, (
        sum(1 for v in id_to_label.values() if v == "critical"),
        sum(1 for v in id_to_label.values() if v == "notable"),
        sum(1 for v in id_to_label.values() if v == "background"),
        "ok",
    )


def main():
    if not LATEST_JSON.exists():
        print(f"ERROR: {LATEST_JSON} not found", file=sys.stderr)
        sys.exit(1)

    with open(LATEST_JSON, encoding="utf-8") as f:
        latest = json.load(f)

    print(f"═══ 关键事件分级 BLUF {datetime.now().strftime('%Y-%m-%d %H:%M')} ═══\n")
    print(f"{'冲突':24s} {'结果':>20s}")
    print("-" * 60)

    global_id_to_label = {}
    for cid, c in latest.get("conflicts", {}).items():
        labels, (n_crit, n_note, n_bg, status) = tag_conflict(cid, c)
        global_id_to_label.update(labels)
        print(f"  {cid:22s} {status:>20s}  C:{n_crit} N:{n_note} B:{n_bg}")
        time.sleep(0.5)  # gentle rate limit

    if not global_id_to_label:
        print("\n无任何更新，跳过写入")
        return

    updated = apply_tags(latest, global_id_to_label)
    print(f"\n应用 {len(global_id_to_label)} 个标签 → 实际更新 {updated} 个 item 副本")

    # Save
    with open(LATEST_JSON, "w", encoding="utf-8") as f:
        json.dump(latest, f, ensure_ascii=False, indent=2)
    print(f"✓ 写回 {LATEST_JSON.relative_to(PROJECT_ROOT)}")

    # Summary
    print("\n关键事件预览：")
    for cid, c in latest["conflicts"].items():
        crits = []
        for cat in c.get("categories", {}).values():
            for it in cat.get("items", []):
                if it.get("criticality") == "critical":
                    crits.append(it)
                    break  # Only need first per category
        seen_titles = set()
        unique_crits = []
        for it in crits:
            t = it.get("title", "")
            if t not in seen_titles:
                seen_titles.add(t)
                unique_crits.append(it)
        if unique_crits:
            print(f"  [{c.get('name', cid)}]")
            for it in unique_crits[:3]:
                print(f"    • {it.get('title', '')[:70]}")


if __name__ == "__main__":
    main()
