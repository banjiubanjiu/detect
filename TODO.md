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

### [已完成] 1. 多源交叉验证（Corroboration）
**问题：** 985 条事件每条独立计数，看不出哪些被多家独立源印证、哪些是单源孤证。`source_credibility.json` 的偏见标签建好了但没用在分析层。
**做法：** 跑事件聚类（标题/实体相似度），把"同一事件不同源"折叠成一条 cluster，标注"N 个独立源 / 跨 K 种偏见标签印证"。前端 Card 角落加 `2 sources` / `5 sources cross-bias` 徽章。
**效果：** 平台从"新闻列表"变成"情报产品"。
**实现：** `scripts/cluster_corroboration.py`（title token Jaccard + Union-Find，零 LLM，< 1s）、`collect.sh` 每次采集后调用、`web/app.js:renderHotReports` + `command.js` + `analytics.js` 三处都渲染 `N源` / `跨N偏见` 徽章。2026-04-09 数据实测：1455 条 item → 42 条入簇 → 10 个最大簇中 7 个跨偏见（F-15E 击落、俄乌能源停火、海峡封锁等）。

### 2. NATO Admiralty Code（A-F / 1-6 双维评分）
**问题：** 现在只有 `credibility_tier` 一维。
**做法：** 每条信息标两维 —— 来源可靠性（A-F）+ 内容准确度（1-6）。A1 = 完全可信 + 多源印证。这是北约/各国情报机构的标准，可在 `process_new.py` 加一次 LLM 评分调用。

### [已完成] 3. I&W 指标（Indicators & Warnings）
**问题：** AI 简报只是叙事文字，没有量化预警。
**做法：** 每个冲突维护一组观察指标（俄乌：俄军日均推进公里、乌无人机日均打击次数、谈判提及频率），每天自动算并和 7/30 天均值对比，触发阈值时高亮"⚠ 异常"。这是 VIEWS / ACLED CAST 的核心方法论。
**依赖：** 需要先做 #4（事件时序存档）。

**实现（2026-04-09）v1：**
- `scripts/indicators.py` 零 LLM 纯 Python < 1s。不依赖 archive 时序（只有 3 天太弱），直接从 `latest.json` 的 `item.date` 算 14 天日分布。
- **3 个自动化通用指标**，无需人工定义每冲突指标：
  - `event_frequency` — 今日事件数 vs 7 日均值，≥2× elevated / ≤0.5× depressed
  - `critical_count` — 今日 criticality=critical 数量 vs 7 日均值（依赖 #5 BLUF 分级的 critical 字段）
  - `escalation_trend` — 今日升级指数 vs 昨日（从 `data/archive/` 读取最后 2 天 snapshot），Δ≥10 rising / Δ≤-10 falling
- **关键设计：reference_date = yesterday (UTC)** 而不是 today。今日永远是 partial day，CI 06:00 UTC 跑时只有 6h 数据，用昨日做参考保证"完整 1 天 vs 完整 7 天"的苹果比苹果对比，避免 partial-day artifact。代价是 24h 滞后，对日级 I&W 可接受。
- 触发阈值保护：`MIN_BASELINE_FOR_FLAG=1.0` —— baseline < 1 条/天时不报 flag，避免 0→1 这种噪音。
- 前端 `app.js` 新增 `loadWarnings() / renderWarningsBadge() / showWarningsModal() / closeWarningsModal()`，在顶栏 healthBadge 旁边加 `warningsBadge`（⚠ N 格式），点击弹 modal。
- Modal 样式在 `style.css` 加 `.warnings-badge / .iw-conflict / .iw-metric / .iw-elevated / .iw-rising / .iw-depressed / .iw-falling`，全部 `var(--ink-*)` 驱动，light/dark 双主题无缝。冲突按预警数量降序排列，异常冲突上浮，正常冲突沉底。
- CI (`collect.yml`) + 本地 `collect.sh` 在 snapshot 后跑 indicators.py。

**实测（2026-04-08 作为 reference day）：**
- 10 项预警，8/9 冲突异常
- 巴以冲突 2 预警：事件频率 97 vs 15.1 (+541%) + 升级指数 79→91 (+12)
- 缅甸内战 2 预警：事件频率 6 vs 1.4 (+320%) + 升级指数 51→73 (+22)
- 俄乌战争：事件频率 110 vs 28.4 (+287%)
- 美伊对峙：事件频率 209 vs 41.3 (+406%) —— 美伊停火新闻潮
- 台海局势：事件频率 10 vs 2.3 (+338%)
- 刚果(金)：升级指数 47→26 (-21) falling ——相对平静

**v2 扩展点**（需要先积累数据或手工配置）：
- archive 达到 14+ 天后加 7 日 escalation 移动平均对比 + 拐点检测
- 手动定义每冲突业务指标（俄乌：无人机打击/日、谈判提及/日；巴以：空袭/日、人质相关/日）。可以加 `data/custom_indicators.yml` 配置文件
- 接入 GDELT Goldstein Scale 恶化趋势（scale 越负越惨烈，7 日均值下降 → 预警）
- 预警触发时往 `pipeline_health.json` 的 issues 也写一条，用现有 healthBadge 统一展示；或者走 Telegram bot 推送（和 #10 订阅与推送合并）

## 二、分析深度

### [已完成] 4. 事件时序存档（前置依赖项，最先做）
**问题：** `latest.json` 只是"当下快照"，`data/archive/` 目录是空的。没有时序数据 → #3 / #6 / #11 全做不了。
**做法：** 每天 commit 时同步把当天 snapshot 存到 `data/archive/YYYY-MM-DD.json`。可只存"摘要级"（升级评分、事件计数、关键指标），不存全量条目以控制体积。
**实际代价：** 12 KB/天 → 一年 4.3 MB → 五年 21 MB。
**实现：** `scripts/snapshot.py` 严格复现 `web/app.js:escalation()` 算法（Python 端），存档含每冲突的升级指数+中间值（freq/gs/mention 各分量）+ 类别条目计数 + 当日简报。`.gitignore` 已开放 `data/archive/`，`collect.yml` 在 briefing 之后调用。

### [已完成] 5. 关键事件 vs 噪音分级（BLUF）
**问题：** 所有条目平铺在卡片里，"重要的"和"背景的"视觉权重相同。
**做法：** 每天 LLM 标 1-3 条 Critical + 5-10 条 Notable，其余归 Background。前端默认只展示前两层，"展开全部"折叠 Background。情报产品的核心是 Bottom Line Up Front。

**实现（2026-04-09）：**
- 后端 `scripts/tag_criticality.py` 早先已经存在（commit 35f78bd 之前），每天跑一次给每条 item 打 `criticality: critical | notable | background`。
- **修 coverage bug**：原版 `TOP_N_PER_CONFLICT=50` 导致大日（e.g. 2026-04-08 us-iran 160 untagged）新数据被截断。改成**批处理**：`collect_untagged_items()` 只收未标条目，`tag_conflict()` 循环 `MAX_BATCHES_PER_CONFLICT=6` 批（每批 50 条），per-conflict 全局预算 3 critical + 10 notable 跨批次共享，尾批不足 5 条直接标 background。修后 BLUF 覆盖率从 70.8% → **100%**（1187/1187）。
- **前端三段式折叠**：`web/app.js renderRiver()` 按 `effectiveWeight() >= 2` 分 above/below（above 包括 critical w=4、notable w=2、background+cross-bias w=4、background+4 源 w=3；below 是弱 background）。above 照常展示，below 默认 `display:none`，末尾加「展开背景动态 (N 条)」按钮。俄乌战争军事分类实测：188 条 → 24 above + 164 below。
- **样式**：`web/style.css` `.bluf-divider / .bluf-toggle / .bluf-below` 用 `--ink-*` / `--mono` 变量，自动跟随 light/dark 主题。按钮淡灰 outline + 数量 mono 字体 + 右侧大写 "BLUF · BELOW THE FOLD" 编辑风 kicker。
- **ROI**：#5 原计划 1-2h，实际含 coverage 修复共 ~1h。读者落地即看到 24 条真正重要的事，而不是 188 条平铺，情报产品味道立刻出来。

### 6. 周度复盘自动生成
基于 #4 的时序数据，每周日自动生成"本周关键转折 / 升级降级 / 新出现的行为体 / 上周预测兑现率"。这是订阅价值的核心。

## 三、工程稳健性

### [已完成] 7. 管道可观测性面板
**问题：** `scrape_methods.json` 是手工维护的黑/白名单，没有自动回退机制。
**做法：** 每次跑采集时记录每个域名的成功率、时延、内容长度、最后成功时间到 `data/pipeline_health.json`，前端加 `/health` 页面显示。死链/失败率突增立刻能看到，也能自动维护 `scrape_methods.json` 的 `note` 字段。
**实现（2026-04-09）：** `scripts/health_report.py`（v1 post-hoc 分析，无需改已有脚本）扫 `latest.json` 产出源分布、top 20 域名、14 天日分布、LLM 覆盖率、orphan 扫描，并检测 5 类异常（orphan_file / low_daily_count / high_missing_translation / high_missing_criticality / stale_data）。`--fix` 模式自动清除 orphan `local_file` 字段（T4 自动修复）。CI (`collect.yml`) 在 snapshot 后跑；本地 `collect.sh` 同步。前端 `app.js:loadHealth` 顶栏 `healthBadge` + 点击弹 modal 显示完整报告（`index.html` `#healthModal`）。实测 2026-04-09：1235 items, 0/1118 orphan, 2 warning (low_daily_count + high_missing_criticality)。

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

**实现（2026-04-09, 待激活）：** Telegram 日报 v1 代码已就绪并接入 CI，
仅等待用户配置 secrets 激活。缺 secret 时脚本 graceful skip, 不报错.

- `scripts/notify.py` — 读 indicators.json + latest.json 拼 Markdown 消息,
  按 `reference_date` 做 dedup (每天一次), quiet day (0 预警 + 0 critical)
  自动跳过, state 存 `data/notify_state.json` 靠 git add -A 持久化跨 CI run
- 消息结构: 🛰️ 日期 + 总预警计数 + 🔴 关键事件 top 5 + ⚠️ I&W 异常 top 9
- `.github/workflows/collect.yml` 在 snapshot 后、commit 前跑, `continue-on-error: true`
- dry-run / force 选项: `python scripts/notify.py --dry-run` / `--force`

**激活步骤 (用户侧, 需 3 分钟):**
1. Telegram 搜 `@BotFather` → `/newbot` → 记下返回的 HTTP API token
2. 给新 bot 发一条消息 → 浏览器打开
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → 找 `chat.id` (正整数=私聊,负整数=群组)
3. https://github.com/banjiubanjiu/detect/settings/secrets/actions
   加两个 repo secret:
   - `TELEGRAM_BOT_TOKEN` = 第 1 步 token
   - `TELEGRAM_CHAT_ID` = 第 2 步 chat id
4. 激活: 下次 cron 自动推送, 或手动 `Run workflow` 立即验证

**未来扩展 (v2):**
- 每用户订阅条件 (只推 us-iran + elevated / 某关键词) — 需要引入一个订阅表
- Email digest (SendGrid / Resend 免费额度即可)
- 针对 critical 级事件的即时推送 (不等 cron, 由独立 workflow 触发)
- Webhook 通用推送 (POST 到用户 endpoint, 支持 Slack/Discord/IFTTT)

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
1. ~~**#4 事件时序存档**~~ — 已完成（`scripts/snapshot.py`）
2. ~~**#1 多源交叉验证**~~ — 已完成（`scripts/cluster_corroboration.py` + 三端徽章）
3. ~~**#7 管道可观测性**~~ — 已完成（`scripts/health_report.py --fix` + 前端 healthBadge/healthModal + CI 接入）

**三项都已交付。下一个推荐起点**：**#3 I&W 指标**（Indicators & Warnings）或 **#5 BLUF 分级**。
- #5 是最便宜的可见提升（LLM prompt 改一次 + 前端三段式展示，1-2h）
- #3 是最专业级的增量（每冲突定义 3-5 个量化指标，和 7/30 天均值比对触发"⚠ 异常"，是 VIEWS / ACLED CAST 的核心方法论，4-6h）

---

# 技术债（identified 2026-04-07）

> 在实施 #4 时序存档 / #5 BLUF / LLM 分类升级的过程中发现但未修的已知问题。
> 都独立可修，按各自严重度和触发频率排优先级。

## 采集管道

### [已完成] T1. `collect.py` 双 `_find_local_file` 定义冲突
**问题：** `collect.py` 里有两个同名函数，签名不同:
- 第 1318 行: `_find_local_file(url, out_dir)` — 2 个参数
- 第 1370 行: `_find_local_file(directory, safe_name, url)` — 3 个参数

后定义的覆盖前者，但 `smart_scrape` 的某些 fallback 路径按 2 参数签名调用，运行时会抛 `missing 1 required positional argument: 'url'`，导致整个 smart_scrape 对某些 URL 完全失败（补抓 MSF 时遇到）。

**修复：** 重命名区分职责（不合并两者以避免行为漂移）:
- `_find_local_file_by_url(url, out_dir)` — smart_scrape 用
- `_find_local_file_by_safe_name(directory, safe_name, url)` — collect_conflict 用

4 处引用全部对齐。验证：import 正常、旧名字已消失、smart_scrape 对 MSF URL 返回正常。

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

### [已完成] T4. `fetch_full_articles` 失败静默 【中】
**问题：** 现在 `fetch_full_articles` 里单条失败只打印日志，**不影响 latest.json 写入**。结果 `local_file` 字段空或指向未生成的文件，前端无感知，用户打开 reader 看到 summary 兜底。

**修复：**
- 失败的 item 不设置 `local_file` 字段（而不是设置一个不存在的路径）
- 或者在 commit 前验证所有 `local_file` 路径实际存在，不存在则清空
- 或者加一个采集后的 health check（T9 的一部分）

**实现（2026-04-09）：** 合并到 T9 / #7 管道可观测性。`scripts/health_report.py --fix` 在每次 CI 运行的 snapshot 步骤之后执行，扫描所有 `local_file` 字段，对不存在的文件自动从 `latest.json` 清除字段（幂等，处理一个 id 在多个 conflict/category 副本的情况）。命中时回写 latest.json 并重算 report。用户不再看到"卡片点开一片空白"的体验。

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

### [已完成] T9. 管道 health check 缺失 【中】
**问题：** 每日 CI 跑完后，没有任何"这次采集健康度"的检查。
- 多少条目抓到 / 多少 fetch_full_articles 失败 / 多少 LLM 失败 / 多少 local_file 字段引用了不存在的文件
- 这些指标现在全靠事后人工统计（本次会话手动做的）

**修复：** 在 `rss_feeds.py` 或独立脚本里加 health 报告:
- `data/pipeline_health.json` 记录每日指标
- CI 里在 commit 之前跑 `validate_latest.py`，关键异常 → workflow fail

这正好对应专业化路线图的 **#7 管道可观测性**。

**实现（2026-04-09）：** 见 #7 实现说明。v1 版本异常不 fail workflow（仅写 warning 到前端 badge），避免淡日误触；后续如要升级为 hard fail，把 `health_report.py` main 末尾的 `return 0` 改成"有 critical 即 exit 1"即可。顺手还补了一个 CI 层的遗漏 bug：`collect.yml` 之前没跑 `cluster_corroboration.py`，导致 CI 自动产的 latest.json 永远没有 cluster 字段（42 条 cluster 是本地手动跑 `collect.sh` 产生的）。本次一并加到 CI。

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

## 前端 UI

> 来自 2026-04-09 整站审核（critique 方法论）。修完了架构 (I-III) 三大项（删独立 ask 页 → 改全局抽屉、整站默认 dark、重命名导航 WAR ROOM/ANALYSIS/OVERVIEW），剩下的都是单页面具体 slop/反模式，独立可修。

### T14. `index.html` viz-row 同构卡片 【中】
**问题：** 首页的 `viz-row` 区域（热门报道 + 关系图谱）和 `viz-row-time`（时间流 + sparkline 墙）都是**两个等大同构 panel** 横向排列。frontend-design 明确反模式："DON'T use identical card grids"。两排下来视觉节奏完全没有。

**修复：**
- 打破 1:1 对称，改成 2:1 或 3:2 的不等比 grid，让一个 panel 主导视觉
- 或者把 `viz-row-time` 的两个 panel 合并（streamgraph 作主图，sparkline 墙作其图例/小图），去掉第二排
- 或者直接删一个（hot list 已经在其他地方出现过，可以只保留 force graph）

### T15. `index.html` "全球冲突态势总览" 9 行水平 bar chart 缺节奏 【中】
**问题：** 总览区 9 个冲突用 9 行完全相同结构的水平 bar chart 排列（名字 + 进度条 + 数字）。信息密度高但**没有视觉节奏**，看起来像 CSV dump。

**修复：**
- 引入 typographic 层次：第一列宽度不等、最严重的 3 条用更大字号
- 或者 top 3 用特殊排版（大卡片），其余 6 条保持 sparkline 行
- 或者按地区分组（欧洲 / 中东 / 非洲 / 亚太），分组之间有明显空间
- 参考 analytics.html 的 Watchlist 表格 — 它用了 PEAK / GS MIN / CLUSTERS 多列对比，节奏更好

### T16. `analytics.html` 顶部 critical strip 用 mono caps 反模式 【中】
**问题：** analytics.html 顶部的 `an-bluf-cards` (CRITICAL · BLUF) 和 4 个指标栏是一排红色/蓝色/橙色 mono uppercase 标签横排。frontend-design 明确："DON'T use monospace as lazy shorthand for technical/developer vibes"。

**缓和因素：** analytics 页其余部分（streamgraph + watchlist）的视觉密度高，勉强把这个 strip 救回来。但在对比度感知上仍然是最弱的一行。

**修复：**
- 用 serif italic 作 kicker + 大数字 sans 替代 mono caps
- 或者把 BLUF 改成 editorial 风格的"今日要点"短列表（Playfair 衬线 + 真正的文字内容）
- 参考 index.html 的 `cd-summary` 样式

### T17. `command.html` watchlist 4 色 bar 缺图例 【低】
**问题：** command 左侧 `cc-left` 的 conflict watchlist 用红 / 橙 / 黄 / 蓝 4 种颜色 bar 表示冲突等级，但页面上**没有图例**。新用户无法推断每种颜色的含义。

**修复：**
- `rail-head` 下方加一行小图例（3-4 色 swatch + 标签）
- 或者 hover 时 tooltip 解释
- 或者用自然可理解的 gradient 代替离散色（深红=严重 → 浅橙=缓和）

### T18. `ai-anchor-fab` 浮窗 vs `ASK` 抽屉 — 双 AI 入口冗余 【低】
**问题：** index.html 右下角有 `ai-anchor-fab`（AI 数字人主播浮窗,Wan2.2-S2V），顶栏又有 `ASK` 链接（→ drawer）。用户看到两个"AI 入口",分不清功能区别。

**修复（任选）:**
- 把 ai-anchor-fab 重命名为 "BRIEFING" 或 "DAILY BRIEF",明确它是"每日简报播报"而非"问答"
- 把两个入口合并：ASK 抽屉里加一个 "听今日简报" tab
- 减少一个：ai-anchor 只在首页显示,不在 analytics/command 出现

### T19. `analytics.html` / `command.html` 不支持 light 切换 【低】
**问题：** 当前整站默认 dark,但 index 仍保留 light 切换按钮让用户可以看米色版本。**analytics 和 command 用独立 CSS (analytics.css / command.css) 硬编码黑底**,没有 light 变体,用户在 index 切到 light 后跳到这两个页面仍然是黑的 — 体感不统一。

**修复：**
- 把 analytics.css 和 command.css 的硬编码颜色替换成 `var(--bg) / var(--fg)` 等
- 在 .css 顶部定义 `:root { --bg: #1a1a18; ... } [data-theme="light"] { --bg: #f4efe6; ... }`
- 或者接受现状（analytics/command 永远 dark 因为是工作台）,只在 index 顶栏 DARK 切换时隐藏 analytics/command 的进入提示"light 仅影响 overview"

工作量：中等（每个 css 文件约 50-80 处硬编码颜色替换）。优先级低因为用户基本都在 dark 工作,light 是偶尔切换。

### T20. `ask-drawer.js` 旧 ask.html 的遗留优化项 【低】
**问题：** 之前 ask.html 上做的几个精调(A 档 critique 诊断时指出的)迁移到 ask-drawer 时为了简化有所牺牲:
- drawer 内没有 hljs 代码高亮(简化为纯 mono `<pre>`,因为加载 hljs 太重)
- drawer 内没有 case file 状态 dateline(ANALYST 固定值,没有实际操作员)
- confidence 等级 A1/B2 是硬编码的,不是真实评估

**修复（如果追求极致）:**
- 按需加载 hljs（仅当答案含 \`\`\`代码块时）
- confidence 根据实际工具调用数 + 答案长度 + 是否命中原文给更精细的评级
- 这些都是锦上添花,非必要

### T21. `health_report.scan_orphans` 对 empty string local_file 不敏感 【低】
**问题：** `scan_orphans` 里 `if not lf: continue` 把空字符串当"无 local_file"
跳过, 所以 `--fix` 永远不会清理它们. 这是历史数据债: 早期版本的 orphan clear
把值设为 `""` 而不是 `pop()` key, 留下 8 条 item 的 `local_file=""`.

**发现于 2026-04-09 #9 Schema 验证** — `scripts/validate_latest.py` 对这些
报 warning ("empty string (orphan clear leftover)"), 暴露出 health_report
的清理路径有漏洞.

**修复：**
- `scan_orphans` 把 `lf == ""` 也算作"需要清理"(和 missing file 并列)
- 或者独立加一个 `scan_empty_local_files` 步骤, 在 `--fix` 时一并 pop
- 预期效果: 下次 CI 跑完 `health_report.py --fix` 后, 这 8 条遗留清零,
  validator 的 8 个 warning 变成 0

**工作量：** ~15 行代码. 低紧迫性 (前端已 fallback, 不影响用户). 建议在下次
碰 health_report.py 时顺手修.

