#!/usr/bin/env node
/**
 * 构建人工标注样本集（阶段 A-02）。
 *
 * 从 samples/daily/*.json 中按固定种子抽样（每天最多 N 条，保证跨天覆盖），
 * 生成可复现的 samples/annotations/set.json。标注结果写入 labels.json。
 *
 * 用法:
 *   node scripts/build-annotation-set.mjs [--per-day=18] [--seed=20260805]
 *
 * 输出:
 *   samples/annotations/set.json    样本清单（id、日期、来源、标题、摘要、链接）
 *   samples/annotations/labels.json 标注骨架（初始为 null，待填充）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../samples/daily');
const OUT_DIR = path.resolve(__dirname, '../samples/annotations');

const args = process.argv.slice(2);
const PER_DAY = parseInt(args.find(a => a.startsWith('--per-day='))?.split('=')[1] || '18', 10);
const SEED = parseInt(args.find(a => a.startsWith('--seed='))?.split('=')[1] || '20260805', 10);

// 可复现的伪随机：mulberry32
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const files = (await fs.readdir(SAMPLES_DIR)).filter(f => f.endsWith('.json')).sort();
  if (!files.length) throw new Error('samples/daily/ 为空，请先运行 node scripts/extract-samples.mjs');

  const rng = mulberry32(SEED);
  const set = [];
  let seq = 0;

  for (const file of files) {
    const date = file.replace('.json', '');
    const raw = await fs.readFile(path.join(SAMPLES_DIR, file), 'utf8');
    const daily = JSON.parse(raw);
    const items = Array.isArray(daily.items) ? daily.items : [];

    // 按固定种子打乱后取前 N 条，保证可复现
    const shuffled = items.map(x => ({ x, r: rng() })).sort((a, b) => a.r - b.r).map(v => v.x);
    const picked = shuffled.slice(0, PER_DAY);

    for (const it of picked) {
      seq++;
      const id = `s${String(seq).padStart(4, '0')}`;
      set.push({
        id,
        date,
        source: it.source || '',
        title: it.translatedTitle && it.translatedTitle !== it.title ? `${it.title}【译:${it.translatedTitle}】` : (it.title || ''),
        summary: (it.summary || '').slice(0, 200),
        url: it.link || ''
      });
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'set.json'), JSON.stringify(set, null, 2) + '\n');

  // labels：若已有标注则保留（合并），否则初始化骨架 —— 保证重复运行不覆盖人工标注
  const labelsPath = path.join(OUT_DIR, 'labels.json');
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(labelsPath, 'utf8'));
  } catch {
    existing = null;
  }
  const labels = {};
  for (const s of set) {
    if (existing?.labels && existing.labels[s.id] && existing.labels[s.id].relevant != null) {
      labels[s.id] = existing.labels[s.id];
    } else {
      labels[s.id] = { relevant: null, topic: null, duplicateOf: null, isPrimary: null, confidence: null, quality: null, note: '' };
    }
  }
  await fs.writeFile(labelsPath, JSON.stringify({
    schemaVersion: 1,
    createdAt: existing?.createdAt || new Date().toISOString(),
    seed: SEED,
    perDay: PER_DAY,
    note: '人工标注（阶段 A-02）。relevant: relevant|irrelevant；quality: high|medium|low（相关但质量低标 low，null=未填）；topic: data/enums.json 中的 topic id（irrelevant 为 null）；duplicateOf: null 或同一事件的样本 id；isPrimary: 是否该重复组主来源（单条为 true，irrelevant 为 null）；confidence: high|medium|low（low 需人工复核）',
    labels
  }, null, 2) + '\n');

  console.log(`✅ 样本集已生成: ${set.length} 条 (每天最多 ${PER_DAY} 条，种子 ${SEED})`);
  console.log(`   样本清单: samples/annotations/set.json`);
  console.log(`   标注文件: samples/annotations/labels.json（已标注 ${Object.values(labels).filter(l => l.relevant != null).length}/${set.length} 条）`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
