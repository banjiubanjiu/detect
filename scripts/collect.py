#!/usr/bin/env python3
"""
全球冲突数据采集脚本
从 xcrawl、Jina Reader、fxtwitter API、yt-dlp 采集数据，输出 data/latest.json + data/sources/

抓取策略：
  1. xcrawl scrape（首选）
  2. Jina Reader（xcrawl 失败时后备）
  3. fxtwitter API（X/Twitter 专用）
  4. yt-dlp（YouTube 字幕专用）
域名→方法映射表见 data/scrape_methods.json
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
SOURCES_DIR = DATA_DIR / "sources"
ARCHIVE_DIR = DATA_DIR / "archive"
METHODS_FILE = DATA_DIR / "scrape_methods.json"
YT_DLP = Path.home() / "bin" / "yt-dlp"

# Load domain → method mapping
DOMAIN_METHODS = {}
BLOCKED_DOMAINS = set()
if METHODS_FILE.exists():
    with open(METHODS_FILE) as f:
        methods_data = json.load(f)
    for domain, info in methods_data.get("domains", {}).items():
        m = info.get("method", "xcrawl")
        DOMAIN_METHODS[domain] = m
        if m == "none":
            BLOCKED_DOMAINS.add(domain)

def get_domain(url):
    """Extract domain from URL."""
    return re.sub(r'^(?:https?://)?(?:www\.)?([^/]+).*', r'\1', url)

def get_scrape_method(url):
    """Determine best scrape method for a URL."""
    domain = get_domain(url)
    if domain in BLOCKED_DOMAINS:
        return "none"
    return DOMAIN_METHODS.get(domain, "xcrawl")  # default to xcrawl


# ── Conflict configurations ──
CONFLICTS = {
    "russia-ukraine": {
        "name": "俄乌战争", "name_en": "Russia-Ukraine", "status": "active",
        "since": "2022-02-24", "region": "欧洲", "intensity": "war",
        "parties": ["俄罗斯", "乌克兰"], "related": [],
        "queries": ["Russia Ukraine war latest", "Ukraine frontline update"],
    },
    "israel-palestine": {
        "name": "巴以冲突", "name_en": "Israel-Palestine", "status": "active",
        "since": "2023-10-07", "region": "中东", "intensity": "war",
        "parties": ["以色列", "哈马斯/巴勒斯坦"], "related": ["us-iran"],
        "queries": ["Israel Palestine war Gaza 2026", "Israel Hamas ceasefire 2026"],
    },
    "us-iran": {
        "name": "美伊对峙", "name_en": "US-Iran", "status": "active",
        "since": "2026-03", "region": "中东", "intensity": "war",
        "parties": ["美国", "伊朗"], "related": ["israel-palestine", "yemen-houthi"],
        "queries": ["US Iran war strikes 2026", "US Iran military conflict 2026"],
    },
    "sudan": {
        "name": "苏丹内战", "name_en": "Sudan Civil War", "status": "active",
        "since": "2023-04-15", "region": "非洲", "intensity": "war",
        "parties": ["苏丹武装部队", "快速支援部队(RSF)"], "related": [],
        "queries": ["Sudan civil war RSF 2026", "Sudan conflict humanitarian 2026"],
    },
    "myanmar": {
        "name": "缅甸内战", "name_en": "Myanmar Civil War", "status": "active",
        "since": "2021-02-01", "region": "亚太", "intensity": "war",
        "parties": ["缅甸军政府", "民族团结政府(NUG)", "少数民族武装"], "related": [],
        "queries": ["Myanmar civil war resistance 2026", "Myanmar junta rebel 2026"],
    },
    "yemen-houthi": {
        "name": "也门/胡塞武装", "name_en": "Yemen / Houthi", "status": "active",
        "since": "2014-09", "region": "中东", "intensity": "conflict",
        "parties": ["胡塞武装", "美英联军", "沙特联军"], "related": ["us-iran"],
        "queries": ["Yemen Houthi Red Sea attacks 2026", "Houthi shipping attacks 2026"],
    },
    "congo-drc": {
        "name": "刚果(金)冲突", "name_en": "Congo DRC / M23", "status": "active",
        "since": "2022-03", "region": "非洲", "intensity": "war",
        "parties": ["刚果政府军", "M23叛军", "卢旺达"], "related": [],
        "queries": ["Congo DRC M23 Rwanda conflict 2026", "DRC war 2026"],
    },
    "syria": {
        "name": "叙利亚局势", "name_en": "Syria", "status": "active",
        "since": "2011-03", "region": "中东", "intensity": "conflict",
        "parties": ["叙利亚过渡政府", "库尔德武装", "残余ISIS"], "related": ["us-iran"],
        "queries": ["Syria post-Assad transition 2026", "Syria political situation 2026"],
    },
    "taiwan-strait": {
        "name": "台海局势", "name_en": "Taiwan Strait", "status": "active",
        "since": "2022-08", "region": "亚太", "intensity": "tension",
        "parties": ["中国大陆", "台湾", "美国"], "related": [],
        "queries": ["Taiwan strait China military 2026", "Taiwan China tensions 2026"],
    },
}


def translate_text(text, max_chars=500):
    """Translate English text to Chinese using OpenRouter LLM."""
    if not text or len(text.strip()) < 10:
        return text
    # Skip if already mostly Chinese
    cn_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
    if cn_chars > len(text) * 0.3:
        return text

    text = text[:max_chars]
    api_key = os.environ.get('OPENROUTER_API_KEY')
    if not api_key:
        # Try loading from last30days config
        env_file = Path.home() / ".config" / "last30days" / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith('OPENROUTER_API_KEY='):
                    api_key = line.split('=', 1)[1].strip()
                    break
    if not api_key:
        return text

    try:
        payload = json.dumps({
            "model": "google/gemini-2.0-flash-001",
            "messages": [
                {"role": "system", "content": "You are a professional translator. Translate the following English text to Chinese. Only output the translation, nothing else. Keep proper nouns, organization names, and place names accurate. For military/political terms use standard Chinese translations."},
                {"role": "user", "content": text}
            ],
            "max_tokens": 1000,
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
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
        translated = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        if translated and len(translated) > 5:
            time.sleep(0.3)  # rate limit
            return translated.strip()
    except Exception as e:
        print(f"    [translate] Error: {e}", file=sys.stderr)

    return text


def translate_item(item):
    """Translate title/summary. For tweets and Reddit, generate headline from content."""
    title = item.get("title", "")
    summary = item.get("summary", "")
    source = item.get("source", "web")

    text = summary or title
    if not text or len(text.strip()) < 10:
        return item
    cn_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
    if cn_chars > len(text) * 0.3:
        return item
    if item.get("title_en"):
        return item

    if source == "x":
        # Tweets/Reddit: generate headline + summary from content (1 API call)
        api_key = _get_openrouter_key()
        if not api_key:
            return item
        prompt = """根据以下英文内容，输出两行（仅两行，无其他内容）：
第一行：一句中文新闻标题（20字以内，概括核心事件，新闻标题风格）
第二行：中文摘要（50-100字，翻译并概括主要内容）

内容：
""" + text[:500]
        try:
            payload = json.dumps({
                "model": "google/gemini-2.0-flash-001",
                "messages": [
                    {"role": "system", "content": "你是专业的军事/政治新闻编辑。"},
                    {"role": "user", "content": prompt}
                ],
                "max_tokens": 300,
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
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode())
            output = result.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
            lines = [l.strip() for l in output.split('\n') if l.strip()]
            if len(lines) >= 2:
                item["title_en"] = title
                item["summary_en"] = summary
                item["title"] = lines[0]
                item["summary"] = lines[1]
            elif len(lines) == 1:
                item["title_en"] = title
                item["title"] = lines[0]
            time.sleep(0.3)
        except Exception as e:
            print(f"    [translate_item] Error: {e}", file=sys.stderr)
    else:
        # Web/YouTube: title already exists, just translate
        cn_in_title = len(re.findall(r'[\u4e00-\u9fff]', title))
        if title and cn_in_title < len(title) * 0.2 and len(title) > 3:
            translated_title = translate_text(title, max_chars=200)
            if translated_title != title:
                item["title_en"] = title
                item["title"] = translated_title
        cn_in_summary = len(re.findall(r'[\u4e00-\u9fff]', summary))
        if summary and cn_in_summary < len(summary) * 0.2 and len(summary) > 10:
            translated_summary = translate_text(summary, max_chars=500)
            if translated_summary != summary:
                item["summary_en"] = summary
                item["summary"] = translated_summary

    return item


def fetch_aljazeera(url, out_dir):
    """Fetch Al Jazeera article via direct curl + HTML parsing."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r'[^a-zA-Z0-9._-]', '_', url.split('/')[-1])[:80]
    md_path = out_dir / f"aljazeera_{slug}.md"
    if md_path.exists() and md_path.stat().st_size > 500:
        return str(md_path.relative_to(DATA_DIR))
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "en-US,en;q=0.9"
        })
        with urllib.request.urlopen(req, timeout=20) as resp:
            page = resp.read().decode("utf-8", errors="ignore")
        import html as htmlmod
        # Extract <p> content, filter UI noise
        blocks = re.findall(r'<p[^>]*>(.*?)</p>', page, re.DOTALL)
        skip_kw = ['sign up', 'navigation', 'cookie', 'privacy', 'share', 'listen', 'save',
                    'follow', 'newsletter', 'advertisement', 'subscribe']
        clean = []
        for b in blocks:
            text = htmlmod.unescape(re.sub(r'<[^>]+>', '', b)).strip()
            if len(text) < 40:
                continue
            if any(kw in text.lower() for kw in skip_kw):
                continue
            clean.append(text)
        if not clean:
            return None
        # Extract title from <title> tag
        title_m = re.search(r'<title[^>]*>(.*?)</title>', page)
        title = title_m.group(1).split('|')[0].strip() if title_m else ''
        content = '\n\n'.join(clean)
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(f"# {title}\n\n**原始链接：** {url}\n\n---\n\n{content}")
        return str(md_path.relative_to(DATA_DIR))
    except Exception as e:
        print(f"    [aljazeera] {url[:50]}: {e}", file=sys.stderr)
        return None


def translate_file(src_path):
    """Translate a source markdown file to Chinese using DeepSeek, save as .zh.md."""
    src = Path(src_path)
    zh_path = src.with_suffix('.zh.md')

    if zh_path.exists() and zh_path.stat().st_size > 200:
        return  # already translated

    if not src.exists():
        return

    with open(src, 'r', encoding='utf-8') as f:
        content = f.read()

    # Skip if already mostly Chinese
    cn = len(re.findall(r'[\u4e00-\u9fff]', content))
    if cn > len(content) * 0.3:
        return

    # Skip very short files
    if len(content) < 200:
        return

    api_key = os.environ.get('OPENROUTER_API_KEY')
    if not api_key:
        env_file = Path.home() / ".config" / "last30days" / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith('OPENROUTER_API_KEY='):
                    api_key = line.split('=', 1)[1].strip()
    if not api_key:
        return

    prompt = """翻译以下 Markdown 文章为中文。严格遵守规则：

1. 保留所有 Markdown 格式（#标题、>引用、**加粗**、链接、图片标记）
2. 保留所有 `**u/用户名**` 和 `(数字 pts)` 原样不动 — 这些是 Reddit 用户名和分数，绝对不要翻译
3. 保留 `**r/子版块名**` 原样不动
4. 保留所有 URL 链接原样不动
5. 保留 `---` 分隔线和 `> ` 引用前缀
6. 只翻译正文内容和评论正文
7. 翻译要自然流畅，使用标准中文军事/政治术语

直接输出翻译后的完整 Markdown，不要加任何解释。"""

    try:
        payload = json.dumps({
            "model": "deepseek/deepseek-chat-v3-0324",
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": content[:15000]}
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

        if translated and len(translated) > 100:
            with open(zh_path, 'w', encoding='utf-8') as f:
                f.write(translated)
            time.sleep(1)  # rate limit
            return
    except Exception as e:
        print(f"    [translate_file] AI error for {src.name}: {e}", file=sys.stderr)

    # Fallback: translate-shell
    trans_bin = Path.home() / "bin" / "trans"
    if trans_bin.exists():
        try:
            result = subprocess.run(
                [str(trans_bin), '-brief', '-no-ansi', ':zh'],
                input=content[:15000], capture_output=True, text=True, timeout=60
            )
            if result.returncode == 0 and result.stdout.strip() and len(result.stdout.strip()) > 100:
                with open(zh_path, 'w', encoding='utf-8') as f:
                    f.write(result.stdout.strip())
                time.sleep(0.3)
        except Exception as e2:
            print(f"    [translate_file] fallback also failed for {src.name}: {e2}", file=sys.stderr)


def clean_by_source(content, source_type):
    """Source-specific cleaning — different rules for reddit/web/x/youtube."""
    if source_type == "reddit":
        reddit_noise = [
            r'^(?:Upvote|Downvote|Share|Save|Hide|Report|Award).*$',
            r'^(?:Posted by|u/\S+\s*\d+\s*(?:hours?|days?|months?).*ago).*$',
            r'^\d+\s*(?:comments?|points?|upvotes?).*$',
            r'^(?:Sort by|Best|Top|New|Controversial|Old|Q&A).*$',
            r'^(?:More posts from|Related communities|About Community).*$',
            r'^(?:Reddit Premium|Coins|Advertise|Careers|Press).*$',
            r'^\[deleted\]$',
            r'^r/\w+\s*$',
            r'^Go to \w+\s*$',
            r'Open menu.*$',
            r'Expand user menu.*$',
            r'Get the Reddit app.*$',
            r'Log in to Reddit.*$',
            r'^Moderator Announcement.*$',
            r'^Read More »$',
            # ALL Reddit images (avatars, snoo, thumbnails, previews)
            r'!\[.*?\]\(https://(?:styles\.redditmedia|preview\.redd|external-preview\.redd|i\.redd)[^\)]*\)',
            r'\[\s*!\[.*?\]\([^\)]*\)\s*\]\([^\)]*\)',
            # Empty/chrome Reddit links
            r'^\s*\[\s*\]\(https://(?:www\.)?reddit\.com[^\)]*\)\s*$',
            # User profile links on own line
            r'^\s*\[\s*\w+\s*\]\(https://www\.reddit\.com/user/[^\)]*\)\s*$',
            # Subreddit link on own line
            r'^\s*\[\s*r/\w+\s*\]\(https://www\.reddit\.com/r/[^\)]*\)\s*$',
            r'^\s*\[.*?Go to \w+.*?\]\(.*?\)\s*$',
            # Bare vote counts
            r'^\s*\d+[kK]?\s*$',
            # Timestamps
            r'^•\s*\d+[dhm]\s+ago\s*$',
            # "Open" external link line
            r'^\s*\w+\.\w+\s+Open\s*$',
        ]
        pattern = re.compile('|'.join(reddit_noise), re.MULTILINE | re.IGNORECASE)
        content = pattern.sub('', content)

    elif source_type == "x":
        # --- X/Twitter page chrome noise ---
        # Phase 1: Remove known noise sections (everything after these markers is junk)
        section_markers = [
            r'^#{1,3}\s*(?:New to X|Trending now)\s*$',
            r'^Sign up now to get your own personalized timeline',
        ]
        for marker in section_markers:
            m = re.search(marker, content, re.MULTILINE | re.IGNORECASE)
            if m:
                content = content[:m.start()]

        # Phase 2: Remove individual noise lines
        x_noise = [
            # Auth / CTA
            r"^(?:Don't miss what's happening|People on X are the first to know).*$",
            r'^(?:Log in|Sign up|Create account)\s*$',
            r'^\[(?:Log in|Sign up|Create account)\]\(.*\)\s*$',
            # Page structure fragments
            r'^#{1,3}\s*(?:Post|Conversation)\s*$',
            r'^(?:See new posts|Show more|Show this thread)\s*$',
            r'^# \[\]\(https://x\.com/?\)\s*$',
            # Legal footer
            r'^\[?Terms of Service\]?\(?.*\)?\s*$',
            r'^\[?Privacy Policy\]?\(?.*\)?\s*$',
            r'^\[?Cookie (?:Policy|Use).*$',
            r'^\[?Accessibility\]?\(?.*\)?\s*$',
            r'^\[?Ads info\]?\(?.*\)?\s*$',
            r'^©\s*20\d\d X Corp\.?\s*$',
            # Metrics on own line
            r'^\d+\s*(?:Views?|Reposts?|Likes?|Bookmarks?|Quotes?)\s*$',
            r'^\[\d+\s*(?:Views?|Reposts?|Likes?|Bookmarks?|Quotes?)\]\(.*\)\s*$',
            # Misc chrome
            r'^By signing up, you agree.*$',
            r'^\|$',
            r'^More$',
            r'^·$',
            r'^\[$',
            # Title tag duplication (e.g. '# User on X: "tweet text" / X')
            r'^#.*on X: ".*" / X\s*$',
            # Timestamp link (e.g. [7:08 PM · Mar 5, 2026](...))
            r'^\[[\d:]+\s*[AP]M\s*·.*\]\(.*\)\s*$',
            # Profile images / card thumbnails
            r'^\[?\!\[(?:Image \d+|.*(?:profile|avatar|card_img)).*\]\(https://pbs\.twimg\.com/.*\)(?:\]\(.*\))?\s*$',
            # Jina metadata headers
            r'^Title:.*/ X\s*$',
            r'^URL Source:\s*https://x\.com/.*$',
            r'^Markdown Content:\s*$',
            r'^Published Time:.*$',
        ]
        pattern = re.compile('|'.join(x_noise), re.MULTILINE | re.IGNORECASE)
        content = pattern.sub('', content)

    elif source_type == "web":
        web_noise = [
            r'^#{1,3}\s*(?:Primary Menu|Main menu|Footer|Sidebar|Navigation|Breadcrumb).*$',
            r'^#{1,3}\s*(?:.*submenu).*$',
            r'^\*\s*\[(?:Analysis|Programs|Experts|Regions|Topics|Events|Podcasts|Newsletters|All \w+)\]\(.*\)\s*$',
            r'^\*\s*\[(?:Home|About|Contact|Privacy|Terms|Careers|Advertise|Help)\]\(.*\)\s*$',
            r'^(?:open|close)\s*$',
            # Navigation menu blocks (e.g. menu\n* [item](url)\n* ...)
            r'^menu\s*\n(?:\*\s*\[.*?\]\(.*?\)\s*\n)*',
            r'^## Utility\s*\n(?:\*\s*\[.*?\]\(.*?\)\s*\n)*',
        ]
        pattern = re.compile('|'.join(web_noise), re.MULTILINE | re.IGNORECASE)
        content = pattern.sub('', content)

    # Universal
    content = re.sub(r'^\s*\[\s*\]\s*$', '', content, flags=re.MULTILINE)
    content = re.sub(r'^\s*!\[\]\([^\)]*\)\s*$', '', content, flags=re.MULTILINE)
    content = re.sub(r'\n{3,}', '\n\n', content)

    return content.strip()


def clean_markdown(text):
    """Clean scraped markdown content — remove navigation, ads, boilerplate."""
    import re as _re
    original_text = text

    patterns = [
        # Navigation / UI
        r'Skip to (?:main )?content[^\n]*',
        r'(?:Open|Close|Expand|Toggle)\s+(?:menu|navigation|settings|sidebar)[^\n]*',
        r'(?:Log [Ii]n|Sign [Uu]p|Sign [Ii]n|Get (?:the )?[Aa]pp|Create account)[^\n]*',
        r'Go to Reddit Home',
        r'Expand user menu',
        r'Open settings menu',

        # Share / social
        r'\[!\[Image[^\]]*\]\([^\)]*\)\]\([^\)]*\)',
        r'\[Share[^\]]*\]\([^\)]*\)',
        r'\[Donate\]\([^\)]*\)',
        r'\[DOWNLOAD PAGE\][^\n]*',
        r'\[PRINT PAGE\][^\n]*',
        r'\[Skip to [^\]]*\]\([^\)]*\)',

        # Ad / cookie / privacy (use *? lazy match, NOT greedy [\s\S]* to end)
        r'Ad Feedback[\s\S]*?Cancel\s+Submit',
        r'Thank You![\s\S]*?Close',
        r'How relevant is this ad[\s\S]*?Submit',
        r'You rely on .{2,80} for truth and transparency[^\n]*(?:\n[^\n#]{0,200})*(?:\n.*?(?:Allow all|Reject all|Manage preferences)[^\n]*)?',
        r'We process your personal information[^\n]*(?:\n[^\n#]{0,200})*(?:\n.*?(?:Allow all|Reject all|Accept|Manage)[^\n]*)?',
        r'We use cookies[^\n]*(?:\n[^\n#]{0,200})*(?:\n.*?(?:Accept|Reject|Manage)[^\n]*)?',
        r'This site is protected by reCAPTCHA[^\n]*',

        # Reddit boilerplate
        r'r/\w+ • \d+[dhm] ago',
        r'\d+ upvotes? · \d+ comments?',
        r'Get the Reddit app',

        # Image noise
        r'!\[Image \d+\]\(https://[^\)]*(?:icon|logo|svg|favicon|avatar|badge)[^\)]*\)',
        r'!\[Image \d+\]\(https://static\d*\.nyt\.com/images/icons/[^\)]+\)',
        r'!\[r/\w+ -[^\]]*\]\([^\)]*\)',

        # Footer / recommended — only heading + following non-heading lines (NOT to end of file)
        r'^#{1,3}\s*(?:More (?:on|from|stories|articles)|Related (?:articles|stories|coverage|From)|Recommended|Also read|You may also like|Popular|Trending|Most read|Keep reading|Read next|What to read next)[^\n]*(?:\n(?!#{1,3}\s)[^\n]{0,200})*',
        r'^#{1,3}\s*(?:About the author|About this|Contact us|Follow us|Stay informed|Sign up|Subscribe|Join us|Support)[^\n]*(?:\n(?!#{1,3}\s)[^\n]{0,200})*',
        r'(?:©|Copyright)\s*\d{4}[^\n]*(?:\n[^\n]{0,150})*',
        r'^SIGN\s*UP[^\n]*(?:\n(?!#{1,3}\s)[^\n]{0,200})*',
        r'^Related From[^\n]*(?:\n(?!#{1,3}\s)[^\n]{0,200})*',
        r'^Ways to make a difference[^\n]*(?:\n(?!#{1,3}\s)[^\n]{0,200})*',

        # Newsletter / CTA — lazy match to nearest boundary, not greedy to EOF
        r'Get our free[^\n]*(?:\n[^\n#]{0,200})*?(?:\n.*?(?:Sign up|Subscribe)[^\n]*)?',
        r'Enter your email[^\n]*(?:\n[^\n#]{0,200})*?(?:\n.*?(?:Sign up|Subscribe)[^\n]*)?',
        r'Free\s+to\s+read[^\n]*(?:\n[^\n#]{0,200})*?(?:\n.*?(?:Sign up|Register)[^\n]*)?',
        r'Already a subscriber\?[^\n]*',
        r'This article appeared in[^\n]*',

        # Jina Reader metadata
        r'^Title:.*$',
        r'^URL Source:.*$',
        r'^Published Time:.*$',
        r'^Markdown Content:\s*',

        # Link-only headings
        r'^#{1,3}\s*\[.*?\]\(.*?\)\s*$',
    ]

    original_len = len(text)
    for p in patterns:
        text = _re.sub(p, '', text, flags=_re.MULTILINE | _re.IGNORECASE)

    # Collapse excessive blank lines
    text = _re.sub(r'\n{3,}', '\n\n', text)
    text = text.strip()

    # Guard against over-cleaning: if we removed more than 90% of content, keep original
    if original_len > 0 and len(text) < original_len * 0.1:
        return original_text

    return text


def is_index_page(url, content=""):
    """Detect whether a URL/content is an index/listing page rather than an article.
    Returns (is_index: bool, reason: str)."""
    score = 0  # positive = index, negative = article

    # --- URL signals ---
    path = re.sub(r'^https?://[^/]+', '', url)

    # Index URL patterns
    has_index_keyword = bool(re.search(r'/(?:topic|topics|tag|tags|category|categories|hub|section|archive|latest|where)(?:/|$)', path, re.I))
    if has_index_keyword:
        score += 4
    # Shallow path with no article identifiers
    segments = [s for s in path.strip('/').split('/') if s]
    has_date = bool(re.search(r'\d{4}', path))
    has_id = bool(re.search(r'[a-z0-9]{8,}|b\d{5,}', segments[-1] if segments else ''))  # hash or numeric ID
    has_long_slug = bool(re.search(r'-[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+', path))
    if len(segments) <= 2 and not has_date and not has_id and not has_long_slug:
        score += 3
    # /country/ pattern (e.g. reliefweb.int/country/sdn)
    if re.search(r'/country/', path, re.I) and len(segments) <= 2:
        score += 2

    # Article URL patterns
    if has_date:
        score -= 3  # date in path
    if re.search(r'/articles?/', path, re.I):
        score -= 3
    if has_long_slug:
        score -= 2
    if path.endswith('.html') or path.endswith('.htm'):
        score -= 1
    if has_id and len(segments) >= 3 and not has_index_keyword:
        score -= 2  # deep path with ID = likely article (unless already flagged as index)

    # --- Content signals (if available) ---
    if content and len(content) > 200:
        lines = [l for l in content.split('\n') if l.strip()]
        if lines:
            total_chars = sum(len(l) for l in lines)
            # Link density
            link_count = len(re.findall(r'\[.*?\]\(.*?\)', content))
            link_density = link_count / max(len(lines), 1)
            if link_density > 1.0:
                score += 3
            elif link_density < 0.3:
                score -= 2

            # Average line length
            avg_len = total_chars / len(lines)
            if avg_len < 40:
                score += 2
            elif avg_len > 80:
                score -= 2

            # Heading density (many h2/h3 relative to text)
            headings = sum(1 for l in lines if re.match(r'^#{2,3}\s', l))
            if headings > 5 and total_chars < 5000:
                score += 3

    is_index = score >= 3
    reason = ""
    if is_index:
        reasons = []
        if re.search(r'/(?:topic|tag|category|hub|section|archive|latest)', path, re.I):
            reasons.append("index URL pattern")
        if len(segments) <= 2:
            reasons.append("shallow path")
        if content:
            reasons.append(f"score={score}")
        reason = ", ".join(reasons) if reasons else f"score={score}"
    return is_index, reason


def quality_check(text, source_type="web"):
    """Post-cleaning quality check. Returns dict with score (0.0-1.0) and verdict."""
    lines = [l for l in text.split('\n') if l.strip()]
    if not lines:
        return {"score": 0.0, "verdict": "JUNK", "reason": "empty"}

    total_lines = len(lines)
    total_chars = sum(len(l) for l in lines)

    # 0) Reject invalid/error pages immediately
    invalid_patterns = [
        r"blocked by network security",
        r"JavaScript is not available",
        r"Please enable JavaScript",
        r"Access Denied",
        r"403 Forbidden",
        r"404 Not Found",
        r"captcha|CAPTCHA",
        r"Checking if the site connection is secure",
        r"file a ticket",
        r"Something went wrong.*try again",
        r"Enable JavaScript and cookies to continue",
    ]
    for p in invalid_patterns:
        if re.search(p, text, re.I):
            return {"score": 0.0, "verdict": "JUNK", "reason": f"invalid page: {p}",
                    "details": {"lines": total_lines, "short_ratio": 0, "link_density": 0,
                                "noise_hits": 0, "avg_line_len": 0, "headings": 0}}

    # 1) Short-line ratio: nav junk produces many short lines (<40 chars)
    short_lines = sum(1 for l in lines if len(l.strip()) < 40)
    short_ratio = short_lines / total_lines

    # 2) Link density: markdown links per line
    link_count = len(re.findall(r'\[.*?\]\(.*?\)', text))
    link_density = link_count / total_lines

    # 3) Known noise keyword hits
    noise_keywords = [
        r'(?:Sign up|Log in|Create account)',
        r'(?:Terms of Service|Privacy Policy|Cookie Policy)',
        r'(?:Trending now|What\'s happening|Who to follow)',
        r'(?:Don\'t miss what\'s happening)',
        r'© 20\d\d X Corp',
        r'(?:Skip to content|Main menu|Primary Menu)',
        r'(?:Subscribe to our newsletter)',
    ]
    noise_hits = sum(1 for p in noise_keywords if re.search(p, text, re.I))

    # Calculate score
    score = 1.0
    if noise_hits >= 5:
        score -= 0.5
    elif noise_hits >= 3:
        score -= 0.3
    elif noise_hits >= 1:
        score -= 0.15

    if short_ratio > 0.7:
        score -= 0.25
    elif short_ratio > 0.5:
        score -= 0.1

    if link_density > 1.5:
        score -= 0.2
    elif link_density > 0.8:
        score -= 0.1

    score = max(0.0, min(1.0, score))

    # For web sources: use jusText as second opinion if score is borderline
    if source_type == "web" and 0.3 <= score <= 0.8:
        try:
            import justext
            # Wrap markdown in minimal HTML for jusText analysis
            html = f"<html><body>{''.join(f'<p>{l}</p>' for l in lines)}</body></html>"
            paragraphs = justext.justext(html, justext.get_stoplist("English"))
            good = sum(1 for p in paragraphs if not p.is_boilerplate)
            total = len(paragraphs)
            if total > 0:
                good_ratio = good / total
                if good_ratio < 0.3:
                    score -= 0.15  # Most content is boilerplate
                elif good_ratio > 0.7:
                    score += 0.1   # Mostly good content
                score = max(0.0, min(1.0, score))
        except Exception:
            pass  # jusText is optional, don't fail if unavailable

    # Index page detection via content structure
    headings = sum(1 for l in lines if re.match(r'^#{2,3}\s', l))
    total_chars = sum(len(l) for l in lines)
    avg_line_len = total_chars / total_lines
    # Index page: many headings + high link density, OR dense headings in short text
    # Index page: many headings + high link density in SHORT text
    # Exclude long-form content (Wikipedia, detailed reports) which naturally has many headings
    heading_ratio = headings / max(total_lines, 1)
    is_index_content = (
        (link_density > 1.0 and avg_line_len < 50) or
        (headings > 5 and total_chars < 5000) or
        (headings > 10 and link_density > 0.2 and heading_ratio > 0.05 and total_chars < 30000)
    )

    if score >= 0.6:
        verdict = "CLEAN"
    elif score >= 0.3:
        verdict = "NOISY"
    else:
        verdict = "JUNK"

    if is_index_content:
        verdict = "INDEX"
        score = min(score, 0.2)

    return {
        "score": round(score, 2),
        "verdict": verdict,
        "details": {
            "lines": total_lines,
            "short_ratio": round(short_ratio, 2),
            "link_density": round(link_density, 2),
            "noise_hits": noise_hits,
            "avg_line_len": round(avg_line_len, 1),
            "headings": headings,
        }
    }


def _get_openrouter_key():
    """Get OpenRouter API key from env or config file."""
    api_key = os.environ.get('OPENROUTER_API_KEY')
    if not api_key:
        env_file = Path.home() / ".config" / "last30days" / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith('OPENROUTER_API_KEY='):
                    api_key = line.split('=', 1)[1].strip()
                    break
    return api_key


def llm_clean_markdown(text):
    """Use LLM to extract article body from noisy markdown (Jina/xcrawl output)."""
    if not text or len(text) < 500:
        return text

    api_key = _get_openrouter_key()
    if not api_key:
        return text

    prompt = """You are a web content cleaner. Extract ONLY the article body from the following markdown.

Rules:
1. REMOVE all navigation menus, category links, sidebar content, footer links, social sharing buttons, ad placeholders, cookie notices, and "recommended articles" sections.
2. KEEP the article title, author, date, all body paragraphs, subheadings, images with captions, and blockquotes that are part of the article.
3. KEEP all markdown formatting (headings, bold, links, images) intact.
4. KEEP the "原始链接" line at the top if present.
5. PRESERVE the original letter casing exactly — do NOT convert to lowercase.
6. Your response must begin IMMEDIATELY with the article content. Do NOT include any preamble such as "Here is...", "I'll extract...", or "Sure..." — output the cleaned markdown only, nothing else."""

    try:
        payload = json.dumps({
            "model": "deepseek/deepseek-chat-v3-0324",
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": text[:30000]}
            ],
            "max_tokens": 12000,
            "temperature": 0.0
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
        with urllib.request.urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode())
        cleaned = result.get("choices", [{}])[0].get("message", {}).get("content", "")

        if cleaned and len(cleaned) > 200:
            return cleaned
    except Exception as e:
        print(f"    [llm_clean] Error: {e}", file=sys.stderr)

    return text


def run_xcrawl_search(query, site=None, limit=10):
    """Run xcrawl search and return results."""
    q = f"site:{site} {query}" if site else query
    try:
        result = subprocess.run(
            ["xcrawl", "search", q, "--limit", str(limit), "--json"],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return data.get("results", [])
    except Exception as e:
        print(f"  [xcrawl search] Error: {e}", file=sys.stderr)
    return []


def run_xcrawl_scrape(urls, out_dir):
    """Scrape URLs with xcrawl, save to out_dir."""
    if not urls:
        return
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        cmd = ["xcrawl", "scrape"] + urls + [
            "--format", "markdown",
            "--output", str(out_dir),
            "--concurrency", "3",
            "--timeout", "30000",
            "--json"
        ]
        subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as e:
        print(f"  [xcrawl scrape] Error: {e}", file=sys.stderr)


def fetch_tweet(user, tweet_id):
    """Fetch full tweet text via fxtwitter API."""
    url = f"https://api.fxtwitter.com/{user}/status/{tweet_id}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        return data.get("tweet", {})
    except Exception as e:
        print(f"  [fxtwitter] Error for {tweet_id}: {e}", file=sys.stderr)
        return None


def extract_tweet_id(url):
    """Extract user and tweet ID from X URL."""
    m = re.search(r'x\.com/(\w+)/status/(\d+)', url)
    if m:
        return m.group(1), m.group(2)
    return None, None


def extract_youtube_id(url):
    """Extract video ID from YouTube URL."""
    m = re.search(r'(?:v=|youtu\.be/)([a-zA-Z0-9_-]{11})', url)
    return m.group(1) if m else None


def fetch_youtube_subtitle(video_id, out_dir):
    """Extract YouTube subtitle using yt-dlp."""
    if not YT_DLP.exists():
        return None

    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = os.path.join(tmp, "sub")
        try:
            subprocess.run(
                [str(YT_DLP), "--write-auto-sub", "--sub-lang", "en",
                 "--skip-download", "--sub-format", "vtt",
                 "-o", tmp_path, f"https://www.youtube.com/watch?v={video_id}"],
                capture_output=True, text=True, timeout=30
            )
            vtt_file = f"{tmp_path}.en.vtt"
            if not os.path.exists(vtt_file):
                return None

            with open(vtt_file) as f:
                vtt = f.read()

            # Parse VTT to plain text
            seen = set()
            texts = []
            for line in vtt.split("\n"):
                line = line.strip()
                if not line or line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:"):
                    continue
                if "-->" in line or re.match(r'^\d+$', line):
                    continue
                clean = re.sub(r'<[^>]+>', '', line)
                if clean and clean not in seen:
                    seen.add(clean)
                    texts.append(clean)

            full_text = " ".join(texts)
            if not full_text:
                return None

            md_path = out_dir / f"youtube_{video_id}.md"
            with open(md_path, "w") as f:
                f.write(f"# YouTube Video {video_id}\n\n")
                f.write(f"**视频链接：** https://www.youtube.com/watch?v={video_id}\n")
                f.write(f"**字幕语言：** English (auto-generated)\n")
                f.write(f"**字数：** {len(full_text.split())} 词\n\n---\n\n")
                f.write(full_text)
            return str(md_path.relative_to(DATA_DIR))
        except Exception as e:
            print(f"  [yt-dlp] Error for {video_id}: {e}", file=sys.stderr)
    return None


def save_tweet_md(tweet, user, tweet_id, out_dir):
    """Save tweet as markdown file."""
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path = out_dir / f"x.com_{user}_status_{tweet_id}.md"
    author = tweet.get("author", {})
    with open(md_path, "w") as f:
        f.write(f"# {author.get('name', user)} (@{author.get('screen_name', user)})\n\n")
        f.write(f"**日期：** {tweet.get('created_at', 'unknown')}\n")
        f.write(f"**原始链接：** https://x.com/{user}/status/{tweet_id}\n")
        f.write(f"**互动：** {tweet.get('likes', 0)} likes / {tweet.get('retweets', 0)} RT / {tweet.get('replies', 0)} replies\n\n")
        f.write("---\n\n")
        f.write(tweet.get("text", ""))
        f.write("\n")
    return str(md_path.relative_to(DATA_DIR))


def fetch_reddit_thread(url, out_dir):
    """Fetch Reddit thread via JSON API — structured, clean, with threaded comments."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Extract path from URL
    m = re.search(r'reddit\.com(/r/\w+/comments/\w+[^?\s]*)', url)
    if not m:
        return None

    path = m.group(1).rstrip('/')
    slug = re.sub(r'[^a-zA-Z0-9._-]', '_', path)[:80]
    md_path = out_dir / f"reddit{slug}.md"
    if md_path.exists() and md_path.stat().st_size > 500:
        return str(md_path.relative_to(DATA_DIR))

    try:
        # Try ScrapeCreators (structured Reddit data, retries on failure)
        sc_key = os.environ.get('SCRAPECREATORS_API_KEY')
        if not sc_key:
            env_file = Path.home() / ".config" / "last30days" / ".env"
            if env_file.exists():
                for line in env_file.read_text().splitlines():
                    if line.startswith('SCRAPECREATORS_API_KEY='):
                        sc_key = line.split('=', 1)[1].strip()

        comments_data = []
        title = ""
        selftext = ""
        score = 0
        num_comments = 0
        subreddit = re.search(r'/r/(\w+)', url).group(1) if re.search(r'/r/(\w+)', url) else ""
        author = ""
        date_str = ""

        if sc_key:
            from urllib.parse import urlencode

            def _sc_request(endpoint, max_retries=2):
                """ScrapeCreators request with retry."""
                api_url = f"https://api.scrapecreators.com/v1/reddit/{endpoint}?{urlencode({'url': url})}"
                for attempt in range(max_retries):
                    try:
                        req = urllib.request.Request(api_url, headers={
                            "x-api-key": sc_key, "User-Agent": "ConflictTracker/1.0"
                        })
                        with urllib.request.urlopen(req, timeout=45) as resp:
                            return json.loads(resp.read().decode())
                    except Exception as e:
                        if attempt < max_retries - 1:
                            time.sleep(3)
                        else:
                            raise e
                return {}

            # Get comments (includes post data)
            try:
                cmt_data = _sc_request("post/comments")
                post_info = cmt_data.get("post", {})
                title = post_info.get("title", "")
                selftext = post_info.get("selftext", "")
                score = post_info.get("score", post_info.get("ups", 0))
                num_comments = post_info.get("num_comments", 0)
                author = post_info.get("author", "")
                created = post_info.get("created_utc", 0)
                if created:
                    from datetime import datetime as _dt
                    try:
                        date_str = _dt.utcfromtimestamp(float(created)).strftime("%Y-%m-%d")
                    except: pass
                comments_data = cmt_data.get("comments", [])
            except Exception as e:
                print(f"    [sc_reddit] {e}", file=sys.stderr)

        # Format comments into threaded markdown
        def format_comments(comments, depth=0, max_depth=3, limit=20):
            lines = []
            count = 0
            for c in comments:
                if count >= limit: break
                body = c.get("body", c.get("text", "")).strip()
                if not body or body in ("[deleted]", "[removed]"): continue
                c_author = c.get("author", c.get("username", "[deleted]"))
                c_score = c.get("score", c.get("upvotes", 0))
                prefix = "> " * (depth + 1)
                lines.append(f"{prefix}**u/{c_author}** ({c_score} pts)")
                for bline in body.split("\n"):
                    lines.append(f"{prefix}{bline}")
                lines.append(f"{prefix}")
                # Handle nested replies if available
                replies = c.get("replies", c.get("children", []))
                if isinstance(replies, list) and replies and depth < max_depth:
                    lines.extend(format_comments(replies, depth + 1, max_depth, 8))
                count += 1
            return lines

        comment_lines = format_comments(comments_data)

        # Build markdown document
        parts = [
            f"# {title}",
            f"",
            f"**r/{subreddit}** | {score} pts | {num_comments} comments | u/{author} | {date_str}",
            f"",
            f"**原始链接：** {url}",
            f"",
            f"---",
        ]

        if selftext:
            parts.append(f"")
            parts.append(selftext[:3000])

        if comment_lines:
            parts.append(f"")
            parts.append(f"## 热门评论")
            parts.append(f"")
            parts.extend(comment_lines)

        content = "\n".join(parts)

        with open(md_path, "w", encoding="utf-8") as f:
            f.write(content)

        return str(md_path.relative_to(DATA_DIR))

    except Exception as e:
        print(f"    [reddit_json] {url[:50]}: {e}", file=sys.stderr)
        return None


def fetch_via_markdownify_wiki(url, out_dir):
    """Extract Wikipedia article using markdownify (superior to Trafilatura for Wikipedia).

    Handles tables, inline references, headings, and internal links correctly.
    Only use for wikipedia.org domains.
    """
    try:
        from trafilatura import fetch_url as tf_fetch
        from lxml import html as lxml_html
        from lxml import etree
        from markdownify import markdownify as md
    except ImportError:
        return None

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r'[^a-zA-Z0-9._-]', '_', get_domain(url) + '_' + url.split('/')[-1])[:80]
    md_path = out_dir / f"{slug}.md"
    if md_path.exists() and md_path.stat().st_size > 300:
        return str(md_path.relative_to(DATA_DIR))

    try:
        raw_html = tf_fetch(url)
        if not raw_html:
            return None

        tree = lxml_html.fromstring(raw_html)
        content_div = tree.xpath('//div[@id="mw-content-text"]')
        if not content_div:
            return None

        # Remove non-content elements
        for tag in content_div[0].xpath(
            '//style | //script | //span[@class="mw-editsection"] | '
            '//div[contains(@class, "navbox")] | '
            '//div[contains(@class, "catlinks")] | '
            '//div[contains(@class, "reflist")] | '
            '//div[contains(@class, "mw-references-wrap")] | '
            '//table[contains(@class, "ambox")] | '
            '//table[contains(@class, "ombox")] | '
            '//div[@id="toc"] | '
            '//div[contains(@class, "toc")]'
        ):
            tag.getparent().remove(tag)

        content_html = etree.tostring(content_div[0], encoding='unicode')
        content = md(content_html, strip=['sup', 'style', 'script'])

        # Post-cleanup
        content = re.sub(r'\[edit\]', '', content)
        content = re.sub(r'\.mw-parser-output[^\n]*\n?', '', content)
        content = re.sub(r'\n{3,}', '\n\n', content)
        content = content.strip()

        if not content or len(content) < 200:
            return None

        with open(md_path, 'w', encoding='utf-8') as f:
            f.write(f"**原始链接：** {url}\n\n---\n\n{content}")
        return str(md_path.relative_to(DATA_DIR))
    except Exception as e:
        print(f"    [markdownify_wiki] {url[:50]}: {e}", file=sys.stderr)
        return None


def _extract_tables_as_markdown(html_str):
    """Extract tables from raw HTML and convert to proper Markdown via markdownify.

    Trafilatura produces broken Markdown for complex nested tables (e.g. Wikipedia
    infobox/wikitable). This function extracts them separately using markdownify.
    """
    try:
        from lxml import html as lxml_html
        from lxml import etree
        from markdownify import markdownify as md
    except ImportError:
        return []

    tree = lxml_html.fromstring(html_str)
    tables = tree.xpath('//table[contains(@class, "infobox") or contains(@class, "wikitable")]')
    result = []
    for table in tables:
        table_html = etree.tostring(table, encoding='unicode')
        table_md = md(table_html, strip=['img', 'sup']).strip()
        if table_md:
            result.append(table_md)
    return result


def fetch_via_trafilatura(url, out_dir):
    """Extract article body using Trafilatura (best quality, primary method for web).

    Uses hybrid extraction: Trafilatura for body text (include_tables=False) +
    markdownify for tables, to avoid broken table conversion on complex pages.
    """
    try:
        from trafilatura import fetch_url as tf_fetch, extract as tf_extract
    except ImportError:
        return None

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r'[^a-zA-Z0-9._-]', '_', get_domain(url) + '_' + url.split('/')[-1])[:80]
    md_path = out_dir / f"{slug}.md"
    if md_path.exists() and md_path.stat().st_size > 300:
        return str(md_path.relative_to(DATA_DIR))

    try:
        html = tf_fetch(url)
        if not html:
            return None

        # Extract tables separately with markdownify (handles complex tables correctly)
        table_sections = _extract_tables_as_markdown(html)

        # Extract body without tables to avoid broken table fragments
        content = tf_extract(html, output_format='markdown', with_metadata=False,
                             include_images=True, include_tables=False)
        if not content or len(content) < 200:
            return None

        # Combine: header + first table (infobox) + body + remaining tables
        parts = [f"**原始链接：** {url}\n\n---\n"]
        if table_sections:
            parts.append(table_sections[0])
            parts.append("---\n")
        parts.append(content)
        for t in table_sections[1:]:
            parts.append(t)

        with open(md_path, 'w', encoding='utf-8') as f:
            f.write("\n\n".join(parts))
        return str(md_path.relative_to(DATA_DIR))
    except Exception as e:
        print(f"    [trafilatura] {url[:50]}: {e}", file=sys.stderr)
        return None


def fetch_via_jina(url, out_dir):
    """Fetch page content via Jina Reader API (fallback when trafilatura fails)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r'[^a-zA-Z0-9._-]', '_', get_domain(url) + url.split('/')[-1])[:80]
    md_path = out_dir / f"{slug}.md"
    if md_path.exists() and md_path.stat().st_size > 200:
        return str(md_path.relative_to(DATA_DIR))
    try:
        jina_url = f"https://r.jina.ai/{url}"
        req = urllib.request.Request(jina_url, headers={
            "Accept": "text/markdown",
            "User-Agent": "Mozilla/5.0"
        })
        with urllib.request.urlopen(req, timeout=20) as resp:
            content = resp.read().decode("utf-8", errors="ignore")
        if len(content) < 300:
            return None
        content = clean_markdown(content)
        content = llm_clean_markdown(content)
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(content)
        time.sleep(0.5)  # rate limit
        return str(md_path.relative_to(DATA_DIR))
    except Exception as e:
        print(f"    [jina] {url[:50]}: {e}", file=sys.stderr)
        return None


def smart_scrape(url, subdir):
    """Scrape a URL using the best available method.

    Priority chain:
      1. Trafilatura (best quality — article body extraction)
      2. Jina Reader (fallback — full page as markdown)
      3. Al Jazeera custom handler (for aljazeera.com)
      4. xcrawl (last resort)
    Blocked domains are skipped entirely.
    """
    domain = get_domain(url)
    if domain in BLOCKED_DOMAINS:
        return None

    out_dir = SOURCES_DIR / subdir

    # 0. Reddit: use JSON API (not HTML scraping)
    if 'reddit.com' in domain:
        return fetch_reddit_thread(url, SOURCES_DIR / "reddit")

    # 0.5. Wikipedia: use markdownify (handles tables, refs, headings correctly)
    if 'wikipedia.org' in domain:
        local = fetch_via_markdownify_wiki(url, out_dir)
        if local:
            return local

    # 1. Try Trafilatura first (best article extraction)
    local = fetch_via_trafilatura(url, out_dir)
    if local:
        return local

    # 2. Al Jazeera custom handler
    if 'aljazeera.com' in domain:
        return fetch_aljazeera(url, out_dir)

    # 3. Jina Reader fallback
    local = fetch_via_jina(url, out_dir)
    if local:
        return local

    # 4. xcrawl last resort
    run_xcrawl_scrape([url], out_dir)
    return _find_local_file(url, out_dir)


def _find_local_file(url, out_dir):
    """Find a matching .md file for a URL in a directory."""
    if not out_dir.exists():
        return None
    slug = url.replace("https://", "").replace("http://", "").replace("/", "_")
    for length in [45, 35, 25]:
        prefix = slug[:length]
        for fname in os.listdir(out_dir):
            if fname.endswith(".md") and prefix in fname:
                return str((out_dir / fname).relative_to(DATA_DIR))
    return None


def json_to_md(json_path):
    """Convert xcrawl JSON output to clean readable markdown."""
    with open(json_path) as f:
        data = json.load(f)
    title = data.get("title", data.get("metadata", {}).get("title", "Untitled"))
    url = data.get("url", data.get("metadata", {}).get("sourceURL", ""))
    content = data.get("markdown", data.get("content", ""))
    content = clean_markdown(content) if content else "(内容为空)"
    if content and content != "(内容为空)":
        content = llm_clean_markdown(content)
    md_path = str(json_path).replace(".json", ".md")
    with open(md_path, "w") as f:
        f.write(f"# {title}\n\n**原始链接：** {url}\n\n---\n\n")
        f.write(content)
    return md_path


def classify_item(title, summary):
    """Simple keyword-based classification."""
    text = (title + " " + summary).lower()
    military_kw = ["offensive", "troops", "drone", "strike", "attack", "frontline", "assault",
                   "military", "forces", "missile", "artillery", "brigade", "battalion",
                   "进攻", "军事", "无人机", "打击", "前线", "部队"]
    diplomacy_kw = ["ceasefire", "peace", "negotiate", "trump", "diplomatic", "talks",
                    "停火", "和平", "谈判", "外交"]
    video_kw = ["youtube.com", "video", "视频"]

    for kw in video_kw:
        if kw in text:
            return "video"
    for kw in diplomacy_kw:
        if kw in text:
            return "diplomacy"
    for kw in military_kw:
        if kw in text:
            return "military"
    return "opinion"


def _find_local_file(directory, safe_name, url):
    """Find a scraped local file matching a URL. Converts JSON to MD if needed.
    Uses progressively shorter prefixes for matching."""
    # Convert any JSON files in directory
    for f in directory.glob("*.json"):
        json_to_md(f)

    # Try matching with progressively shorter prefixes
    candidates = [f for f in directory.glob("*.md") if not f.name.endswith(".zh.md")]
    for prefix_len in [80, 50, 30]:
        prefix = safe_name[:prefix_len]
        for f in candidates:
            if prefix in f.name:
                return str(f.relative_to(DATA_DIR))

    # Last resort: match by domain
    domain = re.sub(r'^(?:https?://)?(?:www\.)?([^/]+).*', r'\1', url)
    for f in candidates:
        if domain.replace(".", "_") in f.name or domain.split(".")[0] in f.name:
            # Verify it's not already claimed by another item
            return str(f.relative_to(DATA_DIR))

    return None


def collect_conflict(conflict_id, config, seen_urls, date_filter):
    """Collect data for a single conflict. Returns list of new items.

    Dedup strategy: search without filtering, let all results come back.
    Only dedup at write stage — skip items whose URL is already in seen_urls
    or whose local file already exists. This avoids the problem where filtering
    search results causes the engine to return nothing new.

    Args:
        seen_urls: set of URLs already in latest.json (for write-stage dedup)
        date_filter: 'after:YYYY-MM-DD' string to append to queries
    """
    queries = config["queries"]
    topic = queries[0] if queries else config["name_en"]
    items = []

    # Track URLs added THIS run across conflicts to avoid cross-conflict dupes
    run_seen = set()

    def _should_add(url):
        """Write-stage dedup: skip if already in history or added this run."""
        if url in seen_urls or url in run_seen:
            return False
        run_seen.add(url)
        return True

    # 1. Web search — use both queries
    results = []
    for q in queries[:2]:
        try:
            results.extend(run_xcrawl_search(f"{q} {date_filter}", limit=5))
        except Exception as e:
            print(f"    [web] search failed: {e}", file=sys.stderr)
    web_urls = []
    for r in results:
        u = r["url"]
        if any(s in u for s in ["x.com", "youtube.com", "reddit.com"]):
            continue
        idx, reason = is_index_page(u)
        if idx:
            print(f"    [跳过索引页] {u[:80]} ({reason})")
            continue
        web_urls.append(u)
    if web_urls:
        run_xcrawl_scrape(web_urls[:3], SOURCES_DIR / "web")
        for r in results:
            if r["url"] not in web_urls[:3]:
                continue
            if not _should_add(r["url"]):
                continue
            safe_name = r["url"].replace("https://", "").replace("http://", "").replace("/", "_")[:100]
            local_file = _find_local_file(SOURCES_DIR / "web", safe_name, r["url"])
            if not local_file:
                continue
            # Read content for date extraction
            file_content = ""
            fp = DATA_DIR / local_file
            if fp.exists():
                file_content = fp.read_text(encoding='utf-8', errors='ignore')[:2000]
            items.append({
                "title": r.get("title", ""),
                "summary": r.get("snippet", ""),
                "source": "web",
                "source_label": r["url"].split("/")[2],
                "date": extract_publish_date(r["url"], file_content),
                "url": r["url"],
                "local_file": local_file,
                "metrics": {}
            })

    # 2. X/Twitter search
    try:
        x_results = run_xcrawl_search(f"{topic} {date_filter}", site="x.com", limit=5)
    except Exception as e:
        print(f"    [x] search failed: {e}", file=sys.stderr)
        x_results = []
    for r in x_results:
        user, tid = extract_tweet_id(r["url"])
        if not user or not tid:
            continue
        if not _should_add(r["url"]):
            continue
        tweet = fetch_tweet(user, tid)
        if not tweet or not tweet.get("text"):
            continue
        local_file = save_tweet_md(tweet, user, tid, SOURCES_DIR / "x")
        author = tweet.get("author", {})
        items.append({
            "title": tweet.get("text", "")[:80],
            "summary": tweet.get("text", "")[:200],
            "source": "x",
            "source_label": f"@{author.get('screen_name', user)}",
            "date": parse_tweet_date(tweet.get("created_at", "")),
            "url": r["url"],
            "local_file": local_file,
            "metrics": {
                "likes": tweet.get("likes", 0),
                "retweets": tweet.get("retweets", 0)
            }
        })

    # 3. Reddit search
    try:
        reddit_results = run_xcrawl_search(f"{topic} {date_filter}", site="reddit.com", limit=5)
    except Exception as e:
        print(f"    [reddit] search failed: {e}", file=sys.stderr)
        reddit_results = []
    new_reddit = [r for r in reddit_results if _should_add(r["url"])]
    for r in new_reddit:
        # Use dedicated Reddit fetcher (ScrapeCreators API), not generic xcrawl
        local_file = fetch_reddit_thread(r["url"], SOURCES_DIR / "reddit")
        if not local_file:
            continue
        items.append({
            "title": r.get("title", ""),
            "summary": r.get("snippet", ""),
            "source": "reddit",
            "source_label": extract_subreddit(r["url"]),
            "date": extract_publish_date(r["url"], r.get("snippet", "")),
            "url": r["url"],
            "local_file": local_file,
            "metrics": {}
        })

    # 4. YouTube search
    try:
        yt_results = run_xcrawl_search(f"{topic} 2026 {date_filter}", site="youtube.com", limit=3)
    except Exception as e:
        print(f"    [youtube] search failed: {e}", file=sys.stderr)
        yt_results = []
    for r in yt_results:
        if not _should_add(r["url"]):
            continue
        vid = extract_youtube_id(r["url"])
        if not vid:
            continue
        local_file = fetch_youtube_subtitle(vid, SOURCES_DIR / "youtube")
        if not local_file:
            continue
        items.append({
            "title": r.get("title", ""),
            "summary": r.get("snippet", ""),
            "source": "youtube",
            "source_label": "YouTube",
            "date": extract_publish_date(r["url"], r.get("snippet", "")),
            "url": r["url"],
            "local_file": local_file,
            "metrics": {}
        })

    return items


def collect():
    """Main collection pipeline — iterates over all conflicts."""
    print(f"=== 数据采集开始 {datetime.now().isoformat()} ===")
    print(f"    共 {len(CONFLICTS)} 个冲突区\n")

    # Ensure directories
    for d in ["reddit", "x", "web", "youtube"]:
        (SOURCES_DIR / d).mkdir(parents=True, exist_ok=True)

    # Time filter: based on last run time, with 1h overlap
    existing_json = DATA_DIR / "latest.json"
    last_run = None
    if existing_json.exists():
        try:
            with open(existing_json) as f:
                last_run = json.load(f).get("updated_at", "")
        except Exception:
            pass

    if last_run:
        try:
            last_dt = datetime.fromisoformat(last_run.replace("Z", "+00:00"))
            # Search from 1 day before last run (overlap to catch late-indexed content)
            filter_dt = last_dt - timedelta(days=1)
            date_filter = f"after:{filter_dt.strftime('%Y-%m-%d')}"
            print(f"    增量模式: 搜索 {filter_dt.strftime('%Y-%m-%d')} 之后的内容")
        except Exception:
            date_filter = f"after:{(datetime.now() - timedelta(days=2)).strftime('%Y-%m-%d')}"
    else:
        # First run: search last 30 days
        date_filter = f"after:{(datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')}"
        print("    首次采集: 搜索最近 30 天")

    # Load existing URLs for write-stage dedup (not search-stage filtering)
    seen_urls = set()
    if existing_json.exists():
        try:
            with open(existing_json) as f:
                existing = json.load(f)
            for conflict_data in existing.get("conflicts", {}).values():
                for cat in conflict_data.get("categories", {}).values():
                    for item in cat.get("items", []):
                        if item.get("url"):
                            seen_urls.add(item["url"])
            print(f"    已有 {len(seen_urls)} 条历史 URL")
        except Exception:
            pass

    # Phase 0: RSS feeds (fast, reliable, no rate limits)
    print("[RSS] 采集 RSS 源...")
    try:
        from rss_feeds import fetch_rss, merge_rss_items, generate_feed
        rss_items = fetch_rss()
        rss_added = merge_rss_items(rss_items)
        print(f"  RSS 完成: {rss_added} 条新增\n")
    except Exception as e:
        print(f"  RSS 跳过: {e}\n")

    # Phase 1: Collect data per conflict (scraping)
    all_items = []  # flat list of all NEW items across conflicts
    conflict_items = {}  # conflict_id -> list of new items

    # Determine which conflicts to search based on intensity + day of week
    # war: every day, conflict: every 2 days, tension: every 3 days
    day_of_year = datetime.now().timetuple().tm_yday
    intensity_schedule = {"war": 1, "conflict": 2, "tension": 3}

    for i, (cid, config) in enumerate(CONFLICTS.items()):
        interval = intensity_schedule.get(config.get("intensity", "war"), 1)
        if day_of_year % interval != 0:
            print(f"[跳过] {config['name']} (intensity={config.get('intensity')}, 每{interval}天搜一次)")
            continue

        print(f"[采集] {config['name']} ({config['name_en']})...")
        items = collect_conflict(cid, config, seen_urls, date_filter)
        conflict_items[cid] = items
        all_items.extend(items)
        src_counts = {}
        for it in items:
            src_counts[it["source"]] = src_counts.get(it["source"], 0) + 1
        print(f"  -> {len(items)} 条新内容 ({', '.join(f'{s}:{n}' for s, n in src_counts.items()) if src_counts else '无新内容'})")
        # Rate limit between conflicts
        if i < len(CONFLICTS) - 1:
            time.sleep(2)

    print(f"\n共采集 {len(all_items)} 条\n")

    # Phase 2: Clean
    print("[清洗] 清洗源文件...")
    for item in all_items:
        lf = item.get("local_file")
        if lf:
            fp = DATA_DIR / lf
            if fp.exists():
                raw = fp.read_text(encoding='utf-8', errors='ignore')
                cleaned = clean_by_source(raw, item["source"])
                if len(cleaned) >= len(raw) * 0.1:
                    fp.write_text(cleaned, encoding='utf-8')

    # Phase 3: Quality check
    print("[质量] 质量检查...")
    qa_issues = []
    clean_items = []
    for item in all_items:
        lf = item.get("local_file")
        if not lf:
            continue
        fp = DATA_DIR / lf
        if not fp.exists():
            continue
        content = fp.read_text(encoding='utf-8', errors='ignore')
        qr = quality_check(content, item["source"])
        item["quality_score"] = qr["score"]
        if qr["verdict"] in ("JUNK", "INDEX"):
            qa_issues.append({
                "file": lf,
                "verdict": qr["verdict"],
                "score": qr["score"],
                "details": qr["details"],
            })
        else:
            clean_items.append(item)
    # Replace all_items with only clean ones
    rejected = len(all_items) - len(clean_items)
    all_items = clean_items
    # Also update conflict_items
    clean_urls = {item.get("url") for item in clean_items}
    for cid in conflict_items:
        conflict_items[cid] = [it for it in conflict_items[cid] if it.get("url") in clean_urls]
    if qa_issues:
        print(f"  {len(qa_issues)} 个文件被拒绝:")
        for issue in qa_issues:
            d = issue["details"]
            print(f"    [{issue['verdict']}] {issue['file']} "
                  f"(score={issue['score']}, noise={d['noise_hits']}, "
                  f"short_ratio={d['short_ratio']}, link_density={d['link_density']})")
        qa_report_path = DATA_DIR / "qa_report.json"
        with open(qa_report_path, "w", encoding="utf-8") as f:
            json.dump({"timestamp": datetime.now().isoformat(), "issues": qa_issues},
                      f, ensure_ascii=False, indent=2)
        print(f"  质量报告: {qa_report_path}")
    else:
        print("  所有文件质量正常")

    # Phase 4: Translate metadata
    print("[翻译] 翻译标题和摘要...")
    for i, item in enumerate(all_items):
        item["id"] = f"{item['source']}_{i}"
    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(translate_item, all_items))
    translated_count = sum(1 for item in all_items if item.get("title_en"))
    print(f"  翻译了 {translated_count} 条")

    # Phase 5: Translate full articles
    print("[翻译] 翻译全文...")
    translate_paths = []
    for item in all_items:
        lf = item.get("local_file")
        if lf:
            fp = DATA_DIR / lf
            if fp.exists():
                translate_paths.append(fp)
    if translate_paths:
        ok, fail = 0, 0
        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = {pool.submit(translate_file, fp): fp for fp in translate_paths}
            for future in as_completed(futures):
                try:
                    future.result()
                    ok += 1
                except Exception:
                    fail += 1
        print(f"  完成 ({ok} 成功, {fail} 失败)")
    else:
        print("  无需翻译")

    # Phase 6: Merge new items into existing data and build output
    print("[输出] 合并数据到 latest.json...")

    # Load existing data
    existing_conflicts = {}
    if existing_json.exists():
        try:
            with open(existing_json) as f:
                existing_conflicts = json.load(f).get("conflicts", {})
        except Exception:
            pass

    conflicts_output = {}
    total_items = 0

    for cid, config in CONFLICTS.items():
        categories = {
            "military": {"label": "军事动态", "icon": "⚔️", "items": []},
            "diplomacy": {"label": "外交谈判", "icon": "🕊️", "items": []},
            "opinion": {"label": "舆论热点", "icon": "💬", "items": []},
            "video": {"label": "视频报道", "icon": "📺", "items": []},
        }

        # Carry over existing items (drop items older than 30 days)
        cutoff_date = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
        existing_urls_in_conflict = set()
        expired_count = 0
        if cid in existing_conflicts:
            for cat_key, cat_data in existing_conflicts[cid].get("categories", {}).items():
                if cat_key in categories:
                    for item in cat_data.get("items", []):
                        item_date = item.get("date", "")
                        if item_date and item_date < cutoff_date:
                            expired_count += 1
                            continue  # drop old items
                        categories[cat_key]["items"].append(item)
                        if item.get("url"):
                            existing_urls_in_conflict.add(item["url"])

        # Add new items (skip if URL already in this conflict's categories)
        new_count = 0
        for item in conflict_items.get(cid, []):
            if item.get("url") in existing_urls_in_conflict:
                continue
            cat = classify_item(item.get("title", ""), item.get("summary", ""))
            if item["source"] == "youtube":
                cat = "video"
            categories[cat]["items"].append(item)
            new_count += 1

        item_count = sum(len(v["items"]) for v in categories.values())
        total_items += item_count

        conflicts_output[cid] = {
            "name": config["name"],
            "name_en": config["name_en"],
            "status": config["status"],
            "since": config["since"],
            "region": config.get("region", ""),
            "intensity": config.get("intensity", ""),
            "parties": config.get("parties", []),
            "related": config.get("related", []),
            "summary": existing_conflicts.get(cid, {}).get("summary", ""),
            "categories": categories,
        }
        if new_count or expired_count:
            parts = []
            if new_count:
                parts.append(f"+{new_count} 新")
            if expired_count:
                parts.append(f"-{expired_count} 过期")
            print(f"  {config['name']}: {', '.join(parts)}, 共 {item_count} 条")

    output = {
        "updated_at": datetime.now().isoformat() + "Z",
        "conflicts": conflicts_output,
        "stats": {
            "total_items": total_items,
            "sources": {},
            "date_range": {
                "from": (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d"),
                "to": datetime.now().strftime("%Y-%m-%d")
            }
        }
    }
    # Count sources across ALL items (existing + new)
    for conflict_data in conflicts_output.values():
        for cat in conflict_data["categories"].values():
            for item in cat["items"]:
                src = item.get("source", "unknown")
                output["stats"]["sources"][src] = output["stats"]["sources"].get(src, 0) + 1

    # Save
    output_path = DATA_DIR / "latest.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    # Archive
    archive_date = datetime.now().strftime("%Y-%m-%d")
    archive_path = ARCHIVE_DIR / archive_date
    archive_path.mkdir(parents=True, exist_ok=True)
    shutil.copy2(output_path, archive_path / "latest.json")

    # Run summary
    new_count = len(all_items)
    skip_count = sum(len(seen_urls) for _ in [1]) - new_count  # approximate
    summary_line = (f"{datetime.now().strftime('%Y-%m-%d %H:%M')} | "
                    f"new:{new_count} total:{total_items} "
                    f"sources:{','.join(f'{k}:{v}' for k,v in output['stats']['sources'].items())}")
    print(f"\n=== 采集完成 ===")
    print(f"  {summary_line}")
    print(f"  数据文件: {output_path}")
    print(f"  存档: {archive_path}")

    # Phase 7: Generate RSS feed
    print("[RSS] 生成 feed.xml...")
    try:
        from rss_feeds import generate_feed
        generate_feed()
    except Exception as e:
        print(f"  RSS 输出跳过: {e}")

    # Append to run log for monitoring
    run_log = DATA_DIR / "run_log.txt"
    with open(run_log, "a", encoding="utf-8") as f:
        f.write(summary_line + "\n")


def parse_tweet_date(date_str):
    """Parse tweet date to YYYY-MM-DD."""
    try:
        dt = datetime.strptime(date_str, "%a %b %d %H:%M:%S %z %Y")
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return datetime.now().strftime("%Y-%m-%d")


def extract_publish_date(url, content=""):
    """Try to extract the real publish date from URL patterns or content.
    Falls back to today's date if nothing found."""
    today = datetime.now().strftime("%Y-%m-%d")

    # 1. URL patterns: /2026/03/28/, /2026-03-28, etc.
    m = re.search(r'/(\d{4})[/-](\d{2})[/-](\d{2})', url)
    if m:
        try:
            dt = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            if datetime(2020, 1, 1) <= dt <= datetime.now() + timedelta(days=7):
                return dt.strftime("%Y-%m-%d")
        except ValueError:
            pass

    # 2. Content patterns: "March 31, 2026", "Mar 5, 2026", "2026-03-28"
    # ISO date
    m = re.search(r'(\d{4}-\d{2}-\d{2})', content[:2000])
    if m:
        try:
            dt = datetime.strptime(m.group(1), "%Y-%m-%d")
            if datetime(2020, 1, 1) <= dt <= datetime.now() + timedelta(days=7):
                return dt.strftime("%Y-%m-%d")
        except ValueError:
            pass

    # English date: "March 31, 2026" or "Mar 5, 2026"
    m = re.search(
        r'(?:January|February|March|April|May|June|July|August|September|October|November|December|'
        r'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})',
        content[:2000]
    )
    if m:
        try:
            date_str = m.group(0).replace(".", "").replace(",", "")
            for fmt in ["%B %d %Y", "%b %d %Y"]:
                try:
                    dt = datetime.strptime(date_str, fmt)
                    if datetime(2020, 1, 1) <= dt <= datetime.now() + timedelta(days=7):
                        return dt.strftime("%Y-%m-%d")
                except ValueError:
                    continue
        except Exception:
            pass

    return today


def extract_subreddit(url):
    """Extract subreddit name from Reddit URL."""
    m = re.search(r'/r/(\w+)', url)
    return f"r/{m.group(1)}" if m else "Reddit"


if __name__ == "__main__":
    collect()
