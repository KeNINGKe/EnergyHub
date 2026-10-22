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
  validateOverrides,
  validateEditorialPolicy
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

test('精选超过 12 条给 warning 而不报错', async () => {
  // 不传 daily，跳过 ID 存在性检查，只验证数量上限是软约束
  const ids = Array.from({ length: 14 }, (_, i) => `evt_zzz00000000${String(i).padStart(2, '0')}`);
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

test('精选 12 条以内不报 warning', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `evt_zzz00000000${String(i).padStart(2, '0')}`);
  const featured = {
    schemaVersion: 1,
    date: '2026-08-05',
    generatedAt: '2026-08-05T04:00:00.000Z',
    observations: [],
    featuredEventIds: ids
  };
  const r = await validateFeatured(featured, null);
  assert.equal(r.valid, true);
  assert.ok(!r.warnings.some(w => w.includes('超过')), '12 条以内不应触发上限 warning');
});

test('hotEventIds：合法引用通过，悬空引用报错，缺失字段不报错（旧数据兼容）', async () => {
  const daily = makeValidDaily();
  const base = { schemaVersion: 1, date: '2026-08-05', generatedAt: '2026-08-05T04:00:00.000Z', observations: [], featuredEventIds: ['evt_abcdef123456'] };
  const ok = await validateFeatured({ ...base, hotEventIds: ['evt_abcdef123456'] }, daily);
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
  const bad = await validateFeatured({ ...base, hotEventIds: ['evt_nonexistent00'] }, daily);
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some(e => e.includes('热点')));
  const legacy = await validateFeatured(base, daily);
  assert.equal(legacy.valid, true, '无 hotEventIds 的旧版 featured 应兼容');
});

test('observationDetails：合法通过，缺 fact/mode 非法/evidenceUrls 非字符串报错，缺失字段兼容', async () => {
  const daily = makeValidDaily();
  const base = { schemaVersion: 1, date: '2026-08-05', generatedAt: '2026-08-05T04:00:00.000Z', observations: [], featuredEventIds: ['evt_abcdef123456'] };
  const ok = await validateFeatured({
    ...base,
    observationDetails: [
      { eventId: 'evt_abcdef123456', fact: '事实', implication: '', watchNext: '', evidenceUrls: ['https://a.com'], mode: 'generated' }
    ]
  }, daily);
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));

  const badMode = await validateFeatured({ ...base, observationDetails: [{ eventId: 'e', fact: 'f', mode: 'yolo' }] }, daily);
  assert.equal(badMode.valid, false);
  assert.ok(badMode.errors.some(e => e.includes('mode')));

  const badEv = await validateFeatured({ ...base, observationDetails: [{ eventId: 'e', fact: 'f', evidenceUrls: [1] }] }, daily);
  assert.equal(badEv.valid, false);
  assert.ok(badEv.errors.some(e => e.includes('evidenceUrls')));

  const noDetails = await validateFeatured(base, daily);
  assert.equal(noDetails.valid, true, '无 observationDetails 的旧版 featured 应兼容');
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

/* ===== 增量字段协议（阶段 A-02，AIHOT_IMPLEMENTATION_PLAN §4）===== */

test('前瞻兼容: 注入 B 阶段增量字段后 daily/featured 校验仍通过（未知字段容忍为契约）', async () => {
  const daily = makeValidDaily();
  // B 阶段规划字段（见 docs/DATA_PROTOCOL.md §10）：正式引入前校验器必须容忍
  daily.items[0].source.id = 'src_example';
  daily.items[0].independentSourceCount = 3;
  daily.items[0].articleId = 'art_abc123';
  daily.items[0].relatedSources[0].sourceId = 'src_example_media';
  daily.items[0].relatedSources[0].publishedAt = '2026-08-04T10:00:00.000Z';
  daily.items[0].selectionTrace = { ruleScore: 78, businessScore: 62, reason: '测试注入' };
  const rd = await validateDailyV2(daily);
  assert.equal(rd.valid, true, JSON.stringify(rd.errors));

  const featured = {
    schemaVersion: 1,
    date: '2026-08-05',
    generatedAt: '2026-08-05T04:00:00.000Z',
    observations: ['数据中心新增负荷继续推动电网扩建需求。'],
    featuredEventIds: ['evt_abcdef123456', 'evt_zyx987654321'],
    // D 阶段规划字段：结构化观察与旧字符串并存派生
    observationDetails: [{
      eventId: 'evt_abcdef123456',
      fact: '某电网宣布新增 1 GW 并网容量。',
      implication: '影响当地并网规划。',
      watchNext: null,
      evidenceUrls: ['https://example.com/article/1'],
      mode: 'generated',
    }],
  };
  const rf = await validateFeatured(featured, daily);
  assert.equal(rf.valid, true, JSON.stringify(rf.errors));
});

test('B-03 增量字段类型校验：independentSourceCount/source.id/relatedSources 扩展字段非法值被拒', async () => {
  const daily = makeValidDaily();
  daily.items[0].independentSourceCount = 0; // 须为 ≥1 整数
  daily.items[1].source.id = '';             // 出现时须为非空字符串
  daily.items[1].independentSourceCount = 2.5;
  daily.items[0].relatedSources[0].publishedAt = 'not-a-date';
  const r = await validateDailyV2(daily);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('items[0]') && e.includes('independentSourceCount')), r.errors.join(';'));
  assert.ok(r.errors.some(e => e.includes('source: id 出现时须为非空字符串')), r.errors.join(';'));
  assert.ok(r.errors.some(e => e.includes('items[1]') && e.includes('independentSourceCount')), r.errors.join(';'));
  assert.ok(r.errors.some(e => e.includes('publishedAt 非法')), r.errors.join(';'));
});

// ---- C-01 editorial-policy（编辑政策校验）----

test('validateEditorialPolicy：骨架合法，active 未冻结门槛报错', () => {
  const ok = {
    schemaVersion: 1, selectionMode: 'legacy',
    weights: { businessRelevance: 30, factualIncrement: 25, impact: 25, evidence: 20 },
    thresholds: { valueScoreSelect: null },
    shadow: { ruleThreshold: 3, nearBand: 1, auditSample: 5 },
  };
  assert.equal(validateEditorialPolicy(ok).valid, true);
  // active 但门槛未冻结 → error
  const active = { ...ok, selectionMode: 'active' };
  const r = validateEditorialPolicy(active);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('valueScoreSelect')));
  // active 且门槛已冻结 → 通过
  assert.equal(validateEditorialPolicy({ ...active, thresholds: { valueScoreSelect: 60 } }).valid, true);
});

test('validateEditorialPolicy：非法 mode / 权重 / shadow 参数报错', () => {
  const base = {
    schemaVersion: 1, selectionMode: 'legacy',
    weights: { businessRelevance: 30, factualIncrement: 25, impact: 25, evidence: 20 },
  };
  assert.ok(!validateEditorialPolicy({ ...base, selectionMode: 'yolo' }).valid);
  assert.ok(!validateEditorialPolicy({ ...base, weights: { ...base.weights, impact: -1 } }).valid);
  assert.ok(!validateEditorialPolicy({ ...base, shadow: { auditSample: 'many' } }).valid);
  assert.ok(!validateEditorialPolicy(null).valid);
  assert.ok(!validateEditorialPolicy({ schemaVersion: 2, selectionMode: 'legacy' }).valid);
});

test('validateEditorialPolicy：observationMode 枚举校验（title/shadow/active，缺失兼容）', () => {
  const base = {
    schemaVersion: 1, selectionMode: 'legacy',
    weights: { businessRelevance: 30, factualIncrement: 25, impact: 25, evidence: 20 },
  };
  // 缺失 observationMode（旧政策）合法；显式合法值合法
  assert.ok(validateEditorialPolicy(base).valid);
  for (const m of ['title', 'shadow', 'active']) {
    assert.ok(validateEditorialPolicy({ ...base, observationMode: m }).valid, `observationMode=${m} 应合法`);
  }
  // active 观察无硬门槛（观察事实验收是人工核查，非配置阈值），不依赖 valueScoreSelect
  assert.ok(validateEditorialPolicy({ ...base, observationMode: 'active' }).valid);
  // 非法枚举报错
  const bad = validateEditorialPolicy({ ...base, observationMode: 'yolo' });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some(e => e.includes('observationMode')));
});
