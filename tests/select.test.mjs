import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeness, primaryRank, compareVectors, pickPrimary, selectPrimaries } from '../scripts/lib/select.mjs';

function item(over = {}) {
  return {
    title: 'T', summary: '', whyItMatters: '', metrics: [], entities: [], region: '未知',
    publishedAt: null, sourceType: 'media', ...over
  };
}

test('completeness：字段齐全度高', () => {
  const full = item({ summary: 's', metrics: [{ v: 1 }], entities: ['X'], region: '中国' });
  const bare = item({});
  assert.ok(completeness(full) > completeness(bare));
});

test('primaryRank：一手来源优先', () => {
  const a = item({ sourceType: 'primary' });
  const b = item({ sourceType: 'media' });
  assert.ok(compareVectors(primaryRank(a), primaryRank(b)) > 0);
});

test('primaryRank：信息更完整优先（同来源类型）', () => {
  const a = item({ sourceType: 'media', summary: 's', metrics: [1] });
  const b = item({ sourceType: 'media' });
  assert.ok(compareVectors(primaryRank(a), primaryRank(b)) > 0);
});

test('primaryRank：发布时间更早优先', () => {
  const a = item({ sourceType: 'media', publishedAt: '2026-08-05T00:00:00Z' });
  const b = item({ sourceType: 'media', publishedAt: '2026-08-06T00:00:00Z' });
  assert.ok(compareVectors(primaryRank(a), primaryRank(b)) > 0);
});

test('pickPrimary：一手来源胜出', () => {
  const items = [
    item({ sourceType: 'media', summary: 'very complete summary here' }),
    item({ sourceType: 'primary', publishedAt: '2026-08-06T00:00:00Z' })
  ];
  const { index } = pickPrimary(items);
  assert.equal(index, 1);
});

test('pickPrimary：时间更早胜出（同来源类型）', () => {
  const items = [
    item({ sourceType: 'media', publishedAt: '2026-08-05T00:00:00Z' }),
    item({ sourceType: 'media', publishedAt: '2026-08-06T00:00:00Z' })
  ];
  const { index } = pickPrimary(items);
  assert.equal(index, 0);
});

test('selectPrimaries：逐簇选主，确定性', () => {
  const items = [
    item({ sourceType: 'media', publishedAt: '2026-08-05T00:00:00Z' }),
    item({ sourceType: 'primary', publishedAt: '2026-08-06T00:00:00Z' }),
    item({ sourceType: 'media', publishedAt: '2026-08-05T00:00:00Z' })
  ];
  const groups = [[0, 1], [2]];
  const r1 = selectPrimaries(items, groups);
  const r2 = selectPrimaries(items, groups);
  assert.equal(r1[0].primaryIndex, 1);
  assert.equal(r1[1].primaryIndex, 2);
  assert.deepEqual(r1.map(g => g.primaryIndex), r2.map(g => g.primaryIndex));
});
