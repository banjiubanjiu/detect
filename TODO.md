# 采集管道待优化项

## 数据源接入优化

### X/Twitter: 用原生 API 替代搜索引擎中转
当前通过 xcrawl 搜 `site:x.com` 获取推文，走的是搜索引擎而非 Twitter 时间线。搜索引擎按相关性排序，热门旧推文长期占据 top 结果，新推文难以被发现。

**方案:** 用 Twitter 搜索 API（或 Nitter RSS）按时间倒序拉取最新推文，fxtwitter 仅作为内容获取层。

### Reddit: 用 Reddit JSON API 替代搜索引擎中转
同上问题。Reddit 有公开的 JSON API（`/r/{subreddit}/new.json`），可以直接按时间排序获取最新帖子。

**方案:** 对每个冲突配置相关 subreddit 列表（如 r/ukraine, r/geopolitics），直接拉 new/hot 帖子。

### Web: 提高 limit 或引入 RSS
xcrawl 搜索结果排序稳定，每天搜同一个 query 返回的 top 5 几乎不变。新文章往往排在后面。

**方案:**
1. 提高 limit 到 10-15，增加捕获新内容的概率
2. 对高频更新的来源（如 Crisis Group、ISW）配置 RSS 订阅，不依赖搜索引擎

## 搜索效率优化

### `after:` 时间过滤可能无效
xcrawl 底层搜索引擎不确定是否支持 Google 的 `after:` 语法。即使支持，精度只到天，对每日采集无实质帮助。

**方案:** 不依赖搜索引擎的时间过滤，改为在采集后根据内容的真实发布日期过滤。搜索正常执行，仅保留发布日期在时间窗口内的条目。

### 每次搜索结果大部分是旧内容
每天同一 query 返回的结果高度重叠，写入去重跳过后实际新增很少，但搜索 API 调用已经浪费了。

**方案:** 结合 RSS + API 直接获取增量（见上），减少对搜索引擎的依赖。

## 内容质量优化

### 标题应为概要而非正文截断
当前推文标题是 `tweet.text[:80]`，直接截断正文前 80 字符。对于长推文会截断在句子中间，对于短推文则标题和摘要完全重复。理想的标题应该是一句话概要。

**方案:** 用 LLM 生成一行标题摘要（<30 字），类似新闻标题风格。可以和 `translate_item` 合并为一次 API 调用，同时完成翻译和摘要生成。Web 文章和 Reddit 帖子同理。

---

# 功能路线图（调研自同类 OSINT 平台）

## 第一梯队 — 高优先级

### [进行中] GDELT 集成
接入 GDELT（全球事件数据库），15分钟更新、100+语言、回溯至1979年、免费 API。Python 包 `gdelt` 可直接调用。作为结构化冲突事件数据补充进 `latest.json`，每条事件自带地理坐标和事件编码。

**参考:** OSINT War Room (Hue-Jhan/OSINT-War-Room)

### [进行中] 信源偏见与可信度标签
给每个信源标注地理来源、政治倾向、可信度等级（如：西方主流/地区媒体/独立记者/社交媒体）。已有 `source_label` 字段，需新增 `credibility_tier` 和 `bias_label`。前端显示可信度徽章。

**参考:** Pharos AI — 30个RSS源标注 Western/Iranian/Israeli/Arab/Russian/Chinese 偏见类别

### 冲突升级评分 / 早期预警
基于事件频率趋势的升级概率评分，在地图上显示为风险热力图。即使简单的"过去7天事件频率变化率"也有价值。

**参考:** VIEWS (viewsforecasting.org), ACLED CAST

### 行为体档案系统
从文章中自动提取国家/组织/人物，生成结构化档案卡。包含能力评估、关系图谱、参与时间线、相关文章列表。

**参考:** Pharos AI 行为体档案, Global Threat Map 实体档案

## 第二梯队 — 中优先级

### ACLED 集成
接入 ACLED（武装冲突事件数据），学术金标准、200+国家、60个字段/事件、免费 API。Python 包 `acled_conflict_analysis` 可用。

### Telegram OSINT 频道监控
很多战区的第一手实时信息源。用 Telethon 库抓取公开频道 + 翻译。

**参考:** OSINT War Room, Telerecon (sockysec/Telerecon)

### 冲突时间轴回放动画
点击"播放"看冲突事件在地图上的时空演进，story-driven map playback。

**参考:** Pharos AI 杀手功能

### 关键基础设施叠加层
冲突事件附近的管道、海底电缆、核设施、军事基地作为可切换的地图图层。

**参考:** OSINT Monitor (marcko80/osintmonitor) — 35+数据层

### 金融关联面板
油价、VIX 恐慌指数、相关国家股市、加密货币，和冲突事件并排显示经济影响。

**参考:** OSINT War Room — yfinance 集成

### 可导出情报产品增强
一键生成某个冲突/国家/时段的 PDF 情报简报（已有 AI 简报基础，可扩展为按需生成）。

**参考:** Global Threat Map — 50页情报报告 + PowerPoint

### 文章自动地理解析
用 Mordecai 3 从正文提取地名 → 解析坐标 → 自动标注到地图。补充当前仅依赖源数据声明位置的不足。

**库:** Mordecai 3 (openeventdata/mordecai), geoparsepy

### Polymarket 预测市场集成
显示地缘事件的群体智慧概率预测，和新闻并排展示。公开 API，接入成本低。

## 第三梯队 — 低优先级 / 低成本增强

### PWA 离线模式
加 `manifest.json` + Service Worker，可安装到手机桌面，离线缓存地图和最近数据。

**参考:** World Monitor — PWA + 离线地图

### 事件类型编码
用 PLOVER 本体（18种标准事件类型）对文章分类，支持按类型筛选（口头合作、物质冲突等）。

**库:** PLOVER/POLECAT (openeventdata/PLOVER)

### 伤亡追踪仪表盘
多源汇总各冲突的伤亡数据，时间戳更新。

### NLP 实体提取增强
用 spaCy 或 GLiNER 自动提取文章中的人物、组织、地点，用于行为体档案和关系图谱。

**库:** spaCy, GLiNER (urchade/GLiNER)

### 飞机/舰船实时追踪层
OpenSky Network（航空器）、AISStream（船舶）作为可切换地图图层。

**参考:** OSINT War Room, WorldView (imparpaulo01/worldview)

## 可用开源库速查

| 类别 | 库 | 用途 |
|------|----|------|
| 全球事件数据 | `gdelt` (PyPI) | GDELT 事件查询 |
| 冲突事件数据 | `acled_conflict_analysis` | ACLED 数据提取分析 |
| 地理解析 | Mordecai 3, geoparsepy | 文本→坐标 |
| 事件编码 | PLOVER/POLECAT | 标准化冲突分类 |
| NLP 实体 | spaCy, GLiNER | 人物/组织/地点提取 |
| 时间轴 | vis-timeline, TimelineJS3 | 交互式时间线 |
| 关系图谱 | Sigma.js, Cytoscape.js | 网络可视化 |
| 情感分析 | VADER, TextBlob | 文章情感倾向 |
| 3D 地图增强 | CesiumJS, deck.gl, MapLibre | 高级地图渲染 |

## 竞品参考

- **World Monitor** github.com/koala73/worldmonitor — 41k stars, 30+数据源
- **Pharos AI** github.com/Juliusolsson05/pharos-ai — 信源偏见标注+行为体档案
- **OSINT War Room** github.com/Hue-Jhan/OSINT-War-Room — GDELT+Telegram+预测市场
- **Global Threat Map** github.com/unicodeveloper/globalthreatmap — AI情报报告
- **OSINT Monitor** github.com/marcko80/osintmonitor — 35+数据层
- **Awesome OSINT** github.com/jivoi/awesome-osint — 工具大全
- **Bellingcat Toolkit** bellingcat.gitbook.io/toolkit — 调查工具集
- **ACLED** acleddata.com — 冲突数据金标准
- **GDELT** gdeltproject.org — 全球事件数据库
- **VIEWS** viewsforecasting.org — 冲突预测系统
