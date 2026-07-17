#!/usr/bin/env node
/**
 * RSS 抓取脚本 — 仅生成日报
 * 读取 data/sources.json 中所有 rss 字段，并行抓取，生成 feeds/daily.json
 * 用法:
 *   node scripts/fetch-rss.mjs
 *   node scripts/fetch-rss.mjs --mode=daily
 */
import fs from 'fs/promises';
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

async function curlFetch(url, maxTime = 30) {
  const { stdout } = await execFileAsync('curl', [
    '-L', '--max-time', String(maxTime), '-s', '--compressed',
    ...COMMON_HEADERS,
    url
  ], { maxBuffer: 20 * 1024 * 1024, timeout: (maxTime + 5) * 1000 });
  return stdout;
}

const now = new Date();
const ONE_DAY = 24 * 60 * 60 * 1000;

function toISODate(d) {
  return d.toISOString().split('T')[0];
}

function withinDays(dateStr, days) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  return (now.getTime() - d.getTime()) <= days * ONE_DAY;
}

function pickSummary(item) {
  if (item.contentSnippet) return item.contentSnippet;
  if (item.summary) return item.summary;
  if (item.contentEncoded) {
    return item.contentEncoded.replace(/<[^>]+>/g, ' ').trim().slice(0, 300);
  }
  return '';
}

// 严格主题白名单：必须与 发电/储能/AIDC/电力解决方案 相关
const ENERGY_KEYWORDS = [
  // 中文
  '电力', '电网', '电能', '发电', '能源', '新能源', '可再生能源', '清洁能源', '绿电', '绿证',
  '储能', '电池', '锂电池', '锂电', '动力电池', '储能电池', '固态电池', '钠离子',
  '燃料电池', '氢能', '氢', '电解槽', '绿氢', '灰氢',
  '光伏', '太阳能', '风电', '风能', '核电', '核能', '反应堆', '铀', '水电', '煤电', '气电', '火电',
  '天然气', '石油', '油气', '煤炭', '生物质',
  '双碳', '碳中和', '碳达峰', '碳市场', '碳交易', '碳排放', '气候变化', '温室气体', '甲烷', 'CCUS', '碳捕集',
  '数据中心', '算力', '智算', '超算', '服务器', 'GPU', 'AI芯片', '芯片', '半导体', '晶圆', 'DRAM', 'HBM',
  '液冷', 'PUE', 'UPS', '不间断电源', '电动车', '电动汽车', 'EV', '充电桩',
  '逆变器', '组件', '硅料', '硅片', '源网荷储', '虚拟电厂', '微电网', '特高压', '变电站', '变压器',
  '输配电', '智能电网', '负荷', '调度', '备用电源', '电力市场', '辅助服务', '现货市场',
  '抽水蓄能', '电化学储能', '光储', '风储', '氢储', 'BESS',
  // English
  'power', 'grid', 'electricity', 'electric', 'energy', 'renewable', 'clean energy',
  'generation', 'generator', 'turbine', 'solar', 'PV', 'wind', 'nuclear', 'reactor', 'uranium', 'hydro', 'coal', 'gas', 'biomass',
  'storage', 'battery', 'batteries', 'lithium', 'solid-state', 'sodium-ion', 'sodium ion',
  'fuel cell', 'hydrogen', 'electrolyzer', 'electrolyser', 'green hydrogen',
  'data center', 'datacenter', 'compute', 'AI chip', 'GPU', 'semiconductor', 'wafer', 'DRAM', 'HBM',
  'liquid cooling', 'PUE', 'UPS', 'EV', 'charging', 'inverter', 'module', 'panel', 'cell',
  'silicon', 'virtual power plant', 'microgrid', 'HVDC', 'transformer', 'substation', 'transmission', 'distribution',
  'load', 'dispatch', 'backup power', 'electricity market', 'ancillary services', 'demand response',
  'pumped hydro', 'BESS', 'solar-plus-storage', 'solar plus storage', 'wind-storage', 'hydrogen storage',
  'carbon', 'net zero', 'carbon neutral', 'emissions', 'green certificate', 'carbon capture',
  // AI / 云计算基础设施与电力
  'PPA', 'power purchase', 'power purchase agreement', 'offtake', 'energy procurement', 'carbon-free energy',
  'renewable energy procurement', 'data centre', 'datacenter', 'hyperscale', 'supercomputer', 'supercomputing',
  'cluster', 'AI infrastructure', 'AI data center', 'foundry', 'sovereign cloud', 'edge data center',
  'interconnection', 'grid interconnection', 'capacity', 'MW', 'megawatt', 'GW', 'gigawatt', 'TW', 'terawatt',
  'Stargate', 'Project Stargate', 'power plant', 'power station', 'cooling', 'liquid cooling', 'water usage',
  'water efficiency', 'energy efficiency',
  '电力需求', '算电协同', '算力中心', '智算中心', '超算中心', '购电协议', '电力采购', '绿电采购', '能源采购',
  '并网', '电力容量', '兆瓦', '万千瓦', '吉瓦', '亿千瓦', '太瓦', '星门', '液冷', '水冷', '能耗', 'PUE', '能源效率',
  '基础设施'
];

function matchesKeyword(text, k) {
  const lowerK = k.toLowerCase();
  // 含中文字符的关键词使用子串匹配（中文没有明显的词边界）
  if (/[一-龥]/.test(lowerK)) {
    return text.includes(lowerK);
  }
  // 英文关键词使用整词/整短语匹配，避免 'power' 匹配 'powerful'
  const words = lowerK.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = `\\b${words.join('\\b\\s+\\b')}\\b`;
  return new RegExp(pattern, 'i').test(text);
}

function isEnergyRelevant(item) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  return ENERGY_KEYWORDS.some(k => matchesKeyword(text, k));
}

// ===== 标题中文翻译（MyMemory 免费 API）=====
const TRANSLATION_CACHE_PATH = 'feeds/translation-cache.json';
const MYMEMORY_DELAY = 300;

async function loadTranslationCache() {
  try {
    const raw = await fs.readFile(TRANSLATION_CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveTranslationCache(cache) {
  await fs.writeFile(TRANSLATION_CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isEnglishTitle(text) {
  return !!text && /[a-zA-Z]/.test(text) && !/[一-龥]/.test(text);
}

async function translateTitles(items) {
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
    await sleep(MYMEMORY_DELAY);
  }
  await saveTranslationCache(cache);
  console.log(`\n翻译完成: ${translated} 条翻译, ${skipped} 条跳过(已中文)`);
}

async function loadSources() {
  const raw = await fs.readFile('data/sources.json', 'utf8');
  return JSON.parse(raw);
}

function collectFeeds(data) {
  const feeds = [];
  for (const cat of data.categories) {
    for (const src of cat.sources) {
      if (src.rss) {
        feeds.push({ ...src, category: cat.name });
      }
    }
  }
  return feeds;
}


function sanitizeXml(xml) {
  // 部分源（如 IEA 旧 RSS）的 URL 参数里含未转义的 &，会导致 XML 解析失败
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
  } catch (err) {
    return null;
  }
}

async function fetchFeed(source) {
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
    pubDate: item.isoDate || item.pubDate || null,
    summary: pickSummary(item),
    source: source.name,
    sourceUrl: source.url
  }));
  console.log(`[成功${via === 'jina' ? ' (Jina)' : ''}] ${source.name}: ${items.length} 条`);
  return { items };
}

async function main() {
  const data = await loadSources();
  const feeds = collectFeeds(data);
  console.log(`\n发现 ${feeds.length} 个 RSS 源\n`);

  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const seenLinks = new Set();
  let allItems = [];
  let success = 0;

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      for (const item of result.value.items) {
        const key = item.link || item.title;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);
        allItems.push(item);
      }
      success++;
    }
  }

  // 严格主题过滤
  const beforeFilter = allItems.length;
  allItems = allItems.filter(isEnergyRelevant);
  console.log(`\n过滤后: ${allItems.length}/${beforeFilter} 条（去除 ${beforeFilter - allItems.length} 条无关内容）`);

  // 按发布时间倒序
  allItems.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  // 翻译英文标题
  await translateTitles(allItems);

  const dailyItems = allItems.filter(i => withinDays(i.pubDate, 1));
  const daily = {
    mode: 'daily',
    date: toISODate(now),
    generatedAt: now.toISOString(),
    totalSources: feeds.length,
    successSources: success,
    count: dailyItems.length,
    items: dailyItems
  };
  await fs.writeFile('feeds/daily.json', JSON.stringify(daily, null, 2) + '\n');
  console.log(`\n✅ 日报已生成: ${dailyItems.length} 条 (来源 ${success}/${feeds.length})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
