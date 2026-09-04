#!/usr/bin/env node
/**
 * 内部重要性评分 + 单来源数量限制（B-08）。
 *
 * importance 仅用于内部排序与精选门槛，不前台展示。信号：
 *   - 来源类型质量（primary 2 / research 1.5 / media 1 / community 0.5）
 *   - 有关键数字 +1、有实体 +0.5、有摘要 +0.5
 *   - 时效：24h 内 +1、72h 内 +0.5
 *   - 多源报道：每有 1 家其他信源报道同一事件 +0.5，封顶 +1.5
 *     （合并聚类给出的 relatedSources 是「事件重要性」最可靠的免费代理指标）
 *
 * 用法：
 *   import { importance, capPerSource } from './score.mjs';
 */

const TYPE_SCORE = { primary: 2, research: 1.5, media: 1, community: 0.5 };

/**
 * 内部重要性评分（0–10）。
 * @param {object} item 条目（含 sourceType, metrics, entities, summary, publishedAt, topic）
 * @param {object} ctx { now, priorityTopics }
 *   priorityTopics: 优先主题列表（data/enums.json），命中的事件 +1，
 *   让专题方向（如 SST/PCS）的内容有机会进入精选，而非被普通媒体分埋没。
 */
export function importance(item, ctx = {}) {
  const now = ctx.now || new Date().toISOString();
  let s = 0;
  const sourceType = item.sourceType || item.source?.type;
  s += TYPE_SCORE[sourceType] ?? 1;
  if (item.metrics?.length) s += 1;
  if (item.entities?.length) s += 0.5;
  if (item.summary) s += 0.5;
  if (item.publishedAt) {
    const ageH = (new Date(now).getTime() - new Date(item.publishedAt).getTime()) / 3600e3;
    if (ageH <= 24 && ageH >= 0) s += 1;
    else if (ageH <= 72) s += 0.5;
  }
  if (Array.isArray(ctx.priorityTopics) && ctx.priorityTopics.includes(item.topic)) s += 1;
  // 重点公司（enums.priorityCompanies，与 entities.json 实体名对齐）：命中 +1，
  // 让宁德时代/Fluence/Vertiv 等重点跟踪对象不被普通媒体分埋没（中英实体名都算命中）
  if (Array.isArray(ctx.priorityCompanies) && ctx.priorityCompanies.length &&
      (item.entities || []).some(e => ctx.priorityCompanies.includes(e))) s += 1;
  // 多源报道：合并聚类中其他信源的数量，1 家 +0.5，封顶 +1.5（≥3 家视为充分交叉验证）
  const related = item.relatedSources?.length || 0;
  if (related > 0) s += Math.min(1.5, related * 0.5);
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
