#!/usr/bin/env node
/**
 * 主题 / 地区 / 实体 / 关键数字 基础提取（B-04）。
 *
 * - extractTopics: 用 data/enums.json 各主题 keywords 计数，取命中最多的 1–2 个主题
 * - extractRegion: 用 data/regions.json 别名表，从文章内容匹配地区（不得按媒体所在地猜测）
 * - extractEntities: 用 data/entities.json 实体库匹配（中文子串 / 英文整词，无后缀容错）
 * - extractMetrics: 正则抽取「数字+单位」，label 取数字前的上下文短语
 *
 * 用法：
 *   import { extractTopics, extractRegion, extractEntities, extractMetrics, extractItem } from './extract.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keywordHit } from './filter.mjs';
import { loadEnums } from './schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let regionsCache = null;
let entitiesCache = null;

export async function loadRegions() {
  if (regionsCache) return regionsCache;
  regionsCache = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'regions.json'), 'utf8'));
  return regionsCache;
}

export async function loadEntities() {
  if (entitiesCache) return entitiesCache;
  entitiesCache = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'entities.json'), 'utf8'));
  return entitiesCache;
}

/**
 * 实体匹配：中文子串；英文整词（无复数后缀，避免 "Apple" 匹配 "apples"）。
 */
function entityHit(text, name) {
  const t = text.toLowerCase();
  const n = String(name).toLowerCase().trim();
  if (!n) return false;
  if (/[一-鿿]/.test(n)) return t.includes(n);
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(t);
}

/** 主题提取：返回命中最多的 1–2 个主题 id。 */
export function extractTopics(text, enums) {
  const scores = [];
  for (const topic of enums.topics) {
    const hits = topic.keywords.filter(k => keywordHit(text, k));
    if (!hits.length) continue;
    scores.push({
      id: topic.id,
      count: hits.length,
      keywordLen: hits.reduce((a, k) => a + k.length, 0)
    });
  }
  scores.sort((a, b) => b.count - a.count || b.keywordLen - a.keywordLen);
  return scores.slice(0, 2).map(s => s.id);
}

// 货币符号：整词边界不应把紧邻货币符号当作「词边界」，
// 否则 "US$415 million" 里的 US 会被误判成美国（文章可能讲的是别国、只是用美元计价）。
const CURRENCY_CLASS = '€$£¥';

/** 英文别名整词命中：全大写缩写（US/UK/EU/USA…）按原大小写匹配，避免与代词 us、US$ 撞车。 */
function englishWordHit(text, alias) {
  const isAcronym = /^[A-Z]{2,}$/.test(alias);
  const source = isAcronym ? text : text.toLowerCase();
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = isAcronym ? '' : 'i';
  return new RegExp(`(^|[^a-z${CURRENCY_CLASS}])${escaped}([^a-z${CURRENCY_CLASS}]|$)`, flags).test(source);
}

/** 地区提取：按别名表顺序首中；无命中返回「未知」。 */
export function extractRegion(text, regionsConfig) {
  const t = String(text || '');
  const tl = t.toLowerCase();
  for (const { alias, region } of regionsConfig.aliases) {
    const a = alias.toLowerCase();
    if (/[一-鿿]/.test(a)) {
      if (tl.includes(a)) return region;
    } else if (englishWordHit(t, alias)) {
      return region;
    }
  }
  return '未知';
}

/** 实体提取：返回命中的实体名（去重，保持出现顺序）。 */
export function extractEntities(text, entities) {
  const seen = new Set();
  const out = [];
  for (const name of entities) {
    if (seen.has(name)) continue;
    if (entityHit(text, name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// 单位表，长单位在前（避免 MW 吃掉 GWdc 之类）
const UNIT_ALTERNATION =
  'GWdc|MWdc|GWh|MWh|TWh|kWh|GW|MW|TW|W|tCO2|万吨标准煤|亿千瓦时|吉瓦时|兆瓦时|万千瓦时|亿千瓦|吉瓦|兆瓦|万千瓦|亿美元|亿元|美元\\/MWh|元\\/MWh|€\\/MWh|\\$\\/MWh|%';
const METRIC_RE = new RegExp(
  `([$€¥]?\\s?)(\\d[\\d,]*(?:\\.\\d+)?)\\s*(\\/?(?:${UNIT_ALTERNATION}))`, 'gi'
);

/** 关键数字提取：返回 [{ label, value, unit }]。 */
export function extractMetrics(text) {
  const t = String(text || '');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = METRIC_RE.exec(t)) !== null) {
    const [, currency, rawValue, rawUnit] = m;
    // 保留原始斜杠：$/MWh、/MWh 等计价单位不丢「每单位」含义
    const unit = `${currency.trim()}${rawUnit}`;
    const key = `${rawValue}|${unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // label：数字前 ≤30 字符，英文取最后 3 个词，中文取最后 6 个字符
    const before = t.slice(Math.max(0, m.index - 30), m.index).replace(/\s+$/, '');
    let label = '';
    if (before) {
      if (/[一-鿿]/.test(before)) label = before.slice(-6);
      else {
        const words = before.split(/\s+/).filter(Boolean);
        label = words.slice(-3).join(' ');
      }
    }
    out.push({
      label: label.trim(),
      value: parseFloat(rawValue.replace(/,/g, '')),
      unit
    });
  }
  return out;
}

/** 对条目做全套提取。 */
export async function extractItem(item, enums) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  const [regionsConfig, entitiesConfig] = await Promise.all([loadRegions(), loadEntities()]);
  return {
    topics: extractTopics(text, enums),
    region: extractRegion(text, regionsConfig),
    entities: extractEntities(text, entitiesConfig.entities),
    metrics: extractMetrics(text)
  };
}

// CLI 自检：node scripts/lib/extract.mjs "文本"
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const text = process.argv[2];
  const enums = await loadEnums();
  const [regionsConfig, entitiesConfig] = await Promise.all([loadRegions(), loadEntities()]);
  console.log(JSON.stringify({
    topics: extractTopics(text, enums),
    region: extractRegion(text, regionsConfig),
    entities: extractEntities(text, entitiesConfig.entities),
    metrics: extractMetrics(text)
  }, null, 2));
}
