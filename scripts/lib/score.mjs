#!/usr/bin/env node
/**
 * 内部重要性评分 + 单来源数量限制（B-08）。
 *
 * importance 仅用于内部排序与精选门槛，不前台展示。信号：
 *   - 来源类型质量（primary 2 / research 1.5 / media 1 / community 0.5）
 *   - 有关键数字 +1、有实体 +0.5、有摘要 +0.5
 *   - 时效：24h 内 +1、72h 内 +0.5
 *
 * 用法：
 *   import { importance, capPerSource } from './score.mjs';
 */

const TYPE_SCORE = { primary: 2, research: 1.5, media: 1, community: 0.5 };

/**
 * 内部重要性评分（0–10）。
 * @param {object} item 条目（含 sourceType, metrics, entities, summary, publishedAt）
 * @param {object} ctx { now }
 */
export function importance(item, ctx = {}) {
  const now = ctx.now || new Date().toISOString();
  let s = 0;
  s += TYPE_SCORE[item.sourceType] ?? 1;
  if (item.metrics?.length) s += 1;
  if (item.entities?.length) s += 0.5;
  if (item.summary) s += 0.5;
  if (item.publishedAt) {
    const ageH = (new Date(now).getTime() - new Date(item.publishedAt).getTime()) / 3600e3;
    if (ageH <= 24 && ageH >= 0) s += 1;
    else if (ageH <= 72) s += 0.5;
  }
  return Math.round(s * 10) / 10;
}

/**
 * 单来源数量限制：每来源最多保留 max 条（按重要性降序后调用，保留 top）。
 * 兼容两种结构：it.source 为字符串，或 it.source 为 { name } 对象。
 * 返回新数组，不改原数组。
 */
export function capPerSource(items, { max = 5 } = {}) {
  const counts = new Map();
  const out = [];
  for (const it of items) {
    const k = (typeof it.source === 'string' ? it.source : it.source?.name) || 'unknown';
    const c = counts.get(k) || 0;
    if (c >= max) continue;
    counts.set(k, c + 1);
    out.push(it);
  }
  return out;
}

// CLI 自检
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  console.log(importance({ sourceType: 'primary', metrics: [1], entities: ['X'], summary: 's', publishedAt: new Date().toISOString() }));
}
