import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importance, capPerSource } from '../scripts/lib/score.mjs';

const NOW = '2026-08-05T12:00:00Z';

function item(over = {}) {
  return {
    sourceType: 'media', metrics: [], entities: [], summary: '', publishedAt: null,
    source: 'X', ...over
  };
}

test('importance：一手+数字+实体+摘要 > 社区裸条目', () => {
  const rich = importance(item({ sourceType: 'primary', metrics: [1], entities: ['E'], summary: 's', publishedAt: '2026-08-05T00:00:00Z' }), { now: NOW });
  const poor = importance(item({ sourceType: 'community' }), { now: NOW });
  assert.ok(rich > poor, `${rich} > ${poor}`);
});

test('importance：24h 内比 72h 高', () => {
  const fresh = importance(item({ publishedAt: '2026-08-05T10:00:00Z' }), { now: NOW });
  const old = importance(item({ publishedAt: '2026-08-02T10:00:00Z' }), { now: NOW });
  assert.ok(fresh > old, `${fresh} > ${old}`);
});

test('importance：类型分排序', () => {
  const p = importance(item({ sourceType: 'primary' }), { now: NOW });
  const r = importance(item({ sourceType: 'research' }), { now: NOW });
  const m = importance(item({ sourceType: 'media' }), { now: NOW });
  const c = importance(item({ sourceType: 'community' }), { now: NOW });
  assert.ok(p > r && r > m && m > c, `${p}/${r}/${m}/${c}`);
});

test('importance：确定性', () => {
  const a = importance(item({ sourceType: 'primary', metrics: [1] }), { now: NOW });
  const b = importance(item({ sourceType: 'primary', metrics: [1] }), { now: NOW });
  assert.equal(a, b);
});

test('capPerSource：每来源限量', () => {
  const items = [
    item({ source: 'A', title: 'a1' }),
    item({ source: 'A', title: 'a2' }),
    item({ source: 'A', title: 'a3' }),
    item({ source: 'A', title: 'a4' }),
    item({ source: 'A', title: 'a5' }),
    item({ source: 'A', title: 'a6' }),
    item({ source: 'B', title: 'b1' })
  ];
  const out = capPerSource(items, { max: 3 });
  assert.equal(out.filter(i => i.source === 'A').length, 3);
  assert.equal(out.filter(i => i.source === 'B').length, 1);
  assert.equal(out.length, 4);
});

test('capPerSource：不修改原数组', () => {
  const items = [item({ source: 'A', title: 'a1' }), item({ source: 'A', title: 'a2' })];
  const out = capPerSource(items, { max: 1 });
  assert.equal(items.length, 2);
  assert.equal(out.length, 1);
});
