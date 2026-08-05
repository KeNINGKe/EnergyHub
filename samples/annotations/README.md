# 样本人工标注（阶段 A-02）

> 交付物：固定样本 + 人工标注 + 质量基线 + 数据协议与校验函数。

## 文件

- `set.json`：112 条样本（7 天 × 每天 ≤18 条，固定种子 20260805，可复现）。
- `labels.json`：逐条标注。**112/112 已人工复核完成**（相关 77 / 无关 35）。生成方式：`scripts/build-review-page.mjs` 生成复核页，在浏览器逐条确认后导出覆盖此文件。

## 标注字段

| 字段 | 取值 | 说明 |
|---|---|---|
| `relevant` | `relevant` / `irrelevant` | 是否与电力/储能/AIDC（含算力基础设施）相关 |
| `quality` | `high` / `medium` / `low` / `null` | 相关内容的质量：软文、泛泛而谈、信息量低标 `low`（应进全部动态但排除出精选）；`null`=未填 |
| `topic` | `data/enums.json` 中的 topic id | 主主题；irrelevant 为 `null` |
| `duplicateOf` | null 或样本 id | 是否与另一条样本属于同一事件 |
| `isPrimary` | true / false / null | 是否该重复组主来源（单条相关为 true，irrelevant 为 null） |
| `confidence` | high / medium / low | low 需人工复核 |
| `note` | 字符串 | 标注理由 |

> `quality` 与 `confidence` 的区别：`confidence` 是「我对这条判断有多大把握」；`quality` 是「这条内容本身值不值得进精选」。相关但质量低的条目应标 `relevant` + `quality: low`（进入全部动态但排除出精选）。

## 相关判定规则（对齐 PRD 8.1）

**相关**：发电（光伏/风电/核电/SMR/氢能/水电/地热）、储能（电池/BESS/抽蓄/换电/充电基础设施）、电网（并网/输配电/微网/电力市场/碳市场/电价）、AIDC（数据中心电力、AI 算力基础设施、GPU/芯片/服务器、液冷/PUE、PPA）、燃料（天然气/氢/煤炭）、相关融资与政策。

**无关（负面规则）**：消费汽车评测/发布/促销/销售数据、消费电子评测与促销、无能源关联的 AI 应用或模型新闻、单纯硬件价格/股价、趣味硬件新闻、娱乐/社会新闻、招聘与营销。

## 已识别的重复事件（样本内）

| 事件 | 主条目 | 重复条目 |
|---|---|---|
| Eolian 俄亥俄州 1.06GWh BESS 开工 | s0027（Energy Storage News） | s0035（Electrek） |
| 美国禁止外国产太阳能逆变器 | s0017（pv magazine，政策报道） | s0084（CleanTechnica，评论） |
| 埃因霍温太阳能救护车原型 | s0111（PV-Tech） | s0094（Electrek） |

## 复核工具

`npm run annotate` → 生成 `samples/annotations/review.html`，浏览器打开逐条确认。
改动任意字段即视为「已复核」，`confidence: low` 自动提升为 `high`；导出/复制按钮始终可用。
重新生成样本集不会覆盖已有标注（`scripts/build-annotation-set.mjs` 合并保留）。
