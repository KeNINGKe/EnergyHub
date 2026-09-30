# EnergyHub V1.1 数据协议

> 阶段 A 交付物（A-03/A-04/A-05 汇总）。配套：`V1.1_PRD.md` 第 7 节、`data/enums.json`、`scripts/lib/schema.mjs`。
> 校验原则：**校验通过前不得覆盖上一份有效数据**（PRD 8、异常场景 AC-08）。

## 1. 文件清单

| 文件 | 用途 | 生成方 |
|---|---|---|
| `feeds/daily-v2.json` | **实际主数据**：全部动态（事件级），前端 `daily-v2 \|\| daily` 优先读取 | `build-daily-v2.mjs`（每日 CI） |
| `feeds/daily.json` | V1 遗留兼容位：仅 `--activate` 时才被 V2 覆盖；前端作为回退 | `build-daily-v2.mjs` |
| `feeds/featured.json` | 今日观察 + 精选 ID 编排 | `build-daily-v2.mjs` |
| `feeds/exposure-history.json` | 跨日曝光记忆（近 N 天上榜 URL → 日期） | `build-daily-v2.mjs`（发布后回写） |
| `feeds/translation-cache.json` | 标题翻译缓存（进仓库防配额耗尽） | 构建时回写 |
| `data/editorial-overrides.json` | 人工覆盖配置（可选） | 人工维护 |
| `data/enums.json` | 主题/来源类型/影响/地区枚举 | 人工维护（阶段 A-05 固化） |
| `feeds/wechat-articles.json` | 微信公众号文章种子（可选） | 人工维护（采集时自动回写） |

## 2. `feeds/daily.json` V2

```jsonc
{
  "schemaVersion": 2,                 // 必填，旧版无此字段（V1）
  "date": "2026-08-05",               // 必填，YYYY-MM-DD（北京时间）
  "generatedAt": "2026-08-05T04:00:00.000Z", // 必填，ISO 8601
  "status": "ok",                     // 必填
  "stats": {                          // 必填
    "sourcesTotal": 34,
    "sourcesSucceeded": 30,
    "articlesFetched": 86,
    "eventsPublished": 52
  },
  "items": [ /* 事件 */ ]
}
```

事件对象：

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `id` | string | ✅ | 稳定哈希，格式 `evt_[a-z0-9]{8,}`，全文件唯一 |
| `title` | string | ✅ | 中文标题 |
| `originalTitle` | string | - | 原文标题 |
| `url` | string | ✅ | 必须为 http(s) 外链 |
| `summary` | string | - | 一句话事实摘要，允许空 |
| `whyItMatters` | string | - | 推荐理由，允许空；精选事件建议非空 |
| `topic` | string | ✅ | 必须来自 `data/enums.json` topics |
| `tags` | string[] | - | 补充标签 |
| `region` | string | ✅ | 国家/经济体或「全球/未知」，开放但建议用已知集合 |
| `entities` | string[] | - | 公司、机构、项目 |
| `metrics` | `{label,value,unit?}[]` | - | 保留原文单位，不做未经验证的换算 |
| `impact` | string | - | `positive`/`negative`/`neutral`/`watch`/`unknown` |
| `importance` | number | - | 仅内部排序，不前台展示 |
| `source` | object | ✅ | `{ name, type(枚举), isPrimary(boolean) }` |
| `publishedAt` | string/null | - | ISO 8601 |
| `discoveredAt` | string/null | - | ISO 8601 |
| `relatedSources` | `{name,url}[]` | - | 同一事件的其他报道 |
| `wechat` | boolean | - | 微信种子注入的事件（`true` 时精选页显示「公众号」徽章，并在精选选择中保底 1 条配额） |

## 3. `feeds/featured.json`

```jsonc
{
  "schemaVersion": 1,
  "date": "2026-08-05",
  "generatedAt": "2026-08-05T04:00:00.000Z",
  "observations": ["今日观察，≤5 条"],
  "featuredEventIds": ["evt_xxx", "evt_yyy"],
  "hotEventIds": ["evt_zzz"]           // 今日热点榜（可选字段，前端只渲染不计算）
}
```

- `featuredEventIds` 中的每个 id **必须存在于同日期 `daily.json`**（校验失败则不发布）。
- 数量目标 5–12 条，**不足时如实减少**，不降低质量门槛（软约束，超上限只给 warning）。
- 数组顺序即展示顺序。
- `observations` 由最终入选集合按重要性取前 3 生成，可被 overrides 覆盖。
- `hotEventIds` 配置见 `data/enums.json` 的 `hot` 段（储能/AIDC 北美置顶、核电排除）；可用 overrides 的 `hotEventIds` 整体替换。

## 4. `data/editorial-overrides.json`

按日期覆盖自动结果。无此文件或为空时，自动任务必须完整运行。

```jsonc
{
  "schemaVersion": 1,
  "byDate": {
    "2026-08-05": {
      "forcedFeaturedIds": ["evt_xxx"],   // 强制入选精选
      "hiddenIds": ["evt_yyy"],           // 从全部动态隐藏
      "unfeaturedIds": ["evt_zzz"],       // 取消精选
      "topics": { "evt_xxx": "grid" },    // 修正主题（必须枚举合法）
      "impacts": { "evt_xxx": "watch" },  // 修正影响方向（必须枚举合法）
      "summaries": { "evt_xxx": "..." },  // 覆盖摘要
      "whyItMatters": { "evt_xxx": "..." }, // 覆盖推荐理由
      "observations": ["...", "..."],     // 覆盖今日观察
      "mergeGroups": [["evt_a", "evt_b"]] // 合并/拆分事件
    }
  }
}
```

配置错误（引用不存在的 id、非法枚举）→ 忽略该错误条目并记录日志，不破坏自动结果。

## 5. 枚举（`data/enums.json`）

- **topics**：12 个固定主题（`data-center-power`、`aidc-project`、`grid`、`energy-storage`、`solar-wind`、`nuclear-smr`、`gas-backup`、`cooling-pue`、`ppa-green-power`、`power-market-policy`、`chips-compute`、`other-energy`），每条含中文 `label` 与 `keywords` 种子。
- **sourceTypes**：`primary`（一手）/ `media`（媒体）/ `research`（研究）/ `community`（社区）。
- **impacts**：`positive` / `negative` / `neutral` / `watch` / `unknown`。
- **regions**：开放国家/经济体集合 + `全球`/`未知`；不得根据媒体所在地猜测事件地区。

## 6. 校验与兼容

### 校验（`scripts/lib/schema.mjs`，CLI：`npm run validate`，测试：`npm test`）

- `validateDailyV2(daily)` → `{valid, errors, warnings}`：schemaVersion、日期/时间格式、ID 格式与唯一性、URL 协议、topic/impact/source.type 枚举、必填字段、metrics 结构、relatedSources。
- `validateFeatured(featured, daily)` → 精选 ID 存在性、observations 上限（warning）、数量上限（warning）。
- `validateOverrides(overrides, daily)` → 日期键格式、引用的 ID 存在性、枚举合法性。
- 过渡期：当前 `feeds/daily.json` 为 V1 旧版（无 `schemaVersion:2`），`npm run validate` **不阻断**，仅提示差异；V2 生成器上线后转为严格校验。

### 前端兼容层（`scripts/lib/compat.mjs`，测试 `tests/compat.test.mjs`）

- `normalizeDaily(daily)` 识别 V1/V2，输出统一渲染结构（AC-11：旧数据至少展示标题/来源/时间/摘要/链接）。
- V1 条目派生稳定 `legacy_<hash>` id；V2 保留 `evt_*` id 与全部结构化字段。
- 缺失字段安全降级为空值，不出现 `undefined`。
- 阶段 C/D 落地时由前端 `app.js`（或 `<script type="module">`）引用同一逻辑。

## 7. 样本与基线（`samples/`）

| 目录 | 内容 |
|---|---|
| `samples/daily/` | 7 天 V1 原始快照（回放夹具，`scripts/extract-samples.mjs`） |
| `samples/annotations/` | 112 条样本 `set.json` + 标注 `labels.json`（AI 预标注 v1，复核状态见顶层 `review` 块） |
| `samples/selection/` | C-01 精选业务价值标注队列（180 条 + 人工复审页） |
| `samples/jev-fixtures/` | 逐日 Jev 固定回执夹具（`--record` 录制，见 §11） |
| `samples/raw/` | CI 每日原始输入快照（gzip，30 天滚动，见 §11） |
| `samples/baseline/` | V1 流程质量基线 `baseline.json`（`scripts/build-baseline.mjs`）+ `quality-upgrade/`（阶段 A 固定基线，见 §11） |

基线（2026-08-05）：无关率 ≈ 26.8%、样本内重复率 ≈ 2.7%、日均成功来源 28.6/34 ≈ 84%、日均条目 45.3。供 F-01 回放前后对比。

## 8. 完成条件核对（阶段 A）

- [x] A-01 固定样本（7 天，`samples/daily/` + manifest）
- [x] A-02 人工标注 ≥100 条（112 条，`samples/annotations/`）
- [x] A-03 校验规则与函数（`scripts/lib/schema.mjs` + `tests/`）
- [x] A-04 前端兼容层（`scripts/lib/compat.mjs` + `tests/`）
- [x] A-05 枚举固化（`data/enums.json`）
- [x] A-06 基线记录（`samples/baseline/`）
- [x] 完成条件「相同输入重复执行，得到结构一致、ID 稳定的输出」：`npm test` 25 项通过，覆盖 ID 稳定性与样本可复现性。

## 9. `feeds/wechat-articles.json`（公众号文章种子，可选）

微信公众号无公开列表页，靠「人工把值得抓的单篇文章链接丢进种子文件」补充进日报。采集时只抓 `fetched: false` 的条目，抓完自动回写 `fetched: true`；已抓取记录保留 3 天后自动清理。

```jsonc
{
  "version": "1.0.0",
  "updatedAt": "2026-08-07T00:00:00.000Z",   // 最近一次回写时间（采集自动更新）
  "articles": [
    {
      "sourceName": "储能与电力市场",          // 必填，将作为日报来源名
      "url": "https://mp.weixin.qq.com/s/xxx", // 必填，mp.weixin.qq.com 单篇文章链接
      "title": "",                             // 可选，留空则抓取后回填
      "pubDate": null,                         // 可选 ISO，留空则解析正文日期
      "addedAt": "2026-08-07T00:00:00.000Z",   // 加入时间（用于 3 天清理）
      "fetched": false                         // 是否已抓取（采集自动置 true）
    }
  ]
}
```

采集位置：`scripts/build-daily-v2.mjs` 线上抓取段在 `fetchAllFeeds` 之后读取并注入 items 流；实现见 `scripts/lib/fetch.mjs` 的 `loadWechatSeeds` / `saveWechatSeeds` / `fetchWechatSeeds`。

## 10. 增量字段协议（阶段 B 起）

> 来源：`docs/AIHOT_IMPLEMENTATION_PLAN.md` §4 A-02。规则先行、字段随后——
> B/D/C 阶段真正引入下列字段时，本文表同步补充约束细节。

三条兼容规则：

1. **只新增可选字段**：旧消费端（前端 `assets/app.js`、管理后台、钉钉推送）遇到未知字段必须忽略，不得因新字段缺失或出现而报错（`tests/schema.test.mjs` 前瞻兼容用例把这一容忍性固化为契约）。
2. **schemaVersion 不变**：`daily-v2.json` 保持 `schemaVersion: 2`、`featured.json` 保持 `1`。若实施中确需破坏兼容，另开版本迁移任务，不搭车。
3. **来源身份优先配置 ID 与显式别名表**，域名只作兜底（公众号不能统一算 `mp.weixin.qq.com` 一家）；无法确认身份时保留未知标记，不宣称完成转载溯源。

规划字段（首次引入阶段）：

| 字段/文件 | 用途 | 首次引入 |
|---|---|---|
| `source.id`、关联报道 `sourceId` | 稳定的来源身份 | B |
| `independentSourceCount` | 含主来源的去重来源总数 | B |
| 关联报道 `publishedAt`（可选） | 后续热度衰减依据；未知不伪造 | B |
| 内部文章 `articleId` | 基于保守归一 URL 的稳定身份 | B |
| `data/event-overrides.json` | 跨日文章级必须合并/禁止合并约束 | B |
| `featured.observationDetails` | 与字符串观察并存的事实与引用 | D |
| 内部 `selectionTrace` | 规则分、业务分、理由、模型/提示词版本 | C |
| `feeds/archive/`、`feeds/topics/` | 历史快照与主题索引 | E |

## 11. 离线回放与固定回执夹具（阶段 A-01）

固定可复现基线：固定输入 + 固定模型回执，离线重复回放同一输出，供 B 阶段改动前后对比。

| 命令/机制 | 说明 |
|---|---|
| `npm run build:v2:replay` | 老回放入口：`samples/daily/*.json` 走完整管线，写 `feeds/dry-run/<date>/`（不碰正式数据） |
| `npm run baseline:upgrade` | 基线编排：逐日回放 → `samples/baseline/quality-upgrade/<date>/{daily,featured}.json` + `report.json`（逐日指标：精选/热点/观察/漏合/合并决策日志/耗时）+ `manifest.json`（代码/配置/提示词/运行环境 sha256 摘要） |
| `JEV_REPLAY_FILE` | 离线回放已录制 Jev 判定回执，**绝不发网络请求**；未命中硬失败（提示 `--record` 重录），不静默降级——否则基线会无感知漂移 |
| `JEV_RECORD_FILE` | 真实调用后把回执原子落盘（`samples/jev-fixtures/<date>.json`，key=payload 的 sha256 前 16 位）。记录**本次实际使用的回执**：有 `TYPESAFE_API_KEY` 走直连；无 key 且配置了 `JEV_FALLBACK_*` 时直接走备胎，夹具 header 的 `source` 字段标注来源（`jev-direct` / `fallback:<模型>`），编排脚本逐日核验文件落盘且非全错 |

夹具失效与重录：改动 `scripts/lib/jev.mjs` 提示词、`data/enums.json` topics 或回放输入，都会使旧 key 失效（这是特性——manifest 的版本摘要捕获的正是它）。重录一条命令：

```
TYPESAFE_API_KEY=<key> node scripts/build-quality-baseline.mjs --record
```

原始输入快照（`samples/raw/`，CI 常驻积累）：线上构建设 `RAW_SNAPSHOT_DIR=samples/raw` 后，把「管线真实输入」（翻译+种子注入后的 rawItems）连同当日 `exposure-history.json`、`wechat-articles.json` gzip 落盘到 `samples/raw/<date>/`；`scripts/prune-raw-snapshots.mjs --keep=30` 滚动清理。V2 时代日期由此积累，`baseline:upgrade` 自动纳入（输入来源优先 `samples/daily/`）。

曝光记忆与回放：7 个既有基线日（2026-07-30~08-05）早于曝光记忆功能上线（2026-09-08），当时状态本就是空，按空集回放是**正确行为**而非缺陷；`samples/raw/` 快照日则按当日 `exposure-history.json` 还原。

误合/漏合口径：漏合由 `samples/annotations` 的 duplicateOf 标注对按 URL 指纹（主 URL + relatedSources，canonical 归一）推导，覆盖面限于已标注样本；误合无负例标签，`report.json` 的 `mergeDecisionLog` 只供人工抽查，不给计数。

> **公众号名册（2026-08-07 收集，未进 `data/sources.json`）**：公众号无公开主页可跳转，卡片无法直达，故不在信息源页展示，仅作种子文件抓取。名单：电网头条、能源新磁场、新能源产业家、创客能源、电气时代、能源新媒、蓝色碳能（电力/新能源）；SST渗透率、燃气轮机聚焦（发电）；储能与电力市场、储能头条、储能100人、兰木达电力现货、蓝海经研、阳光电源、光储星球、储能日参（储能）；AIDC储能、IDC Energy（AIDC）；华为数字能源（AI/云计算）。抓取某公众号文章时，将文章链接按本文件格式填入 `articles` 即可，`sourceName` 用上表名称。
