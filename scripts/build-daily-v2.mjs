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
import { loadFilters, classifyItem, keywordHit } from './lib/filter.mjs';
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
const DAILY_MAX_AGE_DAYS = 7;

function eventId(it) {
  const key = canonicalUrl(it.url) || it.originalTitle || it.title;
  return `evt_${hashId(key).slice(0, 12)}`;
}

/**
 * 精选选择：重要性降序 + 主题多样性 + 来源多样性 + 质量门槛 + 时效窗口。
 * 微信来源事件（wechat:true）在主题/来源配额上保底入选（默认 1 条），
 * 保证公众号内容可靠地进入精选，而非只靠重要性竞争。
 * 时效窗口：只接受 now 之前 maxAgeHours（默认 72h）内发布的事件，
 * 无日期或更早的旧文章不进精选（PRD：精选是"今日精选"，不是全局历史榜）。
 *
 * 今日观察（observations）在全部选择完成后，从最终入选集合按重要性取前 3 条，
 * 而非沿用选择过程中的遇到顺序——否则微信/优先主题保底项会劫持头条位，
 * 当天真正最高分的大事件反而进不了「今日观察」。
 */
export function selectFeatured(events, enums, opts = {}) {
  const { threshold = 3, maxPerTopic = 2, maxPerSource = 2, maxFeatured = 12, wechatQuota = 1,
          priorityQuota = 1, maxAgeHours = 72, priorityMaxAgeHours = 168, now = new Date().toISOString() } = opts;
  const nowMs = new Date(now).getTime();
  const isFresh = (ev) => {
    if (!ev.publishedAt) return false;
    const t = new Date(ev.publishedAt).getTime();
    if (isNaN(t)) return false;
    const ageH = (nowMs - t) / 3600e3;
    return ageH >= 0 && ageH <= maxAgeHours;
  };
  // 优先主题（SST/PCS/EMS 等）时效窗放宽到 7 天：细分领域新闻稀疏，
  // 不能因 72h 内无新事件就让重点方向在精选长期为 0。
  const isFreshPriority = (ev) => {
    if (!ev.publishedAt) return false;
    const t = new Date(ev.publishedAt).getTime();
    if (isNaN(t)) return false;
    const ageH = (nowMs - t) / 3600e3;
    return ageH >= 0 && ageH <= priorityMaxAgeHours;
  };
  const selected = [];
  const topicCount = {};
  const srcCount = {};
  const reserved = new Set();
  const admit = (ev) => {
    reserved.add(ev.id);
    selected.push(ev);
    const t = ev.topic || 'other-energy';
    topicCount[t] = (topicCount[t] || 0) + 1;
    srcCount[ev.source.name] = (srcCount[ev.source.name] || 0) + 1;
  };

  // 预选：微信事件保底。重要性降序里权重最高的前 wechatQuota 条先占位，
  // 跨过主题/来源配额（它们不参与后面的主选），保证公众号内容可靠进精选。
  for (const ev of events) {
    if (ev.importance < threshold) break;
    if (selected.length >= wechatQuota) break;
    if (!(ev.wechat === true) || reserved.has(ev.id)) continue;
    if (!isFresh(ev)) continue;
    admit(ev);
  }

  // 预选：优先主题保底（enums.priorityTopics，如 SST/PCS）。每个优先主题各占
  // priorityQuota 席，跨过主题/来源配额——保证重点方向在精选稳定可见，而不是被
  // 当日高分大事件挤掉。仍要求 ≥threshold、72h 内（质量与时效应有底线）。
  const priorityTopics = enums.priorityTopics || [];
  const priorityUsed = {};
  for (const ev of events) {
    if (selected.length >= maxFeatured) break;
    if (!priorityTopics.includes(ev.topic)) continue;
    if ((priorityUsed[ev.topic] || 0) >= priorityQuota) continue;
    if (ev.importance < threshold) continue;
    if (reserved.has(ev.id)) continue;
    if (!isFreshPriority(ev)) continue;   // 优先主题用 7 天窗（见上）
    admit(ev);
    priorityUsed[ev.topic] = (priorityUsed[ev.topic] || 0) + 1;
  }

  // 主选：其余事件按重要性降序 + 主题/来源配额（已预选的微信/优先主题事件跳过）
  for (const ev of events) {
    if (ev.importance < threshold) break; // 已按重要性降序，低于门槛即可停
    if (selected.length >= maxFeatured) break;
    if (reserved.has(ev.id)) continue;
    if (!isFresh(ev)) continue; // 超过时效窗口的旧事件不进精选
    const t = ev.topic || 'other-energy';
    if ((topicCount[t] || 0) >= maxPerTopic) continue;
    if ((srcCount[ev.source.name] || 0) >= maxPerSource) continue;
    admit(ev);
  }

  const featuredEventIds = selected.map(ev => ev.id);
  // 今日观察：从最终入选集合按重要性降序取前 3（稳定排序，同分保持入选顺序）
  const observations = [...selected]
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, 3)
    .map(ev => {
      const t = ev.topic || 'other-energy';
      const topicLabel = enums.topics.find(x => x.id === t)?.label || t;
      return `【${topicLabel}】${ev.title}`.slice(0, 60);
    });
  return { featuredEventIds, observations };
}

/**
 * 今日热点榜（构建端产出 featured.hotEventIds，前端只渲染）。
 * 配置取 data/enums.json 的 hot 段：topics=最高优先档（储能/AIDC），
 * exclude 的主题/关键词（核电）排除。
 * 排序：importance（内容分）为主；regionBoost 命中的地区（北美）加
 * regionBoostScore 软加分（默认 0.5）——同分/近分时北美靠前，
 * 不再硬置顶（高分的中国/欧洲事件可以压过低分北美事件）。
 * 同分为稳定输入序（确定性）。人工可通过 editorial-overrides 的 hotEventIds 整体替换。
 * @returns {string[]} 事件 id 列表（≤ hot.maxItems）
 */
export function selectHot(events, enums, _opts = {}) {
  const cfg = enums.hot || {};
  const topics = new Set(cfg.topics || []);
  if (!topics.size) return [];
  const exclTopics = new Set(cfg.exclude?.topics || []);
  const exclKws = cfg.exclude?.keywords || [];
  const regionRe = (cfg.regionBoost || []).length
    ? new RegExp(cfg.regionBoost.join('|'), 'i') : null;
  const boostScore = typeof cfg.regionBoostScore === 'number' ? cfg.regionBoostScore : 0.5;
  const maxItems = cfg.maxItems ?? 5;

  const candidates = [];
  for (const ev of events) {
    if (!topics.has(ev.topic) || exclTopics.has(ev.topic)) continue;
    const hay = [ev.title, ev.originalTitle, ev.summary, (ev.entities || []).join(' ')]
      .filter(Boolean).join(' ');
    if (exclKws.some(k => keywordHit(hay, k))) continue;
    const boost = regionRe && regionRe.test(ev.region || '') ? boostScore : 0;
    candidates.push({ ev, score: (ev.importance || 0) + boost });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxItems).map(x => x.ev.id);
}

/**
 * 核心管线：把去重前的原始条目处理为 V2 daily + featured。
 * @param {Array} rawItems 原始条目 { title, link, guid, pubDate, summary, source, translatedTitle }
 * @param {object} ctx { date, now, filters, enums, sourceTypes, sourceMap, overridesForDate }
 * @returns {{ daily, featured, stats }}
 */
export function resolveReplayNow(date, generatedAt) {
  const fromSample = generatedAt ? new Date(generatedAt) : null;
  if (fromSample && Number.isFinite(fromSample.getTime())) return fromSample;
  return new Date(`${date}T23:59:59+08:00`);
}

export function ensureNonEmptyBuild(stats, { dryRun = false } = {}) {
  if (stats.events === 0 && !dryRun) {
    throw new Error(`本次构建 0 个事件（原始 ${stats.raw} 条），已中止且保留既有日报。`);
  }
}

export async function processItems(rawItems, ctx) {
  const { date, now, filters, enums, sourceTypes, sourceMap, overridesForDate, globalHiddenIds } = ctx;
  const stats = { raw: rawItems.length, staleFiltered: 0, duplicatesRemoved: 0, filteredOut: 0, events: 0, featured: 0, hot: 0 };

  // 0. 全部动态只保留最近 7 天。无发布时间的页面型来源继续保留，交给后续
  // 精选时效规则和前端降级处理；非法、未来或超窗的明确日期直接剔除。
  const maxAgeMs = DAILY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const nowMs = now.getTime();
  const timelyItems = rawItems.filter(it => {
    if (!it.pubDate) return true;
    const publishedMs = new Date(it.pubDate).getTime();
    if (!Number.isFinite(publishedMs)) return false;
    const ageMs = nowMs - publishedMs;
    return ageMs >= 0 && ageMs <= maxAgeMs;
  });
  stats.staleFiltered = rawItems.length - timelyItems.length;

  // 1. 确定性去重
  const { kept: deduped, removed: dupRemoved } = dedupItems(timelyItems);
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
      source: { name: primary.source, type: primary.sourceType, isPrimary: primary.sourceType === 'primary' },
      publishedAt: primary.publishedAt,
      discoveredAt: primary.discoveredAt,
      relatedSources,
      wechat: primary.wechat || false
    });
  }

  // 6. 重要性评分 + 单来源限制（priorityTopics 让 sst-pcs 等优先主题有机会进精选；
  //    priorityCompanies 让重点公司动态同享 +1）
  for (const ev of events) ev.importance = importance(ev, {
    now: now.toISOString(),
    priorityTopics: enums.priorityTopics || [],
    priorityCompanies: enums.priorityCompanies || []
  });
  events.sort((a, b) => b.importance - a.importance);
  const capped = capPerSource(events, { max: 6 });
  stats.events = capped.length;

  // 7. 今日观察 + 精选候选 + 今日热点榜（时效窗口相对本次构建时间 now）
  const { featuredEventIds, observations } = selectFeatured(capped, enums, { now: now.toISOString() });
  const hotEventIds = selectHot(capped, enums);

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
    featuredEventIds,
    hotEventIds
  };
  stats.featured = featuredEventIds.length;
  stats.hot = hotEventIds.length;

  // 8. 人工覆盖（B-11）：全局永久黑名单总是应用；当日配置存在时叠加应用
  {
    const { errors, warnings } = applyOverrides(daily, featured, overridesForDate || {}, enums, globalHiddenIds || []);
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
  const items = (raw.items || []).map(it => ({
    title: it.title || '',
    link: it.link || it.url || '',
    guid: it.guid || null,
    pubDate: it.pubDate || it.isoDate || null,
    summary: it.summary || '',
    source: it.source || '',
    translatedTitle: it.translatedTitle || null
  }));
  return { items, generatedAt: raw.generatedAt || null };
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
      const replayData = await loadReplayItems(d);
      const items = replayData.items;
      const date = d;
      // 优先使用快照自己的生成时间，确保发布时间晚于中午的条目不会被误判为未来。
      const replayNow = resolveReplayNow(d, replayData.generatedAt);
      console.log(`\n===== 回放 ${date} =====`);
      const { daily, featured, stats } = await processItems(items, {
        date, now: replayNow, filters, enums, sourceTypes, sourceMap,
        overridesForDate: overrides.byDate?.[date],
        globalHiddenIds: overrides.globalHiddenIds || [],
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
  // 页面型信源（fetchType:'page' 标记，见 data/sources.json 的「电力设备 / SST·PCS」分类）
  // 通过 Jina 页面解析纳入采集。注意：会增加每次构建的抓取时长与 Jina 限流压力，
  // 新增页面源时按需维护 fetchType:'page' 标记，不要给普通无 RSS 源随意打标。
  const feeds = collectFeeds(data, { includePages: true });
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
  console.log(`翻译: 成功 ${tr.translated} / 跳过 ${tr.skipped} / 失败 ${tr.failed} / 专有名词 ${tr.identity} 条`);

  const date = toISODate(now);
  console.log(`\n===== 生成 ${date} =====`);
  const { daily, featured, stats } = await processItems(rawItems, {
    date, now, filters, enums, sourceTypes, sourceMap,
    overridesForDate: overrides.byDate?.[date],
    globalHiddenIds: overrides.globalHiddenIds || [],
    sourcesTotal, sourcesSucceeded
  });
  await logStats(date, stats, daily, featured);

  // 空结果保护：抓取/过滤全空时保留既有数据，避免用空日报覆盖线上（如全部 RSS 源临时失败）
  ensureNonEmptyBuild(stats, { dryRun });

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
  if (activate) {
    await atomicWrite(path.join(ROOT, 'feeds', 'daily.json'), daily, (d) => validateDailyV2(d, enums));
    console.log('✅ 已激活 feeds/daily.json（V2）');
  } else {
    await atomicWrite(path.join(ROOT, 'feeds', 'daily-v2.json'), daily, (d) => validateDailyV2(d, enums));
    console.log('✅ 已写入 feeds/daily-v2.json（V2 暂存，--activate 覆盖 daily.json）');
  }
  // daily 先落盘；若 featured 随后写入失败，前端会识别日期不一致并显示明确错误，
  // 避免新 featured 引用尚未落盘的事件 ID。
  await atomicWrite(path.join(ROOT, 'feeds', 'featured.json'), featured, (d) => validateFeatured(d, daily, enums));
  console.log('✅ 已写入 feeds/featured.json');
}

async function logStats(date, stats, daily, featured) {
  console.log(`  原始 ${stats.raw} → 过期 ${stats.staleFiltered} → 去重 ${stats.duplicatesRemoved} → 过滤 ${stats.filteredOut} → 事件 ${stats.events}（精选 ${stats.featured}，热点 ${stats.hot ?? 0}）`);
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
