/**
 * V1.1 数据协议校验单元测试（阶段 A-03）。
 * 运行: npm test
 *
 * 覆盖：daily.json V2 必填/枚举/ID/URL/时间字段、
 *       featured.json 精选 ID 存在性、overrides 引用合法性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDailyV2,
  validateFeatured,
  validateOverrides
} from '../scripts/lib/schema.mjs';

/** 构造一份合法的 daily.json V2 样例。 */
function makeValidDaily(overrides = {}) {
  return {
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
        relatedSources: [
          { name: 'Example Media', url: 'https://example.com/article/1/report' }
        ]
      },
      {
        id: 'evt_zyx987654321',
        title: '某储能项目投运',
        url: 'https://example.com/article/2',
        summary: '',
        whyItMatters: '',
        topic: 'energy-storage',
        tags: [],
        region: '中国',
        entities: [],
        metrics: [],
        impact: 'neutral',
        importance: 40,
        source: { name: 'Example Media', type: 'media', isPrimary: false },
        publishedAt: null,
        discoveredAt: '2026-08-05T04:00:00.000Z',
        relatedSources: []
      }
    ],
    ...overrides
  };
}

test('合法 daily.json V2 通过校验', async () => {
  const r = await validateDailyV2(makeValidDaily());
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
});

test('topic 不在枚举时报错', async () => {
  const daily = makeValidDaily();
  daily.items[0].topic = 'not-a-topic';
  const r = await validateDailyV2(daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('topic')));
});

test('url 非 http(s) 时报错', async () => {
  const daily = makeValidDaily();
  daily.items[0].url = 'javascript:alert(1)';
  const r = await validateDailyV2(daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('url')));
});

test('id 格式非法时报错', async () => {
  const daily = makeValidDaily();
  daily.items[0].id = '不是合法ID';
  const r = await validateDailyV2(daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('id')));
});

test('id 重复时报错', async () => {
  const daily = makeValidDaily();
  daily.items[1].id = daily.items[0].id;
  const r = await validateDailyV2(daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('重复')));
});

test('缺少 title 时报错', async () => {
  const daily = makeValidDaily();
  delete daily.items[0].title;
  const r = await validateDailyV2(daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('title')));
});

test('source.type 不在枚举时报错', async () => {
  const daily = makeValidDaily();
  daily.items[0].source.type = 'chat';
  const r = await validateDailyV2(daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('type')));
});

test('source.isPrimary 必须与 primary 类型一致', async () => {
  const daily = makeValidDaily();
  daily.items[1].source.isPrimary = true;
  const r = await validateDailyV2(daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('isPrimary')));
});

test('schemaVersion 不是 2 时报错', async () => {
  const daily = makeValidDaily({ schemaVersion: 1 });
  const r = await validateDailyV2(daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('schemaVersion')));
});

test('重复 url 给出 warning 而不算致命', async () => {
  const daily = makeValidDaily();
  daily.items[1].url = daily.items[0].url;
  const r = await validateDailyV2(daily);
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some(w => w.includes('重复')));
});

/* ===== featured.json ===== */

test('合法 featured.json 通过校验', async () => {
  const daily = makeValidDaily();
  const featured = {
    schemaVersion: 1,
    date: '2026-08-05',
    generatedAt: '2026-08-05T04:00:00.000Z',
    observations: ['数据中心新增负荷继续推动电网扩建需求。'],
    featuredEventIds: ['evt_abcdef123456', 'evt_zyx987654321']
  };
  const r = await validateFeatured(featured, daily);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('精选 ID 不存在于 daily 时报错', async () => {
  const daily = makeValidDaily();
  const featured = {
    schemaVersion: 1,
    date: '2026-08-05',
    generatedAt: '2026-08-05T04:00:00.000Z',
    observations: [],
    featuredEventIds: ['evt_nonexistent0000']
  };
  const r = await validateFeatured(featured, daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('不存在')));
});

test('精选超过 20 条给 warning 而不报错', async () => {
  // 不传 daily，跳过 ID 存在性检查，只验证数量上限是软约束
  const ids = Array.from({ length: 22 }, (_, i) => `evt_zzz00000000${String(i).padStart(2, '0')}`);
  const featured = {
    schemaVersion: 1,
    date: '2026-08-05',
    generatedAt: '2026-08-05T04:00:00.000Z',
    observations: [],
    featuredEventIds: ids
  };
  const r = await validateFeatured(featured, null);
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some(w => w.includes('超过')));
});

test('精选 20 条以内不报 warning', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `evt_zzz00000000${String(i).padStart(2, '0')}`);
  const featured = {
    schemaVersion: 1,
    date: '2026-08-05',
    generatedAt: '2026-08-05T04:00:00.000Z',
    observations: [],
    featuredEventIds: ids
  };
  const r = await validateFeatured(featured, null);
  assert.equal(r.valid, true);
  assert.ok(!r.warnings.some(w => w.includes('超过')), '20 条以内不应触发上限 warning');
});

/* ===== editorial-overrides.json ===== */

test('合法 overrides 通过校验', async () => {
  const daily = makeValidDaily();
  const overrides = {
    schemaVersion: 1,
    byDate: {
      '2026-08-05': {
        forcedFeaturedIds: ['evt_abcdef123456'],
        hiddenIds: [],
        topics: { 'evt_abcdef123456': 'aidc-project' },
        observations: ['人工观察。']
      }
    }
  };
  const r = await validateOverrides(overrides, daily);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('overrides 修改 topic 为非法值时报错', async () => {
  const daily = makeValidDaily();
  const overrides = {
    schemaVersion: 1,
    byDate: {
      '2026-08-05': {
        topics: { 'evt_abcdef123456': 'bad-topic' }
      }
    }
  };
  const r = await validateOverrides(overrides, daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('topic')));
});

test('overrides 引用不存在的 id 时报错', async () => {
  const daily = makeValidDaily();
  const overrides = {
    schemaVersion: 1,
    byDate: {
      '2026-08-05': {
        forcedFeaturedIds: ['evt_ghost0000000']
      }
    }
  };
  const r = await validateOverrides(overrides, daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('不存在')));
});

test('overrides 日期键格式非法时报错', async () => {
  const overrides = {
    schemaVersion: 1,
    byDate: {
      '2026/08/05': { hiddenIds: [] }
    }
  };
  const r = await validateOverrides(overrides, null);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('YYYY-MM-DD')));
});
