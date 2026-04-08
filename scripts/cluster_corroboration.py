#!/usr/bin/env python3
"""
多源交叉验证 (Multi-source corroboration)

把 latest.json 里"同一事件不同来源"的 item 折叠成 cluster，为每条 item 标注
cluster_id / cluster_size / cluster_bias_count，让前端能渲染 "N 个源印证 / 跨 K 种偏见"
徽章。

为什么需要：
  806 条 item 独立计数，无法体现 "N 家独立源印证 / 跨 K 种偏见标签" 的情报学信号。
  专业 OSINT 平台和新闻聚合器的最大区别就在这里。

算法：
  Step 1: blocking — 同一冲突内按 ±2 day window 比对（不跨冲突，避免误合）
  Step 2: 桶内 token Jaccard 相似度，>= SIM_THRESHOLD 视为同一事件
          - 仅用 title_en（97% 覆盖），分词后剔停用词
            * 不用 summary：dry-run 验证显示加 summary 会把 0.62 稀释到 0.17
          - 缺英文版的 fallback 到中文 char 4-gram
          - 中英文 token 集不互相比较
          - 短 title (< MIN_TOKENS) 不参与，避免短推文误聚
  Step 3: Union-Find 合并相似对成 cluster
  Step 4: 写回 cluster_id / cluster_size / cluster_bias_count（singleton 不写）

跳过 GDELT 条目：
  GDELT 是机器抽取的结构化事件记录，不是独立的新闻报道。
  "两条 GDELT 相似" 不代表 "两家媒体独立印证"，反而模板词会撞出大量假阳性。
  v1 只对 web/reddit/x/youtube 来源做聚类。

幂等：
  - cluster_id = sha1(sorted_member_ids)[:6]，成员不变 → ID 不变
  - 重跑产生相同结果，git diff 为空
  - 失效 cluster 字段会被清理（item 离开簇时）

成本：
  - 纯 Python，零 LLM 调用
  - 全数据集 < 1 秒
"""

import hashlib
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

PROJECT_ROOT = Path(__file__).parent.parent
LATEST_JSON = PROJECT_ROOT / "data" / "latest.json"
CRED_JSON = PROJECT_ROOT / "data" / "source_credibility.json"

# Tunables
DATE_WINDOW_DAYS = 2          # ±N days for blocking within a conflict
SIM_THRESHOLD = 0.5           # jaccard threshold to call two items "same event"
MIN_CLUSTER_SIZE = 2          # only annotate clusters with >= this many members
MIN_TOKENS = 4                # need at least N tokens to participate (skip short tweets)
PREVIEW_TOP_N = 10            # how many largest clusters to print for verification
SKIP_SOURCES = {'gdelt'}      # GDELT events are machine-extracted, not independent sources

# English stopwords + common report cliches that drown out signal
STOPWORDS = {
    'the','a','an','of','in','on','at','to','for','with','by','from','and','or','but',
    'is','are','was','were','be','been','being','have','has','had','do','does','did',
    'will','would','could','should','may','might','must','can','as','that','this','these',
    'those','it','its','their','his','her','our','your','my','we','they','he','she',
    'said','says','say','told','tell','reported','reports','report','according',
    'after','before','during','while','about','over','under','through','than','then',
    'new','first','last','one','two','three','calls','call','also','more','most','some',
    'into','out','up','down','off','only','very','just','now','still','here','there',
    'who','what','when','where','why','how','which','whose',
}


def normalize_en(text):
    """Lowercase, drop punct, split into tokens, drop stopwords + short tokens.

    Hyphens are stripped (not split-on) so military hardware identifiers like
    F-15E / T-90 / Kh-101 / MiG-29 stay as single tokens (f15e, t90, kh101, mig29).
    Without this, the regex [a-z][a-z0-9]{2,} would lose them to fragments like
    'f' (too short) + '15e' (starts with digit).
    """
    if not text:
        return set()
    text = text.lower().replace('-', '')
    tokens = re.findall(r'[a-z][a-z0-9]{2,}', text)
    return {t for t in tokens if t not in STOPWORDS}


def normalize_zh(text):
    """Char 4-gram for Chinese fallback."""
    if not text:
        return set()
    text = re.sub(r'[\s\W]+', '', text)
    if len(text) < 4:
        return set()
    return {text[i:i + 4] for i in range(len(text) - 3)}


def item_tokens(item):
    """Build comparison token set from TITLE ONLY. Returns (lang, token_set).

    Why title only: dry-run on 2026-04-07 showed adding summary tanks signal —
    Murmansk pair dropped 0.64 → 0.39, energy truce pair 0.62 → 0.17.
    Summary text drowns the entity overlap with story-specific filler.
    """
    en_tokens = normalize_en(item.get('title_en') or '')
    if len(en_tokens) >= MIN_TOKENS:
        return ('en', en_tokens)
    zh_tokens = normalize_zh(item.get('title') or '')
    if len(zh_tokens) >= MIN_TOKENS:
        return ('zh', zh_tokens)
    return ('', set())


def jaccard(a, b):
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    return inter / len(a | b)


class UnionFind:
    """Iterative path compression to avoid Python recursion limit."""

    def __init__(self):
        self.parent = {}

    def find(self, x):
        if x not in self.parent:
            self.parent[x] = x
            return x
        # Find root
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        # Path compression
        while self.parent[x] != root:
            nxt = self.parent[x]
            self.parent[x] = root
            x = nxt
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def collect_unique_items(latest):
    """Walk all categories, dedupe by id (one item can appear in multiple cats/conflicts).
    Returns id -> {item, conflict} (first conflict seen wins for placement).
    GDELT items are excluded from clustering — they're machine-extracted event records,
    not independent journalistic reports."""
    seen = {}
    for cid, c in latest.get('conflicts', {}).items():
        for cat in c.get('categories', {}).values():
            for it in cat.get('items', []):
                iid = it.get('id')
                if not iid or iid in seen:
                    continue
                if it.get('source') in SKIP_SOURCES:
                    continue
                seen[iid] = {'item': it, 'conflict': cid}
    return seen


def parse_date(s):
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], '%Y-%m-%d')
    except Exception:
        return None


def cluster_items(unique_items):
    """Run blocking + jaccard + union-find. Returns id -> root_id."""
    by_conflict = defaultdict(list)
    for iid, meta in unique_items.items():
        d = parse_date(meta['item'].get('date'))
        if d is None:
            continue
        lang, tokens = item_tokens(meta['item'])
        by_conflict[meta['conflict']].append((iid, d, lang, tokens))

    uf = UnionFind()
    pair_count = 0
    sim_count = 0
    for cid, items in by_conflict.items():
        items.sort(key=lambda x: x[1])
        n = len(items)
        for i in range(n):
            iid_i, d_i, lang_i, tok_i = items[i]
            uf.find(iid_i)  # ensure registered (singletons too)
            if not tok_i:
                continue
            for j in range(i + 1, n):
                iid_j, d_j, lang_j, tok_j = items[j]
                # Sorted by date → break once gap exceeds window
                if (d_j - d_i).days > DATE_WINDOW_DAYS:
                    break
                if lang_i != lang_j or not tok_j:
                    continue
                pair_count += 1
                if jaccard(tok_i, tok_j) >= SIM_THRESHOLD:
                    sim_count += 1
                    uf.union(iid_i, iid_j)

    print(f"  比对对数: {pair_count}, 相似对: {sim_count}", file=sys.stderr)
    return {iid: uf.find(iid) for iid in uf.parent}


def get_domain(url):
    if not url:
        return ''
    try:
        host = urlparse(url).netloc.lower()
        if host.startswith('www.'):
            host = host[4:]
        return host
    except Exception:
        return ''


def get_bias(item, cred_db):
    """Resolve item -> bias label, or None. Mirrors web/app.js credInfo() logic."""
    domains = cred_db.get('domains', {})
    host = get_domain(item.get('url'))
    if host in domains:
        return domains[host].get('bias')
    parts = host.split('.')
    if len(parts) > 2:
        parent = '.'.join(parts[-2:])
        if parent in domains:
            return domains[parent].get('bias')
    src = item.get('source')
    if src in ('x', 'youtube', 'reddit', 'gdelt'):
        return 'neutral'
    return None


def build_cluster_metadata(unique_items, id_to_root, cred_db):
    """Group by root, compute size + bias diversity. Returns root_id -> meta dict."""
    groups = defaultdict(list)
    for iid, root in id_to_root.items():
        groups[root].append(iid)

    result = {}
    for root, members in groups.items():
        if len(members) < MIN_CLUSTER_SIZE:
            continue
        h = hashlib.sha1(','.join(sorted(members)).encode('utf-8')).hexdigest()[:6]
        biases = set()
        for iid in members:
            b = get_bias(unique_items[iid]['item'], cred_db)
            if b:
                biases.add(b)
        result[root] = {
            'cluster_id': f'cl_{h}',
            'cluster_size': len(members),
            'cluster_bias_count': len(biases),
            'members': sorted(members),
            'biases': sorted(biases),
        }
    return result


def apply_to_latest(latest, id_to_root, cluster_meta):
    """Write cluster fields to all item copies. Strip stale fields from non-clustered items."""
    id_to_meta = {}
    for iid, root in id_to_root.items():
        meta = cluster_meta.get(root)
        if meta:
            id_to_meta[iid] = meta

    updated = 0
    cleared = 0
    for c in latest.get('conflicts', {}).values():
        for cat in c.get('categories', {}).values():
            for it in cat.get('items', []):
                iid = it.get('id')
                if not iid:
                    continue
                meta = id_to_meta.get(iid)
                if meta:
                    if (it.get('cluster_id') != meta['cluster_id']
                            or it.get('cluster_size') != meta['cluster_size']
                            or it.get('cluster_bias_count') != meta['cluster_bias_count']):
                        it['cluster_id'] = meta['cluster_id']
                        it['cluster_size'] = meta['cluster_size']
                        it['cluster_bias_count'] = meta['cluster_bias_count']
                        updated += 1
                else:
                    if 'cluster_id' in it or 'cluster_size' in it or 'cluster_bias_count' in it:
                        it.pop('cluster_id', None)
                        it.pop('cluster_size', None)
                        it.pop('cluster_bias_count', None)
                        cleared += 1
    return updated, cleared


def print_preview(unique_items, cluster_meta):
    """Print top N largest clusters for visual verification of cluster quality."""
    sorted_clusters = sorted(
        cluster_meta.values(),
        key=lambda c: (-c['cluster_size'], -c['cluster_bias_count'])
    )[:PREVIEW_TOP_N]
    print(f"\n═══ Top {PREVIEW_TOP_N} 簇预览 ═══\n")
    for c in sorted_clusters:
        print(f"[{c['cluster_id']}] size={c['cluster_size']}  "
              f"bias_count={c['cluster_bias_count']}  biases={c['biases']}")
        for iid in c['members']:
            it = unique_items[iid]['item']
            label = it.get('source_label', '')
            title = (it.get('title_en') or it.get('title') or '')[:90]
            print(f"  • [{label[:18]:<18}] {title}")
        print()


def main():
    if not LATEST_JSON.exists():
        print(f"ERROR: {LATEST_JSON} not found", file=sys.stderr)
        sys.exit(1)

    with open(LATEST_JSON, encoding='utf-8') as f:
        latest = json.load(f)
    with open(CRED_JSON, encoding='utf-8') as f:
        cred_db = json.load(f)

    print(f"═══ 多源交叉验证聚类 {datetime.now().strftime('%Y-%m-%d %H:%M')} ═══\n")
    unique_items = collect_unique_items(latest)
    print(f"unique items: {len(unique_items)}")

    id_to_root = cluster_items(unique_items)
    cluster_meta = build_cluster_metadata(unique_items, id_to_root, cred_db)
    total_clustered = sum(c['cluster_size'] for c in cluster_meta.values())
    cross_bias = sum(1 for c in cluster_meta.values() if c['cluster_bias_count'] >= 2)
    print(f"clusters (size>={MIN_CLUSTER_SIZE}): {len(cluster_meta)}")
    print(f"items in clusters: {total_clustered}/{len(unique_items)}")
    print(f"cross-bias clusters: {cross_bias}/{len(cluster_meta)}")

    if '--dry-run' in sys.argv:
        print_preview(unique_items, cluster_meta)
        print("\n[dry-run] 未写回 latest.json")
        return

    updated, cleared = apply_to_latest(latest, id_to_root, cluster_meta)
    print(f"\n应用：更新 {updated} 个 item 副本，清理 {cleared} 个失效字段")

    with open(LATEST_JSON, 'w', encoding='utf-8') as f:
        json.dump(latest, f, ensure_ascii=False, indent=2)
    print(f"✓ 写回 {LATEST_JSON.relative_to(PROJECT_ROOT)}")

    print_preview(unique_items, cluster_meta)


if __name__ == '__main__':
    main()
