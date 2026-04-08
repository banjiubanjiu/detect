#!/usr/bin/env python3
"""
本地开发服务器 — 静态文件 + 翻译 API + Agentic Ask API
替代 python3 -m http.server，增加:
  GET  /api/translate?file=...  按需翻译某 source
  POST /api/ask                  智能问答 (Agentic Retrieval, SSE 流式)
"""

import json
import os
import re
import subprocess
import urllib.request
import urllib.error
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PORT = 8080
ROOT = Path(__file__).parent.parent
DATA = ROOT / "data"
ENV_FILE = Path.home() / ".config" / "last30days" / ".env"
TRANS = Path.home() / "bin" / "trans"

# Agentic Ask 配置
ASK_MODEL = "google/gemini-2.5-flash"   # OpenRouter 模型,1M 上下文 + tool calling
ASK_MAX_STEPS = 10                       # 工具调用循环上限,防失控
ASK_READ_MAX_CHARS = 8000                # read_source 单次返回字符上限


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == '/api/translate':
            self.handle_translate(parsed)
            return

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/ask':
            self.handle_ask()
            return
        self.send_json(404, {"error": "Not Found"})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    # ---------- /api/ask: Agentic Retrieval (SSE 流式) ----------
    def handle_ask(self):
        # 1. 解析请求体
        try:
            length = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(length).decode('utf-8') if length else '{}'
            req = json.loads(raw)
        except Exception as e:
            self.send_json(400, {"error": f"无效 JSON: {e}"})
            return

        question = (req.get("question") or "").strip()
        history = req.get("history") or []  # [{role, content}, ...]
        if not question:
            self.send_json(400, {"error": "缺少 question 字段"})
            return

        if not _get_env_var('OPENROUTER_API_KEY'):
            self.send_json(503, {"error": "OPENROUTER_API_KEY 未配置"})
            return

        # 2. 开 SSE 响应头(单问单答,close 收尾让客户端立即结束)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache, no-transform')
        self.send_header('Connection', 'close')
        self.send_header('X-Accel-Buffering', 'no')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        # 关闭 keep-alive 让浏览器/curl 在响应结束后立即断开
        self.close_connection = True

        def emit(event, data):
            try:
                payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
                self.wfile.write(payload.encode('utf-8'))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                raise

        # 3. 构造消息历史
        messages = [{"role": "system", "content": ASK_SYSTEM_PROMPT}]
        for h in history[-10:]:
            r = h.get("role")
            c = h.get("content")
            if r in ("user", "assistant") and c:
                messages.append({"role": r, "content": str(c)})
        messages.append({"role": "user", "content": question})

        emit("start", {"model": ASK_MODEL})

        # 4. Tool calling 循环
        try:
            for step in range(ASK_MAX_STEPS):
                t0 = time.time()
                resp = call_openrouter_chat(messages, tools=ASK_TOOLS)
                elapsed = round(time.time() - t0, 2)

                choice = (resp.get("choices") or [{}])[0]
                msg = choice.get("message") or {}
                tool_calls = msg.get("tool_calls") or []
                content = msg.get("content") or ""

                # 4a. 模型决定调工具
                if tool_calls:
                    # 把 assistant 的工具调用消息原样加入历史
                    messages.append({
                        "role": "assistant",
                        "content": content,
                        "tool_calls": tool_calls,
                    })
                    for tc in tool_calls:
                        fn = (tc.get("function") or {}).get("name")
                        raw_args = (tc.get("function") or {}).get("arguments") or "{}"
                        try:
                            args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                        except Exception:
                            args = {}
                        emit("tool_call", {
                            "step": step + 1,
                            "name": fn,
                            "args": args,
                            "model_ms": int(elapsed * 1000),
                        })

                        # 派发工具
                        impl = ASK_TOOL_DISPATCH.get(fn)
                        if not impl:
                            result = {"error": f"未知工具: {fn}"}
                        else:
                            try:
                                result = impl(args)
                            except Exception as e:
                                result = {"error": f"工具异常: {e}"}

                        # 把结果加入历史 + 推送到前端(精简版)
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.get("id"),
                            "name": fn,
                            "content": json.dumps(result, ensure_ascii=False),
                        })
                        emit("tool_result", {
                            "step": step + 1,
                            "name": fn,
                            "summary": _summarize_tool_result(fn, result),
                        })
                    continue  # 进入下一轮

                # 4b. 模型给出最终答案
                emit("answer", {"text": content, "model_ms": int(elapsed * 1000)})
                emit("done", {"steps": step + 1})
                return

            # 超过 MAX_STEPS
            emit("error", {"message": f"工具调用超过 {ASK_MAX_STEPS} 轮上限,可能陷入循环"})
            emit("done", {"steps": ASK_MAX_STEPS})
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode('utf-8', errors='replace')
            except Exception:
                body = ''
            emit("error", {"message": f"OpenRouter HTTP {e.code}: {body[:500]}"})
            emit("done", {"steps": -1})
        except (BrokenPipeError, ConnectionResetError):
            print("[ask] 客户端断开")
        except Exception as e:
            try:
                emit("error", {"message": f"{type(e).__name__}: {e}"})
                emit("done", {"steps": -1})
            except Exception:
                pass

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


def _summarize_tool_result(name, result):
    """把工具返回的大对象压成前端展示用的一行/几行。"""
    if not isinstance(result, dict):
        return {"text": str(result)[:200]}
    if "error" in result:
        return {"error": result["error"]}
    if name == "list_conflicts":
        cs = result.get("conflicts", [])
        return {"text": f"{len(cs)} 个冲突: " + ", ".join(c.get("name", "?") for c in cs[:10])}
    if name == "get_category":
        return {
            "text": f"{result.get('label')} · 共 {result.get('total')} 条 · 返回 {result.get('returned')} 条",
            "preview": [i.get("title") for i in (result.get("items") or [])[:3]],
        }
    if name == "search_keyword":
        rs = result.get("results", [])
        return {
            "text": f"匹配 {len(rs)} 条" + (" (截断)" if result.get("truncated") else ""),
            "preview": [r.get("title") for r in rs[:3]],
        }
    if name == "read_source":
        return {
            "text": f"读取 {result.get('file')} ({result.get('total_chars')} 字符" + (", 翻译版" if result.get("is_translated") else "") + ")",
        }
    return {"text": json.dumps(result, ensure_ascii=False)[:200]}


def _get_env_var(name):
    """Load env var from process env or ENV_FILE."""
    val = os.environ.get(name)
    if val:
        return val
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith(f'{name}='):
                return line.split('=', 1)[1].strip()
    return None


def _get_api_key():
    """Backwards compat: returns OpenRouter key."""
    return _get_env_var('OPENROUTER_API_KEY')


# 翻译 prompt（统一）
TRANSLATE_PROMPT = """翻译以下 Markdown 文章为中文。严格遵守规则：

1. 保留所有 Markdown 格式（#标题、>引用、**加粗**、链接、图片标记）
2. 保留所有 `**u/用户名**` 和 `(数字 pts)` 原样不动 — 这些是 Reddit 用户名和分数，绝对不要翻译
3. 保留 `**r/子版块名**` 原样不动
4. 保留所有 URL 链接原样不动
5. 保留 `---` 分隔线
6. 保留 `> ` 引用前缀
7. 只翻译正文内容和评论正文
8. 翻译要自然流畅，使用标准中文军事/政治术语

直接输出翻译后的完整 Markdown，不要加任何解释。"""


def _call_groq(text):
    """通过 Groq 翻译，速度优先（实测 1.6 秒/篇）。"""
    api_key = _get_env_var('GROQ_API_KEY')
    if not api_key:
        return None
    try:
        payload = json.dumps({
            "model": "llama-3.3-70b-versatile",
            "messages": [
                {"role": "system", "content": TRANSLATE_PROMPT},
                {"role": "user", "content": text}
            ],
            "max_tokens": 8000,
            "temperature": 0.1
        }).encode('utf-8')
        req = urllib.request.Request(
            "https://api.groq.com/openai/v1/chat/completions",
            data=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "ConflictTracker/1.0"
            }
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode())
        translated = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        if translated and len(translated) > 20:
            return translated.strip()
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print(f"[translate] Groq rate limited, falling back to OpenRouter")
        else:
            print(f"[translate] Groq error: {e}, falling back to OpenRouter")
    except Exception as e:
        print(f"[translate] Groq error: {e}, falling back to OpenRouter")
    return None


def _call_openrouter(text):
    """通过 OpenRouter / deepseek-v3 翻译，质量更好但慢（~7 秒/篇）。"""
    api_key = _get_env_var('OPENROUTER_API_KEY')
    if not api_key:
        return None
    try:
        payload = json.dumps({
            "model": "deepseek/deepseek-chat-v3-0324",
            "messages": [
                {"role": "system", "content": TRANSLATE_PROMPT},
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
        print(f"[translate] OpenRouter error: {e}")
    return None


# ============================================================
# Agentic Ask — 工具检索 (Agentic Retrieval, no vector DB)
# ============================================================

def _load_latest():
    """加载并返回 latest.json (每次都重读,数据更新立即生效)。"""
    try:
        with open(DATA / "latest.json", 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        return {"error": f"failed to load latest.json: {e}"}


def tool_list_conflicts(_args):
    """工具1: 列出所有监测中的冲突 + 每个分类的事件数量。"""
    data = _load_latest()
    if "error" in data:
        return data
    out = []
    for cid, c in data.get("conflicts", {}).items():
        cats = {}
        for catid, cat in c.get("categories", {}).items():
            cats[catid] = {
                "label": cat.get("label"),
                "count": len(cat.get("items", [])),
            }
        out.append({
            "id": cid,
            "name": c.get("name"),
            "name_en": c.get("name_en"),
            "status": c.get("status"),
            "since": c.get("since"),
            "region": c.get("region"),
            "summary": c.get("summary"),
            "categories": cats,
        })
    return {"updated_at": data.get("updated_at"), "conflicts": out}


def tool_get_category(args):
    """工具2: 取某冲突某分类下的事件列表(精简,不含全文)。"""
    cid = args.get("conflict_id")
    catid = args.get("category")
    limit = int(args.get("limit", 20))
    crit = args.get("criticality")
    if not cid or not catid:
        return {"error": "conflict_id 和 category 必填"}
    data = _load_latest()
    if "error" in data:
        return data
    conflict = data.get("conflicts", {}).get(cid)
    if not conflict:
        return {"error": f"未知 conflict_id: {cid}"}
    cat = conflict.get("categories", {}).get(catid)
    if not cat:
        return {"error": f"未知 category: {catid}"}
    items = cat.get("items", [])
    total = len(items)
    if crit:
        items = [i for i in items if i.get("criticality") == crit]
    items = items[:limit]
    return {
        "conflict_id": cid,
        "category": catid,
        "label": cat.get("label"),
        "total": total,
        "returned": len(items),
        "items": [{
            "id": i.get("id"),
            "title": i.get("title"),
            "title_en": i.get("title_en"),
            "summary": i.get("summary"),
            "source": i.get("source"),
            "source_label": i.get("source_label"),
            "date": i.get("date"),
            "criticality": i.get("criticality"),
            "url": i.get("url"),
            "local_file": i.get("local_file"),
        } for i in items],
    }


def tool_read_source(args):
    """工具3: 读取某 source markdown 原文(优先用 .zh.md 翻译版)。"""
    rel = args.get("local_file", "")
    # 安全:必须以 sources/ 开头,禁止逃逸
    if not rel.startswith("sources/") or ".." in rel:
        return {"error": "local_file 必须以 sources/ 开头且不含 '..'"}
    p = (DATA / rel).resolve()
    if not str(p).startswith(str(DATA.resolve())):
        return {"error": "路径越界"}
    # 优先读 .zh.md 翻译版
    zh = p.with_suffix(".zh.md") if not p.name.endswith(".zh.md") else p
    target = zh if zh.exists() and zh.stat().st_size > 100 else p
    if not target.exists():
        return {"error": f"文件不存在: {rel}"}
    try:
        content = target.read_text(encoding='utf-8')
    except Exception as e:
        return {"error": f"读取失败: {e}"}
    truncated = len(content) > ASK_READ_MAX_CHARS
    return {
        "file": rel,
        "served": target.name,
        "is_translated": target.name.endswith(".zh.md"),
        "total_chars": len(content),
        "truncated": truncated,
        "content": content[:ASK_READ_MAX_CHARS],
    }


def tool_search_keyword(args):
    """工具4: 在 latest.json 索引里按关键词搜 title/summary(中英文)。"""
    kw = (args.get("keyword") or "").strip()
    if not kw:
        return {"error": "keyword 必填"}
    limit = int(args.get("limit", 20))
    data = _load_latest()
    if "error" in data:
        return data
    kw_low = kw.lower()
    results = []
    for cid, c in data.get("conflicts", {}).items():
        for catid, cat in c.get("categories", {}).items():
            for item in cat.get("items", []):
                hay = " ".join([
                    str(item.get("title", "")),
                    str(item.get("title_en", "")),
                    str(item.get("summary", "")),
                    str(item.get("summary_en", "")),
                ]).lower()
                if kw_low in hay:
                    results.append({
                        "conflict_id": cid,
                        "category": catid,
                        "id": item.get("id"),
                        "title": item.get("title"),
                        "summary": item.get("summary"),
                        "date": item.get("date"),
                        "criticality": item.get("criticality"),
                        "local_file": item.get("local_file"),
                    })
                    if len(results) >= limit:
                        return {"keyword": kw, "results": results, "truncated": True}
    return {"keyword": kw, "results": results, "truncated": False}


# OpenAI tool schema (OpenRouter 兼容 OpenAI tools 格式)
ASK_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_conflicts",
            "description": "列出当前所有正在监测的冲突,每条含名称/状态/地区/30天摘要,以及该冲突下有哪些分类(military 军事/diplomacy 外交/opinion 舆论/humanitarian 人道/video 视频)和每个分类的事件数量。这通常是回答任何问题的第一步,用来发现可用的 conflict_id 和 category 名。",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_category",
            "description": "获取某冲突某分类下的事件清单(只返回 title/summary/date/criticality/local_file,不含全文)。从 list_conflicts 拿到 conflict_id 和 category 后调用。可选 criticality 过滤(critical/important/background)。默认返回 20 条,可调大 limit 但建议 ≤50。",
            "parameters": {
                "type": "object",
                "properties": {
                    "conflict_id": {"type": "string", "description": "如 'russia-ukraine','israel-palestine','us-iran'"},
                    "category": {"type": "string", "description": "如 'military','diplomacy','opinion','humanitarian','video'"},
                    "limit": {"type": "integer", "default": 20},
                    "criticality": {"type": "string", "enum": ["critical", "important", "background"]},
                },
                "required": ["conflict_id", "category"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_source",
            "description": "读取某事件的 markdown 原文,从 get_category 或 search_keyword 返回的 local_file 字段获得路径。最多返回 8000 字符,优先返回中文翻译版(若已缓存)。仅在用户需要细节、引用、深度内容时调用,不要对所有结果都调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "local_file": {"type": "string", "description": "形如 'sources/web/xxx.md',来自 get_category/search_keyword 返回值"},
                },
                "required": ["local_file"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_keyword",
            "description": "跨所有冲突按关键词搜 title/summary(中英都支持)。当用户问的话题不知归属于哪个冲突,或跨多冲突时使用。返回最多 20 条匹配。",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string"},
                    "limit": {"type": "integer", "default": 20},
                },
                "required": ["keyword"],
            },
        },
    },
]

ASK_TOOL_DISPATCH = {
    "list_conflicts": tool_list_conflicts,
    "get_category": tool_get_category,
    "read_source": tool_read_source,
    "search_keyword": tool_search_keyword,
}


ASK_SYSTEM_PROMPT = """你是冲突监测助手。用户的数据库覆盖 9 个全球冲突(俄乌、巴以、美伊、苏丹、缅甸、也门、刚果金、叙利亚、台海)的最近 30 天事件,数据来自 RSS/Reddit/X/YouTube,每条事件有 criticality(critical/important/background)分级。

工作流程:
1. 几乎所有问题都先调 list_conflicts 看清全貌(除非用户已明确指定冲突且你已知 ID)。
2. 用 get_category 拿事件清单(用 criticality 过滤 + 合理 limit)。话题不明时用 search_keyword 跨冲突搜。
3. 仅当用户需要细节/原文/引用时,才用 read_source 读 1-3 篇关键原文。不要批量读全部结果。
4. 综合作答时:
   - 用中文回答
   - 给出关键事件的 **日期**、**来源**(source_label),按时间或重要度排序
   - 若信息有矛盾或不足,明确说明
   - 不要编造数据库里不存在的事件

效率原则:能用索引(get_category/search_keyword)解决的不要 read_source;能 1-2 步解决的不要 5 步。"""


def call_openrouter_chat(messages, tools=None):
    """调用 OpenRouter chat completions(非流式),返回 dict。"""
    api_key = _get_env_var('OPENROUTER_API_KEY')
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY 未配置")
    body = {
        "model": ASK_MODEL,
        "messages": messages,
        "temperature": 0.3,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    payload = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "ConflictTracker-Ask/1.0",
            "HTTP-Referer": "http://localhost:8080",
            "X-Title": "Conflict Tracker Ask",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def translate_markdown(text):
    """优先级: Groq (快, 1.6s) → OpenRouter (慢但稳, 7s) → translate-shell (最终兜底)"""
    # 1. Try Groq first (10x faster latency)
    result = _call_groq(text)
    if result:
        return result

    # 2. Fall back to OpenRouter
    result = _call_openrouter(text)
    if result:
        return result

    # 3. Final fallback: translate-shell
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
    groq_ok = bool(_get_env_var('GROQ_API_KEY'))
    or_ok = bool(_get_env_var('OPENROUTER_API_KEY'))
    print(f"Server starting on http://localhost:{PORT}")
    print(f"  Static files: {ROOT}")
    print(f"  Translate API: http://localhost:{PORT}/api/translate?file=sources/...")
    print(f"  Ask API:       http://localhost:{PORT}/api/ask  (POST, SSE)")
    print(f"  Ask page:      http://localhost:{PORT}/web/ask.html")
    print(f"  Groq (primary, ~1.6s/article):    {'OK' if groq_ok else 'NO KEY'}")
    print(f"  OpenRouter (translate + ask):     {'OK' if or_ok else 'NO KEY (ask 不可用)'}")
    print(f"  Ask model: {ASK_MODEL}")
    server = ThreadingHTTPServer(('', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutdown.")
