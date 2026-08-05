import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFilters, classify, keywordHit } from '../scripts/lib/filter.mjs';

const filters = await loadFilters();

test('强词：单独命中即相关', () => {
  const r = classify('某地 1GWh BESS 储能电站并网投运', filters);
  assert.equal(r.relevant, true);
  assert.ok(r.hits.some(h => h.type === 'strong'));
  assert.match(r.reason, /强词:/);
});

test('强词：中文子串匹配', () => {
  assert.equal(classify('光伏电站项目获批', filters).relevant, true);
  assert.equal(classify('液冷散热方案发布', filters).relevant, true);
});

test('组合词：同组 ≥2 命中才相关', () => {
  // "数据中心" + "算力" 同组，相关
  assert.equal(classify('数据中心与算力需求增长', filters).relevant, true);
  // 单独 "数据中心" 不相关（不在强词，组合不足）
  assert.equal(classify('数据中心服务升级公告', filters).relevant, false);
});

test('组合词：EV 消费车评不相关（只有单个 EV 词）', () => {
  assert.equal(classify('2027 Chevrolet Blazer EV 配置升级价格不变', filters).relevant, false);
});

test('组合词：EV + 充电设施相关', () => {
  assert.equal(classify('EV charging network deploys 500+ fast chargers', filters).relevant, true);
});

test('通用词：单个泛词不相关', () => {
  assert.equal(classify('关于能源的入门介绍', filters).relevant, false);
});

test('通用词：≥2 泛词兜底相关', () => {
  assert.equal(classify('清洁能源与电力转型报告', filters).relevant, true);
});

test('负面词：命中即过滤，且优先于强词', () => {
  const r = classify('储能电池电饭煲促销 优惠券 车评 手机评测', filters);
  assert.equal(r.relevant, false);
  assert.match(r.reason, /负面词:/);
});

test('负面词：车评里即使有 EV 也过滤', () => {
  assert.equal(classify('新车评测：电动 SUV 试驾体验', filters).relevant, false);
});

test('英文整词：power 不匹配 powerful', () => {
  assert.equal(keywordHit('powerful engine', 'power'), false);
  assert.equal(keywordHit('solar power capacity', 'power'), true);
});

test('英文单位：MW 匹配相邻数字 1.6MW', () => {
  assert.equal(keywordHit('a 1.6MW gas plant', 'MW'), true);
  assert.equal(keywordHit('a 1.6 MW gas plant', 'MW'), true);
});

test('英文短语：PPA 整词匹配', () => {
  assert.equal(keywordHit('signed a 15-year PPA', 'PPA'), true);
  assert.equal(keywordHit('paper-based process', 'PPA'), false);
});

test('无关键词命中：不相关，原因可读', () => {
  const r = classify('宠物用品选购指南', filters);
  assert.equal(r.relevant, false);
  assert.equal(r.reason, '无关键词命中');
});

test('配置完整性：四类关键词均在', () => {
  assert.ok(filters.strong.length > 0);
  assert.ok(filters.combination.groups.length >= 3);
  assert.ok(filters.generic.words.length > 0);
  assert.ok(filters.negative.length > 0);
  assert.ok(filters.combination.min >= 2);
  assert.ok(filters.generic.min >= 2);
});
