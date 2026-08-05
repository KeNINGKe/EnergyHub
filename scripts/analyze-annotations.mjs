#!/usr/bin/env node
/**
 * 统计标注样本的分布与质量基线（阶段 A-02 / A-06）。
 * 输出：相关/无关比例、置信度分布、topic 分布、样本内重复组。
 *
 * 用法: node scripts/analyze-annotations.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANN_DIR = path.resolve(__dirname, '../samples/annotations');

const set = JSON.parse(await fs.readFile(path.join(ANN_DIR, 'set.json'), 'utf8'));
const labelsData = JSON.parse(await fs.readFile(path.join(ANN_DIR, 'labels.json'), 'utf8'));
const L = labelsData.labels;

const total = set.length;
const labeled = set.filter(s => L[s.id]?.relevant != null).length;
const relevant = set.filter(s => L[s.id]?.relevant === 'relevant').length;
const irrelevant = total - relevant;

const confidence = {};
for (const s of set) {
  const c = L[s.id]?.confidence || 'unset';
  confidence[c] = (confidence[c] || 0) + 1;
}

const quality = {};
for (const s of set) {
  const q = L[s.id]?.quality || 'unset';
  quality[q] = (quality[q] || 0) + 1;
}

const topics = {};
for (const s of set) {
  const t = L[s.id]?.topic;
  if (t) topics[t] = (topics[t] || 0) + 1;
}

const dupRoots = {};
for (const s of set) {
  const d = L[s.id]?.duplicateOf;
  if (d) dupRoots[d] = (dupRoots[d] || 0) + 1;
}

const lowConfidence = set.filter(s => L[s.id]?.confidence === 'low').map(s => s.id);

console.log(`标注覆盖: ${labeled}/${total} 条`);
console.log(`相关: ${relevant} 条 (${(relevant / total * 100).toFixed(1)}%)`);
console.log(`无关: ${irrelevant} 条 (${(irrelevant / total * 100).toFixed(1)}%)`);
console.log(`置信度分布: ${JSON.stringify(confidence)}`);
console.log(`质量分布: ${JSON.stringify(quality)}（相关但低质量 = quality:low）`);
console.log(`样本内重复组: ${Object.keys(dupRoots).length} 组，从属条目 ${Object.values(dupRoots).reduce((a, b) => a + b, 0)} 条`);
console.log(`待人工复核(low): ${lowConfidence.length} 条 -> ${lowConfidence.join(', ')}`);
console.log('\n--- topic 分布（相关样本） ---');
Object.entries(topics).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));
