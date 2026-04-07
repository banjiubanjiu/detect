#!/usr/bin/env python3
"""
RSS 输入：从智库、媒体、Reddit 等 RSS 源采集冲突相关新闻
RSS 输出：为本站生成 feed.xml 供外部订阅

用法:
  python3 scripts/rss_feeds.py fetch    # 采集 RSS 源，合并到 latest.json
  python3 scripts/rss_feeds.py generate # 从 latest.json 生成 feed.xml
  python3 scripts/rss_feeds.py both     # 先采集再生成
"""

import json
import html
import os
import re
import sys
import hashlib
import feedparser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom.minidom import parseString

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
LATEST_JSON = DATA_DIR / "latest.json"
FEED_XML = PROJECT_ROOT / "web" / "feed.xml"

# ─── RSS 源配置 ───
# 每个源: (url, conflict_keys, categories)
# conflict_keys: 匹配到哪些冲突 (关键词列表)
# 一个源可以覆盖多个冲突，靠标题关键词匹配

RSS_SOURCES = [
    # ═══ T1 智库/机构 ═══
    {"url": "https://understandingwar.org/rss.xml", "name": "ISW", "tier": "t1"},
    {"url": "https://www.crisisgroup.org/feed", "name": "Crisis Group", "tier": "t1"},
    {"url": "https://www.brookings.edu/topic/defense-security/feed/", "name": "Brookings", "tier": "t1"},
    {"url": "https://www.csis.org/analysis/feed", "name": "CSIS", "tier": "t1"},
    {"url": "https://www.cfr.org/rss/publication", "name": "CFR", "tier": "t1"},
    {"url": "https://www.atlanticcouncil.org/feed/", "name": "Atlantic Council", "tier": "t1"},
    {"url": "https://www.rand.org/pubs.xml", "name": "RAND", "tier": "t1"},
    {"url": "https://www.hrw.org/rss/news", "name": "HRW", "tier": "t1"},
    {"url": "https://reliefweb.int/updates/rss.xml", "name": "ReliefWeb", "tier": "t1"},
    {"url": "https://news.un.org/feed/subscribe/en/news/topic/peace-and-security/feed/rss.xml", "name": "UN News", "tier": "t1"},
    # 新增 T1（经测试可用）
    {"url": "https://www.msf.org/rss/all", "name": "MSF", "tier": "t1"},

    # ═══ T2 西方主流媒体 ═══
    {"url": "https://feeds.bbci.co.uk/news/world/rss.xml", "name": "BBC World", "tier": "t2"},
    {"url": "https://www.theguardian.com/world/rss", "name": "The Guardian", "tier": "t2"},
    {"url": "https://feeds.npr.org/1004/rss.xml", "name": "NPR World", "tier": "t2"},
    {"url": "https://www.rferl.org/api/rss", "name": "RFE/RL", "tier": "t2"},
    {"url": "https://warontherocks.com/feed/", "name": "War on the Rocks", "tier": "t2"},
    {"url": "https://www.eurasiareview.com/feed/", "name": "Eurasia Review", "tier": "t2"},
    # 新增西方
    {"url": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", "name": "NYT World", "tier": "t2"},
    {"url": "https://feeds.washingtonpost.com/rss/world", "name": "Washington Post", "tier": "t2"},
    {"url": "https://www.france24.com/en/rss", "name": "France 24", "tier": "t2"},
    {"url": "https://rss.dw.com/xml/rss-en-world", "name": "DW", "tier": "t2"},
    {"url": "https://www.defenseone.com/rss/all/", "name": "Defense One", "tier": "t2"},
    {"url": "https://www.foreignpolicy.com/feed/", "name": "Foreign Policy", "tier": "t2"},

    # ═══ T2 阿拉伯/中东视角 ═══
    {"url": "https://www.aljazeera.com/xml/rss/all.xml", "name": "Al Jazeera", "tier": "t2"},
    {"url": "https://www.middleeasteye.net/rss", "name": "Middle East Eye", "tier": "t2"},
    # Al Arabiya, The National UAE — RSS blocked by server

    # ═══ T2 以色列视角 ═══
    {"url": "https://www.timesofisrael.com/feed/", "name": "Times of Israel", "tier": "t2"},
    {"url": "https://www.jpost.com/rss/rssfeedsfrontpage.aspx", "name": "Jerusalem Post", "tier": "t2"},

    # ═══ T2 俄方/独立俄媒 ═══
    {"url": "https://meduza.io/rss/en/all", "name": "Meduza", "tier": "t2"},
    {"url": "https://www.themoscowtimes.com/rss/news", "name": "Moscow Times", "tier": "t2"},

    # ═══ T2 乌克兰视角 ═══
    {"url": "https://english.nv.ua/rss/all.xml", "name": "NV Ukraine", "tier": "t2"},
    {"url": "https://www.ukrinform.net/rss/block-lastnews", "name": "Ukrinform", "tier": "t2"},

    # ═══ T2 亚太区域 ═══
    {"url": "https://www.irrawaddy.com/feed", "name": "The Irrawaddy", "tier": "t2"},
    # BenarNews — RSS blocked by server
    {"url": "https://thediplomat.com/feed/", "name": "The Diplomat", "tier": "t2"},
    {"url": "https://www.scmp.com/rss/91/feed", "name": "SCMP Asia", "tier": "t2"},

    # ═══ T2 非洲区域 ═══
    {"url": "https://www.dabangasudan.org/en/all-news/rss", "name": "Dabanga Sudan", "tier": "t2"},
    # The Africa Report — RSS blocked by server

    # ═══ T2 军事/OSINT 专业 ═══
    {"url": "https://www.thedrive.com/the-war-zone/feed", "name": "The War Zone", "tier": "t2"},
    {"url": "https://www.navalnews.com/feed/", "name": "Naval News", "tier": "t2"},
    {"url": "https://www.defensenews.com/arc/outboundfeeds/rss/", "name": "Defense News", "tier": "t2"},
]

# ─── 冲突关键词匹配 ───
# Note: 英文关键词用词边界 regex 匹配 (\b...s?\b)，所以必须显式列出形容词/国籍形式
# (ukrainian/russian/iranian 等) — 裸 "iran" 不会匹配 "iranian"，因为 i 后面是 word char。
# 中文关键词用子字符串匹配 (中文没有词边界概念)。
CONFLICT_KEYWORDS = {
    "russia-ukraine": [
        "ukraine", "ukrainian", "russia", "russian", "kyiv", "kremlin",
        "donbas", "crimea", "zelensky", "putin", "kharkiv", "zaporizhzhia",
        "drone strike russia",
        "乌克兰", "俄罗斯", "俄乌",
    ],
    "israel-palestine": [
        "israel", "israeli", "palestine", "palestinian", "gaza", "hamas",
        "netanyahu", "idf", "west bank", "hezbollah", "ceasefire gaza", "hostage",
        "以色列", "巴勒斯坦", "加沙", "哈马斯",
    ],
    "us-iran": [
        "iran", "iranian", "tehran", "irgc", "us iran", "persian gulf",
        "hormuz", "strait of hormuz", "nuclear iran", "sanctions iran",
        "伊朗", "美伊",
    ],
    "sudan": [
        "sudan", "sudanese", "khartoum", "rsf", "rapid support", "darfur",
        "苏丹",
    ],
    "myanmar": [
        "myanmar", "burma", "burmese", "junta", "rohingya", "nug myanmar",
        "tatmadaw",
        "缅甸",
    ],
    "yemen-houthi": [
        "yemen", "yemeni", "houthi", "red sea", "aden", "ansar allah",
        "也门", "胡塞",
    ],
    "congo-drc": [
        "congo", "congolese", "drc", "m23", "goma", "kivu", "monusco",
        "刚果",
    ],
    "syria": [
        "syria", "syrian", "damascus", "kurdish sdf", "isis syria", "idlib",
        "aleppo",
        "叙利亚",
    ],
    "taiwan-strait": [
        "taiwan", "taiwanese", "taipei", "china taiwan", "pla",
        "south china sea", "taiwan strait",
        "台湾", "台海",
    ],
}


def _has_chinese(s):
    """Check if string contains any CJK character."""
    return any('\u4e00' <= c <= '\u9fff' for c in s)


def match_conflict(title, summary=""):
    """Match text to conflict(s) by keywords. Returns list of conflict IDs.

    Matching rules:
    - English keywords: word-boundary regex \b...s?\b to avoid substring
      false positives (e.g., "pla" in "places", "frontline" in "frontlines")
      with optional plural suffix support.
    - Chinese keywords: substring match (no word boundaries in CJK).
    """
    text = f"{title} {summary}".lower()
    matches = []
    for cid, keywords in CONFLICT_KEYWORDS.items():
        for kw in keywords:
            kw_lower = kw.lower()
            if _has_chinese(kw_lower):
                hit = kw_lower in text
            else:
                hit = bool(re.search(r'\b' + re.escape(kw_lower) + r's?\b', text))
            if hit:
                matches.append(cid)
                break
    return matches


def make_id(url):
    """Generate a stable ID from URL."""
    return "rss_" + hashlib.md5(url.encode()).hexdigest()[:12]


def parse_date(entry):
    """Extract date from RSS entry."""
    for field in ("published_parsed", "updated_parsed"):
        t = entry.get(field)
        if t:
            try:
                return datetime(*t[:6]).strftime("%Y-%m-%d")
            except Exception:
                pass
    return datetime.now().strftime("%Y-%m-%d")


def get_domain(url):
    return re.sub(r'^(?:https?://)?(?:www\.)?([^/]+).*', r'\1', url)


def clean_html_text(text):
    """Strip HTML tags, decode entities, collapse whitespace."""
    text = re.sub(r'<[^>]+>', '', text)
    text = html.unescape(text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def clean_reddit_summary(summary):
    """Reddit RSS summaries are boilerplate — strip them."""
    # Pattern: "submitted by /u/xxx [link] [comments]"
    if re.search(r'submitted by|/u/|\[link\]|\[comments\]', summary):
        return ""
    return summary


def _import_collect():
    """Import functions from collect.py."""
    sys.path.insert(0, str(Path(__file__).parent))
    import collect
    return collect


def fetch_full_articles(items):
    """Fetch full article content for RSS items using smart_scrape (parallel)."""
    try:
        collect = _import_collect()
    except Exception as e:
        print(f"  [抓取] 无法导入 collect 模块: {e}")
        return

    # Deduplicate by URL — same article matched to multiple conflicts shares one fetch
    seen_urls = {}
    to_fetch = []
    for i, (cid, cat, it) in enumerate(items):
        url = it.get("url")
        if not url or it.get("local_file"):
            continue
        if url in seen_urls:
            continue
        seen_urls[url] = it
        to_fetch.append((url, it))

    if not to_fetch:
        return

    print(f"  [抓取] 并行抓取 {len(to_fetch)} 篇全文...", end=" ", flush=True)

    def do_fetch(entry):
        url, item = entry
        try:
            local = collect.smart_scrape(url, "web")
            if local:
                item["local_file"] = local
                return True
        except Exception:
            pass
        return False

    fetched = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(do_fetch, to_fetch))
        fetched = sum(1 for r in results if r)

    # Propagate local_file to other items sharing the same URL
    for cid, cat, it in items:
        url = it.get("url")
        if url and url in seen_urls and not it.get("local_file"):
            shared = seen_urls[url]
            if shared.get("local_file"):
                it["local_file"] = shared["local_file"]

    print(f"{fetched} 成功")


def translate_rss_items(items):
    """Translate RSS item titles and summaries to Chinese.

    去重策略: 同一 URL 在多个冲突分类中的副本只翻译一次，然后将结果传播到所有副本。
    """
    try:
        collect = _import_collect()
        translate_fn = collect.translate_text
    except Exception:
        print("  [翻译] 无法导入翻译模块，跳过")
        return

    # 按 URL 去重: 每个唯一 URL 只翻译一次
    unique = {}  # url -> item (representative)
    for cid, cat, it in items:
        if not it.get("title") or re.search(r'[\u4e00-\u9fff]', it["title"]):
            continue
        url = it.get("url") or it.get("title")  # 兜底用标题做 key
        if url not in unique:
            unique[url] = it

    if not unique:
        return

    print(f"  [翻译] 翻译 {len(unique)} 条标题+摘要 (去重后)...", end=" ", flush=True)

    def do_translate(it):
        try:
            translated = translate_fn(it["title"], max_chars=200)
            if translated and translated != it["title"]:
                it["title_en"] = it["title"]
                it["title"] = translated
            summary = it.get("summary", "")
            if summary and not re.search(r'[\u4e00-\u9fff]', summary):
                translated_s = translate_fn(summary, max_chars=500)
                if translated_s and translated_s != summary:
                    it["summary_en"] = summary
                    it["summary"] = translated_s
        except Exception:
            pass
        return it

    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(do_translate, unique.values()))

    # 传播翻译结果到同 URL 的其他副本
    for cid, cat, it in items:
        url = it.get("url") or it.get("title")
        if url in unique and unique[url] is not it:
            src = unique[url]
            for k in ("title", "title_en", "summary", "summary_en"):
                if k in src:
                    it[k] = src[k]

    done = sum(1 for it in unique.values() if it.get("title_en"))
    print(f"{done} 完成")


def translate_full_articles(items):
    """Translate full article .md files to Chinese.

    去重策略: 同一文件路径只翻译一次（使用 set 去重，避免并发写同一文件）。
    """
    try:
        collect = _import_collect()
        translate_file_fn = collect.translate_file
    except Exception:
        print("  [翻译全文] 无法导入翻译模块，跳过")
        return

    # 按 fp 路径去重
    unique_fps = set()
    for cid, cat, it in items:
        lf = it.get("local_file")
        if lf:
            fp = DATA_DIR / lf
            zh_path = fp.with_suffix(".zh.md")
            if fp.exists() and not zh_path.exists():
                unique_fps.add(fp)

    if not unique_fps:
        return

    print(f"  [翻译全文] 翻译 {len(unique_fps)} 篇文章 (去重后)...", end=" ", flush=True)
    ok = 0
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(translate_file_fn, fp): fp for fp in unique_fps}
        for future in futures:
            try:
                future.result()
                ok += 1
            except Exception:
                pass
    print(f"{ok} 完成")


# ═══════════════════════════════════════
#  RSS 输入: 从 RSS 源采集
# ═══════════════════════════════════════

def fetch_rss():
    """Fetch all RSS sources, match to conflicts, return new items."""
    # Load existing IDs to avoid duplicates
    existing_ids = set()
    existing_urls = set()
    if LATEST_JSON.exists():
        with open(LATEST_JSON) as f:
            data = json.load(f)
        for c in data.get("conflicts", {}).values():
            for cat in c.get("categories", {}).values():
                for it in cat.get("items", []):
                    existing_ids.add(it.get("id", ""))
                    existing_urls.add(it.get("url", ""))

    new_items = []  # (conflict_id, category, item_dict)
    total_fetched = 0
    total_matched = 0

    for src in RSS_SOURCES:
        url = src["url"]
        name = src["name"]
        tier = src["tier"]
        print(f"  [{name}] fetching...", end=" ", flush=True)

        try:
            feed = feedparser.parse(url)
            entries = feed.entries[:30]  # Max 30 per source
            print(f"{len(entries)} entries", end="")
        except Exception as e:
            print(f"ERROR: {e}")
            continue

        matched = 0
        for entry in entries:
            entry_url = entry.get("link", "")
            entry_id = make_id(entry_url)

            # Skip duplicates
            if entry_id in existing_ids or entry_url in existing_urls:
                continue

            title = clean_html_text(entry.get("title", ""))
            summary = clean_html_text(entry.get("summary", ""))

            # Drop summaries that are garbage
            if summary and (len(summary) < 15 or summary.startswith("Click to expand")):
                summary = ""

            summary = summary[:300]

            if not title:
                continue

            # Match to conflicts
            conflicts = match_conflict(title, summary)
            if not conflicts:
                continue

            date = parse_date(entry)

            # Guess category from keywords
            cat = guess_category(title, summary)

            item = {
                "id": entry_id,
                "title": title,
                "summary": summary if summary else title,
                "source": "web",
                "source_label": name,
                "date": date,
                "url": entry_url,
                "rss_source": name,
            }

            for cid in conflicts:
                new_items.append((cid, cat, item.copy()))
                matched += 1

            existing_ids.add(entry_id)
            existing_urls.add(entry_url)

        total_fetched += len(entries)
        total_matched += matched
        print(f", {matched} matched")

    print(f"\n  Total: {total_fetched} fetched, {total_matched} matched to conflicts")

    if new_items:
        # 1. Fetch full article content
        fetch_full_articles(new_items)
        # 2. Translate titles + summaries (fast, ~1-3 sec each)
        translate_rss_items(new_items)
        # 注: 全文翻译已迁移到 translate.yml workflow，独立运行避免阻塞采集
        # 旧代码: translate_full_articles(new_items)

    return new_items


def guess_category(title, summary=""):
    """Guess category from text content."""
    text = f"{title} {summary}".lower()

    diplomatic_kw = ["ceasefire", "negotiate", "diplomat", "sanction", "treaty",
                      "peace talk", "un security", "foreign minister", "summit",
                      "停火", "谈判", "外交", "制裁"]
    humanitarian_kw = ["humanitarian", "refugee", "civilian", "aid", "displaced",
                       "famine", "crisis", "unhcr", "red cross", "casualt",
                       "人道", "难民", "平民", "援助"]
    opinion_kw = ["analysis", "opinion", "commentary", "expert", "perspective",
                  "assessment", "forecast", "outlook", "评论", "分析"]

    for kw in diplomatic_kw:
        if kw in text:
            return "diplomatic"
    for kw in humanitarian_kw:
        if kw in text:
            return "humanitarian"
    for kw in opinion_kw:
        if kw in text:
            return "opinion"
    return "military"


def merge_rss_items(new_items):
    """Merge new RSS items into latest.json."""
    if not new_items:
        print("  No new items to merge.")
        return 0

    with open(LATEST_JSON) as f:
        data = json.load(f)

    added = 0
    for cid, cat, item in new_items:
        if cid not in data["conflicts"]:
            continue
        cats = data["conflicts"][cid]["categories"]
        if cat not in cats:
            cats[cat] = {"label": {"military": "军事动态", "diplomatic": "外交动态",
                                    "humanitarian": "人道危机", "opinion": "评论分析"}.get(cat, cat),
                         "items": []}

        # Check no duplicate
        existing = {it["id"] for it in cats[cat]["items"]}
        if item["id"] not in existing:
            cats[cat]["items"].append(item)
            added += 1

    if added > 0:
        # Sort items by date within each category
        for c in data["conflicts"].values():
            for cat in c["categories"].values():
                cat["items"].sort(key=lambda x: x.get("date", ""), reverse=True)

        data["updated_at"] = datetime.now(timezone.utc).isoformat()
        with open(LATEST_JSON, "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"  Merged {added} new items into latest.json")
    return added


# ═══════════════════════════════════════
#  RSS 输出: 生成 feed.xml
# ═══════════════════════════════════════

def generate_feed(site_url="https://detect.example.com"):
    """Generate RSS 2.0 feed from latest.json."""
    with open(LATEST_JSON) as f:
        data = json.load(f)

    rss = Element("rss", version="2.0")
    rss.set("xmlns:atom", "http://www.w3.org/2005/Atom")
    channel = SubElement(rss, "channel")

    SubElement(channel, "title").text = "战况追踪 — Global Conflict Monitor"
    SubElement(channel, "link").text = site_url
    SubElement(channel, "description").text = "实时追踪全球主要冲突态势，多源聚合情报"
    SubElement(channel, "language").text = "zh-CN"
    SubElement(channel, "lastBuildDate").text = datetime.now(timezone.utc).strftime(
        "%a, %d %b %Y %H:%M:%S +0000"
    )

    atom_link = SubElement(channel, "atom:link")
    atom_link.set("href", f"{site_url}/feed.xml")
    atom_link.set("rel", "self")
    atom_link.set("type", "application/rss+xml")

    # Collect all items, sort by date, take latest 50
    all_items = []
    for cid, c in data["conflicts"].items():
        for cat_key, cat in c["categories"].items():
            for it in cat["items"]:
                all_items.append({**it, "_conflict": cid, "_cname": c["name"],
                                  "_cat": cat.get("label", cat_key)})

    all_items.sort(key=lambda x: x.get("date", ""), reverse=True)

    for it in all_items[:50]:
        item = SubElement(channel, "item")
        SubElement(item, "title").text = f"[{it['_cname']}] {it.get('title', '')}"
        SubElement(item, "link").text = it.get("url", "")
        SubElement(item, "description").text = it.get("summary", it.get("title", ""))

        guid = SubElement(item, "guid")
        guid.text = it.get("url", it.get("id", ""))
        guid.set("isPermaLink", "true" if it.get("url", "").startswith("http") else "false")

        if it.get("date"):
            try:
                dt = datetime.strptime(it["date"], "%Y-%m-%d")
                SubElement(item, "pubDate").text = dt.strftime("%a, %d %b %Y 00:00:00 +0000")
            except ValueError:
                pass

        SubElement(item, "category").text = it["_cname"]
        SubElement(item, "category").text = it["_cat"]
        src = SubElement(item, "source")
        src.text = it.get("source_label", it.get("rss_source", ""))
        src.set("url", it.get("url", ""))

    xml_str = tostring(rss, encoding="unicode")
    pretty = parseString(xml_str).toprettyxml(indent="  ", encoding="utf-8")

    FEED_XML.parent.mkdir(parents=True, exist_ok=True)
    FEED_XML.write_bytes(pretty)
    print(f"  Generated {FEED_XML} ({len(all_items[:50])} items)")


# ═══════════════════════════════════════
#  CLI
# ═══════════════════════════════════════

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "both"

    if cmd in ("fetch", "both"):
        print("═══ RSS 输入: 采集 RSS 源 ═══")
        items = fetch_rss()
        merge_rss_items(items)

    if cmd in ("generate", "gen", "both"):
        print("\n═══ RSS 输出: 生成 feed.xml ═══")
        generate_feed()

    print("\nDone.")


if __name__ == "__main__":
    main()
