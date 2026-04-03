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
    """Translate title and summary of an item if they are in English."""
    title = item.get("title", "")
    summary = item.get("summary", "")

    # Check if title is English (>3 chars, less than 20% Chinese)
    cn_in_title = len(re.findall(r'[\u4e00-\u9fff]', title))
    if title and cn_in_title < len(title) * 0.2 and len(title) > 3 and not item.get("title_en"):
        translated_title = translate_text(title, max_chars=200)
        if translated_title != title:
            item["title_en"] = title
            item["title"] = translated_title

    # Check if summary is English (>10 chars, less than 20% Chinese)
    cn_in_summary = len(re.findall(r'[\u4e00-\u9fff]', summary))
    if summary and cn_in_summary < len(summary) * 0.2 and len(summary) > 10 and not item.get("summary_en"):
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

    elif source_type == "web":
        web_noise = [
            r'^#{1,3}\s*(?:Primary Menu|Main menu|Footer|Sidebar|Navigation|Breadcrumb).*$',
            r'^#{1,3}\s*(?:.*submenu).*$',
            r'^\*\s*\[(?:Analysis|Programs|Experts|Regions|Topics|Events|Podcasts|Newsletters|All \w+)\]\(.*\)\s*$',
            r'^\*\s*\[(?:Home|About|Contact|Privacy|Terms|Careers|Advertise|Help)\]\(.*\)\s*$',
            r'^(?:open|close)\s*$',
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


def fetch_via_trafilatura(url, out_dir):
    """Extract article body using Trafilatura (best quality, primary method for web)."""
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
        content = tf_extract(html, output_format='markdown', with_metadata=False, include_images=True)
        if not content or len(content) < 200:
            return None
        with open(md_path, 'w', encoding='utf-8') as f:
            f.write(f"**原始链接：** {url}\n\n---\n\n{content}")
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


def collect():
    """Main collection pipeline."""
    print(f"=== 数据采集开始 {datetime.now().isoformat()} ===\n")

    # Ensure directories
    for d in ["reddit", "x", "web", "youtube"]:
        (SOURCES_DIR / d).mkdir(parents=True, exist_ok=True)

    all_items = []

    # 1. Web search
    print("[1/4] 网页搜索...")
    for query in SEARCH_QUERIES[:2]:
        results = run_xcrawl_search(query, limit=5)
        web_urls = [r["url"] for r in results
                    if not any(s in r["url"] for s in ["x.com", "youtube.com", "reddit.com"])]
        if web_urls:
            run_xcrawl_scrape(web_urls[:3], SOURCES_DIR / "web")
            for r in results:
                if r["url"] in web_urls[:3]:
                    # Find the scraped file
                    safe_name = r["url"].replace("https://", "").replace("http://", "").replace("/", "_")[:100]
                    local_files = list((SOURCES_DIR / "web").glob(f"*{safe_name[:50]}*"))
                    local_file = None
                    if local_files:
                        for lf in local_files:
                            if lf.suffix == ".json":
                                json_to_md(lf)
                            if lf.suffix == ".md":
                                local_file = str(lf.relative_to(DATA_DIR))
                    all_items.append({
                        "title": r.get("title", ""),
                        "summary": r.get("snippet", ""),
                        "source": "web",
                        "source_label": r["url"].split("/")[2],
                        "date": datetime.now().strftime("%Y-%m-%d"),
                        "url": r["url"],
                        "local_file": local_file,
                        "metrics": {}
                    })
    print(f"  找到 {len([i for i in all_items if i['source']=='web'])} 条网页")

    # 2. X/Twitter search
    print("[2/4] X/Twitter 搜索...")
    x_results = run_xcrawl_search(TOPIC, site="x.com", limit=10)
    x_count = 0
    for r in x_results:
        user, tid = extract_tweet_id(r["url"])
        if not user or not tid:
            continue
        tweet = fetch_tweet(user, tid)
        if not tweet:
            continue
        local_file = save_tweet_md(tweet, user, tid, SOURCES_DIR / "x")
        author = tweet.get("author", {})
        all_items.append({
            "title": r.get("title", tweet.get("text", "")[:80]),
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
        x_count += 1
    print(f"  找到 {x_count} 条推文")

    # 3. Reddit search
    print("[3/4] Reddit 搜索...")
    reddit_results = run_xcrawl_search(TOPIC, site="reddit.com", limit=10)
    reddit_urls = [r["url"] for r in reddit_results]
    if reddit_urls:
        run_xcrawl_scrape(reddit_urls[:8], SOURCES_DIR / "reddit")
    for r in reddit_results[:8]:
        safe = r["url"].replace("https://", "").replace("/", "_")[:80]
        local_files = list((SOURCES_DIR / "reddit").glob(f"*"))
        local_file = None
        for lf in local_files:
            if lf.suffix == ".json":
                json_to_md(lf)
            if lf.suffix == ".md" and safe[:30] in str(lf):
                local_file = str(lf.relative_to(DATA_DIR))
        all_items.append({
            "title": r.get("title", ""),
            "summary": r.get("snippet", ""),
            "source": "reddit",
            "source_label": extract_subreddit(r["url"]),
            "date": datetime.now().strftime("%Y-%m-%d"),
            "url": r["url"],
            "local_file": local_file,
            "metrics": {}
        })
    print(f"  找到 {len(reddit_results[:8])} 条帖子")

    # 4. YouTube search
    print("[4/4] YouTube 搜索...")
    yt_results = run_xcrawl_search(TOPIC + " 2026", site="youtube.com", limit=6)
    yt_count = 0
    for r in yt_results:
        vid = extract_youtube_id(r["url"])
        if not vid:
            continue
        local_file = fetch_youtube_subtitle(vid, SOURCES_DIR / "youtube")
        if not local_file:
            continue  # Skip videos without subtitles — no readable content
        all_items.append({
            "title": r.get("title", ""),
            "summary": r.get("snippet", ""),
            "source": "youtube",
            "source_label": "YouTube",
            "date": datetime.now().strftime("%Y-%m-%d"),
            "url": r["url"],
            "local_file": local_file,
            "metrics": {}
        })
        yt_count += 1
    print(f"  找到 {yt_count} 条视频（仅含有字幕的）")

    # Classify and build categories
    categories = {
        "military": {"label": "军事动态", "icon": "⚔️", "items": []},
        "diplomacy": {"label": "外交谈判", "icon": "🕊️", "items": []},
        "opinion": {"label": "舆论热点", "icon": "💬", "items": []},
        "video": {"label": "视频报道", "icon": "📺", "items": []},
    }

    # Clean, translate, classify
    print("[5/6] 清洗源文件...")
    for item in all_items:
        lf = item.get("local_file")
        if lf:
            fp = DATA_DIR / lf
            if fp.exists():
                raw = fp.read_text(encoding='utf-8', errors='ignore')
                cleaned = clean_by_source(raw, item["source"])
                if len(cleaned) >= len(raw) * 0.1:  # over-cleaning protection
                    fp.write_text(cleaned, encoding='utf-8')

    print("[6/7] 翻译标题和摘要...")
    translated_count = 0
    for i, item in enumerate(all_items):
        item["id"] = f"{item['source']}_{i}"
        translate_item(item)
        if item.get("title_en"):
            translated_count += 1
        cat = classify_item(item["title"], item["summary"])
        if item["source"] == "youtube":
            cat = "video"
        categories[cat]["items"].append(item)
    print(f"  翻译了 {translated_count} 条")

    # Translate full articles
    print("[7/7] 翻译全文...")
    for item in all_items:
        lf = item.get("local_file")
        if lf:
            fp = DATA_DIR / lf
            if fp.exists():
                translate_file(fp)
    print("  完成")

    # Build summary
    counts = {k: len(v["items"]) for k, v in categories.items()}
    source_counts = {}
    for item in all_items:
        source_counts[item["source"]] = source_counts.get(item["source"], 0) + 1

    output = {
        "updated_at": datetime.now().isoformat() + "Z",
        "summary": f"本次采集共获取 {len(all_items)} 条信息：军事动态 {counts['military']} 条，外交谈判 {counts['diplomacy']} 条，舆论热点 {counts['opinion']} 条，视频报道 {counts['video']} 条。数据来源覆盖 Reddit、X/Twitter、YouTube 和权威网页。",
        "categories": categories,
        "stats": {
            "total_items": len(all_items),
            "sources": source_counts,
            "date_range": {
                "from": (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d"),
                "to": datetime.now().strftime("%Y-%m-%d")
            }
        }
    }

    # Save
    output_path = DATA_DIR / "latest.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    # Archive
    archive_date = datetime.now().strftime("%Y-%m-%d")
    archive_path = ARCHIVE_DIR / archive_date
    archive_path.mkdir(parents=True, exist_ok=True)
    shutil.copy2(output_path, archive_path / "latest.json")

    print(f"\n=== 采集完成 ===")
    print(f"  总条目: {len(all_items)}")
    print(f"  数据文件: {output_path}")
    print(f"  存档: {archive_path}")


def parse_tweet_date(date_str):
    """Parse tweet date to YYYY-MM-DD."""
    try:
        dt = datetime.strptime(date_str, "%a %b %d %H:%M:%S %z %Y")
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return datetime.now().strftime("%Y-%m-%d")


def extract_subreddit(url):
    """Extract subreddit name from Reddit URL."""
    m = re.search(r'/r/(\w+)', url)
    return f"r/{m.group(1)}" if m else "Reddit"


if __name__ == "__main__":
    collect()
