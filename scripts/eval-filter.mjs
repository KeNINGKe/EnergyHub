#!/usr/bin/env node
/**
 * B-02 验收：用 112 条人工标注评估相关性硬过滤器的查准率/查全率。
 *
 * 用法: node scripts/eval-filter.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFilters, classifyItem } from './lib/filter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANN_DIR = path.resolve(__dirname, '../samples/annotations');

const set = JSON.parse(await fs.readFile(path.join(ANN_DIR, 'set.json'), 'utf8'));
const labels = JSON.parse(await fs.readFile(path.join(ANN_DIR, 'labels.json'), 'utf8')).labels;
const filters = await loadFilters();

let tp = 0, fp = 0, fn = 0, tn = 0;
const fpList = [], fnList = [];

for (const s of set) {
  const human = labels[s.id]?.relevant === 'relevant';
  const auto = classifyItem({ title: s.title, summary: s.summary }, filters);
  if (auto.relevant && human) tp++;
  else if (auto.relevant && !human) { fp++; fpList.push({ id: s.id, title: s.title.slice(0, 70), reason: auto.reason }); }
  else if (!auto.relevant && human) { fn++; fnList.push({ id: s.id, title: s.title.slice(0, 70) }); }
  else tn++;
}

const precision = tp / (tp + fp);
const recall = tp / (tp + fn);
const f1 = (2 * precision * recall) / (precision + recall);

console.log(`标注样本: ${set.length} 条 | TP ${tp} FP ${fp} FN ${fn} TN ${tn}`);
console.log(`precision ${precision.toFixed(3)} | recall ${recall.toFixed(3)} | F1 ${f1.toFixed(3)}`);

if (fpList.length) {
  console.log('\n— 误收 (FP) —');
  fpList.forEach(x => console.log(`  ${x.id} | ${x.title} | ${x.reason}`));
}
if (fnList.length) {
  console.log('\n— 漏收 (FN) —');
  fnList.forEach(x => console.log(`  ${x.id} | ${x.title}`));
}

// 非零退出码，便于 CI 判断
if (f1 < 0.8) {
  console.error('\nF1 < 0.8，未达验收线。');
  process.exit(1);
}
console.log(`\nF1 ≥ 0.8 达标。`);
