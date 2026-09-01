import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverrides } from '../scripts/lib/overrides.mjs';
import { loadEnums, validateOverrides } from '../scripts/lib/schema.mjs';

const enums = await loadEnums();

function mkDaily(ids) {
  return {
    schemaVersion: 2,
    items: ids.map(id => ({
      id,
      title: `T ${id}`, url: `https://x.com/${id}`, topic: 'grid',
      source: { name: 'S', type: 'media', isPrimary: true },
      relatedSources: []
    }))
  };
}
const featured = (ids) => ({ observations: [], featuredEventIds: [...ids] });

test('overrides：隐藏事件', () => {
  const daily = mkDaily(['evt_a', 'evt_b']);
  const { errors } = applyOverrides(daily, featured(['evt_a']), { hiddenIds: ['evt_b'] }, enums);
  assert.deepEqual(daily.items.map(e => e.id), ['evt_a']);
  assert.equal(errors.length, 0);
});

test('overrides：强制精选', () => {
  const daily = mkDaily(['evt_a', 'evt_b']);
  const f = featured([]);
  applyOverrides(daily, f, { forcedFeaturedIds: ['evt_b'] }, enums);
  assert.deepEqual(f.featuredEventIds, ['evt_b']);
});

test('overrides：取消精选', () => {
  const daily = mkDaily(['evt_a']);
  const f = featured(['evt_a']);
  applyOverrides(daily, f, { unfeaturedIds: ['evt_a'] }, enums);
  assert.deepEqual(f.featuredEventIds, []);
});

test('overrides：修正主题与影响方向', () => {
  const daily = mkDaily(['evt_a']);
  applyOverrides(daily, featured([]), { topics: { evt_a: 'energy-storage' }, impacts: { evt_a: 'watch' } }, enums);
  assert.equal(daily.items[0].topic, 'energy-storage');
  assert.equal(daily.items[0].impact, 'watch');
});

test('overrides：非法枚举记录错误不破坏', () => {
  const daily = mkDaily(['evt_a']);
  const { errors } = applyOverrides(daily, featured([]), { topics: { evt_a: 'bogus-topic' } }, enums);
  assert.equal(errors.length, 1);
  assert.equal(daily.items[0].topic, 'grid'); // 未被破坏
});

test('overrides：引用不存在的 id 报错', () => {
  const daily = mkDaily(['evt_a']);
  const { errors } = applyOverrides(daily, featured([]), { hiddenIds: ['evt_zzz'] }, enums);
  assert.equal(errors.length, 1);
});

test('overrides：覆盖今日观察', () => {
  const daily = mkDaily(['evt_a']);
  const f = featured([]);
  applyOverrides(daily, f, { observations: ['观察一', '观察二'] }, enums);
  assert.deepEqual(f.observations, ['观察一', '观察二']);
});

test('overrides：合并事件', () => {
  const daily = mkDaily(['evt_a', 'evt_b', 'evt_c']);
  const f = featured(['evt_a', 'evt_b']);
  applyOverrides(daily, f, { mergeGroups: [['evt_a', 'evt_b']] }, enums);
  assert.deepEqual(daily.items.map(e => e.id), ['evt_a', 'evt_c']);
  assert.equal(daily.items[0].relatedSources.length, 1);
  assert.deepEqual(f.featuredEventIds, ['evt_a']); // 被合并的从精选移除
});

test('overrides：空配置无副作用', () => {
  const daily = mkDaily(['evt_a']);
  const f = featured(['evt_a']);
  const { errors, warnings } = applyOverrides(daily, f, {}, enums);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
});

test('overrides：全局黑名单删除事件且幂等', () => {
  const daily = mkDaily(['evt_a', 'evt_b']);
  const f = featured(['evt_b']);
  f.hotEventIds = ['evt_b'];
  applyOverrides(daily, f, {}, enums, ['evt_b']);
  assert.deepEqual(daily.items.map(e => e.id), ['evt_a']);
  assert.deepEqual(f.featuredEventIds, []);
  assert.deepEqual(f.hotEventIds, []);
  // 再跑一次（已应用）不报错、无变化
  const { errors } = applyOverrides(daily, f, {}, enums, ['evt_b']);
  assert.equal(errors.length, 0);
  assert.deepEqual(daily.items.map(e => e.id), ['evt_a']);
});

test('overrides：全局黑名单含过期 id 静默跳过', () => {
  const daily = mkDaily(['evt_a']);
  const { errors } = applyOverrides(daily, featured([]), {}, enums, ['evt_gone', 'evt_a']);
  assert.equal(errors.length, 0);
  assert.deepEqual(daily.items.map(e => e.id), []); // evt_gone 跳过，evt_a 删除
});

/* ===== validateOverrides 判级 ===== */

const mkOverrides = (byDate, extra = {}) => ({ schemaVersion: 1, byDate, ...extra });

test('validateOverrides：hiddenIds 引用已应用 id → 降级 warning 不阻断', async () => {
  const daily = mkDaily(['evt_a']); // evt_b 已被隐藏移除
  const r = await validateOverrides(mkOverrides({ '2026-09-01': { hiddenIds: ['evt_b'] } }), daily);
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some(w => w.includes('evt_b')));
  assert.equal(r.errors.length, 0);
});

test('validateOverrides：forcedFeaturedIds 引用缺失仍是致命错误', async () => {
  const daily = mkDaily(['evt_a']);
  const r = await validateOverrides(mkOverrides({ '2026-09-01': { forcedFeaturedIds: ['evt_zzz'] } }), daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('evt_zzz')));
});

test('validateOverrides：mergeGroups 成员缺失降级 warning，结构非法仍 error', async () => {
  const daily = mkDaily(['evt_a']);
  const ok = await validateOverrides(mkOverrides({ '2026-09-01': { mergeGroups: [['evt_a', 'evt_gone']] } }), daily);
  assert.equal(ok.valid, true);
  assert.ok(ok.warnings.some(w => w.includes('evt_gone')));
  const bad = await validateOverrides(mkOverrides({ '2026-09-01': { mergeGroups: [['evt_a']] } }), daily);
  assert.equal(bad.valid, false);
});

test('validateOverrides：globalHiddenIds 顶层校验，缺失 id 仅 warning', async () => {
  const daily = mkDaily(['evt_a']);
  const r = await validateOverrides(mkOverrides({}, { globalHiddenIds: ['evt_a', 'evt_expired'] }), daily);
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some(w => w.includes('evt_expired')));
  assert.equal(r.errors.length, 0);
  const bad = await validateOverrides(mkOverrides({}, { globalHiddenIds: 'not-array' }), daily);
  assert.equal(bad.valid, false);
});
