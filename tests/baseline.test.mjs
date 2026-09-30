import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMissedMerges, independentSourceProxy, mergeDecisionLog } from '../scripts/build-quality-baseline.mjs';
import { writeRawSnapshot } from '../scripts/build-daily-v2.mjs';
import { expiredDates } from '../scripts/prune-raw-snapshots.mjs';
import { loadEnums, validateDailyV2, validateFeatured } from '../scripts/lib/schema.mjs';
import { loadFilters } from '../scripts/lib/filter.mjs';
import { loadSourceTypes, loadSourceMap } from '../scripts/lib/source.mjs';
import { loadOverrides } from '../scripts/lib/overrides.mjs';
import { loadReplayItems, resolveReplayNow, processItems } from '../scripts/build-daily-v2.mjs';
import { canonicalJson } from '../scripts/lib/digest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 漏合推导（computeMissedMerges 纯函数）----

const EV_A1 = { id: 'evt_aaaa', url: 'https://x.com/a1', relatedSources: [] };
const EV_A2 = { id: 'evt_bbbb', url: 'https://x.com/a2', relatedSources: [] };
const EV_C = { id: 'evt_cccc', url: 'https://x.com/c', relatedSources: [] };

const SET = [
  { id: 's1', url: 'https://x.com/a1' },
  { id: 's2', url: 'https://x.com/a2' },
  { id: 's3', url: 'https://x.com/a1?utm=tracker' }, // canonical 后与 s1 同 URL
  { id: 's4', url: 'https://x.com/c' },
];

test('computeMissedMerges: duplicateOf 同组落不同事件 = 漏合；query 差异 canonical 命中同一事件', () => {
  // s1↔s2 同组但分别落在 evt_aaaa/evt_bbbb → 漏合；s3 与 s1 同事件（canonical）
  const labels = {
    s1: { duplicateOf: 's2' },
    s2: { duplicateOf: null },
    s3: { duplicateOf: 's1' }, // 连通分量 {s1,s2,s3}
    s4: { duplicateOf: null },
  };
  const r = computeMissedMerges([EV_A1, EV_A2, EV_C], SET, labels);
  assert.equal(r.totalGroups, 1, '只有一组 duplicateOf 连通分量');
  assert.equal(r.missedCount, 1);
  assert.equal(r.groups[0].eventIds.length, 2);
  assert.ok(r.groups[0].placements.some(p => p.id === 's3' && p.eventId === 'evt_aaaa'), 'utm query 被 canonical 归一');
});

test('computeMissedMerges: 同组全落同一事件不算漏合；指向不存在样本的 duplicateOf 跳过', () => {
  const labels = {
    s1: { duplicateOf: 's3' }, // s1/s3 同事件 evt_aaaa → 不漏
    s2: { duplicateOf: 'ghost' }, // ghost 不在 set：跳过不炸
  };
  const r = computeMissedMerges([EV_A1, EV_A2, EV_C], SET, labels);
  assert.equal(r.missedCount, 0);
});

test('independentSourceProxy: 主来源 1 + distinct 关联来源名（同媒体多篇只计 1）', () => {
  assert.equal(independentSourceProxy({ relatedSources: [] }), 1);
  assert.equal(independentSourceProxy({
    url: 'u', relatedSources: [
      { name: '媒体A', url: '1' }, { name: '媒体A', url: '2' }, { name: '媒体B', url: '3' },
    ],
  }), 3, '媒体A 两篇只算一家 + 媒体B + 主来源');
});

test('mergeDecisionLog: 只记有相关报道的事件，成员含主来源', () => {
  const daily = { items: [
    { id: 'e1', title: '单独事件', url: 'u1', source: { name: 'S1' }, relatedSources: [] },
    { id: 'e2', title: '多源事件', url: 'u2', source: { name: 'S2' }, relatedSources: [{ name: 'S3', url: 'u3' }] },
  ] };
  const log = mergeDecisionLog(daily);
  assert.equal(log.length, 1);
  assert.equal(log[0].eventId, 'e2');
  assert.deepEqual(log[0].members.map(m => m.source), ['S2', 'S3']);
});

// ---- 原始快照与滚动清理 ----

test('writeRawSnapshot: 三个 json.gz 可读回且内容一致', async () => {
  const os = await import('node:os');
  const zlib = await import('node:zlib');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rawsnap-'));
  const rawItems = [{ title: 't', link: 'https://x/1', source: 'S' }];
  await writeRawSnapshot(dir, { date: '2026-09-30', rawItems, exposureHistory: { exposed: { 'https://x/1': '2026-09-29' } }, wechatSeeds: { articles: [] } });
  const names = await fs.readdir(path.join(dir, '2026-09-30'));
  assert.deepEqual(names.sort(), ['exposure-history.json.gz', 'items.json.gz', 'wechat-seeds.json.gz']);
  const items = JSON.parse(zlib.gunzipSync(await fs.readFile(path.join(dir, '2026-09-30', 'items.json.gz'))).toString());
  assert.deepEqual(items, rawItems);
});

test('expiredDates: 保留窗口外的日期目录名、非法名忽略', () => {
  const names = ['2026-09-01', '2026-09-29', '2026-09-30', 'not-a-date', '.gitkeep'];
  assert.deepEqual(expiredDates(names, 29, '2026-09-30'), ['2026-09-01'], '差 29 天 ≥ keep=29 即过期');
  assert.deepEqual(expiredDates(names, 30, '2026-09-30'), [], '差 29 天 < keep=30 未过期');
  assert.deepEqual(expiredDates(names, 1, '2026-09-30'), ['2026-09-01', '2026-09-29'], 'keep=1：昨天也过期');
});

// ---- 端到端：单日回放确定性（阶段 A 验收核心）----

test('端到端: 最小样本日双跑 deep-equal（固定 replayNow 下管线确定性）', async () => {
  const date = '2026-08-02';
  const [enums, filters, sourceTypes, sourceMapData, overrides] = await Promise.all([
    loadEnums(), loadFilters(), loadSourceTypes(), loadSourceMap(), loadOverrides()
  ]);
  const sourceMap = sourceMapData.byName;
  const replayData = await loadReplayItems(date);
  const replayNow = resolveReplayNow(date, replayData.generatedAt);

  const run = async () => processItems(replayData.items, {
    date, now: replayNow, filters, enums, sourceTypes, sourceMap,
    overridesForDate: overrides.byDate?.[date],
    globalHiddenIds: overrides.globalHiddenIds || [],
    sourcesTotal: 0, sourcesSucceeded: 0,
  });
  const r1 = await run();
  const r2 = await run();
  assert.equal(canonicalJson(r1), canonicalJson(r2), '同一输入双跑 canonical 序列化一致');

  const vd = await validateDailyV2(r1.daily, enums);
  const vf = await validateFeatured(r1.featured, r1.daily, enums);
  assert.equal(vd.valid, true, `daily 校验: ${vd.errors.join('; ')}`);
  assert.equal(vf.valid, true, `featured 校验: ${vf.errors.join('; ')}`);
});
