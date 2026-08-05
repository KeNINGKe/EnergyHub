#!/usr/bin/env node
/**
 * 主条目选择（B-07）。
 *
 * 排序优先级（字典序比较向量，先比较前项）：
 *   1. 一手来源（item.sourceType = primary）
 *   2. 信息完整度（摘要/数字/实体/地区齐全度）
 *   3. 发布时间更早
 *   4. 来源质量（research > media > community）
 *
 * 用法：
 *   import { primaryRank, compareVectors, pickPrimary, selectPrimaries } from './select.mjs';
 */

const SOURCE_QUALITY = { primary: 4, research: 3, media: 2, community: 1 };

/** 信息完整度：0–1，字段齐全度（摘要/数字/实体/地区）。 */
export function completeness(item) {
  let score = 0;
  let total = 0;
  const checks = [
    [item.summary, 1],
    [item.whyItMatters, 1],
    [item.metrics?.length, 0.5],
    [item.entities?.length, 0.5],
    [item.region && item.region !== '未知', 0.5]
  ];
  for (const [val, weight] of checks) {
    total += weight;
    if (val) score += weight;
  }
  return total ? score / total : 0;
}

/** 来源质量分。 */
export function sourceQuality(sourceType) {
  return SOURCE_QUALITY[sourceType] || SOURCE_QUALITY.media;
}

/**
 * 主条目排序向量（越大越优）。sourceType 直接读 item 自身字段。
 * @returns {number[]}
 */
export function primaryRank(item) {
  const isPrimary = (item.sourceType || 'media') === 'primary' ? 1 : 0;
  const comp = completeness(item);
  const pub = item.publishedAt || '0000-01-01T00:00:00Z';
  const time = -new Date(pub).getTime();
  const quality = sourceQuality(item.sourceType);
  return [isPrimary, comp, time, quality];
}

/** 向量字典序比较：a > b 返回正数。 */
export function compareVectors(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const va = a[i] ?? -Infinity;
    const vb = b[i] ?? -Infinity;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * 从一组条目（合并簇）中选主条目。
 * @param {Array} items 条目数组（各自带 sourceType）
 * @returns {{ index: number, rank: number[] }}
 */
export function pickPrimary(items) {
  let best = 0;
  let bestRank = null;
  for (let i = 0; i < items.length; i++) {
    const rank = primaryRank(items[i]);
    if (bestRank === null || compareVectors(rank, bestRank) > 0) {
      best = i;
      bestRank = rank;
    }
  }
  return { index: best, rank: bestRank };
}

/**
 * 对合并结果逐簇选主条目。
 * @param {Array} items 全量条目
 * @param {Array<number[]>} memberGroups 每簇的成员下标
 * @returns {Array<{ primaryIndex: number, members: number[] }>}
 */
export function selectPrimaries(items, memberGroups) {
  return memberGroups.map(members => {
    const { index } = pickPrimary(members.map(i => items[i]));
    return { primaryIndex: members[index], members };
  });
}

// CLI 自检
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  console.log(primaryRank({ summary: 'x', metrics: [1], publishedAt: '2026-08-05T00:00:00Z', sourceType: 'media' }));
}
