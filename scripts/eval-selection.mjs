#!/usr/bin/env node
/**
 * 精选评测（阶段 C-01，AIHOT_IMPLEMENTATION_PLAN §6）。
 *
 * 用 samples/selection/ 的人工标注评估「每日精选 12 条」的评选质量：
 *   - 查准率/查全率（select/reject 二分类，either 不入分母——拿不准就该标 either）
 *   - Top-5 人工认可率（候选足够的日期，当天高分前 5 里几条被人工认可）
 *   - 重要事件漏选数（isMajorEvent=true 且未被精选，单独计数）
 *   - 主题/地区分组表现 + 错例清单（分子分母同时给出，小样本达标≠长期质量）
 *
 * 口径说明：样本是抓取层原始条目，「未进精选」= 被过滤/未聚类/落选三者的
 * 合并视角——评测回答的是「这条值不值得占精选一个位置，管线给对了吗」，
 * 不区分它在哪一层被拦下（分层定位靠 selectionTrace/合并日志）。
 *
 * dev/holdout 按事件组划分（同一事件的转载/中英文版本不得跨集合泄漏）：
 * 确定性种子 70/30；默认只报 dev，--holdout 报留出集（仅版本验收用，
 * 不用于反复调提示词）。
 *
 * 0 标注时输出框架自检（不造任何数字）。
 *
 * 用法:
 *   npm run eval:selection               # dev 集
 *   npm run eval:selection -- --holdout  # 留出集（版本验收时才看）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventFingerprint } from './lib/exposure.mjs';
import { canonicalUrl } from './lib/compat.mjs';
import { mulberry32 } from './lib/selection-score.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEL_DIR = path.join(ROOT, 'samples', 'selection');
const BASELINE_DIR = path.join(ROOT, 'samples', 'baseline', 'quality-upgrade');
const SPLIT_SEED = 20261013;

/** 事件组 → dev/holdout（确定性；组数按种子洗牌后前 70% 归 dev）。 */
export function splitGroups(groupIds, { seed = SPLIT_SEED, devRatio = 0.7 } = {}) {
  const ids = [...new Set(groupIds)].sort();
  const shuffled = ids.map(g => ({ g, r: mulberry32(seed + [...g].reduce((a, c) => a + c.charCodeAt(0), 0))() }))
    .sort((a, b) => a.r - b.r)
    .map(v => v.g);
  const devCount = Math.max(1, Math.round(shuffled.length * devRatio));
  const dev = new Set(shuffled.slice(0, devCount));
  return { dev, holdout: new Set(ids.filter(g => !dev.has(g))) };
}

/**
 * 装载基线回放产物，构建 URL→事件 视图（canonical 归一，含 relatedSources）。
 * 返回 { urlToEvent: Map, byDate: Map<date, {events, featuredIds}> }。
 */
export async function loadBaselineViews(dates) {
  const urlToEvent = new Map();
  const byDate = new Map();
  for (const date of dates) {
    const dir = path.join(BASELINE_DIR, date);
    let daily, featured;
    try {
      daily = JSON.parse(await fs.readFile(path.join(dir, 'daily.json'), 'utf8'));
      featured = JSON.parse(await fs.readFile(path.join(dir, 'featured.json'), 'utf8'));
    } catch {
      continue; // 该日无基线产物：样本按「未进精选」口径处理
    }
    const featuredIds = new Set(featured.featuredEventIds || []);
    const events = (daily.items || []).map(ev => ({
      id: ev.id,
      title: ev.title,
      importance: ev.importance,
      topic: ev.topic || 'other-energy',
      region: ev.region || '未知',
      featured: featuredIds.has(ev.id),
    }));
    byDate.set(date, { events, featuredIds: [...featuredIds] });
    for (const ev of daily.items || []) {
      for (const u of eventFingerprint(ev)) {
        if (!urlToEvent.has(u)) urlToEvent.set(u, { eventId: ev.id, date, featured: featuredIds.has(ev.id) });
      }
    }
  }
  return { urlToEvent, byDate };
}

/** 把标注样本挂到基线事件（canonicalUrl 对齐 eventFingerprint 口径）。 */
export function attachEvents(set, labels, urlToEvent) {
  return set.map(s => {
    const label = labels[s.id] || {};
    const url = canonicalUrl(s.url);
    return { ...s, label, matched: url ? (urlToEvent.get(url) || null) : null };
  });
}

/** 二分类指标（分子分母都给出；either 不入分母）。 */
export function binaryMetrics(rows) {
  let tp = 0, fp = 0, fn = 0, tn = 0, either = 0;
  const fpList = [], fnList = [];
  for (const r of rows) {
    const d = r.label.decision;
    if (d !== 'select' && d !== 'reject') { if (d === 'either') either++; continue; }
    const predicted = r.matched?.featured === true;
    if (d === 'select' && predicted) tp++;
    else if (d === 'reject' && predicted) { fp++; fpList.push(r); }
    else if (d === 'select' && !predicted) { fn++; fnList.push(r); }
    else tn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  return { tp, fp, fn, tn, either, precision, recall, fpList, fnList };
}

/**
 * Top-5 人工认可率（逐日）：当天基线精选事件按 importance 降序取前 5，
 * 逐条找覆盖它的标注样本：select=认可，reject=不认可，either/无标注=不计入。
 * 标注覆盖不足时按实际条数统计，不凑数。
 */
export function top5Approval(byDate, rows) {
  const out = [];
  const urlByEvent = new Map();
  for (const r of rows) {
    if (!r.matched) continue;
    if (!urlByEvent.has(r.matched.eventId)) urlByEvent.set(r.matched.eventId, []);
    urlByEvent.get(r.matched.eventId).push(r);
  }
  for (const [date, { events }] of byDate) {
    const featured = events.filter(e => e.featured)
      .sort((a, b) => (b.importance || 0) - (a.importance || 0));
    if (featured.length < 5) continue; // 候选不足的日期不评 Top-5（方案 §6）
    const top5 = featured.slice(0, 5).map(e => {
      const labeled = (urlByEvent.get(e.id) || []).filter(r => r.label.decision);
      const decision = labeled[0]?.label.decision || 'unlabeled';
      return { eventId: e.id, title: String(e.title || '').slice(0, 80), decision };
    });
    const judged = top5.filter(t => t.decision === 'select' || t.decision === 'reject');
    const approved = top5.filter(t => t.decision === 'select').length;
    out.push({ date, top5, judged: judged.length, approved });
  }
  return out;
}

/** 重要事件漏选：isMajorEvent=true 且未被精选（决策为 select 的列为高优先）。 */
export function missedMajorEvents(rows) {
  return rows
    .filter(r => r.label.isMajorEvent === true && r.matched?.featured !== true)
    .map(r => ({ id: r.id, date: r.date, title: r.title.slice(0, 100), decision: r.label.decision, reason: r.label.reason || '' }));
}

/** 主题分组表现（样本自身无 topic 字段，用 preAnnotation.topic 兜底）。 */
function byTopic(rows) {
  const groups = {};
  for (const r of rows) {
    if (r.label.decision !== 'select' && r.label.decision !== 'reject') continue;
    const topic = r.preAnnotation?.topic || 'unknown';
    (groups[topic] = groups[topic] || []).push(r);
  }
  const out = {};
  for (const [topic, list] of Object.entries(groups)) {
    const m = binaryMetrics(list);
    out[topic] = { n: list.length, tp: m.tp, fp: m.fp, fn: m.fn, tn: m.tn, precision: m.precision, recall: m.recall };
  }
  return out;
}

function fmt(x) { return x == null ? 'n/a' : x.toFixed(3); }

async function main() {
  const args = process.argv.slice(2);
  const holdout = args.includes('--holdout');

  const set = JSON.parse(await fs.readFile(path.join(SEL_DIR, 'set.json'), 'utf8'));
  const labelsDoc = JSON.parse(await fs.readFile(path.join(SEL_DIR, 'labels.json'), 'utf8'));
  const labels = labelsDoc.labels || {};

  const labeled = set.filter(s => labels[s.id]?.decision != null);
  console.log(`精选标注: ${labeled.length}/${set.length} 条已标（either 不入分母）`);
  if (labeled.length === 0) {
    console.log('0 条已标：评测框架就绪，标注完成前不产出任何指标（不造数）。');
    await fs.writeFile(path.join(SEL_DIR, 'eval-report.json'), JSON.stringify({
      schemaVersion: 1, generatedAt: new Date().toISOString(), status: 'no-labels', labeled: 0, total: set.length,
    }, null, 2) + '\n');
    return;
  }

  const dates = [...new Set(set.map(s => s.date))];
  const { urlToEvent, byDate } = await loadBaselineViews(dates);
  const rows = attachEvents(set, labels, urlToEvent);

  // dev/holdout 按事件组划分（null 组按样本自身 id 单独成组，不跨集合）
  const groupOf = s => labels[s.id]?.eventGroupId || `solo:${s.id}`;
  const { dev, holdout: hold } = splitGroups(set.map(groupOf));
  const devRows = rows.filter(r => dev.has(groupOf(r)));
  const holdRows = rows.filter(r => hold.has(groupOf(r)));
  const target = holdout ? holdRows : devRows;
  const setName = holdout ? 'holdout' : 'dev';

  console.log(`\n===== ${setName} 集（按事件组 ${holdout ? hold.size : dev.size} 组划分）=====`);

  const m = binaryMetrics(target);
  console.log(`二分类: TP ${m.tp} FP ${m.fp} FN ${m.fn} TN ${m.tn}（either ${m.either} 不计）`);
  console.log(`  查准率 ${m.precision == null ? 'n/a' : `${m.tp}/${m.tp + m.fp} = ${fmt(m.precision)}`}`);
  console.log(`  查全率 ${m.recall == null ? 'n/a' : `${m.tp}/${m.tp + m.fn} = ${fmt(m.recall)}`}`);

  const top5 = top5Approval(byDate, rows); // Top-5 是逐日榜单视角，不分 dev/holdout（标注全量判读）
  if (top5.length) {
    console.log(`\nTop-5 人工认可率（候选 ≥5 的 ${top5.length} 天）:`);
    for (const d of top5) console.log(`  ${d.date}: ${d.approved}/${d.judged} 被认可（${d.judged < 5 ? '标注覆盖不足，按实际条数' : ''}）`);
  } else {
    console.log('\nTop-5: 无候选 ≥5 的日期（标注覆盖或基线产物不足）');
  }

  const missed = missedMajorEvents(rows);
  console.log(`\n重要事件漏选（isMajorEvent=true 未进精选）: ${missed.length} 条`);
  missed.slice(0, 10).forEach(x => console.log(`  ${x.id} [${x.date}] ${x.title}${x.decision === 'select' ? ' ⚠️人工认为该选' : ''}`));

  console.log(`\n主题分组:`);
  for (const [t, g] of Object.entries(byTopic(target)).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${t}: n=${g.n} P=${fmt(g.precision)} R=${fmt(g.recall)}`);
  }

  if (m.fpList.length) {
    console.log(`\n— 误选（人工 reject 但进了精选）—`);
    m.fpList.forEach(r => console.log(`  ${r.id} [${r.date}] ${r.title.slice(0, 70)} | 理由: ${r.label.reason || '(未填)'}`));
  }
  if (m.fnList.length) {
    console.log(`\n— 漏选（人工 select 但未进精选）—`);
    m.fnList.forEach(r => console.log(`  ${r.id} [${r.date}] ${r.title.slice(0, 70)} | 理由: ${r.label.reason || '(未填)'}`));
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    set: setName,
    labeled: labeled.length,
    total: set.length,
    groups: { dev: dev.size, holdout: hold.size },
    binary: { tp: m.tp, fp: m.fp, fn: m.fn, tn: m.tn, either: m.either, precision: m.precision, recall: m.recall },
    top5,
    missedMajorEvents: missed,
    byTopic: byTopic(target),
    fpList: m.fpList.map(r => ({ id: r.id, date: r.date, title: r.title, reason: r.label.reason })),
    fnList: m.fnList.map(r => ({ id: r.id, date: r.date, title: r.title, reason: r.label.reason })),
    notes: [
      '未进精选 = 被过滤/未聚类/落选的合并视角；分层定位用 selectionTrace',
      '门槛（查准 ≥90%/查全 ≥80%）在基线测得后冻结；小样本达标≠长期质量',
      'holdout 仅版本验收用，不用于反复调提示词',
    ],
  };
  await fs.writeFile(path.join(SEL_DIR, 'eval-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\n报告已写入 samples/selection/eval-report.json（${setName} 集）`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
