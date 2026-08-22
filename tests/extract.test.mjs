import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnums } from '../scripts/lib/schema.mjs';
import { loadRegions, loadEntities, extractTopics, extractRegion, extractRegionFromParts, regionVotes, extractEntities, extractMetrics } from '../scripts/lib/extract.mjs';

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

test('extractRegion：US$ 货币符号不误判为美国（西班牙文章）', () => {
  const text = 'The Spanish Ministry of Ecological Transition (MITECO) has awarded €360 million (US$415 million) to 1.14GW of solar PV co-located with batteries';
  assert.equal(extractRegion(text, regionsConfig), '西班牙');
});

test('extractRegion：代词 us 不误判为美国', () => {
  assert.equal(extractRegion('The Spanish government allocated funds, allowing us to build more', regionsConfig), '西班牙');
});

test('extractRegion：国名形容词识别', () => {
  assert.equal(extractRegion('Spanish regulator approves 1.14GW co-located storage', regionsConfig), '西班牙');
  assert.equal(extractRegion('British grid operator plans interconnector', regionsConfig), '英国');
  assert.equal(extractRegion('French nuclear fleet maintenance', regionsConfig), '法国');
  assert.equal(extractRegion('German storage market grows', regionsConfig), '德国');
  assert.equal(extractRegion('Dutch port hosts new plant', regionsConfig), '荷兰');
});

test('extractRegion：U.S. 与 EU 缩写', () => {
  assert.equal(extractRegion('U.S. Department of Energy funding', regionsConfig), '美国');
  assert.equal(extractRegion('EU storage mandate', regionsConfig), '欧盟');
});

test('extractRegion：Latin/Central/South America 归拉美而非美国', () => {
  assert.equal(extractRegion('Latin American solar markets expand', regionsConfig), '拉美');
  assert.equal(extractRegion('Central America renewable projects get funding', regionsConfig), '拉美');
  assert.equal(extractRegion('South American grid interconnection plans', regionsConfig), '拉美');
});

test('extractRegion：American 整词识别为美国', () => {
  assert.equal(extractRegion('winners of the American Solar Challenge honored', regionsConfig), '美国');
});

test('extractRegion：欧盟（Europe 整词）', () => {
  assert.equal(extractRegion('Europe bets big on batteries', regionsConfig), '欧盟');
});

test('extractRegion：无命中返回未知', () => {
  assert.equal(extractRegion('无地区信息', regionsConfig), '未知');
});

test('regionVotes：多地区命中按次数取胜，同数按最早位置', () => {
  // 智利 1 次 + 澳大利亚 1 次 → 平票，智利在标题中位置更早
  const r = regionVotes('Sungrow在智利赢得606MWh，Hithium在澳大利亚赢得421MW', regionsConfig);
  assert.equal(r.region, '智利');
  // 中国别名命中两次（中国 + Chinese）压过单次智利
  const r2 = regionVotes('Chinese company Sungrow won a project in Chile for 中国 market', regionsConfig);
  assert.equal(r2.region, '中国');
});

test('extractRegion：新增国家别名（智利/波兰/越南等）', () => {
  assert.equal(extractRegion('Chile approves 1GWh BESS project', regionsConfig), '智利');
  assert.equal(extractRegion('Poland grid adds battery capacity', regionsConfig), '波兰');
  assert.equal(extractRegion('Vietnam solar expansion continues', regionsConfig), '越南');
});

test('extractRegionFromParts：标题优先于正文（公司国籍噪声不覆盖事件国家）', () => {
  // 标题写明智利项目；摘要提到中国厂商——正确结果应为智利而非中国
  const title = 'Sungrow wins 606MWh BESS deal in Chile';
  const body = 'Chinese inverter maker Sungrow signed the contract, expanding its overseas footprint';
  assert.equal(extractRegionFromParts(title, body, regionsConfig), '智利');
});

test('extractRegionFromParts：标题无命中退回正文，全球让位具体地区', () => {
  assert.equal(
    extractRegionFromParts('Battery prices keep falling', 'the global market sees China leading production', regionsConfig),
    '中国'
  );
  assert.equal(
    extractRegionFromParts('Battery prices keep falling', 'worldwide demand keeps growing', regionsConfig),
    '全球'
  );
  assert.equal(extractRegionFromParts('no region here', 'nothing either', regionsConfig), '未知');
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
