import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRescue, topicCriteria, rescueThreshold, needsTopicArbitration } from '../scripts/lib/jev.mjs';

test('shouldRescue: relevant 且概率达阈值才捞回', () => {
  assert.equal(shouldRescue({ relevant: true, probability: 0.87 }), true);
  assert.equal(shouldRescue({ relevant: true, probability: 0.65 }), true);
  assert.equal(shouldRescue({ relevant: true, probability: 0.64 }), false);
  assert.equal(shouldRescue({ relevant: false, probability: 0.99 }), false);
});

test('shouldRescue: null/残缺 verdict 不捞回（失败维持被拒）', () => {
  assert.equal(shouldRescue(null), false);
  assert.equal(shouldRescue(undefined), false);
  assert.equal(shouldRescue({ probability: 0.99 }), false);
  assert.equal(shouldRescue({ relevant: true }), false);
});

test('shouldRescue: 阈值可通过参数覆盖', () => {
  assert.equal(shouldRescue({ relevant: true, probability: 0.6 }, 0.5), true);
  assert.equal(shouldRescue({ relevant: true, probability: 0.6 }, 0.7), false);
});

test('rescueThreshold: 默认 0.65（2026-09-21 校准），非法 env 回落默认', () => {
  assert.equal(rescueThreshold(), 0.65);
  process.env.JEV_RESCUE_THRESHOLD = '0.7';
  assert.equal(rescueThreshold(), 0.7);
  process.env.JEV_RESCUE_THRESHOLD = 'abc';
  assert.equal(rescueThreshold(), 0.65);
  process.env.JEV_RESCUE_THRESHOLD = '1.5';
  assert.equal(rescueThreshold(), 0.65);
  delete process.env.JEV_RESCUE_THRESHOLD;
});

test('topicCriteria: enums.topics 映射为 id→label', () => {
  const enums = { topics: [{ id: 'sst', label: '固态变压器' }, { id: 'pcs', label: 'PCS/储能变流器' }] };
  assert.deepEqual(topicCriteria(enums), { sst: '固态变压器', pcs: 'PCS/储能变流器' });
  assert.deepEqual(topicCriteria({}), {});
  assert.deepEqual(topicCriteria(null), {});
});

test('needsTopicArbitration: 空/兜底档要仲裁，具体主题不仲裁', () => {
  assert.equal(needsTopicArbitration({ topics: [] }, {}), true);
  assert.equal(needsTopicArbitration({ topics: null }, {}), true);
  assert.equal(needsTopicArbitration({}, {}), true);
  assert.equal(needsTopicArbitration({ topics: ['other-energy'] }, {}), true);
  assert.equal(needsTopicArbitration({ topics: ['grid', 'pcs'] }, {}), false);
  // Jev 已判过主题（捞回条目）不重复仲裁
  assert.equal(needsTopicArbitration({ topics: [] }, { _jev: { topic: 'grid' } }), false);
});
