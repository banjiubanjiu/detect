#!/usr/bin/env python3
"""
GDELT 集成：从 GDELT 全球事件数据库获取冲突事件，合并到 latest.json

用法:
  python3 scripts/gdelt_feed.py           # 获取昨天+今天的事件
  python3 scripts/gdelt_feed.py 3         # 获取最近3天的事件

GDELT CAMEO 编码参考:
  14x = 抗议   17x = 胁迫   18x = 袭击
  19x = 常规军事行动   20x = 非常规大规模暴力
"""

import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

try:
    import gdelt
    import pandas as pd
except ImportError:
    print("需要安装: pip install gdelt pandas")
    sys.exit(1)

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
LATEST_JSON = DATA_DIR / "latest.json"
CRED_FILE = DATA_DIR / "source_credibility.json"

# ── 冲突 → GDELT 过滤条件 ──
# country_codes: Actor1/Actor2/ActionGeo 的国家代码
# geo_names: ActionGeo_FullName 中的关键词（补充过滤）
CONFLICT_FILTERS = {
    "russia-ukraine": {
        "country_codes": ["RUS", "UKR"],
        "geo_names": ["ukraine", "russia", "donetsk", "luhansk", "zaporizhzhia", "kherson", "crimea", "kursk"],
        "require_both": False,  # 只要一方匹配即可
    },
    "israel-palestine": {
        "country_codes": ["ISR", "PSE"],
        "geo_names": ["gaza", "west bank", "israel", "palestine", "lebanon", "hezbollah"],
        "require_both": False,
    },
    "us-iran": {
        "country_codes": ["IRN"],  # 只用伊朗代码，避免所有美国国内事件
        "geo_names": ["iran", "tehran", "persian gulf", "strait of hormuz"],
        "require_both": False,
    },
    "sudan": {
        "country_codes": ["SDN", "SSD"],
        "geo_names": ["sudan", "khartoum", "darfur"],
        "require_both": False,
    },
    "myanmar": {
        "country_codes": ["MMR"],
        "geo_names": ["myanmar", "burma", "naypyidaw", "yangon", "mandalay"],
        "require_both": False,
    },
    "yemen-houthi": {
        "country_codes": ["YEM"],
        "geo_names": ["yemen", "houthi", "red sea", "sanaa", "aden"],
        "require_both": False,
    },
    "congo-drc": {
        "country_codes": ["COD"],
        "geo_names": ["congo", "goma", "kinshasa", "north kivu"],
        "require_both": False,
    },
    "syria": {
        "country_codes": ["SYR"],
        "geo_names": ["syria", "damascus", "aleppo", "idlib"],
        "require_both": False,
    },
    "taiwan-strait": {
        "country_codes": ["TWN"],  # 只用台湾代码，避免所有中国国内事件
        "geo_names": ["taiwan", "taipei", "strait"],
        "require_both": False,
    },
}

# 高冲突 CAMEO 事件代码前缀
# 14=抗议 17=胁迫 18=袭击 19=常规军事 20=非常规暴力
CONFLICT_CODES = re.compile(r'^(14|17|18|19|20)')

# GoldsteinScale 阈值（越负=越冲突，-10最严重）
MIN_GOLDSTEIN = -3.0  # 只保留负面事件


def fetch_gdelt_events(days=2):
    """获取最近 N 天的 GDELT 事件数据。"""
    gd = gdelt.gdelt(version=2)

    # gdelt library needs dates oldest-first for range, or single date
    # Fetch each day individually and concatenate to avoid date ordering issues
    frames = []
    for i in range(1, days + 1):  # start from 1 (yesterday) since today may not be ready
        d = datetime.now() - timedelta(days=i)
        date_str = d.strftime("%Y %b %d")
        try:
            df = gd.Search([date_str], table='events', coverage=False)
            frames.append(df)
            print(f"[GDELT] {date_str}: {len(df)} 事件")
        except Exception as e:
            print(f"[GDELT] {date_str} 失败: {e}")

    if not frames:
        return pd.DataFrame()

    result = pd.concat(frames, ignore_index=True)
    print(f"[GDELT] 总计原始事件数: {len(result)}")
    return result


def filter_conflict_events(df):
    """按冲突分类过滤 GDELT 事件，返回 {conflict_id: [events]}。"""
    if df.empty:
        return {}

    # 只保留冲突相关的 CAMEO 代码
    mask_code = df['EventCode'].astype(str).apply(lambda x: bool(CONFLICT_CODES.match(x)))
    # 只保留负面事件
    mask_tone = df['GoldsteinScale'].astype(float) <= MIN_GOLDSTEIN
    df_conflict = df[mask_code & mask_tone].copy()
    print(f"[GDELT] 冲突事件数 (CAMEO 14-20, GS<={MIN_GOLDSTEIN}): {len(df_conflict)}")

    results = {}
    for cid, filt in CONFLICT_FILTERS.items():
        codes = set(filt["country_codes"])
        geo_kw = [kw.lower() for kw in filt.get("geo_names", [])]

        # 国家代码匹配
        mask_country = (
            df_conflict['Actor1CountryCode'].isin(codes) |
            df_conflict['Actor2CountryCode'].isin(codes) |
            df_conflict['ActionGeo_CountryCode'].isin(codes)
        )

        # 地理名称匹配（补充）
        geo_full = df_conflict['ActionGeo_FullName'].fillna('').str.lower()
        mask_geo = geo_full.apply(lambda g: any(kw in g for kw in geo_kw))

        matched = df_conflict[mask_country | mask_geo]

        if len(matched) > 0:
            # 按 NumMentions 降序排序，取 top 事件
            matched = matched.sort_values('NumMentions', ascending=False)
            results[cid] = matched
            print(f"  {cid}: {len(matched)} 事件")

    return results


def event_to_item(row, conflict_id):
    """将一条 GDELT 事件转换为 latest.json 的 item 格式。"""
    actor1 = str(row.get('Actor1Name', '') or '').strip()
    actor2 = str(row.get('Actor2Name', '') or '').strip()
    desc = str(row.get('CAMEOCodeDescription', '') or '').strip()
    geo = str(row.get('ActionGeo_FullName', '') or '').strip()
    gs = float(row.get('GoldsteinScale', 0))
    url = str(row.get('SOURCEURL', '') or '').strip()
    mentions = int(row.get('NumMentions', 0))
    num_sources = int(row.get('NumSources', 0))
    num_articles = int(row.get('NumArticles', 0))

    # 构建标题
    parts = []
    if actor1:
        parts.append(actor1)
    if actor2:
        parts.append(f"→ {actor2}")
    if desc:
        parts.append(f": {desc}")
    if geo:
        parts.append(f"({geo})")
    title_en = ' '.join(parts) if parts else desc or 'GDELT Event'

    # 日期
    date_str = str(row.get('SQLDATE', ''))
    if len(date_str) == 8:
        date = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    else:
        date = datetime.now().strftime("%Y-%m-%d")

    # 提取域名作为 source_label
    domain = ''
    if url:
        m = re.match(r'https?://(?:www\.)?([^/]+)', url)
        if m:
            domain = m.group(1)

    # 事件代码用于分类
    event_code = str(row.get('EventCode', ''))

    item = {
        "id": f"gdelt_{row.get('GLOBALEVENTID', '')}",
        "title": title_en,  # 后续翻译
        "title_en": title_en,
        "summary": f"GDELT Event: {desc}. Actors: {actor1 or '?'} / {actor2 or '?'}. Location: {geo}. Goldstein Scale: {gs}. Mentioned in {mentions} sources.",
        "summary_en": f"GDELT Event: {desc}. Actors: {actor1 or '?'} / {actor2 or '?'}. Location: {geo}. Goldstein Scale: {gs}. Mentioned in {mentions} sources.",
        "source": "gdelt",
        "source_label": domain or "GDELT",
        "date": date,
        "url": url,
        "metrics": {
            "mentions": mentions,
            "sources": num_sources,
            "articles": num_articles,
            "goldstein": gs,
        },
        "gdelt_meta": {
            "event_id": str(row.get('GLOBALEVENTID', '')),
            "event_code": event_code,
            "cameo_desc": desc,
            "actor1": actor1,
            "actor2": actor2,
            "actor1_country": str(row.get('Actor1CountryCode', '') or ''),
            "actor2_country": str(row.get('Actor2CountryCode', '') or ''),
            "geo_lat": float(row.get('ActionGeo_Lat', 0) or 0),
            "geo_lon": float(row.get('ActionGeo_Long', 0) or 0),
            "geo_name": geo,
        },
    }

    return item


def classify_gdelt_event(event_code):
    """根据 CAMEO 代码分类到我们的 category。"""
    code = str(event_code)
    if code.startswith('19') or code.startswith('20'):
        return 'military'
    if code.startswith('18'):
        return 'military'
    if code.startswith('14'):
        return 'opinion'  # 抗议归入观点
    if code.startswith('17'):
        return 'diplomacy'  # 胁迫归入外交
    return 'military'


def merge_to_latest(conflict_events, max_per_conflict=10):
    """将 GDELT 事件合并到 latest.json。"""
    if not LATEST_JSON.exists():
        print("[GDELT] latest.json 不存在，跳过")
        return

    data = json.load(open(LATEST_JSON, encoding='utf-8'))

    # 收集已有的 URL 和 GDELT event ID，防止重复
    existing_urls = set()
    existing_gdelt_ids = set()
    for conflict in data.get("conflicts", {}).values():
        for cat in conflict.get("categories", {}).values():
            for item in cat.get("items", []):
                if item.get("url"):
                    existing_urls.add(item["url"])
                gm = item.get("gdelt_meta", {})
                if gm.get("event_id"):
                    existing_gdelt_ids.add(gm["event_id"])

    added_total = 0
    for cid, df in conflict_events.items():
        if cid not in data.get("conflicts", {}):
            continue

        added = 0
        for _, row in df.iterrows():
            if added >= max_per_conflict:
                break

            eid = str(row.get('GLOBALEVENTID', ''))
            url = str(row.get('SOURCEURL', '') or '')

            # 去重
            if eid in existing_gdelt_ids:
                continue
            if url and url in existing_urls:
                continue

            item = event_to_item(row, cid)
            cat = classify_gdelt_event(row.get('EventCode', ''))

            if cat in data["conflicts"][cid]["categories"]:
                data["conflicts"][cid]["categories"][cat]["items"].append(item)
                existing_urls.add(url)
                existing_gdelt_ids.add(eid)
                added += 1
                print(f"  + [{cid}/{cat}] {item['title_en'][:70]}")

        added_total += added

    if added_total > 0:
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

        with open(LATEST_JSON, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n[GDELT] 完成: 新增 {added_total} 条事件")
    return added_total


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 2

    df = fetch_gdelt_events(days)
    if df.empty:
        print("[GDELT] 无数据")
        return

    conflict_events = filter_conflict_events(df)
    if not conflict_events:
        print("[GDELT] 无匹配冲突事件")
        return

    merge_to_latest(conflict_events)


if __name__ == "__main__":
    main()
