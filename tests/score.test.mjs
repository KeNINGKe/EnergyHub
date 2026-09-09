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

test('importance：优先主题 +1，且不依赖 priorityTopics 也能跑', () => {
  const base = item({ sourceType: 'media', summary: 's', publishedAt: '2026-08-05T00:00:00Z' });
  const noBoost = importance(base, { now: NOW });            // media 1 + 摘要 .5 + 时效 24h 1 = 2.5
  const boosted = importance({ ...base, topic: 'pcs' }, { now: NOW, priorityTopics: ['sst', 'pcs'] });
  assert.equal(boosted - noBoost, 1, `${boosted} 应比 ${noBoost} 高 1`);
  // 未命中优先主题不额外加分；未传 priorityTopics 时正常跑
  const other = importance({ ...base, topic: 'grid' }, { now: NOW, priorityTopics: ['sst', 'pcs'] });
  assert.equal(other, noBoost);
  assert.equal(importance(base, { now: NOW }), 2.5, '无 priorityTopics 仍正常计算');
});

test('importance：重点公司命中 +1（叠加实体在场 +0.5），未命中不加', () => {
  const base = item({ sourceType: 'media', summary: 's', publishedAt: '2026-08-05T00:00:00Z' });
  const noBoost = importance(base, { now: NOW });
  const pc = ['宁德时代', 'CATL', 'Fluence'];
  const hitZh = importance({ ...base, entities: ['宁德时代'] }, { now: NOW, priorityCompanies: pc });
  const hitEn = importance({ ...base, entities: ['CATL'] }, { now: NOW, priorityCompanies: pc });
  const miss = importance({ ...base, entities: ['其他公司'] }, { now: NOW, priorityCompanies: pc });
  // 差值 = 公司加权 1 + 实体在场 0.5；未命中公司只有实体在场 0.5
  assert.equal(hitZh - noBoost, 1.5);
  assert.equal(hitEn - noBoost, 1.5);
  assert.equal(miss - noBoost, 0.5);
  // 未传 priorityCompanies 时正常跑（向后兼容）
  assert.equal(importance({ ...base, entities: ['宁德时代'] }, { now: NOW }) - noBoost, 0.5);
});

test('importance：多源报道加分，封顶 +1.5', () => {
  const base = item({ sourceType: 'media', summary: 's', publishedAt: '2026-08-05T00:00:00Z' });
  const solo = importance(base, { now: NOW });
  const two = importance({ ...base, relatedSources: [{ name: 'B', url: 'https://b.com/1' }] }, { now: NOW });
  const many = importance({ ...base, relatedSources: [{ name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }] }, { now: NOW });
  assert.equal(two - solo, 0.5, '1 家其他信源 +0.5');
  assert.equal(many - solo, 1.5, '≥3 家封顶 +1.5');
});

test('importance：无 relatedSources 字段正常计算（兼容旧条目）', () => {
  assert.equal(importance(item({ sourceType: 'media' }), { now: NOW }), importance(item({ sourceType: 'media', relatedSources: [] }), { now: NOW }));
});

test('importance：政策标准落地双命中 +1，单命中/未配置不加分', () => {
  const base = item({ sourceType: 'media', summary: 's', publishedAt: '2026-08-05T00:00:00Z' });
  const pb = {
    actions: ['政策', '标准', '发布', 'regulation', 'standard'],
    techs: ['高压直流', '800V', 'HVDC', 'PUE', '供电'],
    score: 1
  };
  const noBoost = importance(base, { now: NOW });
  // 双命中（中文：政策动作词 + 技术词都在标题里）
  const hitZh = importance({ ...base, title: '七部门发布数据中心800V高压直流政策' }, { now: NOW, policyBoost: pb });
  assert.equal(hitZh - noBoost, 1, `双命中应 +1，${hitZh} vs ${noBoost}`);
  // 双命中（英文，扫 originalTitle）
  const hitEn = importance({ ...base, originalTitle: 'EU unveils HVDC regulation for data centers' }, { now: NOW, policyBoost: pb });
  assert.equal(hitEn - noBoost, 1, `英文双命中应 +1`);
  // 只有动作词、没有技术词 → 不加
  const onlyAction = importance({ ...base, title: '七部门发布新能源汽车下乡政策' }, { now: NOW, policyBoost: pb });
  assert.equal(onlyAction, noBoost, '单命中动作词不加分');
  // 只有技术词、没有动作词 → 不加
  const onlyTech = importance({ ...base, title: '某园区采用800V高压直流供电方案' }, { now: NOW, policyBoost: pb });
  assert.equal(onlyTech, noBoost, '单命中技术词不加分');
  // 未传 policyBoost → 向后兼容
  const noCfg = importance({ ...base, title: '七部门发布数据中心800V高压直流政策' }, { now: NOW });
  assert.equal(noCfg, noBoost, '未配置时不加分');
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
