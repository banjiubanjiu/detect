#!/usr/bin/env python3
"""
Telegram 冲突情报日报推送 (#10 订阅与推送)

每日 CI 跑完 indicators.py + health_report.py 后调用本脚本.
读 data/indicators.json + data/latest.json, 拼一条 Markdown 消息,
通过 Telegram Bot API 推送到用户订阅的 chat_id.

触发/抑制逻辑:
  - 用 reference_date (= yesterday) 做 dedup, 每天只推一次
  - Quiet day (无 I&W 预警 + 无当日 critical BLUF) 直接 skip, 不骚扰
  - state 存 data/notify_state.json, 靠 CI 的 git add -A 持久化

环境变量:
  TELEGRAM_BOT_TOKEN  — BotFather 生成
  TELEGRAM_CHAT_ID    — 通过 getUpdates 查到的个人/群组/频道 id
  SITE_URL            — 可选, 默认 https://banjiubanjiu.github.io/detect/

用法:
  python scripts/notify.py            # 正常发送 (需两个 env var)
  python scripts/notify.py --dry-run  # 只打印消息, 不发
  python scripts/notify.py --force    # 忽略 dedup 强制发送
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
INDICATORS_JSON = DATA_DIR / "indicators.json"
LATEST_JSON = DATA_DIR / "latest.json"
STATE_FILE = DATA_DIR / "notify_state.json"

DEFAULT_SITE_URL = "https://banjiubanjiu.github.io/detect/"
CRITICAL_PREVIEW_LIMIT = 5
TITLE_MAX_CHARS = 60
WARNING_LINE_MAX = 9  # cap I&W section so 9+ warned conflicts don't spam


# ───────────────── state ─────────────────

def load_state():
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ───────────────── message build ─────────────────

def escape_md(s):
    """Escape chars that break legacy Markdown parse_mode.

    We use classic Markdown (not V2) because the escape rules are simpler —
    only * _ ` [ need protection, and only inside text we want rendered as
    plain. We wrap variable text in this so titles with markdown punctuation
    don't accidentally become bold/italic.
    """
    if not s:
        return ""
    return (
        str(s)
        .replace("\\", "")
        .replace("*", "·")
        .replace("_", " ")
        .replace("`", "'")
        .replace("[", "(")
        .replace("]", ")")
    )


def collect_critical_events(latest, ref_date, limit=CRITICAL_PREVIEW_LIMIT):
    """Pull up to `limit` items with criticality=critical dated on ref_date.

    Dedupe by id (same story can live under multiple conflicts) and attach
    the FIRST conflict we see it in as display name — same trade-off as
    renderHotReports (see review #11 / T11).
    """
    seen = set()
    crits = []
    for cid, c in latest.get("conflicts", {}).items():
        cname = c.get("name", cid)
        for cat in c.get("categories", {}).values():
            for it in cat.get("items", []):
                iid = it.get("id")
                if not iid or iid in seen:
                    continue
                if it.get("criticality") != "critical":
                    continue
                if (it.get("date") or "")[:10] != ref_date:
                    continue
                seen.add(iid)
                crits.append({"_cname": cname, "title": it.get("title", ""), "date": it.get("date", "")})
    crits.sort(key=lambda x: x["date"], reverse=True)
    return crits[:limit]


def format_warning_details(cid, c):
    """Build "cname · 指标X ↑N% / 指标Y ↑M" line for a single flagged conflict."""
    cname = c.get("name", cid)
    parts = []
    for key in c.get("warnings", []):
        m = c.get("metrics", {}).get(key, {})
        label = m.get("label", key)
        flag = m.get("flag")
        if key == "escalation_trend":
            delta = m.get("delta")
            if delta is not None:
                arrow = "↑" if delta > 0 else "↓"
                parts.append(f"{label} {arrow}{abs(delta)}")
        else:
            delta_pct = m.get("delta_pct")
            today = m.get("today")
            if delta_pct is not None and m.get("baseline", 0) > 0:
                arrow = "↑" if delta_pct > 0 else "↓"
                parts.append(f"{label} {arrow}{abs(delta_pct)}%")
            elif today is not None:
                # rare-event path (baseline too small for ratio) — show
                # absolute count with "今" prefix so readers don't mistake
                # "关键事件 5" for "score=5".
                parts.append(f"{label} 今{today}")
    return f"• {escape_md(cname)} · {' / '.join(parts)}" if parts else None


def build_message(indicators, latest, site_url):
    ref_date = indicators.get("reference_date", "?")
    total_w = indicators.get("total_warnings", 0)
    flagged = indicators.get("flagged_conflicts", 0)
    total_c = len(indicators.get("conflicts", {}))

    lines = [
        f"🛰️ *冲突情报日报* · {ref_date}",
        "",
        f"_{total_w} 项预警 · {flagged}/{total_c} 冲突异常_",
    ]

    # Critical BLUF events
    crits = collect_critical_events(latest, ref_date)
    if crits:
        lines.append("")
        lines.append(f"🔴 *关键事件 (今日 {len(crits)})*")
        for c in crits:
            title = escape_md(c["title"])[:TITLE_MAX_CHARS]
            lines.append(f"• [{escape_md(c['_cname'])}] {title}")

    # I&W anomalies
    warned = [(cid, c) for cid, c in indicators.get("conflicts", {}).items() if c.get("warnings")]
    warned.sort(key=lambda x: -len(x[1].get("warnings", [])))
    if warned:
        lines.append("")
        lines.append("⚠️ *I&W 异常*")
        shown = 0
        for cid, c in warned:
            if shown >= WARNING_LINE_MAX:
                break
            line = format_warning_details(cid, c)
            if line:
                lines.append(line)
                shown += 1
        if len(warned) > shown:
            lines.append(f"_(+{len(warned) - shown} 其他冲突异常)_")

    lines.append("")
    lines.append(f"🔗 {site_url}")
    return "\n".join(lines)


def has_content(indicators, crits):
    """Decide whether today is worth a notification at all."""
    return (indicators.get("total_warnings", 0) > 0) or bool(crits)


# ───────────────── telegram ─────────────────

def send_telegram(token, chat_id, text):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
        "disable_web_page_preview": True,
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"[telegram] HTTP {e.code}: {body}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[telegram] send failed: {e}", file=sys.stderr)
        return None


# ───────────────── main ─────────────────

def main():
    dry_run = "--dry-run" in sys.argv
    force = "--force" in sys.argv

    if not INDICATORS_JSON.exists():
        print("indicators.json missing, skip")
        return 0
    if not LATEST_JSON.exists():
        print("latest.json missing, skip")
        return 0

    with open(INDICATORS_JSON, encoding="utf-8") as f:
        indicators = json.load(f)
    with open(LATEST_JSON, encoding="utf-8") as f:
        latest = json.load(f)

    ref_date = indicators.get("reference_date", "")
    if not ref_date:
        print("indicators.json has no reference_date, skip")
        return 0

    # Dedup: one push per reference_date unless --force
    state = load_state()
    if not force and state.get("last_ref_date") == ref_date:
        print(f"Already notified for ref_date={ref_date}, skip (use --force to override)")
        return 0

    # Quiet day gate
    crits = collect_critical_events(latest, ref_date)
    if not has_content(indicators, crits):
        print(f"Quiet day (0 warnings, 0 critical for {ref_date}), skip")
        # Still record state so tomorrow's quiet check doesn't re-evaluate
        state["last_ref_date"] = ref_date
        state["last_result"] = "quiet_skipped"
        state["last_checked_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if not dry_run:
            save_state(state)
        return 0

    site_url = os.environ.get("SITE_URL", DEFAULT_SITE_URL)
    msg = build_message(indicators, latest, site_url)
    print("═══ message preview ═══")
    print(msg)
    print("═══ end ═══")
    print(f"length: {len(msg)} chars")

    if dry_run:
        print("[dry-run] not sending, not writing state")
        return 0

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing, skip (not an error)")
        return 0

    result = send_telegram(token, chat_id, msg)
    if not result or not result.get("ok"):
        print(f"[telegram] send failed, state NOT updated: {result}", file=sys.stderr)
        return 1

    state["last_ref_date"] = ref_date
    state["last_result"] = "sent"
    state["last_sent_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    state["last_message_id"] = result.get("result", {}).get("message_id")
    save_state(state)
    print(f"✓ sent to chat_id={chat_id}, message_id={state['last_message_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
