import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRescue, topicCriteria, rescueThreshold } from '../scripts/lib/jev.mjs';

test('shouldRescue: relevant 且概率达阈值才捞回', () => {
  assert.equal(shouldRescue({ relevant: true, probability: 0.87 }), true);
  assert.equal(shouldRescue({ relevant: true, probability: 0.8 }), true);
  assert.equal(shouldRescue({ relevant: true, probability: 0.79 }), false);
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

test('rescueThreshold: 默认 0.8，非法 env 回落默认', () => {
  assert.equal(rescueThreshold(), 0.8);
  process.env.JEV_RESCUE_THRESHOLD = '0.65';
  assert.equal(rescueThreshold(), 0.65);
  process.env.JEV_RESCUE_THRESHOLD = 'abc';
  assert.equal(rescueThreshold(), 0.8);
  process.env.JEV_RESCUE_THRESHOLD = '1.5';
  assert.equal(rescueThreshold(), 0.8);
  delete process.env.JEV_RESCUE_THRESHOLD;
});

test('topicCriteria: enums.topics 映射为 id→label', () => {
  const enums = { topics: [{ id: 'sst', label: '固态变压器' }, { id: 'pcs', label: 'PCS/储能变流器' }] };
  assert.deepEqual(topicCriteria(enums), { sst: '固态变压器', pcs: 'PCS/储能变流器' });
  assert.deepEqual(topicCriteria({}), {});
  assert.deepEqual(topicCriteria(null), {});
});
