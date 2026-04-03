#!/usr/bin/env python3
"""
本地开发服务器 — 静态文件 + 翻译 API
替代 python3 -m http.server，增加 /api/translate 端点
"""

import json
import os
import re
import subprocess
import urllib.request
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PORT = 8080
ROOT = Path(__file__).parent.parent
ENV_FILE = Path.home() / ".config" / "last30days" / ".env"
TRANS = Path.home() / "bin" / "trans"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == '/api/translate':
            self.handle_translate(parsed)
            return

        super().do_GET()

    def handle_translate(self, parsed):
        """Translate a source file to Chinese, cache result."""
        params = parse_qs(parsed.query)
        file_path = params.get('file', [None])[0]

        if not file_path:
            self.send_json(400, {"error": "Missing ?file= parameter"})
            return

        src = ROOT / "data" / file_path
        if not src.exists():
            self.send_json(404, {"error": "Source file not found"})
            return

        # Check cache
        zh_path = src.with_suffix('.zh.md')
        if zh_path.exists() and zh_path.stat().st_size > 100:
            with open(zh_path, 'r', encoding='utf-8') as f:
                self.send_json(200, {"translated": f.read(), "cached": True})
            return

        # Read source
        with open(src, 'r', encoding='utf-8') as f:
            content = f.read()

        # Check if already mostly Chinese
        cn_chars = len(re.findall(r'[\u4e00-\u9fff]', content))
        if cn_chars > len(content) * 0.3:
            self.send_json(200, {"translated": content, "cached": False, "note": "already_chinese"})
            return

        # Translate using translate-shell in chunks
        translated = translate_markdown(content)

        if translated:
            # Cache
            with open(zh_path, 'w', encoding='utf-8') as f:
                f.write(translated)
            self.send_json(200, {"translated": translated, "cached": False})
        else:
            self.send_json(500, {"error": "Translation failed"})

    def send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        if '/api/' in str(args[0]):
            super().log_message(format, *args)


def _get_api_key():
    """Load OpenRouter API key from env or config file."""
    key = os.environ.get('OPENROUTER_API_KEY')
    if key:
        return key
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith('OPENROUTER_API_KEY='):
                return line.split('=', 1)[1].strip()
    return None


def translate_markdown(text):
    """Translate markdown to Chinese using AI, preserving structure."""
    api_key = _get_api_key()
    if not api_key:
        return None

    prompt = """翻译以下 Markdown 文章为中文。严格遵守规则：

1. 保留所有 Markdown 格式（#标题、>引用、**加粗**、链接、图片标记）
2. 保留所有 `**u/用户名**` 和 `(数字 pts)` 原样不动 — 这些是 Reddit 用户名和分数，绝对不要翻译
3. 保留 `**r/子版块名**` 原样不动
4. 保留所有 URL 链接原样不动
5. 保留 `---` 分隔线
6. 保留 `> ` 引用前缀
7. 只翻译正文内容和评论正文
8. 翻译要自然流畅，使用标准中文军事/政治术语

直接输出翻译后的完整 Markdown，不要加任何解释。"""

    try:
        payload = json.dumps({
            "model": "deepseek/deepseek-chat-v3-0324",
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": text}
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
            return translated.strip()
    except Exception as e:
        print(f"[translate] AI error: {e}, falling back to translate-shell")

    # Fallback: translate-shell
    if TRANS.exists():
        try:
            result = subprocess.run(
                [str(TRANS), '-brief', '-no-ansi', ':zh'],
                input=text, capture_output=True, text=True, timeout=60
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except Exception as e2:
            print(f"[translate] translate-shell also failed: {e2}")

    return None


if __name__ == '__main__':
    api_ok = bool(_get_api_key())
    print(f"Server starting on http://localhost:{PORT}")
    print(f"  Static files: {ROOT}")
    print(f"  Translate API: http://localhost:{PORT}/api/translate?file=sources/...")
    print(f"  AI translate (DeepSeek via OpenRouter): {'OK' if api_ok else 'NO KEY'}")
    server = HTTPServer(('', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutdown.")
