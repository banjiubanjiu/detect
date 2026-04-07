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

### [已完成] GDELT 集成
接入 GDELT（全球事件数据库），15分钟更新、100+语言、回溯至1979年、免费 API。Python 包 `gdelt` 可直接调用。作为结构化冲突事件数据补充进 `latest.json`，每条事件自带地理坐标和事件编码。

**参考:** OSINT War Room (Hue-Jhan/OSINT-War-Room)

### [已完成] 信源偏见与可信度标签
给每个信源标注地理来源、政治倾向、可信度等级（如：西方主流/地区媒体/独立记者/社交媒体）。已有 `source_label` 字段，需新增 `credibility_tier` 和 `bias_label`。前端显示可信度徽章。

**参考:** Pharos AI — 30个RSS源标注 Western/Iranian/Israeli/Arab/Russian/Chinese 偏见类别

### [已完成] 冲突升级评分 / 早期预警
基于事件频率趋势+GoldsteinScale+提及量的复合评分（0-100），地球仪按升级指数显示热力色。

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

### [已完成] 冲突时间轴回放动画
播放按钮+时间滑块，在地图上看冲突事件的时空演进。GDELT事件自动按坐标标注。

### [已完成] 关键基础设施叠加层
24个军事基地、8个核设施、10条管道/电缆/咽喉要道，可切换图层显示在冲突详情地图上。

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

---

# 专业化升级路线图（从「聚合器」到「情报产品」）

> 与功能路线图的区别：路线图照搬同类竞品功能；本节是按情报学/工程标准提出的"专业度"升级，
> 大多不需要新数据源，而是把现有数据用得更深、产品形态更接近专业 OSINT。

## 一、情报学专业度（最高优先）

### 1. 多源交叉验证（Corroboration）
**问题：** 985 条事件每条独立计数，看不出哪些被多家独立源印证、哪些是单源孤证。`source_credibility.json` 的偏见标签建好了但没用在分析层。
**做法：** 跑事件聚类（标题/实体相似度），把"同一事件不同源"折叠成一条 cluster，标注"N 个独立源 / 跨 K 种偏见标签印证"。前端 Card 角落加 `2 sources` / `5 sources cross-bias` 徽章。
**效果：** 平台从"新闻列表"变成"情报产品"。

### 2. NATO Admiralty Code（A-F / 1-6 双维评分）
**问题：** 现在只有 `credibility_tier` 一维。
**做法：** 每条信息标两维 —— 来源可靠性（A-F）+ 内容准确度（1-6）。A1 = 完全可信 + 多源印证。这是北约/各国情报机构的标准，可在 `process_new.py` 加一次 LLM 评分调用。

### 3. I&W 指标（Indicators & Warnings）
**问题：** AI 简报只是叙事文字，没有量化预警。
**做法：** 每个冲突维护一组观察指标（俄乌：俄军日均推进公里、乌无人机日均打击次数、谈判提及频率），每天自动算并和 7/30 天均值对比，触发阈值时高亮"⚠ 异常"。这是 VIEWS / ACLED CAST 的核心方法论。
**依赖：** 需要先做 #4（事件时序存档）。

## 二、分析深度

### [已完成] 4. 事件时序存档（前置依赖项，最先做）
**问题：** `latest.json` 只是"当下快照"，`data/archive/` 目录是空的。没有时序数据 → #3 / #6 / #11 全做不了。
**做法：** 每天 commit 时同步把当天 snapshot 存到 `data/archive/YYYY-MM-DD.json`。可只存"摘要级"（升级评分、事件计数、关键指标），不存全量条目以控制体积。
**实际代价：** 12 KB/天 → 一年 4.3 MB → 五年 21 MB。
**实现：** `scripts/snapshot.py` 严格复现 `web/app.js:escalation()` 算法（Python 端），存档含每冲突的升级指数+中间值（freq/gs/mention 各分量）+ 类别条目计数 + 当日简报。`.gitignore` 已开放 `data/archive/`，`collect.yml` 在 briefing 之后调用。

### 5. 关键事件 vs 噪音分级（BLUF）
**问题：** 所有条目平铺在卡片里，"重要的"和"背景的"视觉权重相同。
**做法：** 每天 LLM 标 1-3 条 Critical + 5-10 条 Notable，其余归 Background。前端默认只展示前两层，"展开全部"折叠 Background。情报产品的核心是 Bottom Line Up Front。

### 6. 周度复盘自动生成
基于 #4 的时序数据，每周日自动生成"本周关键转折 / 升级降级 / 新出现的行为体 / 上周预测兑现率"。这是订阅价值的核心。

## 三、工程稳健性

### 7. 管道可观测性面板
**问题：** `scrape_methods.json` 是手工维护的黑/白名单，没有自动回退机制。
**做法：** 每次跑采集时记录每个域名的成功率、时延、内容长度、最后成功时间到 `data/pipeline_health.json`，前端加 `/health` 页面显示。死链/失败率突增立刻能看到，也能自动维护 `scrape_methods.json` 的 `note` 字段。

### 8. 翻译质量抽检 + 缓存键稳定
**问题：** Groq → OpenRouter → translate-shell 三层 fallback，但没有质量回退检测，也无法保证缓存命中。
**做法：**
- 抽 1% 翻译做反向翻译比对，质量崩坏时告警
- 翻译缓存以 `(text_hash, target_lang)` 为 key，避免源文件更新触发重复翻译消耗额度

### 9. 数据契约 + Schema 验证
**问题：** `latest.json` 由 `collect.py` / `rss_feeds.py` / `gdelt_feed.py` / `briefing.py` 多个脚本写入，schema 漂移没有保护。
**做法：** 写一个 `validate_latest.py`（jsonschema 或 pydantic），CI 里每次 commit 前跑。条目缺字段、日期格式错、坐标越界立刻挂掉。

## 四、用户价值

### 10. 订阅与推送
**问题：** 现在只有 RSS（`feed.xml`），用户必须主动来看。
**做法：**
- Telegram bot：用户订阅特定冲突 / 升级阈值 / 关键词，触发即推
- Email digest：每天/每周
- Webhook：把 Critical 级事件 POST 给用户的 endpoint

无需服务端，GitHub Actions 跑完后调一次 Telegram Bot API 即可。

### 11. 公开数据 API + 数据集声明
**问题：** `latest.json` 是隐式 API，没有字段定义、license、稳定性承诺。
**做法：** README 明确写"API 入口" + 字段定义 + 更新频率 + license（CC-BY）+ 时序快照下载。让项目从"网站"变成"基础设施"，吸引研究者引用。

### 12. 永久链接 + 引用规范
**问题：** 条目 ID 是 `rss_dc603d71724b`，URL 不可外链定位。分享时只能截图。
**做法：** 让每条目可独立访问 `/#item/rss_dc603d71724b`，分享时是稳定锚点。学者/记者要的是"可引用"。

## 五、内容深度（中期）

### 13. 实体识别 + Wikidata 链接
TODO 里已有 spaCy/GLiNER（行为体档案系统），专业版加一步：识别出的人物/组织/装备链接到 Wikidata QID。一次解析后所有实体卡片可悬浮显示背景。装备识别（武器系统、舰船型号、飞机型号）是军事 OSINT 的核心特色。

### 14. 控制区/前线图层
**问题：** 地图只有点，看不到"占领区/前线"的语义。
**做法：** 俄乌、苏丹、缅甸用 DeepStateMap / Liveuamap 的 KML/GeoJSON 做底图（注意 license），事件点叠在控制区上，语义瞬间清晰。

### 15. 视频/影像证据库
**问题：** YouTube 只取字幕，证据级影像没有沉淀。
**做法：** geolocate-able 的视频（含坐标的 OSINT 推文）单独建库，关联到事件 cluster，做"证据墙"。Bellingcat 的玩法。

## 优先级建议

**本周可做完且立刻提升专业度的三件：**
1. **#4 事件时序存档** — 30 行代码，解锁后续所有趋势分析（前置依赖）
2. **#1 多源交叉验证** — 已有的可信度标签终于被用上，cards 立刻"权威"起来
3. **#7 管道可观测性** — 让维护从被动救火变成主动监控

