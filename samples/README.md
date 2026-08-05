# EnergyHub V1.1 回放测试样本

> 阶段 A-01 交付物：固定样本 + 人工标注 + 质量基线 + 数据协议与校验函数。

## 目录

```
samples/
├── README.md            # 本说明
├── manifest.json        # 样本清单（日期、commit、抓取统计）
├── daily/               # 每天一份原始 daily.json 快照
│   ├── 2026-07-30.json
│   └── ...
├── annotations/         # A-02 人工标注结果
│   └── labels.json
└── baseline/            # A-06 质量基线
    └── baseline.json
```

## 样本来源与提取规则

- 来源：`KeNINGKe/EnergyHub@main` git 历史中的 `feeds/daily.json` 提交。
- 规则：daily.json 的 `date` 字段按北京时间（UTC+8）计算，一天可能有 05:00 / 12:00 两班；每个日期只保留**提交时间最新**的一份，保证「连续 7 天、每天一份」。
- 提取脚本：`scripts/extract-samples.mjs`（`npm run samples` 或 `node scripts/extract-samples.mjs --days=7`）。

## 样本日期与规模（2026-08-05 提取）

| 日期 | commit | items | success/total |
|---|---|---|---|
| 2026-07-30 | 915b316 | 62 | 26/34 |
| 2026-07-31 | 4926d53 | 57 | 30/34 |
| 2026-08-01 | 1a40353 | 46 | 30/34 |
| 2026-08-02 | 02fb1ca | 7 | 27/34 |
| 2026-08-03 | 8884820 | 15 | 30/34 |
| 2026-08-04 | 13c4c8f | 59 | 30/34 |
| 2026-08-05 | 0ed221a | 71 | 27/34 |

> 2026-08-02 / 08-03 为低产日（周末效应），items 明显偏少，是验证「低产日也能生成有效文件」的天然样本。
> 每份样本均带 `translatedTitle`（MyMemory 英文标题翻译），回放时应视为输入的一部分。
