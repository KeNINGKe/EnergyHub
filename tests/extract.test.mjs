import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnums } from '../scripts/lib/schema.mjs';
import { loadRegions, loadEntities, extractTopics, extractRegion, extractEntities, extractMetrics } from '../scripts/lib/extract.mjs';

const enums = await loadEnums();
const regionsConfig = await loadRegions();
const entitiesConfig = await loadEntities();

test('extractTopics：命中储能主题', () => {
  const t = extractTopics('1GWh BESS 储能电站 在俄亥俄州开工', enums);
  assert.ok(t.includes('energy-storage'), t.join(','));
});

test('extractTopics：命中 AIDC 电力交叉主题', () => {
  const t = extractTopics('数据中心电力需求 算电协同 增长', enums);
  assert.ok(t.includes('data-center-power'), t.join(','));
});

test('extractTopics：返回最多 2 个主题', () => {
  const t = extractTopics('光伏 风电 核电 储能 电网 电力市场 数据中心 芯片 GPU', enums);
  assert.ok(t.length <= 2, t.join(','));
});

test('extractTopics：无命中返回空数组', () => {
  assert.deepEqual(extractTopics('随便一句话', enums), []);
});

test('extractRegion：中国', () => {
  assert.equal(extractRegion('国家发改委发布中国电力数据', regionsConfig), '中国');
});

test('extractRegion：美国（US 整词）', () => {
  assert.equal(extractRegion('US energy department announces 10GW', regionsConfig), '美国');
  assert.equal(extractRegion('The USA grid faces demand', regionsConfig), '美国');
});

test('extractRegion：US 不误匹配 focus', () => {
  assert.notEqual(extractRegion('focus on storage economics', regionsConfig), '美国');
});

test('extractRegion：欧盟（Europe 整词）', () => {
  assert.equal(extractRegion('Europe bets big on batteries', regionsConfig), '欧盟');
});

test('extractRegion：无命中返回未知', () => {
  assert.equal(extractRegion('无地区信息', regionsConfig), '未知');
});

test('extractEntities：公司名', () => {
  const es = extractEntities('NVIDIA announces GB300 and Microsoft Azure expansion', entitiesConfig.entities);
  assert.ok(es.includes('NVIDIA'), es.join(','));
  assert.ok(es.includes('Microsoft'), es.join(','));
});

test('extractEntities：中文名', () => {
  const es = extractEntities('宁德时代 发布新型电池', entitiesConfig.entities);
  assert.ok(es.includes('宁德时代'), es.join(','));
});

test('extractEntities：Apple 不匹配 apples（无后缀容错）', () => {
  assert.deepEqual(extractEntities('fresh apples in the store', entitiesConfig.entities), []);
});

test('extractMetrics：MW 数字', () => {
  const m = extractMetrics('a 641MW module supply deal');
  assert.equal(m[0].value, 641);
  assert.equal(m[0].unit, 'MW');
  assert.ok(m[0].label.length > 0, 'label 非空');
});

test('extractMetrics：GWh 与中文单位', () => {
  const m = extractMetrics('1.2GWh storage and 50 万千瓦 wind');
  const units = m.map(x => x.unit);
  assert.ok(units.includes('GWh'), units.join(','));
  assert.ok(units.includes('万千瓦'), units.join(','));
});

test('extractMetrics：$/MWh 电价', () => {
  const m = extractMetrics('price fell to $58/MWh');
  assert.ok(m.some(x => x.unit === '$/MWh' && x.value === 58));
});

test('extractMetrics：去重同值同单位', () => {
  const m = extractMetrics('1MW and 1 MW are the same');
  assert.equal(m.filter(x => x.unit === 'MW').length, 1);
});
