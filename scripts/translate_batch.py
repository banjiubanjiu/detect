#!/usr/bin/env python3
"""
批量翻译未翻译的源文件（.md → .zh.md）
使用 DeepSeek via OpenRouter API

用法:
  python3 scripts/translate_batch.py          # 翻译所有未翻译的
  python3 scripts/translate_batch.py --dry     # 只列出未翻译的文件
  python3 scripts/translate_batch.py --limit 5 # 最多翻译5篇
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent
DATA = ROOT / "data" / "sources"
ENV_FILE = Path.home() / ".config" / "last30days" / ".env"
TRANS = Path.home() / "bin" / "trans"

MODEL = "deepseek/deepseek-chat-v3-0324"
PROMPT = """翻译以下 Markdown 文章为中文。严格遵守规则：

1. 保留所有 Markdown 格式（#标题、>引用、**加粗**、链接、图片标记）
2. 保留所有 `**u/用户名**` 和 `(数字 pts)` 原样不动 — 这些是 Reddit 用户名和分数，绝对不要翻译
3. 保留 `**r/子版块名**` 原样不动
4. 保留所有 URL 链接原样不动
5. 保留 `---` 分隔线
6. 保留 `> ` 引用前缀
7. 只翻译正文内容和评论正文
8. 翻译要自然流畅，使用标准中文军事/政治术语

直接输出翻译后的完整 Markdown，不要加任何解释。"""


def get_api_key():
    key = os.environ.get('OPENROUTER_API_KEY')
    if key:
        return key
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith('OPENROUTER_API_KEY='):
                return line.split('=', 1)[1].strip()
    return None


def is_already_chinese(text):
    cn = len(re.findall(r'[\u4e00-\u9fff]', text))
    return cn > len(text) * 0.3


def find_untranslated():
    """Find .md files without a corresponding .zh.md."""
    untranslated = []
    for md in sorted(DATA.rglob("*.md")):
        if md.name.endswith('.zh.md'):
            continue
        zh = md.with_suffix('.zh.md')
        if zh.exists() and zh.stat().st_size > 100:
            continue
        # Skip if content is already mostly Chinese
        content = md.read_text(encoding='utf-8', errors='ignore')
        if is_already_chinese(content):
            continue
        # Skip very short files
        if len(content) < 50:
            continue
        untranslated.append(md)
    return untranslated


def translate_file(path, api_key):
    """Translate a single .md file using AI."""
    content = path.read_text(encoding='utf-8', errors='ignore')

    try:
        payload = json.dumps({
            "model": MODEL,
            "messages": [
                {"role": "system", "content": PROMPT},
                {"role": "user", "content": content}
            ],
            "max_tokens": 8000,
            "temperature": 0.1
        }).encode('utf-8')

        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "ConflictTracker/1.0"
            }
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode())

        translated = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        if translated and len(translated) > 20:
            zh_path = path.with_suffix('.zh.md')
            zh_path.write_text(translated.strip(), encoding='utf-8')
            return True, zh_path
        else:
            return _fallback_translate(path, content)
    except Exception as e:
        ok, result = _fallback_translate(path, content)
        if ok:
            return ok, f"{result} (fallback)"
        return False, str(e)


def _fallback_translate(path, content):
    """Fallback to translate-shell."""
    if not TRANS.exists():
        return False, "No fallback available"
    try:
        result = subprocess.run(
            [str(TRANS), '-brief', '-no-ansi', ':zh'],
            input=content[:15000], capture_output=True, text=True, timeout=60
        )
        if result.returncode == 0 and result.stdout.strip() and len(result.stdout.strip()) > 100:
            zh_path = path.with_suffix('.zh.md')
            zh_path.write_text(result.stdout.strip(), encoding='utf-8')
            return True, zh_path
    except Exception:
        pass
    return False, "Fallback failed"


def main():
    dry_run = '--dry' in sys.argv
    limit = 999
    if '--limit' in sys.argv:
        idx = sys.argv.index('--limit')
        limit = int(sys.argv[idx + 1])

    api_key = get_api_key()
    if not api_key and not dry_run:
        print("ERROR: No OPENROUTER_API_KEY found")
        sys.exit(1)

    files = find_untranslated()
    print(f"Found {len(files)} untranslated files")

    if dry_run:
        for f in files:
            size = len(f.read_text(encoding='utf-8', errors='ignore'))
            print(f"  {f.relative_to(ROOT)}  ({size} chars)")
        return

    translated = 0
    failed = 0
    for f in files[:limit]:
        rel = f.relative_to(ROOT)
        print(f"  [{translated+failed+1}/{min(len(files),limit)}] {rel} ... ", end='', flush=True)
        ok, result = translate_file(f, api_key)
        if ok:
            print(f"OK → {result.name}")
            translated += 1
        else:
            print(f"FAIL: {result}")
            failed += 1
        time.sleep(1)  # rate limit

    print(f"\nDone: {translated} translated, {failed} failed, {len(files)-translated-failed} remaining")


if __name__ == '__main__':
    main()
