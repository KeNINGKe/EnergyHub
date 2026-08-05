#!/usr/bin/env node
/**
 * 生成 V1 流程质量基线（阶段 A-06）。
 *
 * 输入：
 *   samples/manifest.json      7 天样本的抓取统计（成功来源数等）
 *   samples/annotations/*      112 条人工标注（无关率、重复率、主题分布）
 * 输出：
 *   samples/baseline/baseline.json   可对比的基线报告（供 F-01 回放前后对比）
 *
 * 用法: node scripts/build-baseline.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../samples');

const manifest = JSON.parse(await fs.readFile(path.join(SAMPLES_DIR, 'manifest.json'), 'utf8'));
const set = JSON.parse(await fs.readFile(path.join(SAMPLES_DIR, 'annotations/set.json'), 'utf8'));
const labelsData = JSON.parse(await fs.readFile(path.join(SAMPLES_DIR, 'annotations/labels.json'), 'utf8'));
const L = labelsData.labels;

const total = set.length;
const relevant = set.filter(s => L[s.id]?.relevant === 'relevant').length;
const irrelevant = total - relevant;
const duplicateFrom = set.filter(s => L[s.id]?.duplicateOf).length;
const lowConfidence = set.filter(s => L[s.id]?.confidence === 'low').length;

// 成功来源数：跨 7 天平均
const succ = manifest.samples.map(s => s.successSources).filter(x => x != null);
const totalSrc = manifest.samples.map(s => s.totalSources).filter(x => x != null);
const avgSuccess = Math.round((succ.reduce((a, b) => a + b, 0) / succ.length) * 10) / 10;
const avgTotal = Math.round((totalSrc.reduce((a, b) => a + b, 0) / totalSrc.length) * 10) / 10;
const successRate = Math.round((succ.reduce((a, b) => a + b, 0) / totalSrc.reduce((a, b) => a + b, 0)) * 1000) / 1000;

const avgItems = manifest.stats.avgItemsPerDay;

// 主题分布（相关样本）
const topics = {};
for (const s of set) {
  const t = L[s.id]?.topic;
  if (t) topics[t] = (topics[t] || 0) + 1;
}

const baseline = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: 'V1 流程基线（阶段 A-06）。基于 7 天 daily.json 样本 + 112 条人工标注（AI 预标注 v1）。',
  metrics: {
    sampleDays: manifest.stats.dates,
    totalItemsInSample: manifest.stats.totalItems,
    avgItemsPerDay: avgItems,
    annotatedSamples: total,
    irrelevantRate: Math.round((irrelevant / total) * 1000) / 1000,
    irrelevantCount: irrelevant,
    duplicateRate: Math.round((duplicateFrom / total) * 1000) / 1000,
    duplicateFromCount: duplicateFrom,
    duplicateGroups: 3,
    avgSuccessSources: avgSuccess,
    avgTotalSources: avgTotal,
    sourceSuccessRate: successRate,
    lowConfidenceLabels: lowConfidence
  },
  topicDistribution: topics,
  notes: [
    '无关率基线 ≈ 26.8%：当前 V1 流程仅做关键词硬过滤，消费汽车/消费电子/娱乐类噪声仍大量混入。',
    '重复率基线 ≈ 2.7%（抽样内）：V1 仅按 URL/标题去重，不做事件合并；跨天重复与相似事件重复未计入，实际重复率应更高。',
    '日均成功来源 28.6/34 ≈ 84%，接近 V1.1 目标 85%。',
    '主题分布失衡：chips-compute 与 solar-wind 各占 19 条，而 AIDC 核心主题（data-center-power 4、aidc-project 2）供给明显不足，与 PRD 判断一致。',
    'A-02 标注为 AI 预标注 v1，low 置信度 9 条需人工复核后此基线才可作为正式对比基准。'
  ]
};

const outDir = path.join(SAMPLES_DIR, 'baseline');
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n');

console.log('基线已生成: samples/baseline/baseline.json\n');
console.log(`  无关率: ${baseline.metrics.irrelevantRate} (${baseline.metrics.irrelevantCount}/${baseline.metrics.annotatedSamples})`);
console.log(`  重复率: ${baseline.metrics.duplicateRate} (样本内 ${baseline.metrics.duplicateFromCount} 条从属)`);
console.log(`  成功来源: ${baseline.metrics.avgSuccessSources}/${baseline.metrics.avgTotalSources} = ${(baseline.metrics.sourceSuccessRate * 100).toFixed(1)}%`);
console.log(`  日均条目: ${avgItems}`);
console.log(`  主题覆盖: ${Object.keys(topics).length} 个 topic`);
