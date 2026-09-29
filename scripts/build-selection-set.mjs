#!/usr/bin/env node
/**
 * 构建精选价值标注样本集（内容质量升级方案 C-01 前置准备）。
 *
 * 目的：把「这条消息值不值得进每日精选」的标注尽早交给业务方，
 * 与 A/B 阶段开发并行。数据与基线同源（samples/daily/ 的 7 个基线日，
 * 即当初 112 条相关性标注集的同一批快照），一次劳动两用。
 *
 * 与旧相关性标注（samples/annotations/）的关系：
 *   - 旧的 relevant/quality/topic/duplicateOf 作为**预标注线索**带进
 *     set.json 的 preAnnotation 字段，只用于展示提示，不参与指标计算；
 *   - 新标签（select/reject/either + isMajorEvent + eventGroupId + reason）
 *     全部由人工在 labels.json 里填写，两者分开保存（方案 C-01 要求）。
 *
 * 分层抽样（固定种子，可复现）：
 *   1. 旧标注 relevant=relevant 的全部保留（精选判定的核心人群）；
 *   2. 旧标注 relevant=irrelevant 的全部保留（快速 reject，兼作噪声层）；
 *   3. 未标注条目按种子随机补齐到 --target 条（覆盖未抽样过的情况）。
 *
 * eventGroupId 由旧 duplicateOf 关系用并查集预先连好（防止后续
 * dev/holdout 划分时同一事件的条目跨集合泄漏）；新发现的事件组
 * 在标注时补填。
 *
 * 用法:
 *   node scripts/build-selection-set.mjs [--target=180] [--seed=20260929]
 *
 * 输出:
 *   samples/selection/set.json     待标注清单（含 preAnnotation 线索）
 *   samples/selection/labels.json  标注骨架（重复运行不覆盖已填标签）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAILY_DIR = path.resolve(__dirname, '../samples/daily');
const OLD_LABELS_PATH = path.resolve(__dirname, '../samples/annotations/labels.json');
const OLD_SET_PATH = path.resolve(__dirname, '../samples/annotations/set.json');
const OUT_DIR = path.resolve(__dirname, '../samples/selection');

/** 可复现的伪随机：mulberry32（与 build-annotation-set.mjs 同一实现） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由旧相关性标签推导「建议决定」，仅作标注页提示，不算人工标签。
 * 相关性已判无关 → 建议 reject；相关但质量低 → 建议 reject；
 * 相关 → 不给建议（业务价值必须人来判断）。
 */
export function suggestDecision(oldLabel) {
  if (!oldLabel || oldLabel.relevant == null) return null;
  if (oldLabel.relevant === 'irrelevant') return 'reject';
  if (oldLabel.quality === 'low') return 'reject';
  return null;
}

/** 并查集：把 duplicateOf 边连成事件组，返回 id → eventGroupId。 */
export function buildEventGroups(oldSet, oldLabels) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    // 路径压缩
    let c = x;
    while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  // 先注册全部节点再连边：duplicateOf 可能指向 oldSet 中顺序在后的样本
  // （如 s0094→s0111），单遍扫描会在节点未注册时静默丢边
  for (const s of oldSet) {
    if (!parent.has(s.id)) parent.set(s.id, s.id);
  }
  for (const s of oldSet) {
    const dup = oldLabels[s.id]?.duplicateOf;
    if (dup && parent.has(dup)) union(s.id, dup);
  }
  // 根 → 连续编号（按首次出现顺序，确定性）
  const rootToGroup = new Map();
  const idToGroup = new Map();
  for (const s of oldSet) {
    const root = find(s.id);
    if (!rootToGroup.has(root)) rootToGroup.set(root, `eg${String(rootToGroup.size + 1).padStart(3, '0')}`);
    idToGroup.set(s.id, rootToGroup.get(root));
  }
  return idToGroup;
}

/**
 * 分层选取：labeled-relevant 全留、labeled-irrelevant 全留、
 * unlabeled 用 rng 随机补齐到 target。
 * @returns {Array<{item: object, stratum: string}>}
 */
export function pickStratified(entries, target, rng) {
  const relevant = entries.filter(e => e.stratum === 'labeled-relevant');
  const irrelevant = entries.filter(e => e.stratum === 'labeled-irrelevant');
  const unlabeled = entries.filter(e => e.stratum === 'unlabeled');
  const fill = Math.max(0, target - relevant.length - irrelevant.length);
  const shuffled = unlabeled
    .map(e => ({ e, r: rng() }))
    .sort((a, b) => a.r - b.r)
    .map(v => v.e)
    .slice(0, fill);
  // 顺序按 relevant → irrelevant → fill，标注时核心人群先出现
  return [...relevant, ...irrelevant, ...shuffled];
}

const args = process.argv.slice(2);
const TARGET = parseInt(args.find(a => a.startsWith('--target='))?.split('=')[1] || '180', 10);
const SEED = parseInt(args.find(a => a.startsWith('--seed='))?.split('=')[1] || '20260929', 10);

async function main() {
  const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  if (!isMain) return; // 被 import 复用纯函数时不执行 CLI

  const files = (await fs.readdir(DAILY_DIR)).filter(f => f.endsWith('.json')).sort();
  if (!files.length) throw new Error('samples/daily/ 为空');

  const oldLabelsData = JSON.parse(await fs.readFile(OLD_LABELS_PATH, 'utf8'));
  const oldLabels = oldLabelsData.labels || {};
  const oldSet = JSON.parse(await fs.readFile(OLD_SET_PATH, 'utf8'));
  // 旧样本 id → 样本条目（拿 duplicateOf 所在的日期等信息）
  const groups = buildEventGroups(oldSet, oldLabels);

  // 汇总 7 天条目，带上旧标注线索
  const entries = [];
  for (const file of files) {
    const date = file.replace('.json', '');
    const daily = JSON.parse(await fs.readFile(path.join(DAILY_DIR, file), 'utf8'));
    for (const it of (daily.items || [])) {
      const key = it.link || it.title || '';
      const old = oldSet.find(s => s.url === key && s.date === date);
      const oldLabel = old ? oldLabels[old.id] : null;
      entries.push({
        item: it,
        date,
        oldId: old?.id || null,
        stratum: oldLabel?.relevant === 'relevant' ? 'labeled-relevant'
          : oldLabel?.relevant === 'irrelevant' ? 'labeled-irrelevant' : 'unlabeled',
        oldLabel,
      });
    }
  }

  const rng = mulberry32(SEED);
  const picked = pickStratified(entries, TARGET, rng);

  const set = picked.map((e, i) => ({
    id: `q${String(i + 1).padStart(4, '0')}`,
    date: e.date,
    source: e.item.source || '',
    title: e.item.translatedTitle && e.item.translatedTitle !== e.item.title
      ? `${e.item.title}【译:${e.item.translatedTitle}】`
      : (e.item.title || ''),
    summary: (e.item.summary || '').slice(0, 300),
    url: e.item.link || '',
    stratum: e.stratum,
    preAnnotation: e.oldId ? {
      oldId: e.oldId,
      relevant: e.oldLabel.relevant ?? null,
      quality: e.oldLabel.quality ?? null,
      topic: e.oldLabel.topic ?? null,
      eventGroupId: groups.get(e.oldId) ?? null,
      suggestedDecision: suggestDecision(e.oldLabel),
    } : null,
  }));

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, 'set.json'), JSON.stringify(set, null, 2) + '\n');

  // labels：已填 decision 的标签保留，其余初始化骨架（重复运行不覆盖人工标注）
  const labelsPath = path.join(OUT_DIR, 'labels.json');
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(labelsPath, 'utf8'));
  } catch {
    existing = null;
  }
  const labels = {};
  for (const s of set) {
    if (existing?.labels?.[s.id]?.decision != null) {
      labels[s.id] = existing.labels[s.id];
    } else {
      // eventGroupId 预填旧 duplicateOf 组，标注时可直接沿用或改
      labels[s.id] = {
        decision: null,
        isMajorEvent: null,
        eventGroupId: s.preAnnotation?.eventGroupId ?? null,
        reason: '',
        confidence: null,
      };
    }
  }
  await fs.writeFile(labelsPath, JSON.stringify({
    schemaVersion: 1,
    createdAt: existing?.createdAt || new Date().toISOString(),
    seed: SEED,
    target: TARGET,
    note: '精选价值标注（内容质量升级方案 C-01）。decision: select|reject|either（该不该进每日精选 12 条；either=两可不计分母）；isMajorEvent: true|false|null（当天圈内大事件）；eventGroupId: 同一事件的条目填同一组号（dev/holdout 按事件组划分，防泄漏）；reason: 标注理由；confidence: high|medium|low。preAnnotation 仅为旧相关性标注的线索，不是本标注的结果。',
    labels,
  }, null, 2) + '\n');

  const byStratum = set.reduce((a, s) => { a[s.stratum] = (a[s.stratum] || 0) + 1; return a; }, {});
  const done = Object.values(labels).filter(l => l.decision != null).length;
  console.log(`✅ 精选标注集已生成: ${set.length} 条 (目标 ${TARGET}，种子 ${SEED})`);
  console.log(`   分层: ${JSON.stringify(byStratum)}`);
  console.log(`   样本清单: samples/selection/set.json`);
  console.log(`   标注文件: samples/selection/labels.json（已标 ${done}/${set.length} 条）`);
}

await main();
