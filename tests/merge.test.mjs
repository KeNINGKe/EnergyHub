import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, titleSimilarity, eventSimilarity, sharedMetric, sharedEntity,
  mergeEvents, judgePair, detectConflict, phaseOf, locationHits,
} from '../scripts/lib/merge.mjs';

const T0 = '2026-08-05T02:00:00Z';

function item(over = {}) {
  return {
    title: '', topic: null, entities: [], metrics: [], publishedAt: T0,
    ...over
  };
}

// mergeV2 判定参数（与 data/enums.json merge/features 段同值）
const CFG = {
  features: { mergeV2: true },
  merge: { strongTitle: 0.7, nearTitle: 0.5, partialTitle: 0.2, regionConflict: true, locations: [] },
};

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

test('mergeEvents：聚类 + 独立计数 + 确定性（mergeV2 灰区语义）', () => {
  const items = [
    item({ title: 'Eolian 1.06GWh BESS Ohio', topic: 'energy-storage', metrics: [{ value: 1060, unit: 'MWh' }] }),
    item({ title: 'Eolian battery storage 1.06GWh', topic: 'energy-storage', metrics: [{ value: 1060, unit: 'MWh' }] }),
    item({ title: 'Germany coal plant', topic: 'grid' }),
    item({ title: 'Germany coal shutdown plan', topic: 'grid' })
  ];
  const r1 = mergeEvents(items, { cfg: CFG });
  const r2 = mergeEvents(items, { cfg: CFG });
  // Eolian 对：titleSim 0.43 无实体——旧版同主题+共享数字=0.55 直接合并，B-01 起
  // 共享数字单独不构成证据 → 落灰区；Germany 对 titleSim 0.4 无实体无数字 → 灰区
  assert.equal(r1.clusters.length, 4);
  assert.equal(r1.standaloneCount, 4);
  assert.equal(r1.grayPairs.length, 2);
  assert.deepEqual(r1.clusters.map(c => c.members), r2.clusters.map(c => c.members), '确定性');
  assert.deepEqual(r1.grayPairs.map(p => [p.i, p.j]), [[0, 1], [2, 3]], 'titleSim 降序：0.43 > 0.4');
});

test('mergeEvents：不相似条目不合并', () => {
  const items = [
    item({ title: 'Solar panel price', topic: 'solar-wind' }),
    item({ title: 'GPU shortage', topic: 'chips-compute' })
  ];
  const { clusters } = mergeEvents(items, { cfg: CFG });
  assert.equal(clusters.length, 2);
});

test('mergeEvents：灰区配对——有召回信号但证据不足，最终不同簇才返回', () => {
  const items = [
    // 0,1：同主题同实体、标题部分重叠（0.2）→ 证据不足落灰区（旧版 0.55 直接合并）
    item({ title: 'Fluence stock drops', topic: 'pcs', entities: ['Fluence'] }),
    item({ title: 'Fluence shares fall', topic: 'pcs', entities: ['Fluence'] }),
    // 2,3：同主题无实体（titleSim 0.18）→ 灰区
    item({ title: '储能电站招标', topic: 'energy-storage' }),
    item({ title: '锂电池产能过剩', topic: 'energy-storage' }),
    // 4,5：无任何重叠信号 → none，不进灰区
    item({ title: 'Solar panel price', topic: 'solar-wind' }),
    item({ title: 'GPU shortage', topic: 'chips-compute' })
  ];
  const { clusters, grayPairs: gray } = mergeEvents(items, { cfg: CFG });
  assert.deepEqual(gray.map(p => [p.i, p.j]), [[0, 1], [2, 3]], 'titleSim 降序：0.2 > 0.18');
  assert.equal(clusters.length, 6, '灰区不合并');
  const again = mergeEvents(items, { cfg: CFG });
  assert.deepEqual(gray, again.grayPairs, '同输入同输出');
});

test('mergeEvents：灰区对经传递合并进同簇后不再返回', () => {
  // (0,1) E1 合并 → (0,2) 判定时落灰（0.56 < 0.7）→ (1,2) E1 合并把 2 并进同簇，
  // 灰区对 (0,2) 最终同簇，不再返回给 Jev
  const items = [
    item({ title: 'Gridcore 3GWh hub project update', topic: 'energy-storage' }),
    item({ title: 'Gridcore 3GWh hub project update report', topic: 'energy-storage' }),
    item({ title: 'Gridcore 3GWh hub project update report summary today', topic: 'energy-storage' }),
  ];
  const { clusters, grayPairs: gray } = mergeEvents(items, { cfg: CFG });
  assert.deepEqual(clusters.map(c => c.members), [[0, 1, 2]]);
  assert.equal(gray.length, 0);
});

/* ===== B-01 mergeV2 判定分层（AIHOT_IMPLEMENTATION_PLAN §5）===== */

test('① judgePair：同公司不同项目（旧版纯关联 0.55 过线）→ 冲突否决', () => {
  const a = item({ title: 'Fluence 德州储能电站开工', topic: 'energy-storage', entities: ['Fluence'] });
  const b = item({ title: 'Fluence 加州储能项目获批', topic: 'energy-storage', entities: ['Fluence'] });
  const v = judgePair(a, b, { cfg: CFG });
  assert.ok(v.recall >= 0.45, `旧评分口径下这对会过门槛（recall=${v.recall}）`);
  assert.equal(v.action, 'reject');
  assert.equal(v.rule, 'conflict-location');
  // 通过 mergeEvents 同样不合并，且 pairLog 记录 reject
  const { clusters, pairLog } = mergeEvents([a, b], { cfg: CFG });
  assert.equal(clusters.length, 2);
  assert.equal(pairLog[0].action, 'reject');
  assert.equal(pairLog[0].rule, 'conflict-location');
});

test('② judgePair：E1 标题强证据仍被阶段冲突否决', () => {
  const a = item({ title: '华储 3GWh 独立储能电站项目开工', topic: 'energy-storage', entities: ['华储'] });
  const b = item({ title: '华储 3GWh 独立储能电站项目竣工', topic: 'energy-storage', entities: ['华储'] });
  const v = judgePair(a, b, { cfg: CFG });
  assert.ok(v.titleSim >= 0.7, `titleSim=${v.titleSim} 应命中 E1`);
  assert.equal(v.action, 'reject');
  assert.equal(v.rule, 'conflict-phase');
});

test('② detectConflict：阶段判定恰好命中 1 个才确定，多命中=未知', () => {
  assert.equal(phaseOf('华储 3GWh 储能电站项目开工'), 3);
  assert.equal(phaseOf('华储 3GWh 储能电站项目竣工投运'), 4, '投运/竣工同阶段 4');
  assert.equal(phaseOf('获批项目计划年内开工'), null, '获批(2)+计划(1)+开工(3) 多命中=未知');
  assert.equal(phaseOf('储能电站招标'), null, '无阶段词=未知');
});

test('③ judgePair：同容量不同地点 → 地点冲突否决', () => {
  const a = item({ title: 'Xenergy 2GWh 储能项目落户德州', topic: 'energy-storage', entities: ['Xenergy'] });
  const b = item({ title: 'Xenergy 2GWh 储能项目落户内华达', topic: 'energy-storage', entities: ['Xenergy'] });
  const v = judgePair(a, b, { cfg: CFG });
  assert.equal(v.action, 'reject');
  assert.equal(v.rule, 'conflict-location');
});

test('③ locationHits：多地点命中=未知；地点词表只收次国家地名', () => {
  assert.deepEqual(locationHits('Xenergy 储能项目落户德州'), ['德州']);
  assert.deepEqual(locationHits('美国德州储能项目'), ['德州'], '国名不在词表，州名单独命中');
  assert.deepEqual(locationHits('从加州到内华达的输电线路'), ['加州', '内华达'], '多命中由调用方判未知');
  assert.deepEqual(locationHits('Xenergy 储能项目'), []);
});

test('④ mergeEvents：链式误合被簇级一致性检查阻断', () => {
  const items = [
    item({ title: 'Gridcore 3GWh hub project update', topic: 'energy-storage', region: '美国' }),
    item({ title: 'Gridcore 3GWh hub project update report', topic: 'energy-storage', region: null }),
    item({ title: 'Gridcore 3GWh hub project update analysis', topic: 'energy-storage', region: '德国' }),
  ];
  const { clusters, pairLog } = mergeEvents(items, { cfg: CFG });
  // 0-1 E1 合并；1-2 E1 合并时簇检查发现 0(美国)-2(德国) 冲突 → 拦截
  assert.deepEqual(clusters.map(c => c.members), [[0, 1], [2]]);
  const cc = pairLog.filter(p => p.action === 'cluster-conflict');
  assert.equal(cc.length, 1);
  assert.equal(cc[0].rule, 'E1-strong-title');
  assert.deepEqual([cc[0].blockedBy.a, cc[0].blockedBy.b], [0, 2]);
  assert.equal(cc[0].blockedBy.reason, 'conflict-region');
  // (0,2) 本身也被单对判定直接拒绝
  assert.ok(pairLog.some(p => p.action === 'reject' && p.i === 0 && p.j === 2 && p.rule === 'conflict-region'));
});

test('⑤ judgePair：E3 中英文同事件（标题部分重叠+共享实体+共享数字）合并', () => {
  const a = item({
    title: 'Fluence 1.06GWh BESS 电池储能系统交付', topic: 'energy-storage',
    entities: ['Fluence'], metrics: [{ value: 1060, unit: 'MWh' }],
  });
  const b = item({
    title: 'Fluence delivers 1.06GWh BESS', topic: 'energy-storage',
    entities: ['Fluence'], metrics: [{ value: 1060, unit: 'MWh' }],
  });
  const v = judgePair(a, b, { cfg: CFG });
  assert.ok(v.titleSim >= 0.2 && v.titleSim < 0.5, `titleSim=${v.titleSim}`);
  assert.equal(v.action, 'merge');
  assert.equal(v.rule, 'E3-title-entity-metric');
});

test('⑥ judgePair：共享数字单独不构成证据（E2/E3 都要实体）', () => {
  const a = item({ title: 'Xenergy 2GWh project', topic: null, metrics: [{ value: 2000, unit: 'MWh' }] });
  const b = item({ title: 'Ypower 2GWh project', topic: null, metrics: [{ value: 2000, unit: 'MWh' }] });
  const v = judgePair(a, b, { cfg: CFG });
  assert.ok(v.recall > 0, '有召回信号');
  assert.equal(v.action, 'gray', '不合并，落灰区');
  assert.equal(v.sharedEntity, null);
});

test('⑦ judgePair：缺字段=未知不否决（region 缺失/全球/未知均放行）', () => {
  const a = item({ title: 'Gridcore 3GWh hub project update', region: '美国' });
  const b = item({ title: 'Gridcore 3GWh hub project update', region: null });
  assert.equal(judgePair(a, b, { cfg: CFG }).action, 'merge');
  assert.equal(detectConflict(a, b, CFG).reason, null);
  const c = item({ title: '华储 3GWh 独立储能电站项目竣工', region: '未知' });
  const d = item({ title: '华储 3GWh 独立储能电站项目竣工', region: '德国' });
  assert.equal(judgePair(c, d, { cfg: CFG }).action, 'merge', '未知 ≠ 冲突');
  const e = item({ title: '华储 3GWh 独立储能电站项目竣工', region: '全球' });
  assert.equal(judgePair(c, e, { cfg: CFG }).action, 'merge', '全球 ≠ 冲突');
  // regionConflict 可关：关闭后地区差异不再否决（该对 titleSim 0.8 → E1 合并）
  const g = item({ title: 'Xenergy 储能项目落户德州', region: '美国' });
  const h = item({ title: 'Xenergy 储能项目落户德国', region: '德国' });
  assert.equal(judgePair(g, h, { cfg: CFG }).rule, 'conflict-region');
  const cfgOff = { ...CFG, merge: { ...CFG.merge, regionConflict: false } };
  const vOff = judgePair(g, h, { cfg: cfgOff });
  assert.equal(vOff.action, 'merge');
  assert.equal(vOff.rule, 'E1-strong-title');
});

test('⑧ judgePair/mergeEvents：cannotLink 否决强证据对，mustLink 合并无证据对', () => {
  // cannotLink：近重复标题（E1 线以上）仍被人工约束拒绝
  const a = item({ title: 'Gridcore 3GWh hub project update', articleId: 'art_aaa' });
  const b = item({ title: 'Gridcore 3GWh hub project update report', articleId: 'art_bbb' });
  const links = { mustLink: [], cannotLink: [['art_aaa', 'art_bbb']] };
  assert.equal(judgePair(a, b, { cfg: CFG, links, idA: 'art_aaa', idB: 'art_bbb' }).rule, 'manual-cannot-link');
  const r1 = mergeEvents([a, b], { cfg: CFG, links, articleIdOf: it => it.articleId });
  assert.equal(r1.clusters.length, 2);

  // mustLink：标题/主题/实体毫无重叠（recall 0）仍合并——人工意志不被召回短路
  const c = item({ title: 'CATL 工厂投产', topic: 'pcs', articleId: 'art_ccc' });
  const d = item({ title: 'Bitcoin mining boom', topic: 'chips-compute', articleId: 'art_ddd' });
  const links2 = { mustLink: [['art_ccc', 'art_ddd']], cannotLink: [] };
  const v2 = judgePair(c, d, { cfg: CFG, links: links2, idA: 'art_ccc', idB: 'art_ddd' });
  assert.equal(v2.action, 'merge');
  assert.equal(v2.rule, 'manual-must-link');
  const r2 = mergeEvents([c, d], { cfg: CFG, links: links2, articleIdOf: it => it.articleId });
  assert.equal(r2.clusters.length, 1);
  assert.equal(r2.clusters[0].evidence.rule, 'manual-must-link');
});

test('⑨ mergeEvents：pairLog 完整记录 merge/reject 决策（确定性）', () => {
  const items = [
    item({ title: 'Gridcore 3GWh hub project update', topic: 'energy-storage' }),
    item({ title: 'Gridcore 3GWh hub project update report', topic: 'energy-storage' }),
    item({ title: '华储 3GWh 独立储能电站项目开工', topic: 'energy-storage' }),
    item({ title: '华储 3GWh 独立储能电站项目竣工', topic: 'energy-storage' }),
  ];
  const { pairLog } = mergeEvents(items, { cfg: CFG });
  assert.deepEqual(pairLog, [
    { i: 0, j: 1, action: 'merge', rule: 'E1-strong-title', titleSim: pairLog[0].titleSim, recall: pairLog[0].recall },
    { i: 2, j: 3, action: 'reject', rule: 'conflict-phase', titleSim: pairLog[1].titleSim, recall: pairLog[1].recall },
  ]);
  const again = mergeEvents(items, { cfg: CFG });
  assert.deepEqual(pairLog, again.pairLog, '同输入同输出');
});

test('mergeEvents：features.mergeV2=false 回退旧评分口径（mergeEventsLegacy）', () => {
  const items = [
    item({ title: 'Eolian 1.06GWh BESS Ohio', topic: 'energy-storage', metrics: [{ value: 1060, unit: 'MWh' }] }),
    item({ title: 'Eolian battery storage 1.06GWh', topic: 'energy-storage', metrics: [{ value: 1060, unit: 'MWh' }] }),
  ];
  const legacy = mergeEvents(items, { cfg: { features: { mergeV2: false } } });
  assert.equal(legacy.clusters.length, 1, '旧口径 0.55 直接合并');
  assert.deepEqual(legacy.clusters[0].reason, ['same-topic', 'metric:1060MWh', 'title:0.43']);
  assert.equal(legacy.pairLog, undefined, 'legacy 无过程日志');
  assert.equal(legacy.grayPairs, undefined);
});
