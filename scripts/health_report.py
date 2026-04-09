#!/usr/bin/env python3
"""
管道可观测性报告 (Pipeline Health Report) - v1 post-hoc 分析

思路：
  不改任何已有脚本（rss_feeds / gdelt_feed / tag_criticality / cluster_corroboration / briefing），
  只在管道末尾读 latest.json 做事后分析，算出每源/每域/日分布/LLM 覆盖率/orphan/异常信号。
  能答 90% 的"今天健康吗"类问题，缺的那 10%（阶段耗时、失败 URL）等 v2 instrumentation 再补。

输出：
  data/pipeline_health.json         — 当前状态，前端每次加载读这个
  data/pipeline_health/YYYY-MM-DD.json — 历史归档（v2 画趋势线用）

异常信号（issues 字段）：
  - orphan_file: local_file 指向的文件在 data/ 下不存在（T4 的直接检测）
  - low_daily_count: 今日条目数 < 7 日均值 * 0.5（4 月 4 日那种疑似 CI 故障）
  - high_missing_translation: 缺 title_en/summary_en 的比例 > 10%
  - high_missing_criticality: 缺 criticality 字段的比例 > 5%
  - stale_data: latest.json 的 updated_at 超过 25 小时

v1 不做：
  - 自动修复 orphan（仅检测报告）
  - CI fail build（只 exit 0 + warning，避免淡日误触）
  - 源脚本 instrumentation（见 TODO.md V7.1）
"""

import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
LATEST_JSON = DATA_DIR / "latest.json"
HEALTH_JSON = DATA_DIR / "pipeline_health.json"
HEALTH_ARCHIVE_DIR = DATA_DIR / "pipeline_health"

# Thresholds for issue detection
LOW_DAILY_RATIO = 0.5            # today < 7-day avg * this → flag
HIGH_MISSING_TRANSLATION = 0.10  # > 10% missing translation → flag
HIGH_MISSING_CRITICALITY = 0.05  # > 5% missing criticality → flag
STALE_DATA_HOURS = 25            # updated_at older than this → flag
DATE_HISTO_DAYS = 14             # histogram window for frontend
TOP_DOMAINS = 20                 # how many domains to include in report


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


def collect_unique_items(latest):
    """Dedupe by id across conflicts/categories."""
    seen = {}
    for cid, c in latest.get('conflicts', {}).items():
        for cat in c.get('categories', {}).values():
            for it in cat.get('items', []):
                iid = it.get('id')
                if not iid or iid in seen:
                    continue
                seen[iid] = it
    return seen


def analyze_sources(items):
    """Per-source counts and metadata."""
    by_source = Counter()
    for it in items.values():
        by_source[it.get('source', 'unknown')] += 1
    return dict(by_source)


def analyze_domains(items, top_n=TOP_DOMAINS):
    """Per-domain stats: count, last_date, orphan_count."""
    domain_stats = defaultdict(lambda: {'count': 0, 'last_date': '', 'orphans': 0})
    for it in items.values():
        host = get_domain(it.get('url'))
        if not host:
            continue
        s = domain_stats[host]
        s['count'] += 1
        date = it.get('date', '') or ''
        if date > s['last_date']:
            s['last_date'] = date
    # Sort by count, keep top N
    sorted_domains = sorted(domain_stats.items(), key=lambda kv: -kv[1]['count'])[:top_n]
    return {k: v for k, v in sorted_domains}


def analyze_date_histogram(items, window_days=DATE_HISTO_DAYS):
    """Daily item counts for the last N days. Returns ordered list (oldest → newest)."""
    today = datetime.now(timezone.utc).date()
    counts = Counter()
    for it in items.values():
        date_str = (it.get('date') or '')[:10]
        if date_str:
            counts[date_str] += 1
    result = []
    for i in range(window_days - 1, -1, -1):
        day = today - timedelta(days=i)
        ds = day.strftime('%Y-%m-%d')
        result.append({'date': ds, 'count': counts.get(ds, 0)})
    return result


def analyze_llm_coverage(items):
    """LLM-added field coverage: criticality, title_en, summary_en, cluster."""
    total = len(items)
    if total == 0:
        return {}
    missing_crit = sum(1 for it in items.values() if not it.get('criticality'))
    missing_title_en = sum(1 for it in items.values() if not it.get('title_en'))
    missing_summary_en = sum(1 for it in items.values() if not it.get('summary_en'))
    clustered = sum(1 for it in items.values() if it.get('cluster_size'))
    cross_bias = sum(1 for it in items.values() if (it.get('cluster_bias_count') or 0) >= 2)
    return {
        'total': total,
        'criticality_coverage': round((total - missing_crit) / total, 4),
        'title_en_coverage': round((total - missing_title_en) / total, 4),
        'summary_en_coverage': round((total - missing_summary_en) / total, 4),
        'clustered': clustered,
        'cross_bias_items': cross_bias,
        'missing_criticality': missing_crit,
        'missing_title_en': missing_title_en,
        'missing_summary_en': missing_summary_en,
    }


def scan_orphans(items):
    """Check local_file fields point to existing files under data/.

    Returns (stats, orphan_ids) — stats is a JSON-safe dict meant to land in
    the report; orphan_ids is a separate set used by --fix. Keeping them as
    separate return values avoids the prior "set hidden inside dict" pattern
    that depended on sanitize_report running before json.dump (review #12).
    """
    orphans = []
    orphan_ids = set()
    checked = 0
    for it in items.values():
        lf = it.get('local_file')
        if not lf:
            continue
        checked += 1
        full = DATA_DIR / lf
        if not full.exists():
            orphans.append({
                'id': it.get('id'),
                'title': (it.get('title_en') or it.get('title') or '')[:80],
                'source_label': it.get('source_label'),
                'local_file': lf,
            })
            orphan_ids.add(it.get('id'))
    stats = {
        'checked': checked,
        'orphan_count': len(orphans),
        'orphan_rate': round(len(orphans) / checked, 4) if checked else 0.0,
        'samples': orphans[:5],  # first 5 for display
    }
    return stats, orphan_ids


def fix_orphans_in_latest(latest, orphan_ids):
    """T4 自动修复: 把 orphan item 的 local_file 字段从 latest.json 清除。
    同一 id 可能在多个 category 副本出现, 全部清理。幂等。
    返回清除的副本数 (每个 id 可能 >1)。"""
    if not orphan_ids:
        return 0
    cleared = 0
    for c in latest.get('conflicts', {}).values():
        for cat in c.get('categories', {}).values():
            for it in cat.get('items', []):
                if it.get('id') in orphan_ids and 'local_file' in it:
                    it.pop('local_file', None)
                    cleared += 1
    return cleared


def detect_issues(report, latest):
    """Build issue list from computed stats. Severity: info|warn|critical."""
    issues = []
    histo = report['date_histogram']
    llm = report['llm_coverage']
    orphans = report['orphans']

    # Issue: today count is suspiciously low vs 7-day avg
    # (exclude today from the average to get a proper baseline)
    today_count = histo[-1]['count'] if histo else 0
    prior_7 = [h['count'] for h in histo[-8:-1]]  # prior 7 days excluding today
    if prior_7:
        prior_avg = sum(prior_7) / len(prior_7)
        if prior_avg >= 10 and today_count < prior_avg * LOW_DAILY_RATIO:
            issues.append({
                'code': 'low_daily_count',
                'severity': 'warn',
                'message': f'今日 {today_count} 条，7 日均值 {prior_avg:.1f}，低于 50%',
                'today': today_count,
                'baseline': round(prior_avg, 1),
            })

    # Issue: orphan files
    if orphans['orphan_count'] > 0:
        sev = 'critical' if orphans['orphan_count'] > 10 else 'warn'
        issues.append({
            'code': 'orphan_file',
            'severity': sev,
            'message': f'{orphans["orphan_count"]} 个 local_file 指向不存在的文件',
            'count': orphans['orphan_count'],
        })

    # Issue: missing translation coverage
    if llm.get('total', 0) >= 50:
        missing_tr = max(llm['missing_title_en'], llm['missing_summary_en'])
        missing_rate = missing_tr / llm['total']
        if missing_rate > HIGH_MISSING_TRANSLATION:
            issues.append({
                'code': 'high_missing_translation',
                'severity': 'warn',
                'message': f'翻译缺失率 {missing_rate*100:.1f}% (>{HIGH_MISSING_TRANSLATION*100:.0f}%)',
                'missing_title_en': llm['missing_title_en'],
                'missing_summary_en': llm['missing_summary_en'],
            })

    # Issue: missing criticality (BLUF)
    if llm.get('total', 0) >= 50:
        missing_rate = llm['missing_criticality'] / llm['total']
        if missing_rate > HIGH_MISSING_CRITICALITY:
            issues.append({
                'code': 'high_missing_criticality',
                'severity': 'warn',
                'message': f'BLUF 缺失率 {missing_rate*100:.1f}% (>{HIGH_MISSING_CRITICALITY*100:.0f}%)',
                'missing': llm['missing_criticality'],
            })

    # Issue: stale data (updated_at older than N hours)
    updated_at = latest.get('updated_at', '')
    if updated_at:
        try:
            ts = datetime.fromisoformat(updated_at.replace('Z', '+00:00'))
            age_hours = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
            if age_hours > STALE_DATA_HOURS:
                issues.append({
                    'code': 'stale_data',
                    'severity': 'critical',
                    'message': f'latest.json 已 {age_hours:.1f} 小时未更新 (>{STALE_DATA_HOURS}h)',
                    'age_hours': round(age_hours, 1),
                })
        except Exception:
            pass

    return issues


def compute_status(issues):
    """ok | degraded | critical based on highest severity."""
    if not issues:
        return 'ok'
    if any(i['severity'] == 'critical' for i in issues):
        return 'critical'
    if any(i['severity'] == 'warn' for i in issues):
        return 'degraded'
    return 'ok'


def build_report(latest):
    """Build the health report. Returns (report, orphan_ids) — report is
    JSON-safe and ready to dump; orphan_ids is consumed by --fix mode only.
    """
    items = collect_unique_items(latest)
    orphan_stats, orphan_ids = scan_orphans(items)
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'latest_updated_at': latest.get('updated_at'),
        'total_unique_items': len(items),
        'by_source': analyze_sources(items),
        'top_domains': analyze_domains(items),
        'date_histogram': analyze_date_histogram(items),
        'llm_coverage': analyze_llm_coverage(items),
        'orphans': orphan_stats,
    }
    report['issues'] = detect_issues(report, latest)
    report['status'] = compute_status(report['issues'])
    return report, orphan_ids


def print_summary(report):
    status = report['status']
    icon = {'ok': '✓', 'degraded': '⚠', 'critical': '✗'}[status]
    print(f"\n═══ 管道健康报告  {report['generated_at']} ═══")
    print(f"状态: {icon} {status.upper()}")
    print(f"总条目 (unique): {report['total_unique_items']}")
    print(f"源分布: {report['by_source']}")

    llm = report['llm_coverage']
    print(f"\nLLM 覆盖:")
    print(f"  BLUF criticality : {llm['criticality_coverage']*100:.1f}%")
    print(f"  title_en         : {llm['title_en_coverage']*100:.1f}%  (missing {llm['missing_title_en']})")
    print(f"  summary_en       : {llm['summary_en_coverage']*100:.1f}%  (missing {llm['missing_summary_en']})")
    print(f"  clustered        : {llm['clustered']}  (cross-bias {llm['cross_bias_items']})")

    histo = report['date_histogram']
    print(f"\n最近 {len(histo)} 天日分布:")
    for h in histo:
        bar = '█' * min(int(h['count'] / 5), 30)
        print(f"  {h['date']}  {h['count']:>4d}  {bar}")

    orph = report['orphans']
    print(f"\nOrphan 扫描: {orph['orphan_count']}/{orph['checked']} ({orph['orphan_rate']*100:.1f}%)")

    if report['issues']:
        print(f"\n⚠ 异常 ({len(report['issues'])}):")
        for i in report['issues']:
            sev_icon = {'critical': '✗', 'warn': '⚠', 'info': 'ℹ'}[i['severity']]
            print(f"  {sev_icon} [{i['code']}] {i['message']}")
    else:
        print("\n无异常 ✓")


def main():
    if not LATEST_JSON.exists():
        print(f"ERROR: {LATEST_JSON} not found", file=sys.stderr)
        sys.exit(1)

    fix_mode = '--fix' in sys.argv

    with open(LATEST_JSON, encoding='utf-8') as f:
        latest = json.load(f)

    report, orphan_ids = build_report(latest)

    # T4 自动修复: 发现 orphan 就清掉 latest.json 的 local_file 字段, 再重跑一次扫描
    if fix_mode and orphan_ids:
        cleared = fix_orphans_in_latest(latest, orphan_ids)
        print(f"\n[--fix] 清除 {len(orphan_ids)} 个 id 的 local_file 字段 ({cleared} 个 item 副本)")
        with open(LATEST_JSON, 'w', encoding='utf-8') as f:
            json.dump(latest, f, ensure_ascii=False, indent=2)
        print(f"[--fix] 回写 {LATEST_JSON.relative_to(PROJECT_ROOT)}")
        # Rebuild report so orphan_count 归零, issues 状态刷新
        report, orphan_ids = build_report(latest)

    print_summary(report)

    # Write current
    with open(HEALTH_JSON, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n✓ 写 {HEALTH_JSON.relative_to(PROJECT_ROOT)}")

    # Archive by date (for v2 trend analysis)
    HEALTH_ARCHIVE_DIR.mkdir(exist_ok=True)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    archive_path = HEALTH_ARCHIVE_DIR / f'{today}.json'
    with open(archive_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"✓ 归档 {archive_path.relative_to(PROJECT_ROOT)}")

    # v1: always exit 0 (warnings don't fail build yet)
    return 0


if __name__ == '__main__':
    sys.exit(main())
