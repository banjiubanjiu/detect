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
