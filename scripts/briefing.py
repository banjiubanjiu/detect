#!/usr/bin/env python3
"""
AI 每日简报生成器
读取 latest.json，用 LLM 为每个冲突 + 全局态势生成简报，写回 latest.json

用法:
  python3 scripts/briefing.py
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
LATEST_JSON = PROJECT_ROOT / "data" / "latest.json"


def get_api_key():
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        env_file = Path.home() / ".config" / "last30days" / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("OPENROUTER_API_KEY="):
                    key = line.split("=", 1)[1].strip()
                    break
    return key


def llm_call(system_prompt, user_prompt, max_tokens=1500):
    api_key = get_api_key()
    if not api_key:
        print("  [错误] 无 OPENROUTER_API_KEY")
        return None

    payload = json.dumps({
        "model": "google/gemini-2.0-flash-001",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.3,
    }).encode("utf-8")

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
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode())
        return result["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"  [LLM错误] {e}")
        return None


SYSTEM_PROMPT = """你是一位资深军事与国际关系分析师，为"战况追踪"情报平台撰写每日简报。

要求：
- 用中文撰写，语言简洁专业，类似ISW或Crisis Group的风格
- 基于提供的最新报道数据进行分析，不要编造信息
- 每个冲突简报 3-5 句话，突出：最新重大进展、态势变化趋势、需要关注的信号
- 全局简报 4-6 句话，从宏观角度分析多个冲突之间的联动和整体趋势
- 不要使用 emoji，不要用 markdown 标记"""


def build_conflict_prompt(name, name_en, items):
    """Build prompt for a single conflict briefing."""
    headlines = []
    for it in items[:15]:  # Latest 15 items
        date = it.get("date", "")
        title = it.get("title", "")
        src = it.get("source_label", it.get("rss_source", ""))
        headlines.append(f"[{date}] {title} ({src})")

    return f"""以下是"{name}"（{name_en}）最近的报道标题，请生成一段态势简报（3-5句）：

{chr(10).join(headlines)}"""


def build_global_prompt(conflicts_data):
    """Build prompt for global briefing."""
    summaries = []
    for cid, c in conflicts_data.items():
        all_items = []
        for cat in c.get("categories", {}).values():
            all_items.extend(cat.get("items", []))
        all_items.sort(key=lambda x: x.get("date", ""), reverse=True)
        count = len(all_items)
        latest_title = all_items[0]["title"] if all_items else "无数据"
        summaries.append(f"- {c['name']}（{c.get('intensity','?')}）：{count}条报道，最新：{latest_title}")

    return f"""以下是当前追踪的所有冲突概况，请生成一段全局态势简报（4-6句），分析各冲突之间的联动关系和整体趋势：

{chr(10).join(summaries)}"""


def generate_briefings():
    print(f"═══ AI 每日简报生成 {datetime.now().strftime('%Y-%m-%d %H:%M')} ═══\n")

    with open(LATEST_JSON) as f:
        data = json.load(f)

    conflicts = data.get("conflicts", {})

    # Per-conflict briefings
    for cid, c in conflicts.items():
        print(f"  [{c['name']}]...", end=" ", flush=True)
        all_items = []
        for cat in c.get("categories", {}).values():
            all_items.extend(cat.get("items", []))
        all_items.sort(key=lambda x: x.get("date", ""), reverse=True)

        if not all_items:
            print("无数据，跳过")
            continue

        prompt = build_conflict_prompt(c["name"], c.get("name_en", ""), all_items)
        result = llm_call(SYSTEM_PROMPT, prompt, max_tokens=500)

        if result:
            c["briefing"] = result
            c["briefing_date"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            print(f"OK ({len(result)}字)")
        else:
            print("失败")

    # Global briefing
    print(f"\n  [全局态势]...", end=" ", flush=True)
    prompt = build_global_prompt(conflicts)
    result = llm_call(SYSTEM_PROMPT, prompt, max_tokens=800)

    if result:
        data["briefing"] = result
        data["briefing_date"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        print(f"OK ({len(result)}字)")
    else:
        print("失败")

    # Save
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    with open(LATEST_JSON, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n═══ 简报生成完成 ═══")


if __name__ == "__main__":
    generate_briefings()
