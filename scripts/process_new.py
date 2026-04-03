#!/usr/bin/env python3
"""处理已抓取但未入库的新文件：清洗 → 质量检查 → 翻译 → 合并到 latest.json"""

import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from collect import (
    CONFLICTS, DATA_DIR, clean_by_source, clean_markdown, quality_check,
    translate_item, translate_file, classify_item, extract_publish_date,
    extract_subreddit, parse_tweet_date,
)

SOURCES_DIR = DATA_DIR / "sources"


def find_new_files():
    """Find .md files not yet in latest.json."""
    existing_json = DATA_DIR / "latest.json"
    known_files = set()
    if existing_json.exists():
        data = json.load(open(existing_json))
        for conflict in data.get("conflicts", {}).values():
            for cat in conflict.get("categories", {}).values():
                for item in cat.get("items", []):
                    lf = item.get("local_file")
                    if lf:
                        known_files.add(lf)

    new_files = []
    for subdir in ["web", "x", "reddit", "youtube"]:
        d = SOURCES_DIR / subdir
        if not d.exists():
            continue
        for f in sorted(d.glob("*.md")):
            if f.name.endswith(".zh.md"):
                continue
            rel = str(f.relative_to(DATA_DIR))
            if rel not in known_files and f.stat().st_size > 100:
                new_files.append((subdir, rel, f))
    return new_files


def build_item(source_type, rel_path, filepath):
    """Build an item dict from a file."""
    content = filepath.read_text(encoding="utf-8", errors="ignore")
    url = ""
    # Try to extract URL from file content
    m = re.search(r'\*\*原始链接[：:]\*\*\s*(https?://\S+)', content)
    if m:
        url = m.group(1)
    else:
        # Reconstruct from filename
        name = filepath.stem
        if source_type == "x":
            parts = name.replace("x.com_", "").rsplit("_status_", 1)
            if len(parts) == 2:
                url = f"https://x.com/{parts[0]}/status/{parts[1]}"
        elif source_type == "reddit":
            url = "https://" + name.replace("_", "/")

    # Extract title from first heading
    title = ""
    for line in content.split("\n"):
        if line.startswith("# "):
            title = line[2:].strip()[:100]
            break
    if not title:
        title = filepath.stem[:80]

    summary = ""
    # Get first substantial paragraph as summary
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and not stripped.startswith("**") and not stripped.startswith("---") and len(stripped) > 30:
            summary = stripped[:200]
            break

    date = extract_publish_date(url, content[:2000])

    item = {
        "title": title,
        "summary": summary,
        "source": source_type,
        "source_label": url.split("/")[2] if url and "/" in url else source_type,
        "date": date,
        "url": url,
        "local_file": rel_path,
        "metrics": {},
    }

    if source_type == "x":
        item["source_label"] = f"@{filepath.stem.split('_status_')[0].replace('x.com_', '')}" if "_status_" in filepath.stem else "X"
    elif source_type == "reddit":
        item["source_label"] = extract_subreddit(url) if url else "Reddit"

    return item


def guess_conflict(item):
    """Guess which conflict an item belongs to based on keywords."""
    text = f"{item.get('title', '')} {item.get('summary', '')} {item.get('url', '')}".lower()

    keyword_map = {
        "russia-ukraine": ["ukraine", "russia", "kyiv", "moscow", "donetsk", "frontline", "drone strike ukraine"],
        "israel-palestine": ["israel", "palestine", "gaza", "hamas", "idf"],
        "us-iran": ["iran war", "us iran", "tehran", "persian gulf", "iran strike"],
        "sudan": ["sudan", "rsf", "khartoum", "darfur"],
        "myanmar": ["myanmar", "burma", "junta", "resistance"],
        "yemen-houthi": ["houthi", "yemen", "red sea"],
        "congo-drc": ["congo", "drc", "m23", "goma"],
        "syria": ["syria", "assad", "sdf", "isis syria"],
        "taiwan-strait": ["taiwan", "china military", "strait"],
    }

    best_match = "opinion"  # fallback: unclassified
    best_score = 0
    for cid, keywords in keyword_map.items():
        score = sum(1 for kw in keywords if kw in text)
        if score > best_score:
            best_score = score
            best_match = cid
    return best_match if best_score > 0 else None


def main():
    new_files = find_new_files()
    print(f"找到 {len(new_files)} 个新文件待处理\n")

    if not new_files:
        print("无新文件")
        return

    # 1. Clean
    print("[1/4] 清洗...")
    items = []
    for source_type, rel_path, filepath in new_files:
        raw = filepath.read_text(encoding="utf-8", errors="ignore")
        cleaned = clean_by_source(raw, source_type)
        cleaned = clean_markdown(cleaned)
        if len(cleaned) >= len(raw) * 0.1:
            filepath.write_text(cleaned, encoding="utf-8")
        item = build_item(source_type, rel_path, filepath)
        items.append(item)
    print(f"  {len(items)} 条")

    # 2. Quality check
    print("[2/4] 质量检查...")
    for item in items:
        fp = DATA_DIR / item["local_file"]
        if fp.exists():
            qr = quality_check(fp.read_text(encoding="utf-8", errors="ignore"), item["source"])
            item["quality_score"] = qr["score"]
            if qr["verdict"] != "CLEAN":
                print(f"  [{qr['verdict']}] {item['local_file']} (score={qr['score']})")

    # 3. Translate (parallel)
    print("[3/4] 翻译...")
    # Titles/summaries
    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(translate_item, items))

    # Full text
    translate_paths = []
    for item in items:
        fp = DATA_DIR / item["local_file"]
        zh = fp.with_suffix(".zh.md")
        if fp.exists() and (not zh.exists() or zh.stat().st_size < 200):
            translate_paths.append(fp)

    if translate_paths:
        print(f"  翻译 {len(translate_paths)} 篇全文...")
        ok = 0
        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = {pool.submit(translate_file, fp): fp for fp in translate_paths}
            for future in as_completed(futures):
                try:
                    future.result()
                    ok += 1
                except Exception:
                    pass
        print(f"  完成 ({ok}/{len(translate_paths)})")
    else:
        print("  全文已翻译")

    # 4. Merge into latest.json
    print("[4/4] 合并到 latest.json...")
    existing_json = DATA_DIR / "latest.json"
    data = json.load(open(existing_json))

    for i, item in enumerate(items):
        item["id"] = f"{item['source']}_new_{i}"
        cid = guess_conflict(item)
        if not cid or cid not in data["conflicts"]:
            continue
        cat = classify_item(item.get("title", ""), item.get("summary", ""))
        if item["source"] == "youtube":
            cat = "video"
        # Check not already present
        existing_urls = set()
        for c in data["conflicts"][cid]["categories"].values():
            for it in c.get("items", []):
                existing_urls.add(it.get("url", ""))
        if item.get("url") not in existing_urls:
            data["conflicts"][cid]["categories"][cat]["items"].append(item)
            print(f"  + [{cid}/{cat}] {item['title'][:60]}")

    data["updated_at"] = datetime.now().isoformat() + "Z"

    # Recount stats
    total = 0
    sources = {}
    for conflict in data["conflicts"].values():
        for cat in conflict["categories"].values():
            total += len(cat["items"])
            for it in cat["items"]:
                s = it.get("source", "unknown")
                sources[s] = sources.get(s, 0) + 1
    data["stats"] = {
        "total_items": total,
        "sources": sources,
        "date_range": {
            "from": (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d"),
            "to": datetime.now().strftime("%Y-%m-%d"),
        },
    }

    with open(existing_json, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"\n完成: {len(items)} 条新数据已合并, 总计 {total} 条")


if __name__ == "__main__":
    main()
