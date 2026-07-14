#!/usr/bin/env node
/**
 * RSS 抓取脚本
 * 读取 data/sources.json 中所有 rss 字段，并行抓取，生成 feeds/daily.json 和 feeds/weekly.json
 * 用法:
 *   node scripts/fetch-rss.mjs
 *   node scripts/fetch-rss.mjs --mode=daily
 *   node scripts/fetch-rss.mjs --mode=weekly
 */

import fs from 'fs/promises';
import Parser from 'rss-parser';

const parser = new Parser({
  timeout: 20000,
  headers: {
    'User-Agent': 'EnergyInfoHub/1.0 (https://github.com)'
  },
  customFields: {
    item: [['media:group', 'mediaGroup'], ['content:encoded', 'contentEncoded']]
  }
});

const now = new Date();
const ONE_DAY = 24 * 60 * 60 * 1000;

const args = process.argv.slice(2);
const modeArg = args.find(a => a.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : 'all'; // daily | weekly | all

function toISODate(d) {
  return d.toISOString().split('T')[0];
}

function getWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function getWeekRange(d) {
  const end = new Date(d);
  const start = new Date(end.getTime() - 6 * ONE_DAY);
  return `${toISODate(start)} ~ ${toISODate(end)}`;
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

async function fetchFeed(source) {
  try {
    const feed = await parser.parseURL(source.rss);
    const items = (feed.items || []).slice(0, 15).map(item => ({
      title: item.title || '无标题',
      link: item.link || item.guid || source.url,
      pubDate: item.isoDate || item.pubDate || null,
      summary: pickSummary(item),
      source: source.name,
      sourceUrl: source.url
    }));
    console.log(`[成功] ${source.name}: ${items.length} 条`);
    return { items };
  } catch (err) {
    console.error(`[失败] ${source.name}: ${err.message}`);
    return null;
  }
}

async function main() {
  if (!['daily', 'weekly', 'all'].includes(mode)) {
    console.error('未知 mode:', mode);
    process.exit(1);
  }

  const data = await loadSources();
  const feeds = collectFeeds(data);
  console.log(`\n发现 ${feeds.length} 个 RSS 源，模式: ${mode}\n`);

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

  // 按发布时间倒序
  allItems.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  if (mode === 'daily' || mode === 'all') {
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

  if (mode === 'weekly' || mode === 'all') {
    const weeklyItems = allItems.filter(i => withinDays(i.pubDate, 7));
    const weekly = {
      mode: 'weekly',
      week: `${now.getFullYear()}-W${getWeekNumber(now)}`,
      dateRange: getWeekRange(now),
      generatedAt: now.toISOString(),
      totalSources: feeds.length,
      successSources: success,
      count: weeklyItems.length,
      items: weeklyItems
    };
    await fs.writeFile('feeds/weekly.json', JSON.stringify(weekly, null, 2) + '\n');
    console.log(`\n✅ 周报已生成: ${weeklyItems.length} 条 (来源 ${success}/${feeds.length})`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
