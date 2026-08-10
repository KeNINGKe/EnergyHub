#!/usr/bin/env node
/**
 * V2 daily.json + featured.json 生成器（B-10 / B-11 / B-12 / B-13）。
 *
 * 管线：抓取 → 翻译 → 确定性去重(B-05) → 相关性硬过滤(B-01/B-02) →
 *       提取(B-04) → 来源类型(B-03) → 相似事件合并(B-06) → 主条目(B-07) →
 *       重要性评分+单来源限制(B-08) → 摘要/推荐理由(B-09) → 今日观察+精选(B-10) →
 *       人工覆盖(B-11) → 临时文件+原子替换(B-12) → 统计日志(B-13)。
 *
 * 用法:
 *   node scripts/build-daily-v2.mjs                     # 线上抓取
 *   node scripts/build-daily-v2.mjs --replay [日期]      # 用 samples/daily 回放
 *   node scripts/build-daily-v2.mjs --dry-run           # 只生成临时/预览，不写正式文件
 *   node scripts/build-daily-v2.mjs --activate          # 同时覆盖 feeds/daily.json（V2 上线用）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnums, validateDailyV2, validateFeatured } from './lib/schema.mjs';
import { loadFilters, classifyItem } from './lib/filter.mjs';
import { loadSourceTypes, loadSourceMap, classifySourceType } from './lib/source.mjs';
import { extractItem } from './lib/extract.mjs';
import { dedupItems } from './lib/dedup.mjs';
import { mergeEvents } from './lib/merge.mjs';
import { pickPrimary } from './lib/select.mjs';
import { importance, capPerSource } from './lib/score.mjs';
import { cleanSummary, generateWhyItMatters } from './lib/clean.mjs';
import { loadOverrides, applyOverrides } from './lib/overrides.mjs';
import { hashId, canonicalUrl } from './lib/compat.mjs';
import {
  toISODate, loadSources, collectFeeds, fetchAllFeeds, translateTitles,
  loadWechatSeeds, fetchWechatSeeds
} from './lib/fetch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function eventId(it) {
  const key = canonicalUrl(it.url) || it.originalTitle || it.title;
  return `evt_${hashId(key).slice(0, 12)}`;
}

/**
 * 精选选择：重要性降序 + 主题多样性 + 来源多样性 + 质量门槛。
 * 微信来源事件（wechat:true）在主题/来源配额上保底入选（默认 1 条），
 * 保证公众号内容可靠地进入精选，而非只靠重要性竞争。
 */
export function selectFeatured(events, enums, opts = {}) {
  const { threshold = 3.0, maxPerTopic = 2, maxPerSource = 1, maxFeatured = 10, wechatQuota = 1 } = opts;
  const observations = [];
  const featuredEventIds = [];
  const topicCount = {};
  const srcCount = {};
  const reserved = new Set();

  // 预选：微信事件保底。重要性降序里权重最高的前 wechatQuota 条先占位，
  // 跨过主题/来源配额（它们不参与后面的主选），保证公众号内容可靠进精选。
  for (const ev of events) {
    if (ev.importance < threshold) break;
    if (reserved.size >= wechatQuota) break;
    if (!(ev.wechat === true) || reserved.has(ev.id)) continue;
    reserved.add(ev.id);
    featuredEventIds.push(ev.id);
    const t = ev.topic || 'other-energy';
    const s = ev.source.name;
    topicCount[t] = (topicCount[t] || 0) + 1;
    srcCount[s] = (srcCount[s] || 0) + 1;
    if (observations.length < 3) {
      const topicLabel = enums.topics.find(x => x.id === t)?.label || t;
      observations.push(`【${topicLabel}】${ev.title}`.slice(0, 60));
    }
  }

  // 主选：其余事件按重要性降序 + 主题/来源配额（已预选的微信事件跳过）
  for (const ev of events) {
    if (ev.importance < threshold) break; // 已按重要性降序，低于门槛即可停
    if (featuredEventIds.length >= maxFeatured) break;
    if (reserved.has(ev.id)) continue;
    const t = ev.topic || 'other-energy';
    const s = ev.source.name;
    if ((topicCount[t] || 0) >= maxPerTopic) continue;
    if ((srcCount[s] || 0) >= maxPerSource) continue;
    featuredEventIds.push(ev.id);
    topicCount[t] = (topicCount[t] || 0) + 1;
    srcCount[s] = (srcCount[s] || 0) + 1;
    if (observations.length < 3) {
      const topicLabel = enums.topics.find(x => x.id === t)?.label || t;
      observations.push(`【${topicLabel}】${ev.title}`.slice(0, 60));
    }
  }
  return { featuredEventIds, observations };
}

/**
 * 核心管线：把去重前的原始条目处理为 V2 daily + featured。
 * @param {Array} rawItems 原始条目 { title, link, guid, pubDate, summary, source, translatedTitle }
 * @param {object} ctx { date, now, filters, enums, sourceTypes, sourceMap, overridesForDate }
 * @returns {{ daily, featured, stats }}
 */
export async function processItems(rawItems, ctx) {
  const { date, now, filters, enums, sourceTypes, sourceMap, overridesForDate } = ctx;
  const stats = { raw: rawItems.length, duplicatesRemoved: 0, filteredOut: 0, events: 0, featured: 0 };

  // 1. 确定性去重
  const { kept: deduped, removed: dupRemoved } = dedupItems(rawItems);
  stats.duplicatesRemoved = dupRemoved.length;

  // 2. 相关性硬过滤（记录原因）
  const passed = [];
  for (const it of deduped) {
    const r = classifyItem(it, filters);
    if (r.relevant) passed.push(it);
  }
  stats.filteredOut = deduped.length - passed.length;

  // 3. 提取 + 来源类型
  const enriched = [];
  for (const it of passed) {
    const ex = await extractItem(it, enums);
    const src = sourceMap.get(it.source) || { name: it.source, tags: [] };
    const st = classifySourceType(src, sourceTypes);
    enriched.push({
      title: it.translatedTitle || it.title || '无标题',
      originalTitle: it.title || '',
      url: it.link || it.url || '',
      guid: it.guid || null,
      summary: it.summary || '',
      publishedAt: it.pubDate || null,
      discoveredAt: now.toISOString(),
      source: it.source || '未知来源',
      sourceType: st.type,
      topic: ex.topics[0] || null,
      region: ex.region,
      entities: ex.entities,
      metrics: ex.metrics,
      wechat: it.wechat || false
    });
  }

  // 4. 相似事件合并
  const { clusters } = mergeEvents(enriched);

  // 5. 逐簇选主条目 → 构建事件
  const events = [];
  const idSeen = new Set();
  for (const cluster of clusters) {
    const members = cluster.members.map(i => enriched[i]);
    const { index } = pickPrimary(members);
    const primary = members[index];
    const relatedSources = members
      .filter((m, i) => i !== index)
      .map(m => ({ name: m.source, url: m.url }));
    const id = eventId(primary);
    if (idSeen.has(id)) continue; // 极端兜底：ID 冲突则丢弃
    idSeen.add(id);
    events.push({
      id,
      title: primary.title,
      originalTitle: primary.originalTitle,
      url: primary.url,
      summary: cleanSummary(primary.summary),
      whyItMatters: generateWhyItMatters(primary, enums),
      topic: primary.topic || 'other-energy',
      tags: [],
      region: primary.region || '未知',
      entities: primary.entities,
      metrics: primary.metrics.map(m => ({ label: m.label || m.unit || '关键数字', value: m.value, unit: m.unit })),
      impact: 'unknown',
      importance: 0,
      source: { name: primary.source, type: primary.sourceType, isPrimary: true },
      publishedAt: primary.publishedAt,
      discoveredAt: primary.discoveredAt,
      relatedSources,
      wechat: primary.wechat || false
    });
  }

  // 6. 重要性评分 + 单来源限制
  for (const ev of events) ev.importance = importance(ev, { now: now.toISOString() });
  events.sort((a, b) => b.importance - a.importance);
  const capped = capPerSource(events, { max: 6 });
  stats.events = capped.length;

  // 7. 今日观察 + 精选候选
  const { featuredEventIds, observations } = selectFeatured(capped, enums);

  const daily = {
    schemaVersion: 2,
    date,
    generatedAt: now.toISOString(),
    status: 'ok',
    stats: {
      sourcesTotal: ctx.sourcesTotal ?? 0,
      sourcesSucceeded: ctx.sourcesSucceeded ?? 0,
      articlesFetched: stats.raw,
      eventsPublished: capped.length
    },
    items: capped
  };

  const featured = {
    schemaVersion: 1,
    date,
    generatedAt: now.toISOString(),
    observations,
    featuredEventIds
  };
  stats.featured = featuredEventIds.length;

  // 8. 人工覆盖（B-11）
  if (overridesForDate) {
    const { errors, warnings } = applyOverrides(daily, featured, overridesForDate, enums);
    if (errors.length) console.error(`  [覆盖错误] ${errors.join('; ')}`);
    if (warnings.length) console.warn(`  [覆盖警告] ${warnings.join('; ')}`);
    stats.overrideErrors = errors.length;
  }

  return { daily, featured, stats };
}

/** 原子写：先写 .tmp，校验通过后 rename 覆盖；失败则删除临时文件。 */
export async function atomicWrite(file, data, validator) {
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  const { valid, errors } = await validator(data);
  if (!valid) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error(`校验失败，未覆盖 ${file}：\n${errors.slice(0, 10).join('\n')}`);
  }
  await fs.rename(tmp, file);
}

/** 读取样本回放输入。 */
async function loadReplayItems(date) {
  const file = path.join(ROOT, 'samples', 'daily', `${date}.json`);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  return (raw.items || []).map(it => ({
    title: it.title || '',
    link: it.link || it.url || '',
    guid: it.guid || null,
    pubDate: it.pubDate || it.isoDate || null,
    summary: it.summary || '',
    source: it.source || '',
    translatedTitle: it.translatedTitle || null
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const replay = args.find(a => a === '--replay');
  const replayDate = args[args.indexOf('--replay') + 1];
  const dryRun = args.includes('--dry-run');
  const activate = args.includes('--activate');

  const [enums, filters, sourceTypes, sourceMapData, overrides] = await Promise.all([
    loadEnums(), loadFilters(), loadSourceTypes(), loadSourceMap(), loadOverrides()
  ]);
  const sourceMap = sourceMapData.byName;

  let now = new Date();
  let rawItems = [];
  let sourcesTotal = 0;
  let sourcesSucceeded = 0;

  if (replay) {
    const dates = replayDate ? [replayDate] : (await fs.readdir(path.join(ROOT, 'samples', 'daily'))).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
    for (const d of dates) {
      const items = await loadReplayItems(d);
      const date = d;
      console.log(`\n===== 回放 ${date} =====`);
      const { daily, featured, stats } = await processItems(items, {
        date, now, filters, enums, sourceTypes, sourceMap,
        overridesForDate: overrides.byDate?.[date],
        sourcesTotal, sourcesSucceeded
      });
      await logStats(date, stats, daily, featured);
      const outDir = path.join(ROOT, 'feeds', 'dry-run', date);
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, 'daily.json'), JSON.stringify(daily, null, 2) + '\n');
      await fs.writeFile(path.join(outDir, 'featured.json'), JSON.stringify(featured, null, 2) + '\n');
      const v1 = await validateDailyV2(daily, enums);
      const vf = await validateFeatured(featured, daily, enums);
      console.log(`  校验 daily: ${v1.valid ? '✅' : '❌ ' + v1.errors.join('; ')} | featured: ${vf.valid ? '✅' : '❌ ' + vf.errors.join('; ')}`);
      if (v1.warnings.length) console.log(`  警告: ${v1.warnings.join('; ')}`);
    }
    console.log('\n回放完成（dry-run 输出见 feeds/dry-run/）。');
    return;
  }

  // ---- 线上抓取 ----
  const data = await loadSources();
  // 若未来给公众号信源配上 url，可在这里把页面型信源纳入采集：
  // const feeds = collectFeeds(data, { includePages: true });
  const feeds = collectFeeds(data);
  console.log(`发现 ${feeds.length} 个 RSS 源`);
  const fetched = await fetchAllFeeds(feeds);
  rawItems = fetched.items;
  sourcesTotal = fetched.total;
  sourcesSucceeded = fetched.succeeded;

  // 微信公众号文章种子（feeds/wechat-articles.json，可选）：抓未抓取的文章注入 items 流
  const seed = await loadWechatSeeds();
  if (seed.articles?.length) {
    const seedItems = await fetchWechatSeeds(seed);
    if (seedItems.length) rawItems.push(...seedItems);
  }

  // 翻译英文标题（中文标题自动跳过）
  const tr = await translateTitles(rawItems);
  console.log(`翻译: ${tr.translated} 条`);

  const date = toISODate(now);
  console.log(`\n===== 生成 ${date} =====`);
  const { daily, featured, stats } = await processItems(rawItems, {
    date, now, filters, enums, sourceTypes, sourceMap,
    overridesForDate: overrides.byDate?.[date],
    sourcesTotal, sourcesSucceeded
  });
  await logStats(date, stats, daily, featured);

  // 空结果保护：抓取/过滤全空时保留既有数据，避免用空日报覆盖线上（如全部 RSS 源临时失败）
  if (stats.events === 0) {
    console.warn(`⚠️  本次构建 0 个事件（原始 ${stats.raw} 条），跳过写入，保留既有 feeds/。`);
    return;
  }

  // 校验
  const v1 = await validateDailyV2(daily, enums);
  const vf = await validateFeatured(featured, daily, enums);
  if (!v1.valid || !vf.valid) {
    console.error('校验失败：');
    if (!v1.valid) v1.errors.forEach(e => console.error('  daily: ' + e));
    if (!vf.valid) vf.errors.forEach(e => console.error('  featured: ' + e));
    process.exit(1);
  }
  if (v1.warnings.length) v1.warnings.forEach(w => console.warn('  [警告] ' + w));

  if (dryRun) {
    const outDir = path.join(ROOT, 'feeds', 'dry-run', date);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'daily.json'), JSON.stringify(daily, null, 2) + '\n');
    await fs.writeFile(path.join(outDir, 'featured.json'), JSON.stringify(featured, null, 2) + '\n');
    console.log('--dry-run：已写入 feeds/dry-run/，未覆盖正式文件。');
    return;
  }

  // 正式写入（原子替换）
  await atomicWrite(path.join(ROOT, 'feeds', 'featured.json'), featured, (d) => validateFeatured(d, daily, enums));
  console.log('✅ 已写入 feeds/featured.json');
  if (activate) {
    await atomicWrite(path.join(ROOT, 'feeds', 'daily.json'), daily, (d) => validateDailyV2(d, enums));
    console.log('✅ 已激活 feeds/daily.json（V2）');
  } else {
    await atomicWrite(path.join(ROOT, 'feeds', 'daily-v2.json'), daily, (d) => validateDailyV2(d, enums));
    console.log('✅ 已写入 feeds/daily-v2.json（V2 暂存，--activate 覆盖 daily.json）');
  }
}

async function logStats(date, stats, daily, featured) {
  console.log(`  原始 ${stats.raw} → 去重 ${stats.duplicatesRemoved} → 过滤 ${stats.filteredOut} → 事件 ${stats.events}（精选 ${stats.featured}）`);
  console.log(`  今日观察 ${featured.observations.length} 条：${featured.observations.join(' | ').slice(0, 120)}`);
  if (stats.overrideErrors) console.log(`  [覆盖] ${stats.overrideErrors} 条错误被记录`);
}

// 仅直接执行时才运行（被测试 import 时不应触发抓取/写盘）
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
