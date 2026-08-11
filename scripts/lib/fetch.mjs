#!/usr/bin/env node
/**
 * RSS 抓取共享逻辑（V1 日报任务与 V2 构建器共用）。
 *
 * 提供：curlFetch、fetchFeed（含 Jina 兜底）、fetchPage（无 RSS 页面型抓取）、
 * translateTitles、collectFeeds、toISODate、withinDays、pickSummary，
 * 以及微信文章种子文件 loadWechatSeeds/saveWechatSeeds/fetchWechatSeeds 等。
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

// MyMemory 免费档配额：匿名 5000 字符/天/IP；请求带 de 邮箱参数可提升到
// 50000 字符/天/邮箱（10 倍）。CI 跑在共享 IP 上必须带邮箱，否则大批次
// 新标题会把 5000 字符配额耗尽导致漏翻。优先读 MYMEMORY_EMAIL 环境变量，
// 未设置则用仓库维护邮箱。
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || 'cooper.ke.ning@gmail.com';

export async function curlFetch(url, maxTime = 30) {
  const { stdout } = await execFileAsync('curl', [
    // 不强制 --compressed：部分 Windows curl 构建未包含压缩支持；不发送
    // Accept-Encoding 时服务端会返回可直接解析的未压缩响应。
    '-L', '--max-time', String(maxTime), '-s',
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

/** 是否为微信公众号单篇文章 URL（mp.weixin.qq.com/s/xxx 或 /s?__biz=... 参数式）。 */
export function isWechatArticleUrl(url) {
  return /mp\.weixin\.qq\.com\/s(\/|\?)/i.test(url);
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
  let failed = 0;
  let identity = 0;
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
    const t = await translateOneTitle(item.title);
    if (t) {
      if (t === item.title.trim()) {
        // MyMemory 对纯专有名词常原样返回；缓存命中可省配额，但结果等于原文，
        // 不写 translatedTitle，条目保持英文（本无可翻）。
        cache[item.title] = t;
        identity++;
      } else {
        cache[item.title] = t;
        item.translatedTitle = t;
        translated++;
      }
    } else {
      failed++;
    }
    await sleep(300);
  }
  await saveTranslationCache(cache);
  return { translated, skipped, failed, identity };
}

/** 翻译单个标题：配额耗尽/非200直接放弃（重试无意义），瞬时错误重试 2 次。 */
async function translateOneTitle(title, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(title)}&langpair=en|zh&de=${encodeURIComponent(MYMEMORY_EMAIL)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.quotaFinished || /MYMEMORY WARNING/i.test(data.responseDetails || '') || (data.responseStatus === 403 || data.responseStatus === 429)) {
        console.warn(`[翻译配额耗尽/限流] ${title.slice(0, 50)}`);
        return null;
      }
      if (data.responseStatus === 200 && data.responseData?.translatedText) {
        return String(data.responseData.translatedText).trim();
      }
      console.warn(`[翻译异常响应] ${title.slice(0, 50)}: status=${data.responseStatus} ${data.responseDetails || ''}`.trim());
      return null;
    } catch (err) {
      if (attempt === maxRetries) {
        console.warn(`[翻译失败] ${title.slice(0, 50)}: ${err.message}`);
      }
    }
  }
  return null;
}

export async function loadSources() {
  const raw = await fs.readFile('data/sources.json', 'utf8');
  return JSON.parse(raw);
}

/**
 * 收集待抓取信源。
 * @param {object} data sources.json 结构
 * @param {{includePages?: boolean}} [opts] includePages=true 时才会把「无 rss 但有 url」的
 *   页面型信源纳入采集。即便开启，也只纳入公众号（tags 含 微信公众号）或显式标记
 *   fetchType:'page' 的信源，避免误抓普通 url 站。
 *   返回项带 fetchType: 'rss' | 'page'，fetchFeed 据此分支。
 */
export function collectFeeds(data, opts = {}) {
  const includePages = !!opts.includePages;
  const feeds = [];
  for (const cat of data.categories) {
    for (const src of cat.sources) {
      if (src.rss) {
        feeds.push({ ...src, category: cat.name, fetchType: 'rss' });
      } else if (includePages && src.url) {
        const isWechat = Array.isArray(src.tags) && src.tags.includes('微信公众号');
        if (isWechat || src.fetchType === 'page') {
          feeds.push({ ...src, category: cat.name, fetchType: 'page' });
        }
      }
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

/**
 * 解析 Jina 输出的「普通页面」Markdown（官网 / 聚合页 / 单篇文章页）。
 * 解析层级：列表条目（### / ## 链接）→ 文章标题块（Title:/URL Source:/Published Time:）→ 兜底。
 */
export function parseJinaPage(markdown, fallbackTitle) {
  const content = markdown.split('Markdown Content:')[1] || markdown;
  const items = [];

  // 1) 列表式：### [标题](链接) 或 ## [标题](链接)
  const re = /^(#{2,3})\s+\[(.*?)\]\((.*?)\)\s*$/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    const [, , rawTitle, link] = m;
    items.push({
      title: (rawTitle || slugToTitle(link)).trim(),
      link: link.trim(),
      pubDate: null,
      summary: ''
    });
  }

  // 2) 文章式：单页正文，取 Title 块 + 正文前 300 字作摘要
  if (!items.length) {
    const title = (markdown.match(/^Title:\s*(.+)$/m) || [])[1] || '';
    const link = (markdown.match(/^URL Source:\s*(.+)$/m) || [])[1] || '';
    const dateStr = (markdown.match(/^Published Time:\s*(.+)$/m) || [])[1] || null;
    let pubDate = null;
    if (dateStr) {
      try { pubDate = new Date(dateStr).toISOString(); } catch {}
    }
    items.push({
      title: title.trim() || (fallbackTitle ? String(fallbackTitle) : '无标题'),
      link: link.trim(),
      pubDate,
      summary: content.trim().replace(/\s+/g, ' ').slice(0, 300)
    });
  }

  return items.slice(0, 15);
}

/**
 * 解析 Jina 输出的微信公众号文章页（mp.weixin.qq.com/s/xxx）。
 * 标题取正文 H1（# 标题）或 Title 块；日期支持中文「2026年8月7日」与 ISO；摘要取首个长段落。
 */
export function parseJinaArticle(markdown, fallbackTitle) {
  const content = markdown.split('Markdown Content:')[1] || markdown;

  // 标题
  let title = (content.match(/^#\s+(.+)$/m) || [])[1] || '';
  if (!title) title = (markdown.match(/^Title:\s*(.+)$/m) || [])[1] || '';
  title = title.trim() || (fallbackTitle ? String(fallbackTitle) : '无标题');

  // 链接
  const link = (markdown.match(/^URL Source:\s*(.+)$/m) || [])[1] || '';

  // 日期：中文「2026年8月7日」优先，其次 Published Time 块
  let pubDate = null;
  const zhDate = content.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (zhDate) {
    const [, y, mo, d] = zhDate;
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00+08:00`;
    try { pubDate = new Date(iso).toISOString(); } catch {}
  }
  if (!pubDate) {
    const isoDate = (markdown.match(/^Published Time:\s*(.+)$/m) || [])[1];
    if (isoDate) {
      try { pubDate = new Date(isoDate).toISOString(); } catch {}
    }
  }

  // 摘要：正文首个 ≥40 字的长段落，取前 300 字
  const paras = content
    .split(/\n{2,}/)
    .map(p => p.replace(/^#{1,4}\s+/gm, '').replace(/[*_`>#]/g, '').trim())
    .filter(p => p.length >= 40);
  const summary = (paras[0] || content).replace(/\s+/g, ' ').slice(0, 300);

  return [{
    title: String(title),
    link: link.trim(),
    pubDate,
    summary
  }];
}

/** 从 HTML 中取出 id 对应的 div 完整内容（处理嵌套 div 的闭合）。 */
function extractDivById(html, id) {
  const marker = `id="${id}"`;
  const k = html.indexOf(marker);
  if (k < 0) return '';
  const open = html.indexOf('>', k);
  if (open < 0) return '';
  let depth = 1;
  let pos = open + 1;
  let close = -1;
  while (pos < html.length) {
    const openDiv = html.indexOf('<div', pos);
    const closeDiv = html.indexOf('</div>', pos);
    if (closeDiv === -1) break;
    if (openDiv !== -1 && openDiv < closeDiv) {
      depth++;
      pos = openDiv + 4;
    } else {
      depth--;
      pos = closeDiv + 6;
      if (depth === 0) { close = pos; break; }
    }
  }
  return close === -1 ? '' : html.slice(open + 1, close);
}

/**
 * 解析微信公众号文章页直连 HTML（mp.weixin.qq.com/s/xxx）。
 * Jina 在 mp.weixin.qq.com 会被 Cloudflare 人机验证拦截，直连反而可行。
 * 提取：og:title 标题、js_name 公众号名、正文 js_content、publish 时间。
 * @returns {{title:string, link:string, pubDate:string|null, summary:string, author:string}|null}
 */
export function parseWechatArticleHtml(html, fallbackTitle) {
  const g = re => { const m = html.match(re); return m ? m[1].trim() : ''; };

  const title = g(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/) || fallbackTitle || '';
  const link = g(/<meta[^>]*property="og:url"[^>]*content="([^"]*)"/);
  const author = g(/id="js_name"[\s\S]{0,300}?>\s*([^<]{1,40})/);

  // 发布时间：正文里首个「2026-05-26 14:39」形式
  let pubDate = null;
  const dt = (html.match(/\b20\d\d-\d{2}-\d{2}[ T]\d{2}:\d{2}/) || [])[0];
  if (dt) {
    try { pubDate = new Date(dt.replace(' ', 'T') + '+08:00').toISOString(); } catch {}
  }

  const contentHtml = extractDivById(html, 'js_content');
  const text = contentHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 真实文章正文远不止 20 字；无正文（或正文为空）说明是错误页/已删除/需关注页
  if (text.length < 20) return null;
  return {
    title: title || fallbackTitle || '无标题',
    link,
    pubDate,
    summary: text.slice(0, 300),
    author
  };
}

/**
 * 通用网页 HTML 解析（转载站 Jina 失败时的直连兜底）。
 * 提取 og:title/<title> + 正文前 300 字。无标题且正文 <20 字 → null。
 */
export function parseGenericPageHtml(html, fallbackTitle) {
  const g = re => { const m = html.match(re); return m ? m[1].trim() : ''; };
  const title = g(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/) || g(/<title>([^<]*)<\/title>/) || fallbackTitle || '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title && text.length < 20) return null;
  return [{
    title: title || fallbackTitle || '无标题',
    link: '',
    pubDate: null,
    summary: text.slice(0, 300)
  }];
}

/**
 * 直连抓取单个微信公众号文章页。返回 item 数组（1 条）或 null。
 */
export async function fetchWechatArticle(url) {
  const html = await curlFetch(url, 45);
  const parsed = parseWechatArticleHtml(html);
  if (!parsed) return null;
  return [{
    title: parsed.title,
    link: parsed.link || url,
    pubDate: parsed.pubDate,
    summary: parsed.summary || '',
    author: parsed.author || ''
  }];
}

/** 原始 Jina 抓取：拼 URL、限速、45s 超时，返回 Markdown 文本。 */
async function fetchViaJinaRaw(url, maxTime = 45) {
  const jinaUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`;
  await sleep(1500);
  return curlFetch(jinaUrl, maxTime);
}

async function fetchViaJina(url, mode = 'feed') {
  try {
    const text = await fetchViaJinaRaw(url);
    const items = mode === 'page' ? parseJinaPage(text, url) : parseJinaRSS(text);
    if (!items.length) return null;
    return { items };
  } catch {
    return null;
  }
}

/**
 * 抓取无 RSS 的页面型信源（公众号官网 / 聚合页 / 单篇文章）。
 * 返回 { items, via: 'jina-page' } 或 null（失败）。
 */
export async function fetchPage(source) {
  const url = source.url || source.rss;
  if (!url) {
    console.error(`[失败] ${source.name}: 无抓取入口 url`);
    return null;
  }
  try {
  const isWechatArticle = isWechatArticleUrl(url);
  let items = null;
  if (isWechatArticle) {
    // 微信只走直连（Jina 在 mp.weixin.qq.com 被 Cloudflare 拦截，无有效兜底）
    items = await fetchWechatArticle(url);
  } else {
    const text = await fetchViaJinaRaw(url);
    items = parseJinaPage(text, source.name);
  }
  if (!items || !items.length) {
    console.error(`[失败] ${source.name}: 抓取 ${url} 无结果`);
    return null;
  }
    const mapped = items.slice(0, 15).map(item => ({
      title: item.title || '无标题',
      link: item.link || url,
      guid: item.link || item.guid || url,
      pubDate: item.pubDate || null,
      summary: item.summary || '',
      source: source.name,
      sourceUrl: source.url
    }));
    console.log(`[成功 (Jina 页面)] ${source.name}: ${mapped.length} 条`);
    return { items: mapped, via: 'jina-page' };
  } catch (err) {
    console.error(`[失败] ${source.name}: ${err.message}`);
    return null;
  }
}

/**
 * 抓取单个 feed。返回 { items, via } 或 null（失败）。
 * fetchType==='page' 时走 Jina 页面抓取；否则走 RSS（失败降级 Jina）。
 * item 字段：title, link, pubDate, summary, source, sourceUrl, guid
 */
export async function fetchFeed(source) {
  if (source.fetchType === 'page') return fetchPage(source);

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

// ---- 微信公众号文章种子文件 ----
// feeds/wechat-articles.json 由用户按需维护：有值得抓的公众号文章链接就丢进去，
// 采集时只抓未抓取（fetched=false）的条目，抓完回写标记；已抓取记录保留 3 天。
export const WECHAT_SEEDS_PATH = 'feeds/wechat-articles.json';

/** 支持测试用环境变量覆盖路径。 */
function seedsPath() {
  return process.env.WECHAT_SEEDS_PATH || WECHAT_SEEDS_PATH;
}

export async function loadWechatSeeds() {
  try {
    const raw = JSON.parse(await fs.readFile(seedsPath(), 'utf8'));
    return { version: raw.version || '1.0.0', updatedAt: raw.updatedAt || null, articles: raw.articles || [] };
  } catch {
    return { version: '1.0.0', updatedAt: null, articles: [] };
  }
}

export async function saveWechatSeeds(seed) {
  await fs.writeFile(seedsPath(), JSON.stringify(seed, null, 2) + '\n');
}

/**
 * 抓取种子文件中的未抓取公众号文章，抓完回写 fetched 标记，并清理 3 天前的已抓取记录。
 * 保留期内的已抓取种子也回填 item 流（用抓取时存下的 title/pubDate/summary），
 * 保证公众号内容在重建后不消失（否则 V2 构建只注入一次，重跑即丢）。
 * @returns {Promise<Array>} 注入的 item 流（含本次新抓 + 保留期回填，可注入 rawItems）
 */
export async function fetchWechatSeeds(seed) {
  const items = [];
  const now = new Date();
  const cutoff = now.getTime() - 3 * 24 * 60 * 60 * 1000;
  const remaining = [];
  let done = 0;
  let pruned = 0;
  let reinjected = 0;

  for (const a of seed.articles || []) {
    if (a.fetched) {
      const added = a.addedAt ? new Date(a.addedAt).getTime() : 0;
      if (!isNaN(added) && added >= cutoff) {
        remaining.push(a);
        // 回填已抓取种子（无 summary 时留空，title/link 即可渲染链接卡）
        items.push({
          title: a.title || '无标题',
          link: a.url,
          guid: a.url,
          pubDate: a.pubDate || null,
          summary: a.summary || '',
          source: a.sourceName || '微信公众号',
          sourceUrl: null,
          wechat: true
        });
        reinjected++;
      } else {
        pruned++;
      }
      continue;
    }
    if (!a.url) { remaining.push(a); continue; }
    try {
      const isWechatUrl = isWechatArticleUrl(a.url);
      let parsed = null;
      if (isWechatUrl) {
        // 微信只走直连：Jina 在 mp.weixin.qq.com 被 Cloudflare 拦截，兜底只会注入验证页垃圾
        parsed = await fetchWechatArticle(a.url);
      } else {
        // 转载站（北极星/碳索储能等）：优先 Jina 页面解析，失败降级直连 + 通用 HTML 解析
        // （腾讯新闻/中国发展网等拦截 Jina，但直连可访问）。抓到的内容仍按公众号来源处理
        let text = null;
        try { text = await fetchViaJinaRaw(a.url); } catch {}
        if (text && /Markdown Content:|^Title:/m.test(text)) {
          parsed = parseJinaPage(text, a.title || a.sourceName || a.url);
        } else {
          const html = await curlFetch(a.url, 45);
          parsed = parseGenericPageHtml(html, a.title || a.sourceName || a.url);
        }
      }
      if (!parsed || !parsed.length) {
        // 页面可访问但无有效正文（已删除/失效/需关注）：标记 fetched，避免每次构建重试
        a.fetched = true;
        console.warn(`[微信/转载] ${a.url.slice(0, 60)} 无有效正文，已标记跳过`);
      } else {
        for (const it of parsed) {
          items.push({
            title: it.title,
            link: it.link || a.url,
            guid: a.url,
            pubDate: it.pubDate || a.pubDate || null,
            summary: it.summary || '',
            source: a.sourceName || '微信公众号',
            sourceUrl: null,
            wechat: true
          });
        }
        if (!a.title && parsed[0]?.title) a.title = parsed[0].title;
        if (!a.pubDate && parsed[0]?.pubDate) a.pubDate = parsed[0].pubDate;
        if (parsed[0]?.summary) a.summary = parsed[0].summary;
        if (parsed[0]?.author) a.author = parsed[0].author;
        a.fetched = true;
        done++;
      }
    } catch (err) {
      // 网络错误：不标记，下次构建重试
      console.error(`[微信/转载抓取失败] ${a.url.slice(0, 60)}: ${err.message}`);
    }
    remaining.push(a);
    await sleep(1200);
  }

  if (items.length || done || pruned || reinjected) {
    await saveWechatSeeds({ version: '1.0.0', updatedAt: now.toISOString(), articles: remaining });
    console.log(`[微信公众号种子] 本次新抓 ${done} 条 + 保留期回填 ${reinjected} 条 → 注入 ${items.length} 条，清理过期 ${pruned} 条（保留 ${remaining.length} 条记录）`);
  }
  return items;
}
