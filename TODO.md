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

---

# 技术债（identified 2026-04-07）

> 在实施 #4 时序存档 / #5 BLUF / LLM 分类升级的过程中发现但未修的已知问题。
> 都独立可修，按各自严重度和触发频率排优先级。

## 采集管道

### T1. `collect.py` 双 `_find_local_file` 定义冲突 【高】
**问题：** `collect.py` 里有两个同名函数，签名不同:
- 第 1318 行: `_find_local_file(url, out_dir)` — 2 个参数
- 第 1370 行: `_find_local_file(directory, safe_name, url)` — 3 个参数

后定义的覆盖前者，但 `smart_scrape` 的某些 fallback 路径按 2 参数签名调用，运行时会抛 `missing 1 required positional argument: 'url'`，导致整个 smart_scrape 对某些 URL 完全失败（补抓 MSF 时遇到）。

**修复：** 删掉其中一个、统一签名。建议保留 2 参数版本（调用方多）。

### T2. `smart_scrape` slug 算法三路分叉 【中】
**问题：** 三条 fallback 分支生成不同的文件名 slug:
- `fetch_via_trafilatura`: `domain + '_' + url.split('/')[-1]` (有下划线)
- `fetch_via_jina`: `domain + url.split('/')[-1]` (**无**下划线)
- `fetch_reddit_thread`: `reddit_r_{sub}_comments_{id}` (完全不同的格式)

结果:
- 同一 URL 走 trafilatura 成功和走 jina 成功会产生两个不同文件名的 .md
- `latest.json` 里记录的 `local_file` 可能和重抓后的实际路径不一致（补抓时遇到 2 条 mismatch，靠 `/tmp/align_local_file_paths.py` 修）
- 未来如果采集管道某个 fallback 切换，会产生孤儿文件和路径漂移

**修复：** 抽一个 `_slug_for_url(url, source)` 函数作为唯一 slug 源，三条 fallback 统一调用它。保证同一 URL 无论走哪条路径都生成相同的文件名。

### T3. Jina Reader 免费限额 200/天 【中】
**问题：** `fetch_via_jina` 是 smart_scrape 的 fallback，当 trafilatura 失败时大量走 jina。免费额度 200 请求/天。
如果某天 RSS 采集 >200 条新条目 + trafilatura 大面积失败（如 2026-04-07 的事故），jina 额度用完 → 剩余条目全部 fallback 到 xcrawl（也不可靠）→ `local_file` 字段被设置但文件未生成。

**修复方向（任选）:**
- 付费 Jina（$0.5/1K 请求，几美元/月可以完全摆脱限额）
- 本地增加 Playwright 无头浏览器作为第 4 层 fallback
- 采集策略：超过阈值时降级为"只存 RSS summary，不抓全文"
- 优先使用 trafilatura，降低 jina 依赖（改善 trafilatura 的 fetch_url 容错）

### T4. `fetch_full_articles` 失败静默 【中】
**问题：** 现在 `fetch_full_articles` 里单条失败只打印日志，**不影响 latest.json 写入**。结果 `local_file` 字段空或指向未生成的文件，前端无感知，用户打开 reader 看到 summary 兜底。

**修复：**
- 失败的 item 不设置 `local_file` 字段（而不是设置一个不存在的路径）
- 或者在 commit 前验证所有 `local_file` 路径实际存在，不存在则清空
- 或者加一个采集后的 health check（T9 的一部分）

## 数据层

### T5. `rss_feeds.py` 无条目老化 【低】
**问题：** `latest.json` 的 items 无限累积，只靠"同 URL 去重"防重。如果某条目的 RSS 源改了 URL，会永久留在数据里。没有"超过 30 天自动清理"机制。

**修复：** 每次采集后，清理 date 早于 30 天的条目（保留 id 在最近时序 archive 里）。

### T6. `collect.py:1821-1825` 死代码 archive 写入 【低】
**问题：** collect.py 的 main 里有 archive 写入逻辑：
```python
archive_path = ARCHIVE_DIR / archive_date
archive_path.mkdir(parents=True, exist_ok=True)
shutil.copy2(output_path, archive_path / "latest.json")
```
但 CI 不跑 collect.py（跑的是 rss_feeds.py + gdelt_feed.py），所以这段从未执行。`/data/archive/` 现在由 `snapshot.py` 管理，格式不同（按日期文件 vs 按日期目录）。两者冲突。

**修复：** 删除 `collect.py:1821-1825`，或改为调用 `snapshot.py`。

### T7. `rss_feeds.py` 死代码：关键词匹配函数 【低】
**问题：** LLM 分类升级（commit 35f78bd）后，以下函数和常量不再被 `fetch_rss` 调用，但保留在文件里：
- `match_conflict` (关键词冲突匹配)
- `guess_category` (关键词类别猜测)
- `_has_chinese` (辅助函数)
- `CONFLICT_KEYWORDS` (关键词词表)

保留的原因是"1 周观察期，新 LLM 架构稳定后再删"。

**修复：** 2026-04-14 之后（1 周观察期），如果 LLM 分类流程稳定，删除这些死代码。保留 git 历史作为 rollback 参考。

### T8. `translate_rss_items` 废弃但未删 【低】
**问题：** `fetch_rss` 不再调用 `translate_rss_items`（翻译已并入 `analyze_and_translate`）。函数还在文件里但无入口。

**修复：** 同 T7，1 周观察期后清理。

## 可观测性

### T9. 管道 health check 缺失 【中】
**问题：** 每日 CI 跑完后，没有任何"这次采集健康度"的检查。
- 多少条目抓到 / 多少 fetch_full_articles 失败 / 多少 LLM 失败 / 多少 local_file 字段引用了不存在的文件
- 这些指标现在全靠事后人工统计（本次会话手动做的）

**修复：** 在 `rss_feeds.py` 或独立脚本里加 health 报告:
- `data/pipeline_health.json` 记录每日指标
- CI 里在 commit 之前跑 `validate_latest.py`，关键异常 → workflow fail

这正好对应专业化路线图的 **#7 管道可观测性**。

### T10. repo 体积增长无监控 【低】
**问题：** `data/sources/` 启用后 12 MB 起步，按每天新增 ~1-2 MB 估算一年后 50-100 MB。git 文本压缩会降到一半左右。目前没有任何预警。

**修复：** CI 里加 `du -sh data/sources` 报告，超过阈值（如 500MB）发 issue 或邮件。或者真到那时再做 T5 的老化机制。

## 架构/设计

### T11. 冲突归类无"主冲突 vs 次相关"区分 【低】
**问题：** LLM 可以返回 `conflicts: ["ru", "il", "ir"]` 表示一条文章关联三个冲突。当前结构里这三个副本完全等权，前端三个冲突视图都显示一次，读者分不清这条文章的"主题"究竟是哪个。

**修复：** 给 conflicts 字段加主次分级：`{"primary": "ru", "secondary": ["il", "ir"]}`，前端可以用不同视觉权重区分。需要改 LLM prompt + schema + 前端渲染。

### T12. GDELT 条目不走 LLM 分类 【低】
**问题：** 新架构里 RSS 条目走 `analyze_and_translate`（LLM），但 GDELT 条目仍走 `gdelt_feed.py` 自己的关键词归类。两条管道归类标准不一致。

**修复：** GDELT 条目也经过 `analyze_and_translate`（或其轻量版），保证归类标准统一。增量成本：每天 GDELT ~40 条 × $0.00013 ≈ $0.005/天。

### T13. criticality 的 category key 依赖 【低】
**问题：** `analyze_and_translate` 现在返回 category 字段，但 `_CATEGORY_ALIASES` 把 LLM 可能返回的 "diplomatic" 映射到 "diplomacy"。如果未来加新 category，或者 prompt 里改名，需要同步维护 alias 表。

**修复：** 要么把 prompt 和 schema 的 category key 强制一致（单一事实源），要么把 alias 表写到一个常量文件集中管理。

