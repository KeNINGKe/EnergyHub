#!/usr/bin/env node
/**
 * 相似事件合并（B-06）。
 *
 * 维度：时间（发布时间窗口）、实体（B-04 实体重叠）、标题（归一化 token Jaccard）、
 * 数字（相同单位的关键数字）。确定性：输入顺序决定聚类结果。
 *
 * 合并条件（全部满足）：
 *   - 时间差 ≤ mergeWindow 天
 *   - 相似度分 ≥ threshold（同主题 +0.2，共享实体 +0.35，共享数字 +0.35，
 *     标题 token 重叠 ≥0.35 +0.3、≥0.7 +0.45——近重复标题单独即可过 0.45 门槛，
 *     覆盖「同一事件中英文报道主题/实体提取不一致」的漏合场景）
 *
 * 用法：
 *   import { titleSimilarity, eventSimilarity, mergeEvents } from './merge.mjs';
 */
import { normalizeTitle } from './dedup.mjs';

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/** 标题 token 集：中文按单字、英文按整词、数字+单位合为一个 token。 */
export function tokenize(title) {
  const set = new Set();
  const t = normalizeTitle(title);
  if (!t) return set;
  for (const ch of t) {
    if (/[一-鿿]/.test(ch)) set.add(ch);
  }
  // 数字+单位如 1.06gwh、641mw 保持一个 token；纯英文单词单独成 token
  for (const w of t.match(/[a-z]+|\d+(?:\.\d+)?[a-z]*/g) || []) {
    set.add(`w:${w}`);
  }
  return set;
}

/** 标题相似度：token Jaccard。 */
export function titleSimilarity(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = new Set([...setA, ...setB]).size;
  return union ? inter / union : 0;
}

/** 共享关键数字：相同单位、值 ≥ minValue，且相对误差 ≤ tolerance（容忍四舍五入，如 1.06GWh vs 1GWh）。 */
export function sharedMetric(a, b, minValue = 1, tolerance = 0.1) {
  const ma = a.metrics || [];
  const mb = b.metrics || [];
  for (const x of ma) {
    if (Math.abs(x.value) < minValue || !x.unit) continue;
    for (const y of mb) {
      if (y.unit !== x.unit) continue;
      const maxAbs = Math.max(Math.abs(x.value), Math.abs(y.value));
      if (maxAbs > 0 && Math.abs(x.value - y.value) / maxAbs <= tolerance) {
        return `${x.value}${x.unit}`;
      }
    }
  }
  return null;
}

/** 共享实体。 */
export function sharedEntity(a, b) {
  const ea = new Set(a.entities || []);
  for (const e of b.entities || []) if (ea.has(e)) return e;
  return null;
}

/**
 * 两个已提取条目的事件相似度。
 * @returns {{ score: number, signals: string[] }}
 */
export function eventSimilarity(a, b, opts = {}) {
  const { mergeWindowMs = THREE_DAYS_MS, titleThreshold = 0.35, titleStrongThreshold = 0.7 } = opts;
  // 时间窗口检查
  const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : null;
  const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : null;
  if (ta && tb && Math.abs(ta - tb) > mergeWindowMs) return { score: 0, signals: ['time-out-of-window'] };

  let score = 0;
  const signals = [];
  if (a.topic && a.topic === b.topic) { score += 0.2; signals.push('same-topic'); }
  const ent = sharedEntity(a, b);
  if (ent) { score += 0.35; signals.push(`entity:${ent}`); }
  const met = sharedMetric(a, b);
  if (met) { score += 0.35; signals.push(`metric:${met}`); }
  const sim = titleSimilarity(a.title, b.title);
  if (sim >= titleStrongThreshold) { score += 0.45; signals.push(`title-strong:${sim.toFixed(2)}`); }
  else if (sim >= titleThreshold) { score += 0.3; signals.push(`title:${sim.toFixed(2)}`); }

  return { score, signals };
}

/**
 * 事件合并（并查集，输入顺序决定确定性）。
 * @param {Array} items 条目，需含 { title, topic, entities, metrics, publishedAt }
 * @param {object} opts { threshold=0.45, mergeWindowMs }
 * @returns {{ clusters: Array<{members:Array, reason:string[]}>, standaloneCount: number }}
 */
export function mergeEvents(items, opts = {}) {
  const { threshold = 0.45 } = opts;
  const n = items.length;
  const parent = items.map((_, i) => i);

  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) { parent[find(a)] = find(b); }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      const { score, signals } = eventSimilarity(items[i], items[j], opts);
      if (score >= threshold) {
        union(i, j);
        if (!items[i]._signals) items[i]._signals = signals;
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const clusters = [];
  let standalone = 0;
  for (const idxs of groups.values()) {
    const sorted = idxs.sort((a, b) => a - b);
    const reason = items[sorted[0]]._signals || [];
    if (sorted.length === 1) standalone++;
    clusters.push({ members: sorted, reason });
  }
  return { clusters, standaloneCount: standalone };
}

// CLI 自检：node scripts/lib/merge.mjs
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  console.log(titleSimilarity('Eolian 1.06GWh BESS in Ohio', 'Eolian submits 1.06GWh battery storage in Ohio'));
}
