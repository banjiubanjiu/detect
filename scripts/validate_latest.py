#!/usr/bin/env python3
"""
Data Contract 验证 (#9) — 防 schema 漂移的最后防线

为什么需要:
  latest.json 由 rss_feeds.py / gdelt_feed.py / briefing.py /
  cluster_corroboration.py / tag_criticality.py / health_report.py
  6 个脚本轮番写入, 任何一个改字段都可能破坏下游. 今天 code review
  暴露的 bug (indicators 日期错位 / tag_criticality 静默降级) 一部分
  本质上是"数据被写坏了没人发现". Schema 验证是最便宜的防御网.

设计原则:
  - 只验证"结构是否合法", 不验证"数据是否合理".
    数据合理性是 health_report.py 的职责 (orphan, stale, 覆盖率).
  - 纯 stdlib, 不引入 jsonschema / pydantic.
  - 发现问题分两级: error (schema 破坏, 必须修) / warning (可疑但可能合法).
  - 默认 strict 模式 (任何 error → exit 1).
  - --warn 模式: error 降级为 warning, 总是 exit 0 (CI 初期渐进上线用).

用法:
  python scripts/validate_latest.py          # strict, 本地开发
  python scripts/validate_latest.py --warn   # warn-only, CI 初期
  python scripts/validate_latest.py --file data/indicators.json  # 单文件
"""

import json
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"

# ───────────────── schema constants ─────────────────

VALID_SOURCES = {"rss", "reddit", "x", "youtube", "web", "gdelt"}
VALID_CRITICALITY = {"critical", "notable", "background"}
VALID_CONFLICT_IDS = {
    "russia-ukraine", "israel-palestine", "us-iran", "sudan", "myanmar",
    "yemen-houthi", "congo-drc", "syria", "taiwan-strait",
}
VALID_ADMIRALTY_SOURCE = {"A", "B", "C", "D", "E", "F"}
VALID_ADMIRALTY_INFO = {1, 2, 3, 4, 5, 6}
VALID_IW_FLAGS = {"elevated", "depressed", "rising", "falling", "normal", "insufficient"}
VALID_HEALTH_STATUS = {"ok", "degraded", "critical"}
VALID_ISSUE_SEVERITY = {"info", "warn", "critical"}
VALID_INTENSITY = {"war", "conflict", "tension"}  # conflict-level severity enum (not a number)

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ISO_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")

# latest.json 的 item 必需字段 (缺一就 error)
ITEM_REQUIRED = ["id", "title", "url", "source", "date"]

# latest.json 的 conflict 必需字段
CONFLICT_REQUIRED = ["name", "categories"]


# ───────────────── issue collector ─────────────────

class ValidationIssues:
    def __init__(self):
        self.errors = []   # schema violation
        self.warnings = [] # suspicious but possibly legal

    def err(self, path, msg):
        self.errors.append(f"  ✗ {path}: {msg}")

    def warn(self, path, msg):
        self.warnings.append(f"  ⚠ {path}: {msg}")

    @property
    def has_errors(self):
        return bool(self.errors)

    def print_summary(self, label):
        print(f"\n── {label} ──")
        if not self.errors and not self.warnings:
            print("  ✓ clean")
            return
        if self.errors:
            print(f"  ERRORS ({len(self.errors)}):")
            for e in self.errors[:50]:
                print(e)
            if len(self.errors) > 50:
                print(f"  ... (+{len(self.errors) - 50} more)")
        if self.warnings:
            print(f"  WARNINGS ({len(self.warnings)}):")
            for w in self.warnings[:20]:
                print(w)
            if len(self.warnings) > 20:
                print(f"  ... (+{len(self.warnings) - 20} more)")


# ───────────────── field type helpers ─────────────────

def check_str(issues, path, v, allow_empty=False):
    if not isinstance(v, str):
        issues.err(path, f"expected str, got {type(v).__name__}")
        return False
    if not allow_empty and not v:
        issues.err(path, "empty string")
        return False
    return True


def check_int(issues, path, v, minimum=None, maximum=None):
    if isinstance(v, bool) or not isinstance(v, int):
        issues.err(path, f"expected int, got {type(v).__name__}")
        return False
    if minimum is not None and v < minimum:
        issues.err(path, f"value {v} < minimum {minimum}")
        return False
    if maximum is not None and v > maximum:
        issues.err(path, f"value {v} > maximum {maximum}")
        return False
    return True


def check_num(issues, path, v, minimum=None):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        issues.err(path, f"expected number, got {type(v).__name__}")
        return False
    if minimum is not None and v < minimum:
        issues.err(path, f"value {v} < minimum {minimum}")
        return False
    return True


def check_date_str(issues, path, v, allow_future_days=1):
    """YYYY-MM-DD, and not more than `allow_future_days` in the future."""
    if not check_str(issues, path, v):
        return False
    if not DATE_RE.match(v[:10]):
        issues.err(path, f"bad date format: {v!r} (expected YYYY-MM-DD)")
        return False
    try:
        d = date.fromisoformat(v[:10])
    except ValueError:
        issues.err(path, f"unparseable date: {v!r}")
        return False
    today = datetime.now(timezone.utc).date()
    if (d - today).days > allow_future_days:
        issues.warn(path, f"date in future: {v}")
    return True


def check_iso_ts(issues, path, v):
    if not check_str(issues, path, v):
        return False
    if not ISO_TS_RE.match(v):
        issues.err(path, f"bad ISO timestamp: {v!r}")
        return False
    return True


def check_enum(issues, path, v, allowed):
    if v not in allowed:
        issues.err(path, f"value {v!r} not in {sorted(allowed)}")
        return False
    return True


# ───────────────── latest.json ─────────────────

def validate_item(issues, path, it):
    # Required fields
    for f in ITEM_REQUIRED:
        if f not in it:
            issues.err(path, f"missing required field {f!r}")
            return
    check_str(issues, f"{path}.id", it["id"])
    check_str(issues, f"{path}.title", it["title"])
    check_str(issues, f"{path}.url", it["url"])

    # source enum
    if check_str(issues, f"{path}.source", it["source"]):
        check_enum(issues, f"{path}.source", it["source"], VALID_SOURCES)

    # date format (allow 1 day future for timezone slop)
    check_date_str(issues, f"{path}.date", it["date"])

    # Optional but typed
    if "summary" in it:
        check_str(issues, f"{path}.summary", it["summary"], allow_empty=True)
    if "title_en" in it:
        check_str(issues, f"{path}.title_en", it["title_en"], allow_empty=True)
    if "summary_en" in it:
        check_str(issues, f"{path}.summary_en", it["summary_en"], allow_empty=True)
    if "source_label" in it:
        check_str(issues, f"{path}.source_label", it["source_label"], allow_empty=True)

    if "criticality" in it:
        check_enum(issues, f"{path}.criticality", it["criticality"], VALID_CRITICALITY)

    # T11: primary_conflict — LLM-determined most relevant conflict
    if "primary_conflict" in it:
        if check_str(issues, f"{path}.primary_conflict", it["primary_conflict"]):
            check_enum(issues, f"{path}.primary_conflict", it["primary_conflict"], VALID_CONFLICT_IDS)

    # #2: Admiralty Code
    if "admiralty_code" in it:
        ac = it["admiralty_code"]
        if check_str(issues, f"{path}.admiralty_code", ac):
            if len(ac) != 2 or ac[0] not in VALID_ADMIRALTY_SOURCE or not ac[1].isdigit() or int(ac[1]) not in VALID_ADMIRALTY_INFO:
                issues.err(f"{path}.admiralty_code", f"invalid code {ac!r} (expected A1-F6)")
    if "admiralty_source" in it:
        check_enum(issues, f"{path}.admiralty_source", it["admiralty_source"], VALID_ADMIRALTY_SOURCE)
    if "admiralty_info" in it:
        check_int(issues, f"{path}.admiralty_info", it["admiralty_info"], minimum=1, maximum=6)

    # cluster fields (all optional, but typed when present)
    if "cluster_id" in it and it["cluster_id"] is not None:
        check_str(issues, f"{path}.cluster_id", it["cluster_id"])
    if "cluster_size" in it and it["cluster_size"] is not None:
        # cluster_size 应该 >= 2 (单源不入簇), 但历史数据可能有 1
        if check_int(issues, f"{path}.cluster_size", it["cluster_size"], minimum=1):
            if it["cluster_size"] < 2:
                issues.warn(f"{path}.cluster_size", f"cluster_size={it['cluster_size']} < 2 (singleton)")
    if "cluster_bias_count" in it and it["cluster_bias_count"] is not None:
        check_int(issues, f"{path}.cluster_bias_count", it["cluster_bias_count"], minimum=0)

    if "metrics" in it and it["metrics"] is not None:
        if not isinstance(it["metrics"], dict):
            issues.err(f"{path}.metrics", f"expected dict, got {type(it['metrics']).__name__}")

    # local_file: validator only checks the field is a relative safe string.
    # Physical file existence is health_report.py's job.
    if "local_file" in it and it["local_file"] is not None:
        lf = it["local_file"]
        if not isinstance(lf, str):
            issues.err(f"{path}.local_file", f"expected str, got {type(lf).__name__}")
        elif lf == "":
            # historical orphan-clear leftover — frontend falls back, so warn
            issues.warn(f"{path}.local_file", "empty string (orphan clear leftover)")
        elif lf.startswith("/"):
            issues.err(f"{path}.local_file", "absolute path")
        elif lf.startswith("../") or "/../" in lf or lf.endswith("/.."):
            issues.err(f"{path}.local_file", "parent-traversal path")


def validate_latest(data):
    issues = ValidationIssues()

    if not isinstance(data, dict):
        issues.err("$", f"expected dict, got {type(data).__name__}")
        return issues

    # Top-level
    if "updated_at" in data:
        check_iso_ts(issues, "$.updated_at", data["updated_at"])
    else:
        issues.warn("$.updated_at", "missing")

    if "conflicts" not in data or not isinstance(data["conflicts"], dict):
        issues.err("$.conflicts", "missing or not a dict")
        return issues

    # Per-conflict
    seen_item_ids = {}  # id → first (conflict, category) location for cross-ref
    item_count = 0
    for cid, c in data["conflicts"].items():
        p = f"$.conflicts.{cid}"
        if not isinstance(c, dict):
            issues.err(p, f"expected dict, got {type(c).__name__}")
            continue
        for f in CONFLICT_REQUIRED:
            if f not in c:
                issues.err(p, f"missing required field {f!r}")
        if "name" in c:
            check_str(issues, f"{p}.name", c["name"])
        if "intensity" in c:
            if isinstance(c["intensity"], str):
                check_enum(issues, f"{p}.intensity", c["intensity"], VALID_INTENSITY)
            else:
                issues.err(f"{p}.intensity", f"expected str in {sorted(VALID_INTENSITY)}, got {type(c['intensity']).__name__}")
        if "categories" not in c or not isinstance(c["categories"], dict):
            issues.err(f"{p}.categories", "missing or not a dict")
            continue
        for catk, cat in c["categories"].items():
            cp = f"{p}.categories.{catk}"
            if not isinstance(cat, dict):
                issues.err(cp, f"expected dict, got {type(cat).__name__}")
                continue
            items = cat.get("items", [])
            if not isinstance(items, list):
                issues.err(f"{cp}.items", f"expected list, got {type(items).__name__}")
                continue
            for i, it in enumerate(items):
                ip = f"{cp}.items[{i}]"
                if not isinstance(it, dict):
                    issues.err(ip, f"expected dict, got {type(it).__name__}")
                    continue
                validate_item(issues, ip, it)
                item_count += 1
                # Track cross-reference: same id should have same criticality
                # (tag_criticality invariant)
                iid = it.get("id")
                crit = it.get("criticality")
                if iid and crit is not None:
                    prev = seen_item_ids.get(iid)
                    if prev is None:
                        seen_item_ids[iid] = (ip, crit)
                    elif prev[1] != crit:
                        issues.err(
                            ip,
                            f"criticality {crit!r} conflicts with earlier copy at {prev[0]} ({prev[1]!r})"
                        )

    print(f"  validated {item_count} items across {len(data.get('conflicts', {}))} conflicts")
    return issues


# ───────────────── indicators.json ─────────────────

def validate_iw_metric(issues, path, m, is_escalation):
    if not isinstance(m, dict):
        issues.err(path, f"expected dict, got {type(m).__name__}")
        return
    if "flag" in m:
        check_enum(issues, f"{path}.flag", m["flag"], VALID_IW_FLAGS)
    if "label" in m:
        check_str(issues, f"{path}.label", m["label"])
    if is_escalation:
        # today / yesterday can be None when insufficient
        for f in ("today", "yesterday"):
            if f in m and m[f] is not None:
                check_num(issues, f"{path}.{f}", m[f])
        if "delta" in m and m["delta"] is not None:
            check_num(issues, f"{path}.delta", m["delta"])
    else:
        if "today" in m and m["today"] is not None:
            check_num(issues, f"{path}.today", m["today"], minimum=0)
        if "baseline" in m and m["baseline"] is not None:
            check_num(issues, f"{path}.baseline", m["baseline"], minimum=0)
        if "baseline_days" in m:
            check_int(issues, f"{path}.baseline_days", m["baseline_days"], minimum=0)


def validate_indicators(data):
    issues = ValidationIssues()
    if not isinstance(data, dict):
        issues.err("$", f"expected dict, got {type(data).__name__}")
        return issues

    check_iso_ts(issues, "$.generated_at", data.get("generated_at", ""))
    check_date_str(issues, "$.reference_date", data.get("reference_date", ""), allow_future_days=0)
    check_int(issues, "$.total_warnings", data.get("total_warnings"), minimum=0)
    check_int(issues, "$.flagged_conflicts", data.get("flagged_conflicts"), minimum=0)

    conflicts = data.get("conflicts")
    if not isinstance(conflicts, dict):
        issues.err("$.conflicts", "missing or not a dict")
        return issues

    for cid, c in conflicts.items():
        p = f"$.conflicts.{cid}"
        if not isinstance(c, dict):
            issues.err(p, f"expected dict, got {type(c).__name__}")
            continue
        if "name" in c:
            check_str(issues, f"{p}.name", c["name"])
        metrics = c.get("metrics")
        if not isinstance(metrics, dict):
            issues.err(f"{p}.metrics", "missing or not a dict")
            continue
        for key in ("event_frequency", "critical_count", "escalation_trend"):
            if key not in metrics:
                issues.err(f"{p}.metrics.{key}", "missing")
                continue
            validate_iw_metric(
                issues,
                f"{p}.metrics.{key}",
                metrics[key],
                is_escalation=(key == "escalation_trend"),
            )
        # warnings list
        w = c.get("warnings", [])
        if not isinstance(w, list):
            issues.err(f"{p}.warnings", f"expected list, got {type(w).__name__}")
        else:
            for wi in w:
                if wi not in ("event_frequency", "critical_count", "escalation_trend"):
                    issues.err(f"{p}.warnings", f"unknown metric key {wi!r}")

    return issues


# ───────────────── pipeline_health.json ─────────────────

def validate_health(data):
    issues = ValidationIssues()
    if not isinstance(data, dict):
        issues.err("$", f"expected dict, got {type(data).__name__}")
        return issues

    check_iso_ts(issues, "$.generated_at", data.get("generated_at", ""))
    if "latest_updated_at" in data and data["latest_updated_at"]:
        check_iso_ts(issues, "$.latest_updated_at", data["latest_updated_at"])
    check_int(issues, "$.total_unique_items", data.get("total_unique_items"), minimum=0)

    if "status" in data:
        check_enum(issues, "$.status", data["status"], VALID_HEALTH_STATUS)

    llm = data.get("llm_coverage")
    if isinstance(llm, dict):
        for k in ("criticality_coverage", "title_en_coverage", "summary_en_coverage"):
            if k in llm:
                check_num(issues, f"$.llm_coverage.{k}", llm[k], minimum=0)

    orphans = data.get("orphans")
    if isinstance(orphans, dict):
        check_int(issues, "$.orphans.checked", orphans.get("checked"), minimum=0)
        check_int(issues, "$.orphans.orphan_count", orphans.get("orphan_count"), minimum=0)
        # review #12: ensure no set-backed leak
        if "_orphan_ids" in orphans:
            issues.err("$.orphans._orphan_ids", "internal field leaked to output (review #12)")

    issues_list = data.get("issues", [])
    if not isinstance(issues_list, list):
        issues.err("$.issues", f"expected list, got {type(issues_list).__name__}")
    else:
        for i, iss in enumerate(issues_list):
            ip = f"$.issues[{i}]"
            if not isinstance(iss, dict):
                issues.err(ip, f"expected dict, got {type(iss).__name__}")
                continue
            if "severity" in iss:
                check_enum(issues, f"{ip}.severity", iss["severity"], VALID_ISSUE_SEVERITY)
            if "code" in iss:
                check_str(issues, f"{ip}.code", iss["code"])

    return issues


# ───────────────── main ─────────────────

FILE_VALIDATORS = {
    "latest.json": ("LATEST", validate_latest),
    "indicators.json": ("INDICATORS", validate_indicators),
    "pipeline_health.json": ("PIPELINE HEALTH", validate_health),
}


def main():
    warn_only = "--warn" in sys.argv
    target_file = None
    for i, arg in enumerate(sys.argv):
        if arg == "--file" and i + 1 < len(sys.argv):
            target_file = sys.argv[i + 1]

    files_to_check = []
    if target_file:
        files_to_check = [Path(target_file)]
    else:
        for fname in FILE_VALIDATORS:
            p = DATA_DIR / fname
            if p.exists():
                files_to_check.append(p)

    if not files_to_check:
        print("no files to validate (data/ is empty?)")
        return 0

    total_errors = 0
    total_warnings = 0
    for path in files_to_check:
        fname = path.name
        if fname not in FILE_VALIDATORS:
            print(f"\n── {fname} ──\n  ? no validator registered, skip")
            continue
        label, validator = FILE_VALIDATORS[fname]
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            print(f"\n── {label} ──\n  ✗ invalid JSON: {e}")
            total_errors += 1
            continue
        except OSError as e:
            print(f"\n── {label} ──\n  ✗ read error: {e}")
            total_errors += 1
            continue

        issues = validator(data)
        issues.print_summary(label)
        total_errors += len(issues.errors)
        total_warnings += len(issues.warnings)

    print(f"\n═══ TOTAL: {total_errors} errors, {total_warnings} warnings ═══")

    if total_errors > 0 and not warn_only:
        print("(strict mode — exit 1. Use --warn to demote errors to warnings)")
        return 1
    if warn_only and total_errors > 0:
        print("(--warn mode — errors not blocking)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
