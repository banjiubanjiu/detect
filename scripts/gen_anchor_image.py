#!/usr/bin/env python3
"""
通义万相 wan2.6-t2i 文生图 — 生成数字人主播参考图

用法:
  DASHSCOPE_API_KEY=sk-xxx \
  python3 scripts/gen_anchor_image.py \
    --prompt "严肃专业的中国男新闻主播,正面凝视镜头,深色西装,纯灰色背景,肩部以上半身,影棚打光,4K 摄影,新闻联播风格" \
    --out /tmp/anchor_male.jpg \
    --size 1024*1024

关键参数:
  parameters.watermark = False  ← 关闭默认 AI 生成水印
  parameters.prompt_extend = True ← 让阿里自动扩写提示词,效果通常更好
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

SUBMIT_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation"
TASK_URL = "https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"


def submit(prompt, dashscope_key, model="wan2.6-t2i", size="1024*1024", n=1):
    body = {
        "model": model,
        "input": {
            "messages": [
                {"role": "user", "content": [{"text": prompt}]}
            ]
        },
        "parameters": {
            "prompt_extend": True,
            "watermark": False,
            "n": n,
            "size": size,
        },
    }
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        SUBMIT_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {dashscope_key}",
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"submit HTTP {e.code}: {body_err[:600]}")
    task_id = (result.get("output") or {}).get("task_id")
    if not task_id:
        raise RuntimeError(f"无 task_id: {json.dumps(result)[:300]}")
    return task_id


def poll(task_id, dashscope_key, interval=4, timeout=300):
    deadline = time.time() + timeout
    last_status = None
    while time.time() < deadline:
        req = urllib.request.Request(
            TASK_URL.format(task_id=task_id),
            headers={"Authorization": f"Bearer {dashscope_key}"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
        out = result.get("output") or {}
        status = out.get("task_status")
        if status != last_status:
            print(f"  task={task_id[:12]}... status={status}", flush=True)
            last_status = status
        if status == "SUCCEEDED":
            choices = out.get("choices") or []
            if not choices:
                # 老版本字段
                results = out.get("results") or []
                if results and results[0].get("url"):
                    return [r["url"] for r in results]
                raise RuntimeError(f"SUCCEEDED 但无 image: {json.dumps(result)[:400]}")
            urls = []
            for c in choices:
                content = c.get("message", {}).get("content", [])
                for item in content:
                    if "image" in item:
                        urls.append(item["image"])
            if not urls:
                raise RuntimeError(f"choices 里无 image: {json.dumps(result)[:400]}")
            return urls
        if status in ("FAILED", "CANCELED", "UNKNOWN"):
            raise RuntimeError(f"task {status}: {json.dumps(result)[:500]}")
        time.sleep(interval)
    raise RuntimeError(f"poll 超时 {timeout}s")


def download(url, out_path):
    req = urllib.request.Request(url, headers={"User-Agent": "ConflictTracker-Avatar/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        with open(out_path, "wb") as f:
            f.write(resp.read())
    return out_path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prompt", required=True)
    p.add_argument("--out", required=True, help="本地保存路径")
    p.add_argument("--size", default="1024*1024")
    p.add_argument("--model", default="wan2.6-t2i")
    args = p.parse_args()

    key = os.environ.get("DASHSCOPE_API_KEY")
    if not key:
        print("[错误] 无 DASHSCOPE_API_KEY", file=sys.stderr)
        sys.exit(1)

    print(f"[gen] prompt: {args.prompt[:80]}...")
    task_id = submit(args.prompt, key, model=args.model, size=args.size)
    print(f"[gen] task_id={task_id}")
    urls = poll(task_id, key)
    print(f"[gen] {len(urls)} 张图")
    for i, url in enumerate(urls):
        out = args.out if len(urls) == 1 else args.out.replace(".", f"_{i}.", 1)
        print(f"[download] {url[:80]}... → {out}")
        download(url, out)
    print("[done]")


if __name__ == "__main__":
    main()
