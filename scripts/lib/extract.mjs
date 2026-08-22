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

/** 英文别名整词匹配，返回首个命中位置（无命中 -1）。全大写缩写（US/UK/EU/USA…）
 * 按原大小写匹配，避免与代词 us、US$ 撞车。 */
function englishWordMatch(text, alias) {
  const isAcronym = /^[A-Z]{2,}$/.test(alias);
  const source = isAcronym ? text : text.toLowerCase();
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = isAcronym ? '' : 'i';
  const m = new RegExp(`(^|[^a-z${CURRENCY_CLASS}])${escaped}([^a-z${CURRENCY_CLASS}]|$)`, flags).exec(source);
  return m ? m.index : -1;
}

/**
 * 单文本地区投票：统计每个地区的不同别名命中数（同别名只计一次），
 * 命中数相同按文本中最早出现位置取胜——修复「摘要里的公司国籍抢先命中、
 * 标题里的真实事件国家落选」的首中即得问题。
 * 「全球」类泛称在存在具体地区命中时让位。
 * @returns {{ region: string, votes: number } | null}
 */
export function regionVotes(text, regionsConfig) {
  const t = String(text || '');
  const tl = t.toLowerCase();
  const stats = new Map(); // region -> { count, firstPos }
  for (const { alias, region } of regionsConfig.aliases) {
    const a = alias.toLowerCase();
    const pos = /[一-鿿]/.test(a) ? tl.indexOf(a) : englishWordMatch(t, alias);
    if (pos < 0) continue;
    const cur = stats.get(region);
    if (!cur) stats.set(region, { count: 1, firstPos: pos });
    else {
      cur.count += 1;
      if (pos < cur.firstPos) cur.firstPos = pos;
    }
  }
  if (!stats.size) return null;
  if (stats.size > 1) stats.delete('全球');
  let best = null;
  for (const [region, v] of stats) {
    if (!best || v.count > best.v.count ||
        (v.count === best.v.count && v.firstPos < best.v.firstPos)) {
      best = { region, v };
    }
  }
  return { region: best.region, votes: best.v.count };
}

/** 地区提取（单文本）：投票取胜；无命中返回「未知」。 */
export function extractRegion(text, regionsConfig) {
  const r = regionVotes(text, regionsConfig);
  return r ? r.region : '未知';
}

/**
 * 地区提取（标题优先）：标题（含译名）有具体地区命中直接采用，
 * 否则退回正文投票。标题是事件地区最可靠的信号——摘要常混入
 * 公司国籍、市场对比等噪声地区。
 */
export function extractRegionFromParts(title, body, regionsConfig) {
  const tv = regionVotes(title, regionsConfig);
  if (tv && tv.region !== '全球') return tv.region;
  const bv = regionVotes(body, regionsConfig);
  if (bv) return bv.region;
  return tv ? tv.region : '未知';
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

// 单位表，长单位在前（避免 MW 吃掉 GWdc 之类；kVA 在 kV 前，避免 kVA 被吞成 kV）
const UNIT_ALTERNATION =
  'GWdc|MWdc|GWh|MWh|TWh|kWh|GW|MW|MVA|kVA|kA|kW|kV|Hz|TW|W|tCO2|万吨标准煤|亿千瓦时|吉瓦时|兆瓦时|万千瓦时|亿千瓦|吉瓦|兆瓦|万千瓦|亿美元|亿元|美元\\/MWh|元\\/MWh|€\\/MWh|\\$\\/MWh|%';
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

/** 对条目做全套提取。翻译标题（translatedTitle）一并参与主题/实体/数字提取，
 * 让中文关键词体系对英文信源生效；地区用「标题优先 + 正文投票」。 */
export async function extractItem(item, enums) {
  const text = `${item.title || ''} ${item.translatedTitle || ''} ${item.summary || ''}`;
  const [regionsConfig, entitiesConfig] = await Promise.all([loadRegions(), loadEntities()]);
  return {
    topics: extractTopics(text, enums),
    region: extractRegionFromParts(
      `${item.title || ''} ${item.translatedTitle || ''}`,
      item.summary || '',
      regionsConfig
    ),
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
