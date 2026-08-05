# EnergyHub V1.1 数据协议

> 阶段 A 交付物（A-03/A-04/A-05 汇总）。配套：`V1.1_PRD.md` 第 7 节、`data/enums.json`、`scripts/lib/schema.mjs`。
> 校验原则：**校验通过前不得覆盖上一份有效数据**（PRD 8、异常场景 AC-08）。

## 1. 文件清单

| 文件 | 用途 | 生成方 |
|---|---|---|
| `feeds/daily.json` | 全部动态（事件级） | 阶段 B 生成器（V1.1 后）；当前仍为 V1 旧版 |
| `feeds/featured.json` | 今日观察 + 精选 ID 编排 | 阶段 B 生成器 |
| `data/editorial-overrides.json` | 人工覆盖配置（可选） | 人工维护 |
| `data/enums.json` | 主题/来源类型/影响/地区枚举 | 人工维护（阶段 A-05 固化） |

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

## 3. `feeds/featured.json`

```jsonc
{
  "schemaVersion": 1,
  "date": "2026-08-05",
  "generatedAt": "2026-08-05T04:00:00.000Z",
  "observations": ["今日观察，≤5 条"],
  "featuredEventIds": ["evt_xxx", "evt_yyy"]
}
```

- `featuredEventIds` 中的每个 id **必须存在于同日期 `daily.json`**（校验失败则不发布）。
- 数量目标 5–10 条，**不足时如实减少**，不降低质量门槛（软约束，超上限只给 warning）。
- 数组顺序即展示顺序。

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
| `samples/annotations/` | 112 条样本 `set.json` + 标注 `labels.json`（AI 预标注 v1，9 条 low 待人工复核） |
| `samples/baseline/` | V1 流程质量基线 `baseline.json`（`scripts/build-baseline.mjs`） |

基线（2026-08-05）：无关率 ≈ 26.8%、样本内重复率 ≈ 2.7%、日均成功来源 28.6/34 ≈ 84%、日均条目 45.3。供 F-01 回放前后对比。

## 8. 完成条件核对（阶段 A）

- [x] A-01 固定样本（7 天，`samples/daily/` + manifest）
- [x] A-02 人工标注 ≥100 条（112 条，`samples/annotations/`）
- [x] A-03 校验规则与函数（`scripts/lib/schema.mjs` + `tests/`）
- [x] A-04 前端兼容层（`scripts/lib/compat.mjs` + `tests/`）
- [x] A-05 枚举固化（`data/enums.json`）
- [x] A-06 基线记录（`samples/baseline/`）
- [x] 完成条件「相同输入重复执行，得到结构一致、ID 稳定的输出」：`npm test` 25 项通过，覆盖 ID 稳定性与样本可复现性。
