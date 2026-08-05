#!/usr/bin/env node
/**
 * 确定性去重（B-05）。
 *
 * 按 URL / GUID / 完全相同标题 去重。输入顺序决定保留顺序（先到先留），
 * 相同输入重复执行结果一致（确定性）。
 *
 * - canonicalUrl：去掉 hash、跟踪参数、尾斜杠，参数排序，小写 host
 * - normalizeTitle：取原标题（去掉「【译:…】」），小写、去标点、合并空白
 *
 * 用法：
 *   import { canonicalUrl, normalizeTitle, dedupItems } from './dedup.mjs';
 */

/** 需剔除的跟踪参数。 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'dclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
  'source', 'campaign', 'from', 'via'
]);

/** URL 规范化：相同内容的 URL 得到相同键。 */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    let path = u.pathname;
    if (path !== '/' && path.endsWith('/')) path = path.replace(/\/+$/, '');
    // 保留对排序有意义的参数，剔除跟踪参数
    const keep = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
      keep.push([k.toLowerCase(), v]);
    }
    keep.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const qs = keep.length ? '?' + keep.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return `${u.protocol.toLowerCase()}${host}${path}${qs}`;
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

/** 标题规范化：取原标题（去掉【译:…】/（译…）），小写、去标点、合并空白。 */
export function normalizeTitle(title) {
  let t = String(title || '');
  // 去掉我们拼接的翻译后缀：原文【译:译文】 或 原文（译:译文）
  t = t.replace(/[【（(]\s*译\s*[:：].*?[】）)]$/, '');
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 去重。
 * @param {Array} items 条目数组，每项含 { url, guid?, title }
 * @returns {{ kept: Array, removed: Array<{item:object, reason:string}> }}
 */
export function dedupItems(items) {
  const seenUrl = new Set();
  const seenGuid = new Set();
  const seenTitle = new Set();
  const kept = [];
  const removed = [];
  for (const item of items) {
    const ukey = item.url ? canonicalUrl(item.url) : null;
    const gkey = item.guid ? String(item.guid).trim() : null;
    const tkey = item.title ? normalizeTitle(item.title) : null;

    let reason = null;
    if (ukey && seenUrl.has(ukey)) reason = 'url';
    else if (gkey && seenGuid.has(gkey)) reason = 'guid';
    else if (tkey && seenTitle.has(tkey)) reason = 'title';

    if (reason) {
      removed.push({ item, reason });
      continue;
    }
    if (ukey) seenUrl.add(ukey);
    if (gkey) seenGuid.add(gkey);
    if (tkey) seenTitle.add(tkey);
    kept.push(item);
  }
  return { kept, removed };
}

// CLI 自检：node scripts/lib/dedup.mjs <url>
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  console.log(canonicalUrl(process.argv[2]));
}
