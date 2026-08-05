#!/usr/bin/env node
/**
 * RSS 抓取共享逻辑（V1 日报任务与 V2 构建器共用）。
 *
 * 提供：curlFetch、fetchFeed（含 Jina 兜底）、translateTitles、collectFeeds、
 * toISODate、withinDays、pickSummary 等。
 *
 * 用法：
 *   import { loadSources, collectFeeds, fetchAllFeeds, translateTitles, toISODate } from './fetch.mjs';
 */
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Parser from 'rss-parser';

const execFileAsync = promisify(execFile);

const parser = new Parser({
  customFields: {
    item: [['media:group', 'mediaGroup'], ['content:encoded', 'contentEncoded']]
  }
});

const COMMON_HEADERS = [
  '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 EnergyInfoHub/1.0',
  '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  '-H', 'Accept-Language: en-US,en;q=0.9'
];

export const TRANSLATION_CACHE_PATH = 'feeds/translation-cache.json';

export async function curlFetch(url, maxTime = 30) {
  const { stdout } = await execFileAsync('curl', [
    '-L', '--max-time', String(maxTime), '-s', '--compressed',
    ...COMMON_HEADERS,
    url
  ], { maxBuffer: 20 * 1024 * 1024, timeout: (maxTime + 5) * 1000 });
  return stdout;
}

/** 按北京时间（UTC+8）取日期，避免 UTC 跨天不一致。 */
export function toISODate(d, offsetMs = 8 * 60 * 60 * 1000) {
  return new Date(d.getTime() + offsetMs).toISOString().split('T')[0];
}

export function withinDays(dateStr, days, now) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const base = now || new Date();
  return (base.getTime() - d.getTime()) <= days * 24 * 60 * 60 * 1000;
}

export function pickSummary(item) {
  if (item.contentSnippet) return item.contentSnippet;
  if (item.summary) return item.summary;
  if (item.contentEncoded) {
    return item.contentEncoded.replace(/<[^>]+>/g, ' ').trim().slice(0, 300);
  }
  return '';
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isEnglishTitle(text) {
  return !!text && /[a-zA-Z]/.test(text) && !/[一-鿿]/.test(text);
}

export async function loadTranslationCache() {
  try {
    return JSON.parse(await fs.readFile(TRANSLATION_CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveTranslationCache(cache) {
  await fs.writeFile(TRANSLATION_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

/** 英文标题翻译为中文（MyMemory 免费 API，带缓存）。 */
export async function translateTitles(items) {
  const cache = await loadTranslationCache();
  let translated = 0;
  let skipped = 0;
  for (const item of items) {
    if (!isEnglishTitle(item.title)) {
      skipped++;
      continue;
    }
    if (cache[item.title]) {
      item.translatedTitle = cache[item.title];
      translated++;
      continue;
    }
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(item.title)}&langpair=en|zh`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.responseStatus === 200 && data.responseData?.translatedText) {
        const t = data.responseData.translatedText;
        cache[item.title] = t;
        item.translatedTitle = t;
        translated++;
      }
    } catch (err) {
      console.error(`[翻译失败] ${item.title.slice(0, 40)}: ${err.message}`);
    }
    await sleep(300);
  }
  await saveTranslationCache(cache);
  return { translated, skipped };
}

export async function loadSources() {
  const raw = await fs.readFile('data/sources.json', 'utf8');
  return JSON.parse(raw);
}

export function collectFeeds(data) {
  const feeds = [];
  for (const cat of data.categories) {
    for (const src of cat.sources) {
      if (src.rss) feeds.push({ ...src, category: cat.name });
    }
  }
  return feeds;
}

function sanitizeXml(xml) {
  return xml.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');
}

function slugToTitle(url) {
  try {
    const u = new URL(url);
    const slug = u.pathname.split('/').filter(Boolean).pop() || '无标题';
    return decodeURIComponent(slug)
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  } catch {
    return '无标题';
  }
}

function parseJinaRSS(markdown) {
  const content = markdown.split('Markdown Content:')[1] || markdown;
  const items = [];
  const regex = /### \[(.*?)\]\((.*?)\)\s*\n\s*(?:\[[^\]]*\]\([^)]*\)\s*\n\s*)?([\s\S]*?)\s*\n\s*([A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}|[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const [, rawTitle, link, rawBody, dateStr] = match;
    const title = rawTitle.trim() || slugToTitle(link);
    const body = rawBody.replace(/^\s*\[.*?\]\([^)]*\)\s*$/gm, '').trim();
    let pubDate = null;
    try { pubDate = new Date(dateStr).toISOString(); } catch {}
    items.push({ title, link, pubDate, summary: body });
  }
  return items.slice(0, 15);
}

async function fetchViaJina(url) {
  const jinaUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`;
  try {
    await sleep(1500);
    const text = await curlFetch(jinaUrl, 30);
    const items = parseJinaRSS(text);
    if (!items.length) return null;
    return { items };
  } catch {
    return null;
  }
}

/**
 * 抓取单个 feed。返回 { items, via } 或 null（失败）。
 * item 字段：title, link, pubDate, summary, source, sourceUrl, guid
 */
export async function fetchFeed(source) {
  let via = 'direct';
  let rawItems = [];
  try {
    const xml = sanitizeXml(await curlFetch(source.rss, 45));
    const feed = await parser.parseString(xml);
    rawItems = feed.items || [];
  } catch (err) {
    const jina = await fetchViaJina(source.rss);
    if (jina) {
      rawItems = jina.items;
      via = 'jina';
    } else {
      console.error(`[失败] ${source.name}: ${err.message}`);
      return null;
    }
  }

  const items = rawItems.slice(0, 15).map(item => ({
    title: item.title || '无标题',
    link: item.link || item.guid || source.url,
    guid: item.guid || item.id || null,
    pubDate: item.isoDate || item.pubDate || null,
    summary: pickSummary(item),
    source: source.name,
    sourceUrl: source.url
  }));
  console.log(`[成功${via === 'jina' ? ' (Jina)' : ''}] ${source.name}: ${items.length} 条`);
  return { items, via };
}

/**
 * 并发抓取所有 feed。
 * @returns {Promise<{items: Array, succeeded: number, failed: Array<string>, total: number}>}
 */
export async function fetchAllFeeds(feeds) {
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const items = [];
  let succeeded = 0;
  const failed = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value) {
      items.push(...r.value.items);
      succeeded++;
    } else {
      failed.push(feeds[i].name);
    }
  }
  return { items, succeeded, failed, total: feeds.length };
}
