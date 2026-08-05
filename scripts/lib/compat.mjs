/**
 * 前端兼容层（阶段 A-04）。
 *
 * 目标：旧版 V1 `daily.json` 与新版 V2 `daily.json` 都能被前端统一渲染，
 * 满足 AC-11「旧版数据至少能展示标题、来源、时间、摘要和链接」。
 *
 * 本模块为纯函数、无 DOM/Node 专属依赖（仅用标准库），既可在 Node 中测试，
 * 也可被浏览器前端直接引用（阶段 C/D 落地时接入 app.js）。
 */

/** FNV-1a 64-bit 简化实现，用于从 URL/标题派生确定性哈希（非加密用途）。 */
export function hashId(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** 规范化 URL 用于 ID 派生与去重：去 fragment/query、统一小写主机。 */
export function canonicalUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    u.protocol = u.protocol === 'http:' ? 'https:' : u.protocol;
    return u.href.replace(/\/+$/, '');
  } catch {
    return String(url).trim().replace(/#.*$/, '');
  }
}

/** 清洗摘要：去 HTML、折叠空白、限长。 */
export function cleanSummary(text, maxLen = 220) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** 识别数据版本。 */
export function detectVersion(daily) {
  if (daily && daily.schemaVersion === 2) return 'v2';
  return 'v1';
}

/**
 * 把 V1 / V2 的 daily 数据统一为前端渲染结构。
 *
 * @param {object} daily daily.json 原始数据
 * @returns {object} {
 *   version: 'v1' | 'v2',
 *   date, generatedAt, status,
 *   stats: {...} | null,
 *   items: [{ id, title, url, summary, sourceName, sourceType, isPrimary,
 *             topic, topicLabel, tags, region, metrics, impact,
 *             publishedAt, discoveredAt, relatedCount, relatedSources, legacy }]
 * }
 */
export function normalizeDaily(daily) {
  const version = detectVersion(daily);
  const fallback = {
    version,
    date: daily?.date || '',
    generatedAt: daily?.generatedAt || '',
    status: daily?.status || (version === 'v2' ? 'unknown' : 'ok'),
    stats: daily?.stats || null,
    items: []
  };

  if (!daily || !Array.isArray(daily.items)) return fallback;

  if (version === 'v2') {
    fallback.items = daily.items.map((it) => ({
      id: it.id,
      title: it.title || it.originalTitle || '无标题',
      url: it.url || '',
      summary: cleanSummary(it.summary),
      whyItMatters: typeof it.whyItMatters === 'string' ? it.whyItMatters : '',
      sourceName: it.source?.name || '',
      sourceType: it.source?.type || 'media',
      isPrimary: it.source?.isPrimary === true,
      topic: it.topic || '',
      topicLabel: '', // 前端可结合 enums 填充
      tags: Array.isArray(it.tags) ? it.tags : [],
      region: it.region || '',
      entities: Array.isArray(it.entities) ? it.entities : [],
      metrics: Array.isArray(it.metrics) ? it.metrics : [],
      impact: it.impact || 'unknown',
      importance: typeof it.importance === 'number' ? it.importance : 0,
      publishedAt: it.publishedAt || '',
      discoveredAt: it.discoveredAt || '',
      relatedCount: Array.isArray(it.relatedSources) ? it.relatedSources.length : 0,
      relatedSources: Array.isArray(it.relatedSources) ? it.relatedSources : [],
      legacy: false
    }));
    return fallback;
  }

  // ---- V1：旧版结构映射（保证标题/来源/时间/摘要/链接可展示）----
  fallback.items = daily.items.map((it, idx) => {
    const url = it.link || it.url || it.guid || it.sourceUrl || '';
    const key = canonicalUrl(url) || (it.title || '') + idx;
    const title = it.translatedTitle && it.translatedTitle !== it.title
      ? it.translatedTitle
      : (it.title || '无标题');
    const summary = cleanSummary(it.summary || it.description || it.contentSnippet || '');
    return {
      id: `legacy_${hashId(key).slice(0, 16)}`,
      title,
      originalTitle: it.title || '',
      url,
      summary,
      whyItMatters: '',
      sourceName: it.source || '',
      sourceType: 'media',
      isPrimary: false,
      topic: '',
      topicLabel: '',
      tags: [],
      region: '',
      entities: [],
      metrics: [],
      impact: 'unknown',
      importance: 0,
      publishedAt: it.pubDate || it.isoDate || it.date || '',
      discoveredAt: '',
      relatedCount: 0,
      relatedSources: [],
      legacy: true
    };
  });
  return fallback;
}
