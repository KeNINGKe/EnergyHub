import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectHot, scaleScore, regionGroup } from '../scripts/build-daily-v2.mjs';
import { loadEnums } from '../scripts/lib/schema.mjs';

const enums = await loadEnums();

const ev = (over) => ({
  id: over.id || 'evt_x',
  title: over.title || 't',
  originalTitle: '',
  url: over.url || `https://example.com/${over.id || Math.random().toString(36).slice(2)}`,
  summary: 's',
  topic: 'energy-storage',
  region: over.region || '中国', // 默认白名单内地区，避免与被测项无关的地区过滤干扰
  entities: [],
  metrics: over.metrics || [],
  importance: over.importance ?? 3.5,
  source: { name: over.source || `src-${over.id || 'x'}`, type: 'media' }, // 默认每事件独立来源，避免 maxPerSource 干扰
  publishedAt: over.publishedAt || '2026-09-16T00:00:00Z',
  relatedSources: over.relatedSources || [],
  ...over
});

test('selectHot：地区白名单——欧洲/亚太/全球/未知高分不入榜，北美/中国/中东中分入选', () => {
  const events = [
    ...['德国', '波兰', '西班牙', '意大利', '英国', '法国'].map((r, i) =>
      ev({ id: `eu-${i}`, region: r, importance: 5 })),
    ev({ id: 'ap-1', region: '日本', importance: 5 }),
    ev({ id: 'global-1', region: '全球', importance: 5 }),
    ev({ id: 'unknown-1', region: '未知', importance: 5 }),
    ev({ id: 'cn-1', region: '中国', importance: 4 }),
    ev({ id: 'na-1', region: '美国', importance: 4 }),
    ev({ id: 'me-1', region: '沙特', importance: 4 })
  ];
  const ids = selectHot(events, enums, {});
  assert.equal(ids.length, 3, '白名单外不入候选，不足 5 席就少展示');
  assert.ok(ids.includes('cn-1'));
  assert.ok(ids.includes('na-1'));
  assert.ok(ids.includes('me-1'));
  assert.ok(ids.every(id => !id.startsWith('eu-') && id !== 'ap-1' && id !== 'global-1' && id !== 'unknown-1'));
});

test('selectHot：单源上限——同一来源最多 2 席', () => {
  const events = [
    ...Array.from({ length: 5 }, (_, i) =>
      ev({ id: `s-${i}`, region: '美国', importance: 6, source: 'ESS News' })),
    ev({ id: 'other-1', region: '中国', importance: 2, source: '公众号' }),
    ev({ id: 'other-2', region: '中国', importance: 2, source: '公众号2' })
  ];
  const ids = selectHot(events, enums, {});
  const byId = new Map(events.map(e => [e.id, e]));
  const essCount = ids.filter(id => byId.get(id).source.name === 'ESS News').length;
  assert.ok(essCount <= 2);
  assert.equal(ids.length, 5); // 回填保证不缺岗
});

test('selectHot：回填——源配额导致选不满时第二轮忽略配额补满', () => {
  const events = Array.from({ length: 6 }, (_, i) =>
    ev({ id: `us-${i}`, region: '美国', importance: 4 }));
  const ids = selectHot(events, enums, {});
  assert.equal(ids.length, 5); // 补满 5 席
});

test('selectHot：规模分——3GWh 大单压过 170MWh 小项目（同 importance）', () => {
  const events = [
    ev({ id: 'small', region: '中国', metrics: [{ label: 'x', value: 170, unit: 'MWh' }] }),
    ev({ id: 'big', region: '美国', metrics: [{ label: 'x', value: 3, unit: 'GWh' }] })
  ];
  const ids = selectHot(events, enums, {});
  assert.equal(ids[0], 'big');
});

test('scaleScore：中文单位归一（吉瓦时/兆瓦/万千瓦）', () => {
  assert.equal(scaleScore({ metrics: [{ value: 1, unit: '吉瓦时' }] }, enums.hot.scaleTiers), 1); // 1000MWh → +1
  assert.equal(scaleScore({ metrics: [{ value: 850, unit: '兆瓦' }] }, enums.hot.scaleTiers), 0.5);
  assert.equal(scaleScore({ metrics: [{ value: 30, unit: '万千瓦' }] }, enums.hot.scaleTiers), 0.5); // 300MW
  assert.equal(scaleScore({ metrics: [{ value: 170, unit: 'MWh' }] }, enums.hot.scaleTiers), 0);
  assert.equal(scaleScore({ metrics: [{ value: 5, unit: '$/MWh' }] }, enums.hot.scaleTiers), 0); // 价格不算规模
});

test('selectHot：软曝光惩罚——昨日上榜 -1.5 仍可凭高分入选，第 3 天仅 -0.75', () => {
  const yesterday = ev({ id: 'big-old', region: '美国', importance: 5,
    metrics: [{ value: 3, unit: 'GWh' }], url: 'https://example.com/a' });
  const fresh = ev({ id: 'fresh-cn', region: '中国', importance: 3.5, url: 'https://example.com/b' });
  // 键为 canonical URL（eventFingerprint 产出 https:// 全格式）；b 未上榜
  const ages = new Map([['https://example.com/a', 1]]);
  // 老事件 5 + 1.5(规模) - 1.5(昨日上榜) = 5 仍应排在新事件 3.5 之前
  const ids = selectHot([fresh, yesterday], enums, { exposedAges: ages });
  assert.equal(ids[0], 'big-old');
  // 第 3 天惩罚仅 0.75：5 + 1.5 - 0.75 = 5.75 仍在榜首
  const ids3 = selectHot([fresh, yesterday], enums, { exposedAges: new Map([['https://example.com/a', 2]]) });
  assert.equal(ids3[0], 'big-old');
});

test('selectHot：同日上榜惩罚最重（exposurePenaltyByAge[0]）', () => {
  const a = ev({ id: 'a', region: '美国', importance: 5, url: 'https://example.com/a' });
  const b = ev({ id: 'b', region: '沙特', importance: 5, url: 'https://example.com/b' });
  const ids = selectHot([a, b], enums, { exposedAges: new Map([['https://example.com/a', 0]]) });
  assert.equal(ids[0], 'b'); // a 同日上榜被罚 2 分
});

test('selectHot：data-center-power 进入候选（topics 扩展生效）', () => {
  const events = [
    ev({ id: 'dcp-1', topic: 'data-center-power', region: '美国', importance: 4.5 }),
    ev({ id: 'es-1', topic: 'energy-storage', region: '中国', importance: 3 })
  ];
  const ids = selectHot(events, enums, {});
  assert.ok(ids.includes('dcp-1'));
});

test('selectHot：确定性平局裁决——同分时多源多的在前，与输入序无关', () => {
  const a = ev({ id: 'single', region: '美国', importance: 4, relatedSources: [] });
  const b = ev({ id: 'multi', region: '加拿大', importance: 4,
    relatedSources: [{ name: 'x', url: 'u1' }, { name: 'y', url: 'u2' }] });
  const ids = selectHot([a, b], enums, {});
  assert.equal(ids[0], 'multi');
  const idsReversed = selectHot([b, a], enums, {});
  assert.deepEqual(ids, idsReversed);
});

test('regionGroup：映射与兜底', () => {
  assert.equal(regionGroup('德国', enums.hot.regionGroups), '欧洲');
  assert.equal(regionGroup('美国', enums.hot.regionGroups), '北美');
  assert.equal(regionGroup('沙特', enums.hot.regionGroups), '中东');
  assert.equal(regionGroup('日本', enums.hot.regionGroups), '亚太');
  assert.equal(regionGroup('全球', enums.hot.regionGroups), '其他');
  assert.equal(regionGroup('智利', enums.hot.regionGroups), '其他');
  assert.equal(regionGroup('未知', null), '其他');
});
