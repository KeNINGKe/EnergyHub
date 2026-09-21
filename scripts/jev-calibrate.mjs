#!/usr/bin/env node
/**
 * Jev 概率校准（samples/annotations 112 条人工标注 vs Jev relevant 概率）。
 *
 * 目的：验证 reviewOne 的捞回阈值（JEV_RESCUE_THRESHOLD，默认 0.8）是否合理。
 * 官方文档建议用标注数据 calibrate 概率输出；本脚本输出各阈值下的
 * 混淆矩阵 + 概率分桶，供人工决定阈值，不自动改配置。
 *
 * 用法：TYPESAFE_API_KEY=... node scripts/jev-calibrate.mjs
 * 输出：samples/annotations/jev-calibration.json（结果快照，供对比复盘）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnums } from './lib/schema.mjs';
import { reviewRejected, jevConfigured } from './lib/jev.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

function confusion(samples, threshold) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const s of samples) {
    const pred = s.probability != null && s.probability >= threshold;
    if (s.label === 'relevant') pred ? tp++ : fn++;
    else pred ? fp++ : tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return { threshold, tp, fp, tn, fn, precision, recall,
    f1: precision && recall ? 2 * precision * recall / (precision + recall) : null };
}

const enums = await loadEnums();
if (!jevConfigured()) {
  console.error('未配置 TYPESAFE_API_KEY');
  process.exit(1);
}

const [set, labelsFile] = await Promise.all([
  fs.readFile(path.join(ROOT, 'samples', 'annotations', 'set.json'), 'utf8'),
  fs.readFile(path.join(ROOT, 'samples', 'annotations', 'labels.json'), 'utf8'),
]);
const labels = JSON.parse(labelsFile).labels || {};
const items = JSON.parse(set).map(s => ({
  ...s,
  label: labels[s.id]?.relevant || null,
  labeledTopic: labels[s.id]?.topic || null,
  confidence: labels[s.id]?.confidence || null,
})).filter(s => s.label);
console.log(`标注样本 ${items.length} 条（relevant ${items.filter(s => s.label === 'relevant').length} / irrelevant ${items.filter(s => s.label === 'irrelevant').length}）`);

// 逐条跑 Jev：走 reviewRejected 的并发+退避路径（直连 API，见 lib/jev.mjs 头注），
// 且复用同一套问题定义，保证校准对象 = 线上行为。
console.log(`并发执行中（${items.length} 条，4 并发，预计 ~${Math.ceil(items.length * 2 / 4 / 60)} 分钟）...`);
const verdicts = await reviewRejected(
  items.map(s => ({ title: s.title, summary: s.summary, source: s.source })), enums,
  { budgetMs: 90 * 60_000 });
const results = items.map((s, i) => ({ id: s.id, label: s.label, labeledTopic: s.labeledTopic,
  confidence: s.confidence, probability: verdicts[i]?.probability ?? null, topic: verdicts[i]?.topic ?? null }));

const failures = results.filter(r => r.probability == null);
const ok = results.filter(r => r.probability != null);
console.log(`\nJev 判定成功 ${ok.length} / 失败(超时/异常) ${failures.length}`);

// 各阈值混淆矩阵
console.log('\n阈值 | TP  FP  TN  FN | 精确率 召回率 F1');
for (const t of THRESHOLDS) {
  const c = confusion(ok, t);
  console.log(`${t.toFixed(2)} | ${String(c.tp).padStart(3)} ${String(c.fp).padStart(3)} ${String(c.tn).padStart(3)} ${String(c.fn).padStart(3)} | ${c.precision?.toFixed(2) ?? '-'}   ${c.recall?.toFixed(2) ?? '-'}  ${c.f1?.toFixed(2) ?? '-'}`);
}

// 概率分桶分布（看分离度：理想是相关集中高桶、不相关集中低桶）
const buckets = {};
for (const r of ok) {
  const b = r.probability >= 0.9 ? '0.9+' : r.probability >= 0.8 ? '0.8-0.9' : r.probability >= 0.5 ? '0.5-0.8' : r.probability >= 0.2 ? '0.2-0.5' : '<0.2';
  buckets[b] = buckets[b] || { relevant: 0, irrelevant: 0 };
  buckets[b][r.label]++;
}
console.log('\n概率分桶        relevant irrelevant');
for (const b of ['0.9+', '0.8-0.9', '0.5-0.8', '0.2-0.5', '<0.2']) {
  if (buckets[b]) console.log(`${b.padEnd(12)} ${String(buckets[b].relevant).padStart(8)} ${String(buckets[b].irrelevant).padStart(11)}`);
}

// 主题判定准确率（仅 relevant 且双方都有 topic 的样本）
const topicOk = ok.filter(r => r.label === 'relevant' && r.labeledTopic && r.topic);
const topicHit = topicOk.filter(r => r.topic === r.labeledTopic).length;
console.log(`\n主题一致: ${topicHit}/${topicOk.length}${topicOk.length ? ` (${(topicHit / topicOk.length * 100).toFixed(0)}%)` : ''}`);

// 低置信标注单独看（README 说 low 需人工复核，模型分歧大属正常）
const lowConf = ok.filter(r => r.confidence === 'low');
if (lowConf.length) {
  const agree = lowConf.filter(r => (r.probability >= 0.5) === (r.label === 'relevant')).length;
  console.log(`低置信标注(${lowConf.length}条)方向一致: ${agree}`);
}

// 误判明细：高概率误报(FP)和低概率漏报(FN) @0.8
const setById = new Map(items.map(s => [s.id, s]));
console.log('\n@0.8 误杀(标 relevant 但概率<0.8):');
for (const r of ok) if (r.label === 'relevant' && r.probability < 0.8) {
  console.log(`  ${r.id} p=${r.probability.toFixed(2)} ${(setById.get(r.id)?.title || '').slice(0, 70)}`);
}
console.log('\n@0.8 误捞(标 irrelevant 但概率≥0.8):');
for (const r of ok) if (r.label === 'irrelevant' && r.probability >= 0.8) {
  console.log(`  ${r.id} p=${r.probability.toFixed(2)} ${(setById.get(r.id)?.title || '').slice(0, 70)}`);
}

const out = { generatedAt: new Date().toISOString(), sampleCount: ok.length + failures.length,
  failures: failures.length, confusion: THRESHOLDS.map(t => confusion(ok, t)),
  buckets, topic: { hit: topicHit, total: topicOk.length }, results };
await fs.writeFile(path.join(ROOT, 'samples', 'annotations', 'jev-calibration.json'), JSON.stringify(out, null, 2) + '\n');
console.log('\n✅ 快照已写入 samples/annotations/jev-calibration.json');
