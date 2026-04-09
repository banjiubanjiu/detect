#!/usr/bin/env python3
"""
Indicators & Warnings (I&W) - 量化异常预警 (#3 专业化路线图)

为什么需要：
  AI 简报是叙事文字，没有量化预警信号。情报产品的核心是"今天哪些冲突
  出现了异常"—— 事件频率突增、critical 事件爆发、升级指数拐点。
  这是 VIEWS / ACLED CAST 的核心方法论。

本 v1 设计哲学 —— "能跑起来的最小有用版本"：
  - 不依赖 archive 时序（目前只有 3 天，信号太弱）
  - 直接从 latest.json 的 item.date 字段算日分布（立刻得到 14+ 天历史）
  - 仅 3 个自动化通用指标 —— 不需要人工定义每冲突 3-5 个指标
  - 零 LLM 调用，纯 Python，< 1 秒

三个指标：
  1. event_frequency — 今日事件数 vs 7 日均值（+100% 以上 → elevated）
  2. critical_count  — 今日 criticality=critical 数量 vs 7 日均值
  3. escalation_trend — 今日升级指数 vs 昨日（从 data/archive/ 读，若有）

异常分级：
  - elevated    : 当前值 >= 2× 基线（高于正常 100%+）
  - depressed   : 当前值 <= 0.5× 基线（低于正常 50%+）
  - normal      : 在正常波动范围内
  - insufficient: 样本少于 3 天，无法判断

输出：
  data/indicators.json  — 前端加载

未来扩展（需要先积累数据）：
  - archive 够 14+ 天后加 7 日对比 + 拐点检测
  - 自定义每冲突指标（俄军日均推进公里、乌无人机日均打击）
  - Goldstein Scale 恶化趋势（GDELT 独有）
"""

import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
LATEST_JSON = DATA_DIR / "latest.json"
ARCHIVE_DIR = DATA_DIR / "archive"
INDICATORS_JSON = DATA_DIR / "indicators.json"

HISTO_DAYS = 14              # 回看多少天历史算基线
BASELINE_DAYS = 7            # 基线用最近几天均值（排除今日）
MIN_BASELINE_SAMPLES = 3     # 少于此数就不算异常（用 insufficient）
ELEVATED_RATIO = 2.0         # 今日 >= 基线 × 此值 → elevated
DEPRESSED_RATIO = 0.5        # 今日 <= 基线 × 此值 → depressed
MIN_BASELINE_FOR_FLAG = 1.0  # 基线太小（<1 条/天）不报 flag，避免 0→1 这种噪音


def parse_date(s):
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def dedupe_items(conflict_data):
    """Dedupe items by id across categories (cross-category items count once)."""
    seen = set()
    out = []
    for cat in conflict_data.get("categories", {}).values():
        for it in cat.get("items", []):
            iid = it.get("id")
            if iid and iid in seen:
                continue
            if iid:
                seen.add(iid)
            out.append(it)
    return out


def compute_daily_histogram(items, today, days=HISTO_DAYS):
    """Build {date: count} for the last N days (including today)."""
    counts = defaultdict(int)
    for it in items:
        d = parse_date(it.get("date"))
        if d is None:
            continue
        if (today - d).days < days and (today - d).days >= 0:
            counts[d] += 1
    # Normalize to ordered list
    result = []
    for i in range(days - 1, -1, -1):
        day = today - timedelta(days=i)
        result.append({"date": day.isoformat(), "count": counts.get(day, 0)})
    return result


def compute_daily_critical(items, today, days=HISTO_DAYS):
    """Build {date: critical_count} using criticality=='critical' filter."""
    counts = defaultdict(int)
    for it in items:
        if it.get("criticality") != "critical":
            continue
        d = parse_date(it.get("date"))
        if d is None:
            continue
        if (today - d).days < days and (today - d).days >= 0:
            counts[d] += 1
    result = []
    for i in range(days - 1, -1, -1):
        day = today - timedelta(days=i)
        result.append({"date": day.isoformat(), "count": counts.get(day, 0)})
    return result


def classify(today_value, baseline, min_baseline=MIN_BASELINE_FOR_FLAG):
    """Return flag string based on today vs baseline ratio."""
    if baseline < min_baseline:
        return "normal"  # baseline too small to make noise meaningful
    if baseline == 0:
        return "normal"
    ratio = today_value / baseline
    if ratio >= ELEVATED_RATIO:
        return "elevated"
    if ratio <= DEPRESSED_RATIO:
        return "depressed"
    return "normal"


def build_metric(histo, label):
    """Given a daily histogram list, extract today + 7-day baseline + flag.

    Keep zeros in the baseline — for rare events (critical_count may be 0 on
    most days) a legit quiet day IS a valid sample. Insufficiency is judged
    solely on histogram length, not on non-zero count.
    """
    if len(histo) < 2:
        return {"today": 0, "baseline": 0, "baseline_days": 0, "flag": "insufficient", "label": label}
    today = histo[-1]["count"]
    # baseline = 7 days prior (exclude today)
    prior = [h["count"] for h in histo[-(BASELINE_DAYS + 1):-1]]
    if len(prior) < MIN_BASELINE_SAMPLES:
        return {
            "today": today,
            "baseline": 0,
            "baseline_days": len(prior),
            "flag": "insufficient",
            "label": label,
            "histogram": histo,
        }
    baseline = sum(prior) / len(prior)
    flag = classify(today, baseline)
    delta_pct = round((today - baseline) / baseline * 100) if baseline > 0 else 0
    return {
        "today": today,
        "baseline": round(baseline, 1),
        "baseline_days": len(prior),
        "delta_pct": delta_pct,
        "flag": flag,
        "label": label,
        "histogram": histo,
    }


def load_archive_by_date(d):
    """Load archive file matching the given date (YYYY-MM-DD.json).

    Returns parsed dict or None if missing/corrupt. We look up by exact date
    rather than "the most recent 2 files" because escalation_trend must
    align with reference_date: if event_frequency's "today" means yesterday
    (to avoid partial-day artifact), escalation's "today" must also mean
    yesterday — otherwise the metrics modal mixes two different days.
    """
    if not ARCHIVE_DIR.exists():
        return None
    f = ARCHIVE_DIR / f"{d.isoformat()}.json"
    if not f.exists():
        return None
    try:
        with open(f, encoding="utf-8") as fp:
            return json.load(fp)
    except (json.JSONDecodeError, OSError):
        return None


def build_escalation_metric(cid, today_snap, yday_snap):
    """Compare reference-date escalation index to the day before.

    Both snapshots should be date-aligned with the rest of the report
    (today_snap = reference_date, yday_snap = reference_date - 1 day).
    Missing or invalid snapshot → insufficient.
    """
    if today_snap is None or yday_snap is None:
        return {"today": None, "yesterday": None, "delta": None, "flag": "insufficient", "label": "升级指数"}
    today_esc = today_snap.get("conflicts", {}).get(cid, {}).get("escalation", {}).get("index")
    yday_esc = yday_snap.get("conflicts", {}).get(cid, {}).get("escalation", {}).get("index")
    if today_esc is None or yday_esc is None:
        return {"today": today_esc, "yesterday": yday_esc, "delta": None, "flag": "insufficient", "label": "升级指数"}
    delta = today_esc - yday_esc
    # Flag on >= 10 point swing
    if delta >= 10:
        flag = "rising"
    elif delta <= -10:
        flag = "falling"
    else:
        flag = "normal"
    return {
        "today": today_esc,
        "yesterday": yday_esc,
        "delta": delta,
        "flag": flag,
        "label": "升级指数",
    }


def build_conflict_indicators(cid, conflict, today, today_snap, yday_snap):
    items = dedupe_items(conflict)
    event_histo = compute_daily_histogram(items, today)
    crit_histo = compute_daily_critical(items, today)

    metrics = {
        "event_frequency": build_metric(event_histo, "事件频率"),
        "critical_count": build_metric(crit_histo, "关键事件"),
        "escalation_trend": build_escalation_metric(cid, today_snap, yday_snap),
    }

    # Collect warning labels (anything not normal/insufficient)
    warnings = []
    for key, m in metrics.items():
        flag = m.get("flag")
        if flag in ("elevated", "depressed", "rising", "falling"):
            warnings.append(key)

    return {
        "name": conflict.get("name", cid),
        "name_en": conflict.get("name_en"),
        "metrics": metrics,
        "warnings": warnings,
    }


def build_report(latest):
    """Reference day = yesterday (UTC).

    Why not today: today is always partial at the time indicators.py runs —
    GitHub Actions cron runs at 06:00 UTC = 6 hours of "today" elapsed,
    local manual runs could be anywhere in the day. Using yesterday as the
    reference guarantees a complete day vs a complete 7-day baseline, so
    "event_frequency elevated" is never a partial-day artifact.

    Trade-off: all indicators lag real-world events by 24h. Acceptable for
    a daily I&W snapshot (not a real-time alert system).
    """
    updated_at = latest.get("updated_at", "")
    try:
        ref_dt = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        ref_dt = datetime.now(timezone.utc)
    today = ref_dt.date() - timedelta(days=1)  # always yesterday

    # Load archive snapshots aligned to reference date — NOT "most recent 2
    # files on disk", which would be [real_today, real_yesterday] and break
    # alignment with event_frequency/critical_count (both keyed on `today`).
    today_snap = load_archive_by_date(today)
    yday_snap = load_archive_by_date(today - timedelta(days=1))

    conflicts = {}
    for cid, c in latest.get("conflicts", {}).items():
        conflicts[cid] = build_conflict_indicators(cid, c, today, today_snap, yday_snap)

    total_warnings = sum(len(c["warnings"]) for c in conflicts.values())
    flagged_conflicts = sum(1 for c in conflicts.values() if c["warnings"])

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reference_date": today.isoformat(),
        "conflicts": conflicts,
        "total_warnings": total_warnings,
        "flagged_conflicts": flagged_conflicts,
        "thresholds": {
            "elevated_ratio": ELEVATED_RATIO,
            "depressed_ratio": DEPRESSED_RATIO,
            "escalation_delta": 10,
            "baseline_days": BASELINE_DAYS,
            "min_baseline_samples": MIN_BASELINE_SAMPLES,
        },
    }


def print_summary(report):
    print(f"\n═══ I&W 预警指标  {report['generated_at']} ═══")
    print(f"基准日期: {report['reference_date']}")
    print(f"总预警: {report['total_warnings']}  ·  异常冲突: {report['flagged_conflicts']}/{len(report['conflicts'])}")
    print()
    print(f"{'冲突':24s} {'事件频率':>28s}  {'关键事件':>28s}  {'升级指数':>22s}")
    print("-" * 110)
    for cid, c in report["conflicts"].items():
        m = c["metrics"]
        ef = m["event_frequency"]
        cc = m["critical_count"]
        esc = m["escalation_trend"]

        def fmt(flag_metric):
            flag = flag_metric.get("flag", "normal")
            mark = {
                "elevated": "↑",
                "depressed": "↓",
                "rising": "↑",
                "falling": "↓",
                "normal": "·",
                "insufficient": "?",
            }.get(flag, "·")
            today = flag_metric.get("today")
            base = flag_metric.get("baseline") if "baseline" in flag_metric else flag_metric.get("yesterday")
            pct = flag_metric.get("delta_pct")
            if flag == "insufficient" or base is None:
                return f"{mark} {today} (basel?)"
            if pct is not None:
                return f"{mark} {today} vs {base} ({pct:+d}%)"
            return f"{mark} {today} vs {base}"

        print(f"  {cid:22s}  {fmt(ef):>28s}  {fmt(cc):>28s}  {fmt(esc):>22s}")

    print()
    if report["total_warnings"] == 0:
        print("无预警 ✓")
    else:
        print(f"⚠ 预警明细:")
        for cid, c in report["conflicts"].items():
            if not c["warnings"]:
                continue
            print(f"  [{c['name']}]")
            for key in c["warnings"]:
                m = c["metrics"][key]
                print(f"    ⚠ {m['label']}: flag={m['flag']}")


def main():
    if not LATEST_JSON.exists():
        print(f"ERROR: {LATEST_JSON} not found", file=sys.stderr)
        sys.exit(1)

    with open(LATEST_JSON, encoding="utf-8") as f:
        latest = json.load(f)

    report = build_report(latest)
    print_summary(report)

    with open(INDICATORS_JSON, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n✓ 写 {INDICATORS_JSON.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
