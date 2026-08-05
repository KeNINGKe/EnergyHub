#!/usr/bin/env node
/**
 * 相关性硬过滤（B-01 / B-02）。
 *
 * 配置：data/filters.json —— 四类关键词：
 *   strong      强主题词：单独命中即相关
 *   combination 组合词：同组命中数 ≥ min 才相关
 *   generic     通用词：跨表命中数 ≥ min 才相关（兜底）
 *   negative    负面词：命中即过滤（优先级最高，覆盖强词）
 *
 * 匹配语义：中文关键词用子串匹配；英文关键词用整词匹配
 * （允许与数字相邻，如 "1.6MW" 中的 MW，但不匹配 "powerful" 中的 power）。
 *
 * 用法：
 *   import { loadFilters, classify, isRelevant } from './filter.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILTERS_PATH = path.resolve(__dirname, '../../data/filters.json');

let filtersCache = null;

/** 加载过滤配置（带缓存）。 */
export async function loadFilters() {
  if (filtersCache) return filtersCache;
  const raw = await fs.readFile(FILTERS_PATH, 'utf8');
  filtersCache = JSON.parse(raw);
  return filtersCache;
}

/** 是否中文字符串（含中文即用子串匹配）。 */
function hasCJK(k) {
  return /[一-鿿]/.test(k);
}

/**
 * 单个关键词是否命中文本。
 * 中文：子串；英文：整词（数字相邻也算边界，避免 "powerful" 命中 "power"）。
 */
export function keywordHit(text, keyword) {
  const k = String(keyword).toLowerCase().trim();
  if (!k) return false;
  const t = text.toLowerCase();
  if (hasCJK(k)) return t.includes(k);
  // 英文/单位：整词匹配，要求两侧不是字母（数字/标点/空白/边界均可），
  // 并容忍常见复数/时态后缀（charger→chargers，power→powering）。
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = '(?:s|es|ing|ed)?';
  return new RegExp(`(^|[^a-z])${escaped}${suffix}([^a-z]|$)`, 'i').test(t);
}

/**
 * 对文本做相关性判定。
 * @param {string} text 标题+摘要拼接的全文
 * @param {object} filters 配置对象
 * @returns {{ relevant: boolean, hits: Array<{type:string, keyword:string, group?:string}>, reason: string }}
 */
export function classify(text, filters) {
  const t = String(text || '');
  const hits = [];

  // 1. 负面词（优先级最高）
  for (const kw of filters.negative) {
    if (keywordHit(t, kw)) {
      hits.push({ type: 'negative', keyword: kw });
      return {
        relevant: false,
        hits,
        reason: `负面词:${kw}`
      };
    }
  }

  // 2. 强词
  for (const kw of filters.strong) {
    if (keywordHit(t, kw)) {
      hits.push({ type: 'strong', keyword: kw });
      return {
        relevant: true,
        hits,
        reason: `强词:${kw}`
      };
    }
  }

  // 3. 组合词（同组 ≥ min）
  for (const group of filters.combination.groups) {
    const matched = group.words.filter(kw => keywordHit(t, kw));
    if (matched.length >= filters.combination.min) {
      for (const kw of matched) hits.push({ type: 'combination', keyword: kw, group: group.label });
      return {
        relevant: true,
        hits,
        reason: `组合词×${matched.length}[${group.label}]:${matched.slice(0, 3).join('+')}`
      };
    }
  }

  // 4. 通用词（跨表 ≥ min）
  const genericMatched = filters.generic.words.filter(kw => keywordHit(t, kw));
  if (genericMatched.length >= filters.generic.min) {
    for (const kw of genericMatched) hits.push({ type: 'generic', keyword: kw });
    return {
      relevant: true,
      hits,
      reason: `通用词×${genericMatched.length}:${genericMatched.slice(0, 3).join('+')}`
    };
  }

  // 5. 未命中
  return { relevant: false, hits, reason: '无关键词命中' };
}

/** 便捷包装：只返回是否相关。 */
export function isRelevant(text, filters) {
  return classify(text, filters).relevant;
}

/** 对条目（含 title/summary 字段）判定，供管线使用。 */
export function classifyItem(item, filters) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  return classify(text, filters);
}

// CLI 自检：node scripts/lib/filter.mjs "测试文本"
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const text = process.argv[2];
  const filters = await loadFilters();
  const r = classify(text, filters);
  console.log(JSON.stringify(r, null, 2));
}
