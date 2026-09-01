import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOverrideOp, scanStale, pruneOld, buildTodayPayload
} from '../../scripts/admin/lib/content-ops.mjs';

const DATE = '2026-09-01';
const emptyOverrides = () => ({ schemaVersion: 1, byDate: {} });

function mkDaily(ids) {
  return {
    schemaVersion: 2,
    date: DATE,
    items: ids.map(id => ({
      id, title: `T ${id}`, url: `https://x.com/${id}`, topic: 'grid', impact: 'unknown',
      importance: 3, region: '全球', summary: '', whyItMatters: '',
      source: { name: 'S', type: 'media' }, relatedSources: []
    }))
  };
}
const mkFeatured = (featuredIds, hotIds) => ({ observations: [], featuredEventIds: featuredIds, hotEventIds: hotIds || [] });
const mkEnums = () => ({
  topics: [{ id: 'grid', label: '电网' }, { id: 'energy-storage', label: '储能' }],
  impacts: [{ id: 'positive', label: '利好' }, { id: 'watch', label: '待观察' }]
});

test('applyOverrideOp：forceFeature 写入并去重，再点一次取消', () => {
  let r = applyOverrideOp(emptyOverrides(), [], DATE, { op: 'forceFeature', id: 'evt_a' });
  assert.deepEqual(r.config.byDate[DATE].forcedFeaturedIds, ['evt_a']);
  r = applyOverrideOp(r.config, r.globalIds, DATE, { op: 'forceFeature', id: 'evt_a' });
  assert.equal(r.config.byDate[DATE], undefined); // 取消后配置空，日期键回收
});

test('applyOverrideOp：forceFeature 与 unfeature 互斥清理', () => {
  let r = applyOverrideOp(emptyOverrides(), [], DATE, { op: 'unfeature', id: 'evt_a' });
  r = applyOverrideOp(r.config, r.globalIds, DATE, { op: 'forceFeature', id: 'evt_a' });
  assert.deepEqual(r.config.byDate[DATE].forcedFeaturedIds, ['evt_a']);
  assert.equal(r.config.byDate[DATE].unfeaturedIds, undefined);
});

test('applyOverrideOp：hide 进全局黑名单并清理今日引用', () => {
  const o = emptyOverrides();
  o.byDate[DATE] = {
    forcedFeaturedIds: ['evt_a'], topics: { evt_a: 'grid' },
    mergeGroups: [['evt_a', 'evt_b']]
  };
  const r = applyOverrideOp(o, [], DATE, { op: 'hide', id: 'evt_a' });
  assert.deepEqual(r.globalIds, ['evt_a']);
  // 全局黑名单必须写回顶层配置，否则落盘时丢失
  assert.deepEqual(r.config.globalHiddenIds, ['evt_a']);
  // forced/toppic/mergeGroups 引用全被清掉 → 今日配置为空 → 日期键整个回收
  assert.equal(r.config.byDate[DATE], undefined);
});

test('applyOverrideOp：unhide 从全局黑名单移除并写回', () => {
  let r = applyOverrideOp(emptyOverrides(), ['evt_a', 'evt_b'], DATE, { op: 'unhide', id: 'evt_a' });
  assert.deepEqual(r.globalIds, ['evt_b']);
  assert.deepEqual(r.config.globalHiddenIds, ['evt_b']);
  // 最后一个也移除 → 字段整个消失
  r = applyOverrideOp(r.config, r.globalIds, DATE, { op: 'unhide', id: 'evt_b' });
  assert.equal(r.config.globalHiddenIds, undefined);
});

test('applyOverrideOp：setTopic/setSummary 值 null 删键，空对象回收', () => {
  let r = applyOverrideOp(emptyOverrides(), [], DATE, { op: 'setTopic', id: 'evt_a', value: 'energy-storage' });
  assert.equal(r.config.byDate[DATE].topics.evt_a, 'energy-storage');
  r = applyOverrideOp(r.config, r.globalIds, DATE, { op: 'setTopic', id: 'evt_a', value: null });
  assert.equal(r.config.byDate[DATE], undefined);
});

test('applyOverrideOp：setObservations 截断 5 条，setHotList 去重', () => {
  let r = applyOverrideOp(emptyOverrides(), [], DATE, {
    op: 'setObservations', value: ['1', '2', '3', '4', '5', '6']
  });
  assert.equal(r.config.byDate[DATE].observations.length, 5);
  r = applyOverrideOp(r.config, r.globalIds, DATE, { op: 'setHotList', value: ['evt_a', 'evt_a', 'evt_b'] });
  assert.deepEqual(r.config.byDate[DATE].hotEventIds, ['evt_a', 'evt_b']);
});

test('applyOverrideOp：mergeGroup 增删，重复组不重复添加', () => {
  let r = applyOverrideOp(emptyOverrides(), [], DATE, { op: 'addMergeGroup', value: ['evt_b', 'evt_a'] });
  assert.deepEqual(r.config.byDate[DATE].mergeGroups, [['evt_b', 'evt_a']]);
  r = applyOverrideOp(r.config, r.globalIds, DATE, { op: 'addMergeGroup', value: ['evt_a', 'evt_b'] });
  assert.equal(r.config.byDate[DATE].mergeGroups.length, 1);
  r = applyOverrideOp(r.config, r.globalIds, DATE, { op: 'removeMergeGroup', index: 0 });
  assert.equal(r.config.byDate[DATE], undefined);
});

test('applyOverrideOp：不修改入参', () => {
  const o = emptyOverrides();
  applyOverrideOp(o, [], DATE, { op: 'forceFeature', id: 'evt_a' });
  assert.deepEqual(o, { schemaVersion: 1, byDate: {} });
});

test('applyOverrideOp：未知操作抛错', () => {
  assert.throws(() => applyOverrideOp(emptyOverrides(), [], DATE, { op: 'bogus' }));
});

/* ===== scanStale ===== */

test('scanStale：列出全部缺失引用并标注是否阻断', () => {
  const daily = mkDaily(['evt_live']);
  const o = {
    schemaVersion: 1,
    globalHiddenIds: ['evt_gone1'],
    byDate: {
      [DATE]: {
        forcedFeaturedIds: ['evt_gone2'],      // 阻断
        unfeaturedIds: ['evt_gone3'],          // 非阻断
        hiddenIds: ['evt_gone4'],              // 非阻断
        summaries: { evt_gone5: 'x' },         // 阻断
        mergeGroups: [['evt_live', 'evt_gone6']] // 非阻断
      }
    }
  };
  const stale = scanStale(o, daily);
  const byId = Object.fromEntries(stale.map(s => [s.id, s]));
  assert.equal(byId.evt_gone1.blocking, false);
  assert.equal(byId.evt_gone2.blocking, true);
  assert.equal(byId.evt_gone3.blocking, false);
  assert.equal(byId.evt_gone4.blocking, false);
  assert.equal(byId.evt_gone5.blocking, true);
  assert.equal(byId.evt_gone6.blocking, false);
  assert.equal(stale.length, 6);
});

test('scanStale：空/无缺失返回空数组', () => {
  assert.deepEqual(scanStale(null, mkDaily(['evt_a'])), []);
  assert.deepEqual(scanStale({ schemaVersion: 1, byDate: { [DATE]: { forcedFeaturedIds: ['evt_a'] } } }, mkDaily(['evt_a'])), []);
});

/* ===== pruneOld ===== */

test('pruneOld：只清理超过保留期的日期，全局黑名单不动', () => {
  const o = {
    schemaVersion: 1,
    globalHiddenIds: ['evt_x'],
    byDate: {
      '2026-08-20': { forcedFeaturedIds: ['evt_a'] },
      '2026-08-29': { forcedFeaturedIds: ['evt_b'] },
      [DATE]: { forcedFeaturedIds: ['evt_c'] }
    }
  };
  const { config, pruned } = pruneOld(o, DATE, 3);
  assert.deepEqual(pruned, ['2026-08-20']);
  assert.deepEqual(config.globalHiddenIds, ['evt_x']);
  assert.ok(config.byDate['2026-08-29']);
  assert.ok(config.byDate[DATE]);
});

/* ===== buildTodayPayload ===== */

test('buildTodayPayload：投影、徽章与覆盖标记', () => {
  const daily = mkDaily(['evt_a', 'evt_b', 'evt_c']);
  const featured = mkFeatured(['evt_a'], ['evt_b']);
  const overrides = {
    schemaVersion: 1,
    globalHiddenIds: ['evt_c'],
    byDate: { [DATE]: { topics: { evt_a: 'energy-storage' } } }
  };
  const p = buildTodayPayload(daily, featured, overrides, mkEnums());
  const byId = Object.fromEntries(p.items.map(i => [i.id, i]));
  assert.equal(p.date, DATE);
  assert.equal(p.items.length, 3);
  assert.equal(byId.evt_a.isFeatured, true);
  assert.equal(byId.evt_a.hasOverride, true);
  assert.equal(byId.evt_b.isHot, true);
  assert.equal(byId.evt_b.isFeatured, false);
  assert.equal(byId.evt_c.hiddenGlobal, true);   // 全局隐藏（构建未生效时仍可见）
  assert.deepEqual(p.topics.map(t => t.id), ['grid', 'energy-storage']);
  assert.deepEqual(p.impacts.map(i => i.id), ['positive', 'watch']);
  assert.deepEqual(p.globalIds, ['evt_c']);
});
