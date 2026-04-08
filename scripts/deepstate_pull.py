#!/usr/bin/env python3
"""
DeepStateMap 俄乌前线 GeoJSON 拉取器

每日从 cyterat/deepstate-map-data (GitHub) 拉取最新的 DeepState Map
Multipolygon(俄占区),保存到 data/frontline_ua.geojson,供前端
Leaflet 叠加使用。

用法:
  python3 scripts/deepstate_pull.py         # 自动寻找最近 7 天内最新的文件
  python3 scripts/deepstate_pull.py 14      # 往前追溯 14 天

数据源:
  - 仓库: https://github.com/cyterat/deepstate-map-data
  - 文件命名: data/deepstatemap_data_YYYYMMDD.geojson
  - 更新时间: 每日 03:00 UTC
  - 许可: 依赖 DeepStateMap.Live (OSINT,开放数据)
"""

import json
import sys
from datetime import date, timedelta
from pathlib import Path

try:
    import requests
except ImportError:
    print("需要安装: pip install requests")
    sys.exit(1)

PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / "data"
OUTPUT = DATA_DIR / "frontline_ua.geojson"

REPO = "cyterat/deepstate-map-data"
BRANCH = "main"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/data"


def try_fetch(lookback_days: int = 7) -> tuple[str, dict] | None:
    """
    Walk backward from today, return (filename, parsed_geojson) of the first
    existing file. DeepStateMap usually updates daily, but sometimes there's
    a 1-3 day gap, so we try a window.
    """
    today = date.today()
    for delta in range(0, lookback_days + 1):
        dt = today - timedelta(days=delta)
        fname = f"deepstatemap_data_{dt:%Y%m%d}.geojson"
        url = f"{RAW_BASE}/{fname}"
        try:
            r = requests.get(url, timeout=30)
        except requests.RequestException as e:
            print(f"  [{fname}] 网络错误: {e}")
            continue
        if r.status_code == 200:
            try:
                data = r.json()
            except json.JSONDecodeError as e:
                print(f"  [{fname}] JSON 解析失败: {e}")
                continue
            return fname, data
        if r.status_code != 404:
            print(f"  [{fname}] HTTP {r.status_code}")
    return None


def main() -> int:
    lookback = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    print(f"[deepstate] 拉取 DeepStateMap(往前 {lookback} 天)...")

    result = try_fetch(lookback)
    if not result:
        print(f"[deepstate] ✗ 未找到 {lookback} 天内的数据")
        return 1

    fname, geojson = result

    # Sanity check — 确保是 FeatureCollection 且有 features
    if not isinstance(geojson, dict):
        print(f"[deepstate] ✗ 数据不是 JSON 对象")
        return 1
    if geojson.get("type") != "FeatureCollection":
        print(f"[deepstate] ✗ 不是 FeatureCollection(type={geojson.get('type')})")
        return 1
    features = geojson.get("features", [])
    if not features:
        print(f"[deepstate] ✗ features 为空")
        return 1

    # Attach metadata so 前端可以显示数据时间
    geojson["_meta"] = {
        "source": f"https://github.com/{REPO}",
        "file": fname,
        "fetched_at": date.today().isoformat(),
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(geojson, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    size_kb = OUTPUT.stat().st_size / 1024
    print(f"[deepstate] ✓ {fname}")
    print(f"            → {OUTPUT.relative_to(PROJECT_ROOT)} ({size_kb:.1f} KB, {len(features)} features)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
