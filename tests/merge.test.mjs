import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, titleSimilarity, eventSimilarity, sharedMetric, sharedEntity, mergeEvents } from '../scripts/lib/merge.mjs';

const T0 = '2026-08-05T02:00:00Z';

function item(over = {}) {
  return {
    title: '', topic: null, entities: [], metrics: [], publishedAt: T0,
    ...over
  };
}

test('tokenize：中英混合', () => {
  const s = tokenize('Eolian BESS 储能');
  assert.ok(s.has('w:eolian'));
  assert.ok(s.has('w:bess'));
  assert.ok(s.has('储'));
});

test('titleSimilarity：相近标题高分', () => {
  const sim = titleSimilarity('Tesla Megapack project in Texas', 'Tesla Megapack storage project in Texas');
  assert.ok(sim > 0.5, `sim=${sim}`);
});

test('titleSimilarity：无关标题低分', () => {
  const sim = titleSimilarity('Tesla Megapack price', 'Germany coal plant shutdown');
  assert.ok(sim < 0.2, `sim=${sim}`);
});

test('sharedMetric：相同单位同值', () => {
  const a = item({ metrics: [{ label: '', value: 1060, unit: 'MWh' }] });
  const b = item({ metrics: [{ label: '', value: 1060, unit: 'MWh' }] });
  assert.equal(sharedMetric(a, b), '1060MWh');
});

test('sharedMetric：数值差异大不共享', () => {
  const a = item({ metrics: [{ label: '', value: 3, unit: 'MW' }] });
  const b = item({ metrics: [{ label: '', value: 100, unit: 'MW' }] });
  assert.equal(sharedMetric(a, b), null);
});

test('sharedMetric：四舍五入容差 1.06 vs 1', () => {
  const a = item({ metrics: [{ label: '', value: 1.06, unit: 'GWh' }] });
  const b = item({ metrics: [{ label: '', value: 1, unit: 'GWh' }] });
  assert.equal(sharedMetric(a, b), '1.06GWh');
});

test('sharedEntity：实体重叠', () => {
  assert.equal(sharedEntity(item({ entities: ['NVIDIA'] }), item({ entities: ['NVIDIA', 'Microsoft'] })), 'NVIDIA');
  assert.equal(sharedEntity(item({ entities: ['NVIDIA'] }), item({ entities: ['Intel'] })), null);
});

test('eventSimilarity：同主题+共享数字+标题相似 → 高分合并', () => {
  const a = item({ title: 'Eolian 1.06GWh BESS in Ohio', topic: 'energy-storage', metrics: [{ value: 1060, unit: 'MWh' }] });
  const b = item({ title: 'Eolian submits 1.06GWh battery storage', topic: 'energy-storage', metrics: [{ value: 1060, unit: 'MWh' }] });
  const { score, signals } = eventSimilarity(a, b);
  assert.ok(score >= 0.5, `score=${score}`);
  assert.ok(signals.length >= 2, signals.join(','));
});

test('eventSimilarity：标题近重复单独即可合并（主题/实体提取不一致的漏合场景）', () => {
  const a = item({ title: 'Tesla Megapack project in Texas', topic: 'energy-storage' });
  const b = item({ title: 'Tesla Megapack storage project in Texas', topic: null });
  const { score } = eventSimilarity(a, b);
  assert.ok(score >= 0.45, `score=${score} 应达门槛`);
});

test('eventSimilarity：中等标题相似无佐证不合并不足门槛', () => {
  const a = item({ title: 'Solar panel price drops in Q3', topic: 'solar-wind' });
  const b = item({ title: 'Solar panel price drops again this quarter', topic: 'solar-wind' });
  const { score } = eventSimilarity(a, b);
  // 同主题 + 中等相似 = 0.5，可过；但去掉同主题后仅标题信号不足
  const c = item({ title: 'Solar panel price drops in Q3' });
  const d = item({ title: 'Solar panel price drops again this quarter' });
  const { score: s2 } = eventSimilarity(c, d);
  assert.ok(score >= 0.45);
  assert.ok(s2 < 0.45, `仅中等标题相似 score=${s2} 不应过门槛`);
});

test('eventSimilarity：超时间窗口不合并', () => {
  const a = item({ title: 'Same event', topic: 'grid' });
  const b = item({ title: 'Same event', topic: 'grid', publishedAt: '2026-08-10T02:00:00Z' });
  const { score } = eventSimilarity(a, b);
  assert.equal(score, 0);
});

test('mergeEvents：聚类 + 独立计数 + 确定性', () => {
  const items = [
    item({ title: 'Eolian 1.06GWh BESS Ohio', topic: 'energy-storage', metrics: [{ value: 1060, unit: 'MWh' }] }),
    item({ title: 'Eolian battery storage 1.06GWh', topic: 'energy-storage', metrics: [{ value: 1060, unit: 'MWh' }] }),
    item({ title: 'Germany coal plant', topic: 'grid' }),
    item({ title: 'Germany coal shutdown plan', topic: 'grid' })
  ];
  const r1 = mergeEvents(items);
  const r2 = mergeEvents(items);
  assert.equal(r1.clusters.length, 2);
  assert.equal(r1.standaloneCount, 0);
  assert.deepEqual(r1.clusters.map(c => c.members), r2.clusters.map(c => c.members), '确定性');
});

test('mergeEvents：不相似条目不合并', () => {
  const items = [
    item({ title: 'Solar panel price', topic: 'solar-wind' }),
    item({ title: 'GPU shortage', topic: 'chips-compute' })
  ];
  const { clusters } = mergeEvents(items);
  assert.equal(clusters.length, 2);
});
