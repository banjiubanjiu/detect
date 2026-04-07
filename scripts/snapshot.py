#!/usr/bin/env python3
"""
事件时序存档：每天将 latest.json 摘要级快照存到 data/archive/YYYY-MM-DD.json

为什么需要：
  latest.json 只是"当下快照"，每天被覆盖。没有时序数据 → 趋势分析、升级
  评分历史曲线、周报自动生成、AI 简报兑现率、研究引用价值都做不出来。
  这个脚本是所有"时序"功能的前置依赖项。

存档内容（摘要级，~15KB/天）：
  - 全局 stats（条目数、来源分布、日期范围）
  - 全局简报 + 简报日期
  - 每个 conflict：基本信息、类别条目计数、升级评分（含中间值）、当日简报

升级评分算法严格复现 web/app.js:84-110 escalation()：
  - frequency score (50%): 近 7 天 vs 7-14 天的事件数对比
  - goldstein score (30%): 近 7 天 GDELT 事件的 Goldstein Scale 均值（仅 GDELT）
  - mention score  (20%): 近 7 天 vs 7-14 天的 GDELT 提及量对比
  - 加权和归一到 0-100

与前端的设计差异（已知，不是 bug）：
  - 参考时刻：Python 用 latest.updated_at（确定性）；JS 用 new Date()（浏览器实时）
  - 日期解析：Python 把 item.date "YYYY-MM-DD" 解析为 UTC 0:00；JS new Date() 用浏览器本地时区
  → 边界日期的条目（恰好 7 天前的）可能落入不同 bin，导致指数差 ±1-3 分。
    Python 版本可重现，JS 版本依赖用户浏览器时区/时刻。

幂等：同一天重跑会覆盖。
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
LATEST = DATA_DIR / "latest.json"
ARCHIVE_DIR = DATA_DIR / "archive"

WEEK_SECONDS = 7 * 86400


def parse_item_date(s):
    """Parse item.date (YYYY-MM-DD) → UTC midnight datetime. Returns None on failure."""
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def parse_iso(s):
    """Parse ISO 8601 → datetime. Returns None on failure."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError, AttributeError):
        return None


def compute_escalation(items, now):
    """
    Replicate web/app.js:escalation() in Python.

    Args:
        items: list of item dicts with 'date' and optional 'metrics.goldstein/mentions'
        now:   reference datetime (UTC)

    Returns:
        dict with index (0-100), label, and all intermediate components for transparency
    """
    recent, prior = [], []
    for it in items:
        d = parse_item_date(it.get("date"))
        if not d:
            continue
        delta = (now - d).total_seconds()
        if delta < WEEK_SECONDS:
            recent.append(it)
        elif delta < 2 * WEEK_SECONDS:
            prior.append(it)

    rc, pc = len(recent), len(prior)

    # Frequency score: -1 to +1
    if pc > 0:
        freq_score = (rc - pc) / max(rc, pc)
    else:
        freq_score = 0.5 if rc > 0 else 0.0

    # Goldstein severity (lower = worse, scale -10 to +10)
    # Note: matches JS truthy filter — goldstein=0 is excluded (rare, neutral events)
    recent_gs = [
        it["metrics"]["goldstein"]
        for it in recent
        if it.get("metrics", {}).get("goldstein")
    ]
    if recent_gs:
        gs_avg = sum(recent_gs) / len(recent_gs)
        gs_score = max(-1.0, min(1.0, -gs_avg / 10.0))
    else:
        gs_avg = None
        gs_score = 0.0

    # Mention volume comparison (GDELT only)
    recent_mentions = sum(
        it["metrics"]["mentions"]
        for it in recent
        if it.get("metrics", {}).get("mentions")
    )
    prior_mentions = sum(
        it["metrics"]["mentions"]
        for it in prior
        if it.get("metrics", {}).get("mentions")
    )
    if prior_mentions > 0:
        denom = max(recent_mentions, prior_mentions)
        mention_score = max(-1.0, min(1.0, (recent_mentions - prior_mentions) / denom))
    else:
        mention_score = 0.0

    # Composite: weighted sum → 0-100 index
    # Note: int(x + 0.5) matches JS Math.round() (half-away-from-zero for positives)
    # rather than Python's round() (banker's rounding). (raw+1)*50 is always >= 0.
    raw = freq_score * 0.5 + gs_score * 0.3 + mention_score * 0.2
    index = int(max(0.0, min(100.0, (raw + 1.0) * 50.0)) + 0.5)

    if index >= 62:
        label = "升级"
    elif index <= 38:
        label = "缓和"
    else:
        label = "稳定"

    return {
        "index": index,
        "label": label,
        "recent_count": rc,
        "prior_count": pc,
        "freq_score": round(freq_score, 4),
        "gs_score": round(gs_score, 4),
        "mention_score": round(mention_score, 4),
        "recent_gs_avg": round(gs_avg, 2) if gs_avg is not None else None,
        "recent_mentions": recent_mentions,
        "prior_mentions": prior_mentions,
    }


def build_snapshot(latest):
    """Build snapshot dict from latest.json content."""
    # Use latest.json's updated_at as the reference clock — keeps escalation
    # results stable even if snapshot.py runs hours after data was collected.
    now = parse_iso(latest.get("updated_at")) or datetime.now(timezone.utc)
    snapshot_date = now.date().isoformat()

    snapshot = {
        "date": snapshot_date,
        "snapshot_at": now.isoformat(),
        "stats": latest.get("stats", {}),
        "global_briefing": latest.get("briefing"),
        "briefing_date": latest.get("briefing_date"),
        "conflicts": {},
    }

    for cid, c in latest.get("conflicts", {}).items():
        all_items = []
        cat_counts = {}
        for catk, cat in c.get("categories", {}).items():
            items = cat.get("items", [])
            cat_counts[catk] = len(items)
            all_items.extend(items)

        snapshot["conflicts"][cid] = {
            "name": c.get("name"),
            "name_en": c.get("name_en"),
            "intensity": c.get("intensity"),
            "status": c.get("status"),
            "region": c.get("region"),
            "since": c.get("since"),
            "total_items": len(all_items),
            "categories": cat_counts,
            "escalation": compute_escalation(all_items, now),
            "briefing": c.get("briefing"),
            "briefing_date": c.get("briefing_date"),
        }

    return snapshot, snapshot_date


def main():
    if not LATEST.exists():
        print(f"ERROR: {LATEST} not found", file=sys.stderr)
        sys.exit(1)

    with open(LATEST, encoding="utf-8") as f:
        latest = json.load(f)

    snapshot, snapshot_date = build_snapshot(latest)

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    out_path = ARCHIVE_DIR / f"{snapshot_date}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)

    size_kb = out_path.stat().st_size / 1024
    n_conflicts = len(snapshot["conflicts"])
    print(f"[snapshot] saved {out_path.relative_to(PROJECT_ROOT)} "
          f"({size_kb:.1f} KB, {n_conflicts} conflicts)")

    # Escalation overview for human review
    print()
    print(f"{'冲突':24s} {'状态':6s} {'指数':>5s}  {'近7d':>5s} {'前7d':>5s}  GS均/提及")
    print("-" * 72)
    for cid, c in snapshot["conflicts"].items():
        esc = c["escalation"]
        gs = f"{esc['recent_gs_avg']:+.1f}" if esc["recent_gs_avg"] is not None else "  - "
        mentions = f"{esc['recent_mentions']}/{esc['prior_mentions']}" if esc["recent_mentions"] or esc["prior_mentions"] else "  -"
        print(f"  {cid:22s} {esc['label']:4s} {esc['index']:>5d}  "
              f"{esc['recent_count']:>5d} {esc['prior_count']:>5d}  {gs}  {mentions}")


if __name__ == "__main__":
    main()
