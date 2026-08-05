/**
 * 前端兼容层单元测试（阶段 A-04）。
 * 运行: npm test
 *
 * 验证 V1 旧数据与 V2 新数据都能 normalize 为统一渲染结构，
 * 且 V1 派生 ID 稳定（相同输入重复执行结构一致）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeDaily,
  detectVersion,
  canonicalUrl,
  hashId,
  cleanSummary
} from '../scripts/lib/compat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 真实 V1 样本
const v1Sample = JSON.parse(
  await fs.readFile(path.resolve(__dirname, '../samples/daily/2026-08-05.json'), 'utf8')
);

// 构造 V2 样例
const v2Sample = {
  schemaVersion: 2,
  date: '2026-08-05',
  generatedAt: '2026-08-05T04:00:00.000Z',
  status: 'ok',
  stats: { sourcesTotal: 34, sourcesSucceeded: 30, articlesFetched: 86, eventsPublished: 2 },
  items: [
    {
      id: 'evt_abcdef123456',
      title: '某电网宣布新增 1 GW 并网容量',
      originalTitle: 'Some Grid Announces 1 GW Interconnection',
      url: 'https://example.com/article/1',
      summary: '该电网计划新增 1 GW 并网容量。',
      whyItMatters: '将影响当地并网规划。',
      topic: 'grid',
      tags: ['并网'],
      region: '美国',
      entities: ['Example Grid'],
      metrics: [{ label: '规划负荷', value: '1', unit: 'GW' }],
      impact: 'watch',
      importance: 78,
      source: { name: 'Example Grid', type: 'primary', isPrimary: true },
      publishedAt: '2026-08-05T01:00:00.000Z',
      discoveredAt: '2026-08-05T04:00:00.000Z',
      relatedSources: [{ name: 'Example Media', url: 'https://example.com/article/1/report' }]
    }
  ]
};

test('detectVersion 正确识别 V1/V2', () => {
  assert.equal(detectVersion(v1Sample), 'v1');
  assert.equal(detectVersion(v2Sample), 'v2');
});

test('V1 样本可 normalize 且保留展示必需字段（AC-11）', () => {
  const r = normalizeDaily(v1Sample);
  assert.equal(r.version, 'v1');
  assert.equal(r.date, v1Sample.date);
  assert.ok(r.items.length > 0);
  const it = r.items[0];
  assert.equal(typeof it.title, 'string');
  assert.ok(it.title.length > 0);
  assert.equal(typeof it.url, 'string');
  assert.equal(typeof it.sourceName, 'string');
  assert.equal(typeof it.summary, 'string');
  assert.equal(it.legacy, true);
});

test('V1 派生 ID 稳定且唯一', () => {
  const a = normalizeDaily(v1Sample);
  const b = normalizeDaily(v1Sample);
  assert.deepEqual(a.items.map(x => x.id), b.items.map(x => x.id));
  const ids = new Set(a.items.map(x => x.id));
  assert.equal(ids.size, a.items.length, 'id 应唯一');
  assert.ok(a.items[0].id.startsWith('legacy_'));
});

test('V2 样本 normalize 保留结构化字段', () => {
  const r = normalizeDaily(v2Sample);
  assert.equal(r.version, 'v2');
  assert.equal(r.items[0].id, 'evt_abcdef123456');
  assert.equal(r.items[0].topic, 'grid');
  assert.equal(r.items[0].sourceType, 'primary');
  assert.equal(r.items[0].isPrimary, true);
  assert.equal(r.items[0].relatedCount, 1);
  assert.equal(r.items[0].legacy, false);
});

test('V2 缺失可选字段时安全降级，不出现 undefined', () => {
  const v2Min = {
    schemaVersion: 2,
    date: '2026-08-05',
    generatedAt: '2026-08-05T04:00:00.000Z',
    status: 'ok',
    stats: {},
    items: [{ id: 'evt_abc1234567', title: '只有标题', url: 'https://e.com/a' }]
  };
  const r = normalizeDaily(v2Min);
  const it = r.items[0];
  assert.equal(it.sourceName, '');
  assert.equal(it.topic, '');
  assert.equal(it.summary, '');
  assert.equal(it.impact, 'unknown');
  assert.equal(it.relatedCount, 0);
  // 序列化后不应出现 undefined
  assert.ok(!JSON.stringify(it).includes('undefined'));
});

test('空 daily / 无 items 时返回空渲染结构', () => {
  const r = normalizeDaily(null);
  assert.deepEqual(r.items, []);
  assert.equal(r.version, 'v1');
  const r2 = normalizeDaily({ schemaVersion: 2, items: [] });
  assert.deepEqual(r2.items, []);
});

test('cleanSummary 去 HTML 并截断', () => {
  const out = cleanSummary('<p>Hello <b>world</b></p>   with    spaces', 20);
  assert.equal(out, 'Hello world with spa');
});

test('canonicalUrl 去 fragment/query 并统一协议', () => {
  assert.equal(
    canonicalUrl('http://Example.com/a?x=1#top'),
    'https://example.com/a'
  );
  assert.equal(canonicalUrl('bad url'), 'bad url');
});

test('hashId 确定性', () => {
  assert.equal(hashId('abc'), hashId('abc'));
  assert.notEqual(hashId('abc'), hashId('abd'));
});
