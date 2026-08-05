import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnums, validateDailyV2, validateFeatured } from '../scripts/lib/schema.mjs';
import { loadFilters } from '../scripts/lib/filter.mjs';
import { loadSourceTypes, loadSourceMap } from '../scripts/lib/source.mjs';
import { processItems, selectFeatured, atomicWrite } from '../scripts/build-daily-v2.mjs';

const enums = await loadEnums();
const filters = await loadFilters();
const sourceTypes = await loadSourceTypes();
const { byName: sourceMap } = await loadSourceMap();
const NOW = new Date('2026-08-05T04:00:00Z');

function raw(over = {}) {
  return {
    title: '', link: '', guid: null, pubDate: '2026-08-05T01:00:00Z',
    summary: '', source: 'pv magazine', translatedTitle: null, ...over
  };
}

test('selectFeatured：门槛与多样性', () => {
  const mk = (id, importance, topic, source) => ({ id, importance, topic, source: { name: source } });
  const events = [
    mk('evt_a', 4, 'grid', 'S1'),
    mk('evt_b', 3.5, 'grid', 'S2'),
    mk('evt_c', 3.5, 'solar-wind', 'S3'),
    mk('evt_d', 2.5, 'grid', 'S4') // 低于门槛
  ];
  const { featuredEventIds } = selectFeatured(events, enums);
  assert.ok(!featuredEventIds.includes('evt_d'), '低门槛事件不入精选');
  assert.ok(featuredEventIds.includes('evt_a') && featuredEventIds.includes('evt_c'));
});

test('selectFeatured：同主题最多 2 条', () => {
  const mk = (id, importance, topic) => ({ id, importance, topic, source: { name: 'S' + id } });
  const events = [
    mk('evt_a', 4, 'grid', 'S1'), mk('evt_b', 4, 'grid', 'S2'), mk('evt_c', 4, 'grid', 'S3'),
    mk('evt_d', 4, 'solar-wind', 'S4')
  ];
  const { featuredEventIds } = selectFeatured(events, enums);
  assert.equal(featuredEventIds.filter(id => events.find(e => e.id === id).topic === 'grid').length, 2);
});

test('processItems：产出合法 daily + featured', async () => {
  const items = [
    raw({ title: '1GWh BESS 储能电站并网投运', link: 'https://a.com/1', summary: '某地 1GWh 电池储能并网', source: 'Energy Storage News' }),
    raw({ title: 'GPU 数据中心液冷系统发布', link: 'https://a.com/2', summary: 'AI 数据中心液冷 PUE 0.9', source: 'Data Center Dynamics' }),
    raw({ title: '某地 1GWh BESS 储能电站并网投运（重复标题）', link: 'https://a.com/3', summary: '重复报道', source: 'Electrek' }),
    raw({ title: '最新手机评测：折叠屏体验', link: 'https://a.com/4', summary: '消费电子评测', source: 'Electrek' })
  ];
  const { daily, featured, stats } = await processItems(items, {
    date: '2026-08-05', now: NOW, filters, enums, sourceTypes, sourceMap, overridesForDate: null
  });
  assert.equal(stats.filteredOut, 1, '手机评测被过滤');
  const v1 = await validateDailyV2(daily, enums);
  assert.equal(v1.valid, true, v1.errors.join('; '));
  const vf = await validateFeatured(featured, daily, enums);
  assert.equal(vf.valid, true, vf.errors.join('; '));
  assert.ok(daily.items.every(e => /^evt_[a-z0-9]{8,}$/.test(e.id)), '事件 ID 格式');
  assert.ok(daily.items.every(e => e.topic && enums.topicIds.has(e.topic)), '主题枚举合法');
});

test('processItems：确定性（同输入两次结果一致）', async () => {
  const items = [raw({ title: 'solar PPA signed', link: 'https://a.com/1', summary: 'renewable energy procurement deal' })];
  const ctx = { date: '2026-08-05', now: NOW, filters, enums, sourceTypes, sourceMap, overridesForDate: null };
  const r1 = await processItems(items, ctx);
  const r2 = await processItems(items, ctx);
  assert.deepEqual(r1.daily.items.map(e => e.id), r2.daily.items.map(e => e.id));
  assert.deepEqual(r1.daily.items[0], r2.daily.items[0]);
});

test('atomicWrite：校验失败不覆盖现有文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eih-'));
  const file = path.join(dir, 'x.json');
  await fs.writeFile(file, '{"old":true}');
  const bad = { schemaVersion: 2, items: 123 }; // 非法
  await assert.rejects(() => atomicWrite(file, bad, (d) => validateDailyV2(d, enums)));
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after, { old: true }, '失败时旧文件保持不变');
  // 清理
  await fs.rm(dir, { recursive: true, force: true });
});

test('atomicWrite：校验通过则原子替换', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eih-'));
  const file = path.join(dir, 'x.json');
  await fs.writeFile(file, '{"old":true}');
  const good = {
    schemaVersion: 2, date: '2026-08-05', generatedAt: '2026-08-05T04:00:00Z', status: 'ok',
    stats: { sourcesTotal: 0, sourcesSucceeded: 0, articlesFetched: 0, eventsPublished: 0 },
    items: []
  };
  await atomicWrite(file, good, (d) => validateDailyV2(d, enums));
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after, good);
  await fs.rm(dir, { recursive: true, force: true });
});
