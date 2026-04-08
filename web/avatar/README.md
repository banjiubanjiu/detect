# AI 数字人主播

阿里 **Wan2.2-S2V** 生成嘴型同步视频。脚本：`scripts/generate_avatar_briefing.py`。

**默认按需触发** — 不绑在每日 collect 流程里，避免烧钱。想生成新视频时手动触发 `Generate Avatar Briefing` workflow（一次 ~$1.30）。生成的视频 commit 到 repo 后永久保留，前端一直可看。

## 目录结构

```
web/avatar/
├── README.md            ← 本文件
├── manifest.json        ← 自动维护，前端读取这里加载视频
├── audio/
│   └── YYYY-MM-DD.mp3   ← edge-tts 合成的播报音频 (≤20s)
└── videos/
    └── YYYY-MM-DD.mp4   ← Wan-S2V 生成的嘴型同步视频
```

## 启用步骤（一次性配置）

### 1. 添加 GitHub Secrets

在仓库 Settings → Secrets and variables → Actions 添加：

| Secret | 说明 |
|---|---|
| `DASHSCOPE_API_KEY` | 阿里百炼 API key (sk-...) |
| `ANCHOR_IMAGE_URL` | 主播参考图的**公网直链 URL** |

`OPENROUTER_API_KEY` 已存在（复用现有简报流程）。

### 2. 准备主播参考图

要求（来自 Wan2.2-S2V）：
- 格式：JPG / JPEG / PNG / BMP / WEBP
- 尺寸：宽高 400–7000 px
- 内容：**单人正面**、清晰、表情中性
- 风格建议：严肃新闻主播形象，深色背景，肩部以上半身

托管方式（任选）：
- **方案 A（推荐）**：上传到 [imgur.com](https://imgur.com)，复制直链（注意要 `i.imgur.com/xxxx.jpg` 这种直链而不是页面 URL）
- **方案 B**：commit 一张 `web/avatar/anchor.jpg` 进 repo，URL 是 `https://raw.githubusercontent.com/<owner>/<repo>/main/web/avatar/anchor.jpg`
- **方案 C**：阿里 OSS / Cloudinary / 任何静态图床

把最终 URL 设到 `ANCHOR_IMAGE_URL` secret。

## 退化策略

| 缺什么 | 表现 |
|---|---|
| 缺 `DASHSCOPE_API_KEY` | 只生成音频，前端隐藏视频卡 |
| 缺 `ANCHOR_IMAGE_URL` | 同上，manifest.status = `no_anchor_image` |
| Wan-S2V 失败 | 同上，manifest.status = `video_failed` + error |
| `litterbox.catbox.moe` 不可达 | 视频生成失败但其他 CI 步骤不受影响 |

整个流程被设计成**任何一步失败都不中断主 CI 管道**。

## 触发生成

**远程（推荐 demo 用）**：
```bash
# 默认 480P, 不强制重跑
gh workflow run "Generate Avatar Briefing"

# 高清 + 强制重跑当日
gh workflow run "Generate Avatar Briefing" -f resolution=720P -f force=true
```

**本地测试**：
```bash
# 只跑 LLM + TTS, 跳过视频 (验证音频, 0 成本)
python3 scripts/generate_avatar_briefing.py --dry-run

# 完整跑
DASHSCOPE_API_KEY=sk-xxx \
ANCHOR_IMAGE_URL=https://i.imgur.com/your-anchor.jpg \
python3 scripts/generate_avatar_briefing.py --force
```

## 成本估算

| 视频长度 | 480P | 720P |
|---|---|---|
| 每秒 | $0.0717 | $0.1290 |
| **18 秒 (典型头条) 单次** | **$1.29** | **$2.32** |
| 每天跑 (30 天) | $39 | $70 |
| **按需手动 (5 次/月)** | **$6.5** | **$12** |

TTS 用 edge-tts（微软 Azure 免费），不消耗 DashScope token。

**Demo 建议**：手动触发一次生成今日视频，commit 进 repo 永久可看。除非内容大幅更新，否则不需要重跑。

## 模型 / 参数

- **视频模型**：`wan2.2-s2v`（替代了旧 EMO，效果更好）
- **TTS 引擎**：`edge-tts` `zh-CN-XiaoxiaoNeural`（语速 -5%，音调 -2Hz，模拟新闻播报节奏）
- **音频上限**：20 秒（Wan-S2V 硬限制）→ 头条压缩到 ≤55 字
- **区域限制**：Wan-S2V 仅北京区域可用，需要使用华北 region 的 DashScope key
