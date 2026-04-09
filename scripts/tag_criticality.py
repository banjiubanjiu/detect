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

CRITICAL_LIMIT = 3         # 每冲突最多 critical 条数
NOTABLE_LIMIT = 10         # 每冲突最多 notable 条数
TOP_N_PER_CONFLICT = 50    # 每批喂给 LLM 最近 N 条 (同时也是单次批次大小)
MAX_BATCHES_PER_CONFLICT = 6  # 每个冲突最多循环 N 批, 避免爆炸 (6*50=300 条/天/冲突, 够用)
MIN_BATCH_TO_TAG = 5       # 未标条目少于此数则跳过整个冲突
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


def collect_untagged_items(conflict_data):
    """Get ALL untagged items for a conflict, deduplicated by id, sorted by date desc.

    Changed from "top 50 all items" to "all untagged items" to fix coverage bug where
    burst days (>50 new items in one conflict) left the tail un-tagged forever.
    """
    seen_ids = set()
    items = []
    for catk, cat in conflict_data.get("categories", {}).items():
        for it in cat.get("items", []):
            iid = it.get("id")
            if not iid or iid in seen_ids:
                continue
            seen_ids.add(iid)
            if "criticality" in it:
                continue  # only untagged
            items.append({**it, "_category": catk})
    items.sort(key=lambda x: x.get("date") or "", reverse=True)
    return items


def apply_tags(latest, id_to_label):
    """Write criticality back to all item copies sharing the same ID.

    Only writes items that are explicitly in id_to_label. Items NOT in
    id_to_label are left untagged so the next run can retry them — this is
    important for LLM-failure recovery: when a batch fails mid-conflict we
    must NOT silently demote the tail to background, otherwise the filter in
    collect_untagged_items will skip them forever.

    The "default to background" policy is implemented upstream in tag_conflict
    itself (skip path + in-batch background assignment), which is the correct
    place to distinguish "intentionally skipped" from "LLM failed".
    """
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
    return updated


def tag_conflict(cid, conflict_data):
    """Tag one conflict using batched LLM calls. Returns (id_to_label dict, stats tuple).

    Batching rationale: a single conflict may have 100+ new items on a burst day
    (us-iran 160 seen on 2026-04-08). Splitting into batches of TOP_N_PER_CONFLICT
    avoids both truncation and over-long prompts. Per-conflict critical/notable
    budgets are GLOBAL across batches — we don't want 3 batches × 3 criticals each.
    """
    untagged = collect_untagged_items(conflict_data)
    if len(untagged) < MIN_BATCH_TO_TAG:
        # Too few new items to send to LLM — tag them all as background.
        # This is a deliberate skip (not a failure), so we DO set the label
        # so they don't accumulate forever waiting to cross the threshold.
        id_to_label = {it["id"]: "background" for it in untagged}
        return id_to_label, (0, 0, len(untagged), f"only {len(untagged)} untagged, tagged bg")

    name = conflict_data.get("name", cid)
    id_to_label = {}
    crit_budget = CRITICAL_LIMIT
    note_budget = NOTABLE_LIMIT
    batch_count = 0
    err_msg = None

    for batch_i in range(MAX_BATCHES_PER_CONFLICT):
        start = batch_i * TOP_N_PER_CONFLICT
        end = start + TOP_N_PER_CONFLICT
        batch = untagged[start:end]
        if not batch:
            break
        if len(batch) < MIN_BATCH_TO_TAG and batch_i > 0:
            # Tail too small to send — mark remainder as background and stop
            for it in batch:
                id_to_label[it["id"]] = "background"
            break

        batch_count += 1
        prompt = build_prompt(name, batch)
        response = llm_call(SYSTEM_PROMPT, prompt)
        if not response:
            err_msg = f"LLM failed on batch {batch_i + 1}"
            break

        critical, notable = parse_llm_response(response)
        batch_ids = {it["id"] for it in batch}

        # Spend budget in batch priority order (crit first)
        for iid in critical:
            if iid in batch_ids and crit_budget > 0 and iid not in id_to_label:
                id_to_label[iid] = "critical"
                crit_budget -= 1
        for iid in notable:
            if iid in batch_ids and note_budget > 0 and iid not in id_to_label:
                id_to_label[iid] = "notable"
                note_budget -= 1
        # Everything else in this batch → background
        for iid in batch_ids:
            if iid not in id_to_label:
                id_to_label[iid] = "background"

        if batch_i + 1 < MAX_BATCHES_PER_CONFLICT and end < len(untagged):
            time.sleep(0.3)  # gentle between batches

    if not id_to_label and err_msg:
        return {}, (0, 0, 0, err_msg)

    total_crit = sum(1 for v in id_to_label.values() if v == "critical")
    total_note = sum(1 for v in id_to_label.values() if v == "notable")
    total_bg = sum(1 for v in id_to_label.values() if v == "background")
    status = f"ok ({batch_count} batch{'es' if batch_count != 1 else ''})"
    return id_to_label, (total_crit, total_note, total_bg, status)


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
