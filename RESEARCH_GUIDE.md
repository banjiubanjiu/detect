# 多平台研究工具使用指南

基于实际操作总结的经验，涵盖工具配置、常见问题和最佳实践。

---

## 一、工具概览

| 工具 | 用途 | 安装位置 |
|------|------|----------|
| `/last30days` skill | Reddit/HN/Polymarket 聚合研究 | `.claude/skills/last30days/` |
| `xcrawl` CLI | 网页搜索 + 内容抓取 | 全局 npm（`~/.nvm/.../bin/xcrawl`） |
| `fxtwitter API` | X/Twitter 推文全文获取 | 无需安装，直接 HTTP 调用 |

---

## 二、/last30days 技能

### 配置文件

`~/.config/last30days/.env`

```env
SETUP_COMPLETE=true
FROM_BROWSER=auto
SCRAPECREATORS_API_KEY=xxx        # 必需：Reddit 评论 + TikTok + Instagram
OPENROUTER_API_KEY=sk-or-xxx      # AI 模型（用于搜索和数据提取）
# OPENAI_API_KEY=sk-xxx           # 或用 OpenAI
# XAI_API_KEY=xai-xxx             # 或用 xAI（同时解锁 X/Twitter 搜索）
# INCLUDE_SOURCES=tiktok,instagram # 强制开启 TikTok/Instagram
```

### API Key 选择

| Key | 模型能力 | X/Twitter 搜索 | 获取 |
|-----|---------|---------------|------|
| `OPENAI_API_KEY` | GPT 系列 | 不支持 | platform.openai.com |
| `XAI_API_KEY` | Grok 系列 | 支持 | api.x.ai |
| `OPENROUTER_API_KEY` | 多家模型路由 | 不支持 | openrouter.ai |

**注意：** 至少需要上述三个中的一个，否则脚本无法运行。

### 已知问题与修复

#### 1. Codex 认证冲突（UnicodeEncodeError）

**现象：** 如果 `~/.codex/auth.json` 存在，脚本会自动使用 Codex token 调用 OpenAI API，可能导致编码错误：
```
UnicodeEncodeError: 'latin-1' codec can't encode characters
```

**解决：** 用环境变量覆盖，阻止 Codex token 被使用：
```bash
OPENAI_API_KEY=skip python3 scripts/last30days.py "你的主题"
```

#### 2. INCLUDE_SOURCES 为 None 导致崩溃

**现象：** `AttributeError: 'NoneType' object has no attribute 'split'`

**修复：** 在 `scripts/last30days.py` 第 1740 行：
```python
# 修复前
config.get('INCLUDE_SOURCES', '').split(',')
# 修复后
(config.get('INCLUDE_SOURCES') or '').split(',')
```

#### 3. 智谱/国产模型兼容性

智谱等国产 OpenAI 兼容 API **不能直接使用**。脚本硬编码了 `api.openai.com/v1/models` 端点做模型检测，没有 base_url 配置项。建议用 OpenRouter 作为替代。

### 运行命令

```bash
# 标准运行（有 OpenRouter key）
OPENAI_API_KEY=skip python3 scripts/last30days.py "研究主题"

# 如果有 OpenAI key
python3 scripts/last30days.py "研究主题"

# 如果有 xAI key（同时搜索 X/Twitter）
python3 scripts/last30days.py "研究主题"
```

### 输出

脚本输出结构化的 Reddit 帖子列表，按相关性评分排序，包含标题、分数、评论数和链接。需要 Claude 进一步综合分析。

---

## 三、xcrawl CLI

### 基本命令

```bash
# 搜索
xcrawl search "关键词" --limit 10 --json

# 抓取网页内容
xcrawl scrape "https://example.com" --format markdown --json

# 批量抓取（保存到目录）
xcrawl scrape url1 url2 url3 --format markdown --output ./sources/ --concurrency 3

# 查看剩余额度
xcrawl status
```

### 平台特定搜索技巧

```bash
# 搜索特定平台
xcrawl search "site:x.com 关键词" --limit 10 --json
xcrawl search "site:youtube.com 关键词" --limit 10 --json
xcrawl search "site:reddit.com 关键词" --limit 10 --json

# 指定语言和地区
xcrawl search "关键词" --language zh --country CN --json
```

### 抓取限制

#### 按平台

| 平台 | xcrawl scrape 效果 | 原因 | 替代方案 |
|------|-------------------|------|----------|
| 普通网页 | 正常 | 服务端渲染 HTML | — |
| Reddit | 部分可用 | 大多数可抓，小型子版块偶尔失败 | — |
| X/Twitter | **失败** | 纯 JS SPA，不执行 JavaScript | fxtwitter API |
| YouTube | 页面可抓，视频不可 | 页面元数据可获取，视频内容不可 | yt-dlp 提取字幕 |

#### 抓取失败的网站黑名单（2026-04 实测）

以下网站 xcrawl 免费版**无法抓取**，通常因为反爬保护、付费墙或 JS 渲染：

**主流新闻媒体（付费墙/反爬）：**
| 网站 | 域名 | 原因 |
|------|------|------|
| 纽约时报 | nytimes.com | 付费墙 + 反爬 |
| 彭博社 | bloomberg.com | 付费墙 + 反爬 |
| CNN | cnn.com | JS 渲染 + 反爬 |
| 路透社 | reuters.com | 反爬保护 |
| 卫报 | theguardian.com | 反爬保护 |
| 华尔街日报 | wsj.com | 付费墙 |
| US News | usnews.com | 反爬保护 |

**智库/研究机构：**
| 网站 | 域名 | 原因 |
|------|------|------|
| ISW (战争研究所) | understandingwar.org | 反爬保护 |
| 国际危机组织 | crisisgroup.org | 反爬保护 |
| 查塔姆研究所 | chathamhouse.org | 反爬保护 |
| 布鲁金斯学会 | brookings.edu | 反爬保护 |
| CSIS | csis.org | 反爬保护 |
| 欧洲外交关系委员会 | ecfr.eu | 反爬保护 |
| 美国企业研究所 | aei.org | 反爬保护 |
| 全球台湾研究中心 | globaltaiwan.org | 反爬保护 |
| GMF | gmfus.org | 反爬保护 |
| TIMEP | timep.org | 反爬保护 |
| SNHR | snhr.org | 反爬保护 |

**政府/国际组织：**
| 网站 | 域名 | 原因 |
|------|------|------|
| 美国国会 | congress.gov | 反爬保护 |
| 联合国人权办 | ohchr.org | 超时 |
| 国际红十字会 | ifrc.org | 超时 |
| IRC | rescue.org | 反爬保护 |
| AJC | ajc.org | 反爬保护 |

**地区媒体：**
| 网站 | 域名 | 原因 |
|------|------|------|
| 伊洛瓦底 (缅甸) | irrawaddy.com | 反爬保护 |
| Mizzima (缅甸) | mizzima.com | 反爬保护 |
| 外交官 | thediplomat.com | 反爬保护 |
| 全球安全评论 | globalsecurityreview.com | 反爬保护 |

**Reddit 小型子版块（偶尔失败）：**
- r/zim, r/DebateAnarchism, r/LessCredibleDefence, r/anime_titties 等小型子版块抓取不稳定

#### 可正常抓取的网站（白名单）

| 网站 | 域名 | 备注 |
|------|------|------|
| 半岛电视台 | aljazeera.com | 稳定 |
| 大西洋理事会 | atlanticcouncil.org | 稳定 |
| 自由欧洲电台 | rferl.org | 稳定 |
| Russia Matters (Harvard) | russiamatters.org | 稳定 |
| 维基百科 | wikipedia.org | 稳定 |
| Reddit 主要子版块 | reddit.com | r/worldnews, r/ukraine 等大型版块稳定 |
| X/Twitter (via fxtwitter) | api.fxtwitter.com | 通过 API 获取，稳定 |
| YouTube (via yt-dlp) | youtube.com | 字幕提取稳定，约 70% 视频有字幕 |

#### 应对策略：Jina Reader 作为 xcrawl 的后备

**Jina Reader** (`r.jina.ai`) 是免费的网页转 markdown API，能突破大部分 xcrawl 失败的反爬网站。

```bash
# 基本用法 — 任意 URL 转 markdown
curl -s "https://r.jina.ai/https://www.cnn.com/your-article" -H "Accept: text/markdown"

# 保存到文件
curl -s "https://r.jina.ai/URL" -H "Accept: text/markdown" -o output.md
```

**xcrawl vs Jina Reader 实测对比（2026-04）：**

| 网站 | xcrawl | Jina Reader |
|------|--------|-------------|
| CNN | 失败 | 31K chars |
| NYTimes | 失败 | 62K chars |
| Bloomberg | 失败 | 15K chars |
| ISW (understandingwar.org) | 失败 | 65K chars |
| 国际危机组织 (crisisgroup.org) | 失败 | 30K chars |
| 查塔姆研究所 | 失败 | 待测 |
| Reuters | 失败 | 失败 |

**推荐采集流程（优先级从高到低）：**
1. **Trafilatura**（首选）— `pip install trafilatura`，用 DOM 分析+文本密度算法提取纯正文，F1=0.945，自动过滤导航/页脚/侧边栏
2. **Jina Reader**（后备）— Trafilatura 失败时用，全页面转 markdown（含噪音但聊胜于无）
3. **Al Jazeera 专用** — 直接 curl + HTML `<p>` 标签解析
4. **xcrawl**（最后手段）— 全页面抓取
5. **无原文则不入库** — 所有方法都失败的跳过

**为什么 Trafilatura 优于 Jina Reader / xcrawl：**
- Jina/xcrawl 返回完整页面（导航菜单、页脚、侧边栏都在里面）
- Trafilatura 只返回文章正文，自动过滤所有 chrome
- 实测：CSIS 文章 Jina 返回 45KB（200行导航噪音），Trafilatura 返回 30KB（纯正文）

**Al Jazeera 专用方法：**
Al Jazeera 的 xcrawl 和 Jina Reader 都失败（cookie 弹窗 / HTTP 451），但直接 curl 请求页面 HTML 可以拿到完整内容。用 `<p>` 标签提取文章段落，过滤 UI 噪音（navigation、cookie、share 按钮等），能获取 50+ 段落的完整文章。此方法已集成到 `collect.py` 的 `fetch_aljazeera()` 函数。

**Jina Reader 限制：**
- 免费额度约 200 次/天（付费可扩展）
- 返回内容可能包含广告/导航噪音，需清洗
- 部分付费墙网站仍无法穿透（如 Reuters）

---

## 四、X/Twitter 抓取方案

### 问题

X/Twitter 是纯 JavaScript 渲染的单页应用（SPA）。xcrawl 使用简单 HTTP 请求，不执行 JS，所以拿到的是空壳页面，显示 "JavaScript is not available"。

### 解决方案：fxtwitter API

[fxtwitter](https://github.com/FixTweet/FxTwitter) 提供免费 API，返回推文完整文本的 JSON 数据。

```bash
# 单条推文
curl -s "https://api.fxtwitter.com/{用户名}/status/{推文ID}" | python3 -m json.tool

# 返回结构
{
  "tweet": {
    "text": "完整推文内容...",
    "author": { "name": "...", "screen_name": "..." },
    "created_at": "Mon Mar 30 01:00:00 +0000 2026",
    "likes": 623,
    "retweets": 144,
    "replies": 3
  }
}
```

### 批量抓取脚本

```python
import json, urllib.request, os

tweets = [
    ("用户名", "推文ID"),
    # ...
]

for user, tid in tweets:
    url = f"https://api.fxtwitter.com/{user}/status/{tid}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())
    tweet = data["tweet"]

    with open(f"x_{user}_{tid}.md", "w") as f:
        f.write(f"# {tweet['author']['name']} (@{tweet['author']['screen_name']})\n\n")
        f.write(f"**日期：** {tweet['created_at']}\n")
        f.write(f"**互动：** {tweet['likes']} likes / {tweet['retweets']} RT\n\n---\n\n")
        f.write(tweet["text"])
```

### 其他备选方案

| 方案 | 可行性 | 说明 |
|------|--------|------|
| fxtwitter API | 推荐 | 免费、稳定、返回全文 |
| nitter 实例 | 不稳定 | 公共实例经常下线 |
| Playwright/Puppeteer | 可行但重 | 需要无头浏览器，速度慢 |
| X API (官方) | 付费 | 需要开发者账号 |

---

## 五、YouTube 视频字幕提取

### 工具：yt-dlp

**yt-dlp** 是一个开源命令行工具（github.com/yt-dlp/yt-dlp，190K+ stars），用来从 YouTube 及数千个视频网站下载视频、音频和字幕。它是已停止维护的 `youtube-dl` 的活跃分支，用 Python 编写，Unlicense 许可证（完全免费）。

在研究场景中，我们**只用它提取字幕，不下载视频**——把视频语音转成可读的文字文档，省空间省流量。

**安装位置：** `~/bin/yt-dlp`

**安装命令：**
```bash
mkdir -p ~/bin
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/bin/yt-dlp
chmod +x ~/bin/yt-dlp
```

### 常用命令

```bash
# 只提取字幕，不下载视频（研究场景最常用）
~/bin/yt-dlp --write-auto-sub --sub-lang en --skip-download --sub-format vtt -o "/tmp/output" "YouTube链接"
# 生成 /tmp/output.en.vtt（WebVTT 格式文本文件）

# 下载视频
~/bin/yt-dlp "YouTube链接"

# 只下载音频（MP3）
~/bin/yt-dlp -x --audio-format mp3 "YouTube链接"

# 下载整个播放列表
~/bin/yt-dlp "播放列表链接"

# 列出可用的视频/音频格式
~/bin/yt-dlp -F "YouTube链接"

# 指定中文字幕
~/bin/yt-dlp --write-auto-sub --sub-lang zh --skip-download "YouTube链接"

# 同时提取多种语言字幕
~/bin/yt-dlp --write-auto-sub --sub-lang "en,zh" --skip-download "YouTube链接"
```

### 关键参数说明

| 参数 | 作用 |
|------|------|
| `--write-auto-sub` | 提取自动生成的字幕（YouTube 语音识别） |
| `--write-sub` | 提取手动上传的字幕（质量更高） |
| `--sub-lang en` | 指定字幕语言 |
| `--skip-download` | 不下载视频文件 |
| `--sub-format vtt` | 字幕格式（vtt/srt/ass） |
| `-o "路径"` | 输出路径 |
| `-x --audio-format mp3` | 只提取音频 |
| `-F` | 列出可用格式 |

### 支持的网站（不止 YouTube）

YouTube、Bilibili、Twitter/X、TikTok、Instagram、Vimeo、Dailymotion 等数千个站点。完整列表见 `~/bin/yt-dlp --list-extractors`。

### VTT 转纯文本

```python
import re

with open("output.en.vtt") as f:
    vtt = f.read()

lines = vtt.split("\n")
seen = set()
texts = []
for line in lines:
    line = line.strip()
    if not line or line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:"):
        continue
    if "-->" in line or re.match(r'^\d+$', line):
        continue
    clean = re.sub(r'<[^>]+>', '', line)  # 去 HTML 标签
    if clean and clean not in seen:
        seen.add(clean)
        texts.append(clean)

full_text = " ".join(texts)
```

### 限制

| 情况 | 结果 |
|------|------|
| 有自动字幕（大多数英语视频） | 可提取完整文字 |
| 有手动字幕 | 质量更高 |
| 无字幕（部分短视频/非英语） | 无法提取，约占 30-50% |
| 需要登录才能看的视频 | 需要配置 cookies |

### 替代方案对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| `yt-dlp`（推荐） | 免费、本地运行、无 API 限制 | 需安装、部分视频无字幕 |
| `youtube-transcript-api`（Python） | 纯 Python、无需安装二进制 | 需要 pip |
| Invidious API | 不需本地工具 | 公共实例不稳定，字幕下载常为空 |
| Whisper（本地语音转文字） | 支持所有视频 | 需下载视频 + GPU，速度慢 |
| 付费 API（AssemblyAI 等） | 高准确度 | 需付费 |

---

## 六、推荐研究流程

### 第一步：多平台搜索

```bash
# 1. Reddit + HN + Polymarket（via last30days）
OPENAI_API_KEY=skip python3 scripts/last30days.py "主题"

# 2. X/Twitter（via xcrawl 搜索）
xcrawl search "site:x.com 主题" --limit 10 --json

# 3. YouTube（via xcrawl 搜索）
xcrawl search "site:youtube.com 主题" --limit 10 --json

# 4. 权威网页（via xcrawl 搜索）
xcrawl search "主题" --limit 10 --json
```

### 第二步：抓取原文

```bash
# 网页和 Reddit
xcrawl scrape url1 url2 --format markdown --output ./sources/web/

# X/Twitter（用 fxtwitter API）
curl -s "https://api.fxtwitter.com/user/status/id"
```

### 第三步：生成报告

建议报告结构：
```
项目根目录/
├── research_report.md          # 概要报告
│   ├── 每条信息附 📎在线链接
│   └── 每条信息附 📄本地原文路径
└── sources/                    # 原文目录
    ├── reddit/                 # Reddit 帖子 + 评论
    ├── x/                      # X/Twitter 推文全文
    ├── web/                    # 网页文章
    └── youtube/                # （视频仅链接）
```

---

## 六、费用与额度

| 服务 | 费用模式 | 当前状态 |
|------|---------|---------|
| xcrawl | 按次计费（1000 credits 起） | 可用 `xcrawl status` 查看 |
| ScrapeCreators | 100 次免费，之后付费 | scrapecreators.com |
| OpenRouter | 按 token 计费 | openrouter.ai |
| fxtwitter API | 免费 | 无需注册 |

---

## 七、环境注意事项

### WSL 环境限制

- `FROM_BROWSER=auto` 无法扫描 Windows 浏览器的 cookies（WSL 与 Windows 文件系统隔离）
- 如需 X/Twitter cookies，需手动从 Windows 浏览器提取 `AUTH_TOKEN` 和 `CT0`：
  1. Windows 浏览器登录 x.com
  2. F12 → Application → Cookies → x.com
  3. 复制 `auth_token` 和 `ct0` 值
  4. 写入 `~/.config/last30days/.env`

### 文件权限

```bash
# 修复 .env 文件权限警告
chmod 600 ~/.config/last30days/.env
```
