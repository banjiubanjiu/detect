#!/usr/bin/env python3
"""扫描 sources/ 下所有缺少 .zh.md 的文件，批量翻译。

设计原则:
- 每次只翻译固定数量（默认 30 篇），可控制单次运行时长
- 按文件 mtime 倒序，优先翻最新的文章
- 每篇翻译失败不影响其他
- 完成后退出，由 CI 负责 commit & push

用法:
  python3 scripts/translate_pending.py        # 默认翻译 30 篇
  python3 scripts/translate_pending.py 50     # 翻译 50 篇
  python3 scripts/translate_pending.py 0      # 翻译全部（不限量）
"""

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from collect import translate_file

PROJECT_ROOT = Path(__file__).parent.parent
SOURCES_DIR = PROJECT_ROOT / "data" / "sources"

DEFAULT_LIMIT = 30
WORKERS = 5
MIN_FILE_SIZE = 200  # 跳过过小的文件


def find_untranslated(limit=DEFAULT_LIMIT):
    """找出所有缺少 .zh.md 的源文件，按 mtime 降序排列。

    Args:
        limit: 最大返回数量，0 表示不限。

    Returns:
        list[Path]: 待翻译文件路径列表
    """
    if not SOURCES_DIR.exists():
        return []

    pending = []
    for subdir in sorted(SOURCES_DIR.iterdir()):
        if not subdir.is_dir():
            continue
        for md in subdir.glob("*.md"):
            if md.name.endswith(".zh.md"):
                continue
            zh = md.with_suffix(".zh.md")
            if zh.exists() and zh.stat().st_size > MIN_FILE_SIZE:
                continue
            if md.stat().st_size < MIN_FILE_SIZE:
                continue
            pending.append(md)

    # 按修改时间降序：优先翻译最新文章
    pending.sort(key=lambda p: p.stat().st_mtime, reverse=True)

    if limit > 0:
        pending = pending[:limit]
    return pending


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_LIMIT
    print(f"═══ 翻译 pending 文章 (limit={limit if limit > 0 else '不限'}) ═══")

    # 一次扫描拿全量，再切片
    all_pending = find_untranslated(limit=0)
    if not all_pending:
        print("✓ 没有需要翻译的文章")
        return 0

    pending = all_pending[:limit] if limit > 0 else all_pending
    print(f"待翻译总数: {len(all_pending)}")
    print(f"本次处理: {len(pending)} 篇")
    print()

    start = time.time()
    ok = 0
    failed = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(translate_file, str(fp)): fp for fp in pending}
        for i, future in enumerate(as_completed(futures), 1):
            fp = futures[future]
            try:
                future.result()
                zh = fp.with_suffix(".zh.md")
                if zh.exists() and zh.stat().st_size > MIN_FILE_SIZE:
                    ok += 1
                    elapsed = time.time() - start
                    print(f"  [{i:3d}/{len(pending)}] ✓ {fp.name[:60]} ({elapsed:.0f}s)")
                else:
                    failed += 1
                    print(f"  [{i:3d}/{len(pending)}] ✗ {fp.name[:60]} (空输出)")
            except Exception as e:
                failed += 1
                print(f"  [{i:3d}/{len(pending)}] ✗ {fp.name[:60]}: {e}")

    elapsed = time.time() - start
    remaining = len(all_pending) - ok
    print()
    print(f"═══ 完成: {ok} 成功 / {failed} 失败 / 耗时 {elapsed:.0f}s ═══")
    print(f"剩余待翻译: {remaining} 篇")

    return 0 if ok > 0 or len(pending) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
