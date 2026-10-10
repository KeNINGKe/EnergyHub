#!/usr/bin/env node
/**
 * 固定可复现基线（阶段 A-01，AIHOT_IMPLEMENTATION_PLAN §4）。
 *
 * 逐日把 samples/daily/<date>.json 喂给当前代码的 processItems，用
 * samples/jev-fixtures/<date>.json 的固定 Jev 回执离线复现构建，产出：
 *   samples/baseline/quality-upgrade/<date>/daily.json|featured.json  回放产物
 *   samples/baseline/quality-upgrade/report.json                      逐日指标汇总
 *   samples/baseline/quality-upgrade/manifest.json                    代码/配置/提示词版本摘要
 *
 * 用法:
 *   node scripts/build-quality-baseline.mjs                        # 离线回放（无网络、无 key）
 *   node scripts/build-quality-baseline.mjs --date 2026-08-02       # 只跑一天
 *   TYPESAFE_API_KEY=... node scripts/build-quality-baseline.mjs --record
 *                                                                  # 逐日真实调用录制夹具（一次性）
 *
 * 语义：任一日校验失败或夹具未命中 → 整体退出非零，不写 report/manifest。
 * 误合无负例标签，报告只给合并决策日志供人工抽查，不伪造计数；
 * 漏合由 samples/annotations 的 duplicateOf 对按 URL 指纹推导。
 * 曝光记忆：samples/raw/<date>/exposure-history.json(.gz) 存在则按当日状态
 * 应用（未来 V2 时代快照）；7 个既有基线日（2026-07/08）该功能尚不存在，
 * 按空集回放是正确行为（见 docs/DATA_PROTOCOL.md §11）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadEnums, validateDailyV2, validateFeatured } from './lib/schema.mjs';
import { loadFilters } from './lib/filter.mjs';
import { loadSourceTypes, loadSourceMap } from './lib/source.mjs';
import { loadOverrides } from './lib/overrides.mjs';
import { exposedUrlSet, exposedUrlAgeMap, eventFingerprint } from './lib/exposure.mjs';
import { canonicalUrl } from './lib/compat.mjs';
import { collectVersionManifest, sha256File, sha256String, canonicalJson } from './lib/digest.mjs';
import { _resetFixtureState, _fixtureWriteStatus, loadFixtureEntries } from './lib/jev.mjs';
import { loadReplayItems, resolveReplayNow, processItems, atomicWrite } from './build-daily-v2.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SAMPLES_DAILY = path.join(ROOT, 'samples', 'daily');
const FIXTURE_DIR = path.join(ROOT, 'samples', 'jev-fixtures');
const RAW_SNAPSHOT_DIR = path.join(ROOT, 'samples', 'raw');
const OUT_DIR = path.join(ROOT, 'samples', 'baseline', 'quality-upgrade');
const ANNOTATIONS_DIR = path.join(ROOT, 'samples', 'annotations');

/**
 * 漏合推导（纯函数，便于测试）：duplicateOf 标注的同事件组，按 URL 指纹
 * （主 URL + relatedSources，canonical 归一）映射到回放输出的事件；同组
 * 条目落进 >1 个 eventId 即漏合。
 */
export function computeMissedMerges(events, annotationSet, annotationLabels) {
  const urlToEvent = new Map();
  for (const ev of events || []) {
    for (const u of eventFingerprint(ev)) {
      if (!urlToEvent.has(u)) urlToEvent.set(u, ev.id);
    }
  }
  const byId = new Map((annotationSet || []).map(s => [s.id, s]));

  // duplicateOf 连通分量 → 同事件组
  const labels = annotationLabels || {};
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [id, l] of Object.entries(labels)) {
    if (!l?.duplicateOf) continue;
    if (!byId.has(id) || !byId.has(l.duplicateOf)) continue; // 指向不存在的样本：跳过
    union(id, l.duplicateOf);
  }
  const groups = new Map();
  for (const id of parent.keys()) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(id);
  }

  const missed = [];
  for (const members of groups.values()) {
    const placements = members.map(id => {
      const s = byId.get(id);
      const url = canonicalUrl(s?.url);
      return { id, url, eventId: url ? urlToEvent.get(url) ?? null : null };
    });
    const eventIds = [...new Set(placements.map(p => p.eventId).filter(Boolean))];
    if (eventIds.length > 1) missed.push({ memberIds: members, eventIds, placements });
  }
  return { missedCount: missed.length, groups: missed, totalGroups: groups.size };
}

/** 独立来源数代理：1（主来源）+ distinct(relatedSources[].name)。
 *  B-03 引入正式 independentSourceCount 字段后替换。 */
export function independentSourceProxy(ev) {
  return 1 + new Set((ev?.relatedSources || []).map(r => r.name)).size;
}

/** 合并决策日志（误合人工抽查素材）：仅记录有相关报道的事件。 */
export function mergeDecisionLog(daily) {
  return (daily.items || [])
    .filter(ev => (ev.relatedSources || []).length > 0)
    .map(ev => ({
      eventId: ev.id,
      title: String(ev.title || '').slice(0, 80),
      members: [
        { source: ev.source?.name, url: ev.url },
        ...(ev.relatedSources || []).map(r => ({ source: r.name, url: r.url })),
      ],
    }));
}

/** 读取原始快照的曝光历史（.json 或 .json.gz；缺席返回 null）。 */
async function readSnapshotExposure(date) {
  for (const f of [
    path.join(RAW_SNAPSHOT_DIR, date, 'exposure-history.json'),
    path.join(RAW_SNAPSHOT_DIR, date, 'exposure-history.json.gz'),
  ]) {
    try {
      const buf = await fs.readFile(f);
      const text = f.endsWith('.gz') ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      return JSON.parse(text);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
  return null;
}

/** 读取 samples/raw/<date>/items.json.gz（V2 时代快照输入，与 loadReplayItems 同映射）。 */
async function loadRawSnapshotItems(date) {
  const file = path.join(RAW_SNAPSHOT_DIR, date, 'items.json.gz');
  const raw = JSON.parse(zlib.gunzipSync(await fs.readFile(file)).toString('utf8'));
  const items = (Array.isArray(raw) ? raw : raw.items || []).map(it => ({
    title: it.title || '',
    link: it.link || it.url || '',
    guid: it.guid || null,
    pubDate: it.pubDate || it.isoDate || null,
    summary: it.summary || '',
    source: it.source || '',
    translatedTitle: it.translatedTitle || null
  }));
  // 原始快照无 generatedAt：按当日 23:59:59+08:00（时效窗口超集，确定性）
  return { items, generatedAt: null };
}

/** 基线日期 = samples/daily（V1 时代 7 天）∪ samples/raw（CI 积累的 V2 时代）。 */
async function listDates() {
  const dates = new Set();
  try {
    for (const f of await fs.readdir(SAMPLES_DAILY)) {
      if (f.endsWith('.json')) dates.add(f.slice(0, -5));
    }
  } catch { /* 目录缺席：只看 raw */ }
  try {
    for (const d of await fs.readdir(RAW_SNAPSHOT_DIR)) {
      const hasItems = await fs.stat(path.join(RAW_SNAPSHOT_DIR, d, 'items.json.gz')).then(() => true, () => false);
      if (hasItems) dates.add(d);
    }
  } catch { /* 目录缺席：只看 samples/daily */ }
  return [...dates].sort();
}

function titleOf(daily, id) {
  const ev = daily.items.find(it => it.id === id);
  return ev ? String(ev.title).slice(0, 80) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const record = args.includes('--record');
  const dateIdx = args.indexOf('--date');
  const onlyDate = dateIdx >= 0 ? args[dateIdx + 1] : null;

  if (record && !process.env.TYPESAFE_API_KEY && !(process.env.JEV_FALLBACK_BASE_URL && process.env.JEV_FALLBACK_API_KEY)) {
    throw new Error('--record 需要 TYPESAFE_API_KEY（直连录制）或 JEV_FALLBACK_BASE_URL+JEV_FALLBACK_API_KEY（备胎录制）之一');
  }
  if (record && !process.env.TYPESAFE_API_KEY) {
    console.warn('--record 未设 TYPESAFE_API_KEY：直连跳过，将录制备胎（JEV_FALLBACK_*）回执，夹具 header 会标注 source');
  }
  if (!record && process.env.TYPESAFE_API_KEY) {
    throw new Error('离线回放（默认模式）不能设置 TYPESAFE_API_KEY：请 unset 后重试，或用 --record');
  }

  const dates = onlyDate ? [onlyDate] : await listDates();
  if (!dates.length) throw new Error(`samples/daily/ 下没有快照日期`);

  const [enums, filters, sourceTypes, sourceMapData, overrides] = await Promise.all([
    loadEnums(), loadFilters(), loadSourceTypes(), loadSourceMap(), loadOverrides()
  ]);
  const sourceMap = sourceMapData.byName;

  // 标注（漏合推导素材；缺失时跳过该指标并如实记录）
  let annotationSet = null, annotationLabels = null;
  try {
    annotationSet = JSON.parse(await fs.readFile(path.join(ANNOTATIONS_DIR, 'set.json'), 'utf8'));
    annotationLabels = JSON.parse(await fs.readFile(path.join(ANNOTATIONS_DIR, 'labels.json'), 'utf8')).labels;
  } catch { /* 标注文件缺失：漏合指标缺席 */ }

  const perDate = [];
  const manifestPerDate = [];
  const runStartedAt = new Date().toISOString();
  const runStart = Date.now();

  for (const date of dates) {
    const fixtureFile = path.join(FIXTURE_DIR, `${date}.json`);
    _resetFixtureState();
    if (record) {
      process.env.JEV_RECORD_FILE = fixtureFile;
      delete process.env.JEV_REPLAY_FILE;
    } else {
      process.env.JEV_REPLAY_FILE = fixtureFile;
      delete process.env.JEV_RECORD_FILE;
    }

    // 输入来源：samples/daily 优先（带 generatedAt）；缺席时读 samples/raw 快照
    const fromSamplesDaily = await fs.stat(path.join(SAMPLES_DAILY, `${date}.json`)).then(() => true, () => false);
    const replayData = fromSamplesDaily
      ? await loadReplayItems(date)
      : await loadRawSnapshotItems(date);
    const replayNow = resolveReplayNow(date, replayData.generatedAt);
    console.log(`\n===== ${record ? '录制' : '回放'} ${date} =====`);

    // 曝光记忆：当日原始快照存在则按当时状态应用，否则空集（7 个既有基线日无此状态）
    const exposureHistory = await readSnapshotExposure(date);
    const exposureDays = enums.exposureDays ?? 3;
    const exposedUrls = exposureHistory ? exposedUrlSet(exposureHistory, date, exposureDays) : new Set();
    const exposedAges = exposureHistory ? exposedUrlAgeMap(exposureHistory, date, exposureDays) : new Map();

    const startedAt = Date.now();
    const { daily, featured, stats } = await processItems(replayData.items, {
      date, now: replayNow, filters, enums, sourceTypes, sourceMap,
      overridesForDate: overrides.byDate?.[date],
      globalHiddenIds: overrides.globalHiddenIds || [],
      sourcesTotal: 0, sourcesSucceeded: 0,
      exposedUrls, exposedAges
    });
    const runtimeMs = Date.now() - startedAt;

    const vd = await validateDailyV2(daily, enums);
    const vf = await validateFeatured(featured, daily, enums);
    if (!vd.valid || !vf.valid) {
      throw new Error(`${date} 回放产物校验失败：daily ${vd.errors.join('; ')} | featured ${vf.errors.join('; ')}`);
    }

    if (record) {
      // 落盘核验：文件必须真实存在、有条目、且非全错（否则报成功是假的）
      const { writeError } = _fixtureWriteStatus();
      let entries = 0, errors = 0, source = 'unknown';
      try {
        const doc = await loadFixtureEntries(fixtureFile);
        entries = Object.keys(doc.entries).length;
        errors = Object.values(doc.entries).filter(e => e.error).length;
        source = doc.source || 'unknown';
      } catch (e) {
        throw new Error(`${date} 夹具文件未落盘（${e.message}）${writeError ? `；写入错误：${writeError}` : ''}`);
      }
      if (entries === 0) {
        throw new Error(`${date} 夹具 0 条目：本日没有任何 Jev 调用被记录，请检查样本与 jevConfigured()`);
      }
      if (errors === entries) {
        throw new Error(`${date} 夹具 ${entries} 条全部失败（如 401 认证错误）：key 或网络问题，录制的全是 error 无基线价值，已中止`);
      }
      console.log(`  校验通过，夹具已写入 ${path.relative(ROOT, fixtureFile)}（${entries} 条回执，来源 ${source}，其中 ${errors} 条失败重放）`);
      manifestPerDate.push({ date, runtimeMs, fixture: path.relative(ROOT, fixtureFile), entries, errors, source });
      continue;
    }

    const outDir = path.join(OUT_DIR, date);
    await atomicWrite(path.join(outDir, 'daily.json'), daily, d => validateDailyV2(d, enums));
    await atomicWrite(path.join(outDir, 'featured.json'), featured, d => validateFeatured(d, daily, enums));

    const missed = annotationSet && annotationLabels
      ? computeMissedMerges(daily.items, annotationSet, annotationLabels)
      : { missedCount: null, groups: [], totalGroups: null };

    const perEventSources = daily.items.map(ev => ev.independentSourceCount ?? independentSourceProxy(ev));
    perDate.push({
      date,
      replayNow: replayNow.toISOString(),
      exposureState: exposureHistory ? 'from-samples-raw-snapshot' : 'empty-feature-not-present-or-not-snapshotted',
      runtimeMs,
      stats,
      eventCount: daily.items.length,
      independentSourceCountProxy: {
        note: 'B-03 起优先取正式字段 independentSourceCount（来源身份去重，含主来源）；缺失时回退 1 + distinct(relatedSources[].name)',
        max: Math.max(0, ...perEventSources),
        overTwo: perEventSources.filter(n => n > 2).length,
        distribution: perEventSources.reduce((acc, n) => { acc[n] = (acc[n] || 0) + 1; return acc; }, {}),
      },
      featured: (featured.featuredEventIds || []).map(id => ({ id, title: titleOf(daily, id) })),
      hot: (featured.hotEventIds || []).map(id => ({ id, title: titleOf(daily, id) })),
      observations: featured.observations || [],
      missedMerges: { count: missed.missedCount, totalGroups: missed.totalGroups, groups: missed.groups },
      // B-01 起并存两份合并记录：mergeDecisions=管线过程日志（judgePair 决策/人工
      // 约束/Jev 仲裁，legacy 口径为 null）；mergeMembers=产物推导版（最终成员清单，
      // 人工抽查误合素材，仅记有相关报道的事件）
      mergeDecisions: stats.mergeLog ?? null,
      mergeMembers: mergeDecisionLog(daily),
    });
    manifestPerDate.push({
      date,
      runtimeMs,
      replayNow: replayNow.toISOString(),
      fixture: path.relative(ROOT, fixtureFile),
      fixtureSha256: await sha256File(fixtureFile),
      dailySha256: sha256String(canonicalJson(daily)),
      featuredSha256: sha256String(canonicalJson(featured)),
    });
    console.log(`  事件 ${stats.events} | 精选 ${stats.featured} | 热点 ${stats.hot} | 漏合 ${missed.missedCount ?? 'n/a'} | ${runtimeMs}ms`);
  }

  if (record) {
    console.log(`\n录制完成：${dates.length} 天夹具已写入 ${path.relative(ROOT, FIXTURE_DIR)}。`);
    console.log('下一步：unset TYPESAFE_API_KEY 后运行 npm run baseline:upgrade 离线产出基线。');
    return;
  }

  // 全部日期成功才写汇总（任一日失败已在上面抛出，不会走到这里）
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'offline-replay',
    dates,
    perDate,
    notes: [
      '误合无负例标签：mergeMembers（产物推导）+ mergeDecisions（B-01 过程日志）供人工抽查，不给出计数',
      '漏合由 annotations duplicateOf 对按 URL 指纹推导，覆盖面限于已标注样本',
      '2026-07/08 基线日曝光记忆功能尚不存在，按空集回放',
    ],
  };
  const manifest = await collectVersionManifest(ROOT);
  manifest.totalRuntimeMs = Date.now() - runStart;
  manifest.runStartedAt = runStartedAt;
  manifest.perDate = manifestPerDate;

  await atomicWrite(path.join(OUT_DIR, 'report.json'), report, r =>
    Promise.resolve({ valid: Boolean(r?.perDate?.length), errors: r?.perDate?.length ? [] : ['perDate 为空'] }));
  await atomicWrite(path.join(OUT_DIR, 'manifest.json'), manifest, m =>
    Promise.resolve({ valid: Boolean(m?.codeDigest && m?.perDate?.length), errors: [] }));

  const totalMissed = perDate.reduce((n, d) => n + (d.missedMerges.count || 0), 0);
  console.log(`\n基线完成：${dates.length} 天，总漏合 ${totalMissed} 组`);
  console.log(`  报告 ${path.relative(ROOT, path.join(OUT_DIR, 'report.json'))}`);
  console.log(`  摘要 ${path.relative(ROOT, path.join(OUT_DIR, 'manifest.json'))}（codeDigest ${manifest.codeDigest.slice(0, 8)}…）`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
