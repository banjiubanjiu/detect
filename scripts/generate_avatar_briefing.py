#!/usr/bin/env python3
"""
AI 数字人简报生成器 — 阿里 Wan2.2-S2V

两种模式：
  A) 命令行直接给文案 (用于 demo / 一次性生成):
     python3 scripts/generate_avatar_briefing.py \
         --text "今日全球冲突..." \
         --slug 01 \
         --image-url https://files.catbox.moe/xxx.jpg

  B) 从 latest.json 读 briefing + LLM 自动压头条 (用于 weekly cron):
     OPENROUTER_API_KEY=... \
     DASHSCOPE_API_KEY=... \
     ANCHOR_IMAGE_URL=https://... \
     python3 scripts/generate_avatar_briefing.py --slug auto

输出:
  web/avatar/videos/{date}-{slug}.mp4
  web/avatar/audio/{date}-{slug}.mp3
  web/avatar/config.json   (前端读这个)

环境变量 (B 模式必需):
  DASHSCOPE_API_KEY    阿里百炼 key
  ANCHOR_IMAGE_URL     主播图公网直链
  OPENROUTER_API_KEY   LLM 压头条 (B 模式必需, A 模式不需要)
  AVATAR_RESOLUTION    480P (默认) 或 720P
  AVATAR_VOICE         默认 zh-CN-XiaoxiaoNeural

依赖:
  pip install edge-tts
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent
LATEST_JSON = PROJECT_ROOT / "data" / "latest.json"
AVATAR_DIR = PROJECT_ROOT / "web" / "avatar"
AUDIO_DIR = AVATAR_DIR / "audio"
VIDEO_DIR = AVATAR_DIR / "videos"
CONFIG_PATH = AVATAR_DIR / "config.json"

WAN_SUBMIT_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis"
WAN_TASK_URL = "https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"
DASHSCOPE_UPLOAD_POLICY_URL = "https://dashscope.aliyuncs.com/api/v1/uploads"
WAN_MODEL = "wan2.2-s2v"
DEFAULT_ANCHOR_IMAGE = PROJECT_ROOT / "web" / "avatar" / "anchor.jpg"

DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
DEFAULT_RES = "480P"
HEADLINE_MAX_CHARS = 70  # 中文 ~3.8 字/秒 → 70 字 ≈ 18 秒, 留余量给 20s 上限

POLL_INTERVAL = 6
POLL_TIMEOUT = 600
MAX_VIDEOS_IN_CONFIG = 6  # config.json 保留最近 N 条


# ─────────────────────────── env / key 加载 ───────────────────────────

def _load_env_file_keys():
    env_file = Path.home() / ".config" / "last30days" / ".env"
    if not env_file.exists():
        return {}
    out = {}
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def get_env(name):
    val = os.environ.get(name)
    if val:
        return val
    return _load_env_file_keys().get(name)


# ─────────────────────────── LLM: 压头条 (B 模式) ───────────────────────────

LLM_SYSTEM = """你是新闻播报撰稿人,为 AI 主播改写情报简报。

要求：
- 输出**一句话**中文播报词,不超过 70 个汉字
- 语气客观冷静,新闻联播风格,不煽情
- 突出当日**最重要的一个**事件或趋势,不要平均着力
- 不用 markdown,不用 emoji,不要标题,不要破折号
- 直接以"今日"或具体地点开头,不要"以下"等过渡词
- 末尾必须是句号"""


def llm_compress_headline(briefing_text, openrouter_key):
    payload = json.dumps({
        "model": "google/gemini-2.0-flash-001",
        "messages": [
            {"role": "system", "content": LLM_SYSTEM},
            {"role": "user", "content": f"原文简报：\n\n{briefing_text}\n\n请输出一句话播报词："},
        ],
        "max_tokens": 200,
        "temperature": 0.4,
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {openrouter_key}",
            "Content-Type": "application/json",
            "User-Agent": "ConflictTracker-Avatar/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read().decode())
    text = result["choices"][0]["message"]["content"].strip()
    text = re.sub(r"[\*#`>\n\r]+", "", text).strip()
    text = text.strip("\"'「」『』""''")
    if len(text) > HEADLINE_MAX_CHARS:
        cut = text[:HEADLINE_MAX_CHARS]
        for punc in "。;！？，":
            idx = cut.rfind(punc)
            if idx > HEADLINE_MAX_CHARS - 15:
                cut = cut[:idx + 1]
                break
        text = cut
        if not text.endswith(("。", "！", "？")):
            text = text.rstrip("，；、") + "。"
    return text


# ─────────────────────────── TTS via edge-tts ───────────────────────────

def synthesize_tts(text, out_path, voice=DEFAULT_VOICE):
    try:
        import edge_tts
    except ImportError:
        raise RuntimeError("缺少 edge-tts 包: pip install edge-tts")
    import asyncio

    async def _run():
        comm = edge_tts.Communicate(text, voice, rate="-5%", pitch="-2Hz")
        await comm.save(str(out_path))

    asyncio.run(_run())
    return out_path


# ─────────────────────────── DashScope 文件上传 (推荐: 阿里内网, 无墙) ───────────────────────────

def _multipart_encode(fields, file_field, file_path, file_mime):
    """通用 multipart/form-data 编码 (urllib stdlib 实现)

    fields: dict[str, str] 普通字段
    file_field: 文件字段名
    file_path: Path
    返回 (body_bytes, boundary)
    """
    boundary = "----dashAvatar" + uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode("utf-8")
        )
    parts.append(
        (f'--{boundary}\r\n'
         f'Content-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'
         f'Content-Type: {file_mime}\r\n\r\n').encode("utf-8")
    )
    parts.append(file_path.read_bytes())
    parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), boundary


def dashscope_upload_file(local_path, dashscope_key, model=WAN_MODEL):
    """把本地文件上传到 DashScope 临时 OSS,返回 oss:// URL (有效 48h)

    流程:
      1. GET /api/v1/uploads?action=getPolicy&model=xxx 拿上传凭证
      2. multipart POST 到 upload_host (返回的 OSS 端点)
      3. 拼出 oss://{upload_dir}/{filename}

    调 wan2.2-s2v 时必须配套加 header X-DashScope-OssResourceResolve: enable
    """
    local_path = Path(local_path)
    if not local_path.exists():
        raise FileNotFoundError(f"上传源文件不存在: {local_path}")

    # ── 1. 拿上传凭证 ──
    url = f"{DASHSCOPE_UPLOAD_POLICY_URL}?action=getPolicy&model={model}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {dashscope_key}",
            "User-Agent": "ConflictTracker-Avatar/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            policy_resp = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"获取上传凭证失败 HTTP {e.code}: {body[:400]}")

    data = policy_resp.get("data") or {}
    required = ["upload_host", "upload_dir", "policy", "signature", "oss_access_key_id"]
    for k in required:
        if k not in data:
            raise RuntimeError(f"上传凭证缺字段 {k}: {json.dumps(policy_resp)[:300]}")

    # ── 2. 上传到 OSS ──
    object_key = f"{data['upload_dir']}/{local_path.name}"
    mime = "image/jpeg" if local_path.suffix.lower() in (".jpg", ".jpeg") else \
           "image/png"  if local_path.suffix.lower() == ".png" else \
           "audio/mpeg" if local_path.suffix.lower() == ".mp3" else \
           "audio/wav"  if local_path.suffix.lower() == ".wav" else \
           "application/octet-stream"

    fields = {
        "OSSAccessKeyId": data["oss_access_key_id"],
        "policy": data["policy"],
        "Signature": data["signature"],
        "x-oss-object-acl": data.get("x_oss_object_acl", "private"),
        "x-oss-forbid-overwrite": data.get("x_oss_forbid_overwrite", "true"),
        "key": object_key,
        "success_action_status": "200",
    }
    body, boundary = _multipart_encode(fields, "file", local_path, mime)
    req2 = urllib.request.Request(
        data["upload_host"],
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "ConflictTracker-Avatar/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req2, timeout=180) as resp:
            status = resp.status
            if status not in (200, 204):
                raise RuntimeError(f"OSS upload status={status}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OSS upload HTTP {e.code}: {body[:500]}")

    # ── 3. 拼 oss URL ──
    return f"oss://{object_key}"


# ─────────────────────────── Wan-S2V 调用 ───────────────────────────

def wan_submit(image_url, audio_url, dashscope_key, resolution=DEFAULT_RES):
    body = {
        "model": "wan2.2-s2v",
        "input": {
            "image_url": image_url,
            "audio_url": audio_url,
        },
        "parameters": {
            "resolution": resolution,
        },
    }
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        WAN_SUBMIT_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {dashscope_key}",
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
            "X-DashScope-OssResourceResolve": "enable",  # 必须,让北京 region 解析 oss:// URL
            "User-Agent": "ConflictTracker-Avatar/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise RuntimeError(
            f"wan_submit HTTP {e.code}: {err_body[:600]}\n"
            f"  request body: {json.dumps(body, ensure_ascii=False)[:300]}"
        )
    task_id = (result.get("output") or {}).get("task_id")
    if not task_id:
        raise RuntimeError(f"wan_submit 没拿到 task_id: {json.dumps(result)[:300]}")
    return task_id


def wan_poll(task_id, dashscope_key, interval=POLL_INTERVAL, timeout=POLL_TIMEOUT):
    deadline = time.time() + timeout
    last_status = None
    while time.time() < deadline:
        req = urllib.request.Request(
            WAN_TASK_URL.format(task_id=task_id),
            headers={"Authorization": f"Bearer {dashscope_key}"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode())
        output = result.get("output") or {}
        status = output.get("task_status")
        if status != last_status:
            print(f"  [wan] task={task_id[:12]}... status={status}", flush=True)
            last_status = status
        if status == "SUCCEEDED":
            video_url = (output.get("results") or {}).get("video_url")
            if not video_url:
                raise RuntimeError(f"SUCCEEDED 但无 video_url: {json.dumps(result)[:300]}")
            return video_url, result.get("usage", {})
        if status in ("FAILED", "CANCELED", "UNKNOWN"):
            raise RuntimeError(f"wan task {status}: {json.dumps(result)[:500]}")
        time.sleep(interval)
    raise RuntimeError(f"wan_poll 超时 {timeout}s")


def download_video(video_url, out_path):
    req = urllib.request.Request(video_url, headers={"User-Agent": "ConflictTracker-Avatar/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        out_path.write_bytes(resp.read())
    return out_path


# ─────────────────────────── config.json 维护 ───────────────────────────

def update_config(entry):
    """更新 web/avatar/config.json

    结构:
      {
        "videos": [{slug, date, headline, video, voice, generated_at}, ...],
        "updated_at": "..."
      }

    主键 (date, slug) 去重,新条目替换。按 date desc, slug asc 排序。
    最多保留 MAX_VIDEOS_IN_CONFIG 条。
    """
    config = {"videos": [], "updated_at": ""}
    if CONFIG_PATH.exists():
        try:
            config = json.loads(CONFIG_PATH.read_text())
            if not isinstance(config.get("videos"), list):
                config["videos"] = []
        except Exception:
            config = {"videos": [], "updated_at": ""}

    key = (entry["date"], entry["slug"])
    videos = [v for v in config["videos"] if (v.get("date"), v.get("slug")) != key]
    videos.append(entry)
    videos.sort(key=lambda v: (v.get("date", ""), v.get("slug", "")), reverse=True)
    videos = videos[:MAX_VIDEOS_IN_CONFIG]

    config["videos"] = videos
    config["updated_at"] = datetime.now(timezone.utc).isoformat()

    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, ensure_ascii=False, indent=2))


# ─────────────────────────── main ───────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="生成数字人简报视频")
    p.add_argument("--text", help="直接指定播报词 (≤70 字)。不传则从 latest.json + LLM 自动生成")
    p.add_argument("--slug", default="main", help="视频槽位标识 (默认 main)。同 date+slug 会覆盖")
    p.add_argument("--image", help="主播图 — 本地路径或 http/https/oss URL。不传则用 web/avatar/anchor.jpg")
    p.add_argument("--resolution", default=None, choices=["480P", "720P"])
    p.add_argument("--dry-run", action="store_true", help="只生成音频,不调 Wan-S2V (0 成本测试)")
    p.add_argument("--force", action="store_true", help="即使该 slot 当日已有视频也重跑")
    return p.parse_args()


def main():
    args = parse_args()
    print(f"═══ AI 数字人简报生成 {datetime.now().strftime('%Y-%m-%d %H:%M')} ═══", flush=True)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # ─── 取得文案 ───
    if args.text:
        # 模式 A: 命令行直接给
        headline = args.text.strip()
        if len(headline) > HEADLINE_MAX_CHARS:
            print(f"  [警告] --text {len(headline)} 字超过 {HEADLINE_MAX_CHARS},可能超 20s 上限")
        date_str = today
        print(f"  [text] 直接使用命令行文案 ({len(headline)} 字)")
    else:
        # 模式 B: 从 latest.json 读 + LLM 压
        if not LATEST_JSON.exists():
            print(f"  [错误] {LATEST_JSON} 不存在,且未传 --text")
            sys.exit(1)
        data = json.loads(LATEST_JSON.read_text())
        briefing_text = data.get("briefing", "").strip()
        if not briefing_text:
            print("  [错误] data/latest.json 没有 briefing 字段,且未传 --text")
            sys.exit(1)
        date_str = data.get("briefing_date") or today
        openrouter_key = get_env("OPENROUTER_API_KEY")
        if not openrouter_key:
            print("  [错误] 无 OPENROUTER_API_KEY,无法压缩头条 (或改用 --text 手动指定)")
            sys.exit(1)
        print(f"  [llm] 从 briefing ({len(briefing_text)} 字) 压缩为头条...", flush=True)
        headline = llm_compress_headline(briefing_text, openrouter_key)
        print(f"  [llm] {len(headline)} 字: {headline}")

    print(f"  [info] date={date_str}, slug={args.slug}")

    # ─── 同 slot 已有视频则跳过 (除非 --force) ───
    if not args.force and CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text())
            for v in cfg.get("videos", []):
                if v.get("date") == date_str and v.get("slug") == args.slug and v.get("video"):
                    print(f"  [跳过] {date_str}/{args.slug} 已有视频: {v['video']} (用 --force 重跑)")
                    return
        except Exception:
            pass

    # ─── TTS ───
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    voice = os.environ.get("AVATAR_VOICE", DEFAULT_VOICE)
    audio_path = AUDIO_DIR / f"{date_str}-{args.slug}.mp3"
    print(f"  [tts] {voice} → {audio_path.name}", flush=True)
    synthesize_tts(headline, audio_path, voice=voice)
    audio_size_kb = audio_path.stat().st_size / 1024
    print(f"  [tts] OK ({audio_size_kb:.1f} KB)")

    entry = {
        "slug": args.slug,
        "date": date_str,
        "headline": headline,
        "audio": f"avatar/audio/{audio_path.name}",
        "video": None,
        "voice": voice,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    # ─── Wan-S2V ───
    dashscope_key = get_env("DASHSCOPE_API_KEY")
    image_arg = (args.image or os.environ.get("ANCHOR_IMAGE_URL", "")).strip()
    resolution = args.resolution or os.environ.get("AVATAR_RESOLUTION", DEFAULT_RES)

    # 默认主播图: web/avatar/anchor.jpg
    if not image_arg and DEFAULT_ANCHOR_IMAGE.exists():
        image_arg = str(DEFAULT_ANCHOR_IMAGE)

    if args.dry_run:
        print("  [dry-run] 跳过视频生成")
    elif not dashscope_key:
        print("  [跳过] 无 DASHSCOPE_API_KEY,只生成音频")
    elif not image_arg:
        print(f"  [跳过] 无 --image / ANCHOR_IMAGE_URL,且 {DEFAULT_ANCHOR_IMAGE.name} 不存在")
    else:
        try:
            # 图: 公网 URL 直接用; 否则视为本地路径,上传到 dashscope
            if image_arg.startswith(("http://", "https://", "oss://")):
                anchor_remote = image_arg
                print(f"  [image] 使用远程 URL: {anchor_remote[:80]}")
            else:
                print(f"  [upload] 上传主播图 → DashScope OSS...", flush=True)
                anchor_remote = dashscope_upload_file(image_arg, dashscope_key)
                print(f"  [upload] {anchor_remote}")

            print(f"  [upload] 上传音频 → DashScope OSS...", flush=True)
            audio_remote = dashscope_upload_file(audio_path, dashscope_key)
            print(f"  [upload] {audio_remote}")

            print(f"  [wan] 提交 wan2.2-s2v (resolution={resolution})", flush=True)
            task_id = wan_submit(anchor_remote, audio_remote, dashscope_key, resolution=resolution)
            print(f"  [wan] task_id={task_id}")

            video_url, usage = wan_poll(task_id, dashscope_key)
            print(f"  [wan] OK: {video_url[:80]}...")
            print(f"  [wan] usage: {usage}")

            video_path = VIDEO_DIR / f"{date_str}-{args.slug}.mp4"
            download_video(video_url, video_path)
            video_size_mb = video_path.stat().st_size / 1024 / 1024
            print(f"  [download] {video_path.name} ({video_size_mb:.2f} MB)")

            entry["video"] = f"avatar/videos/{video_path.name}"
            entry["resolution"] = resolution
            entry["usage"] = usage
        except Exception as e:
            print(f"  [错误] 视频生成失败: {e}", file=sys.stderr)
            entry["error"] = str(e)[:300]

    update_config(entry)
    status = "ok" if entry.get("video") else "audio_only"
    print(f"  [config] {CONFIG_PATH.relative_to(PROJECT_ROOT)} status={status}")
    print(f"═══ 完成 ═══")


if __name__ == "__main__":
    main()
