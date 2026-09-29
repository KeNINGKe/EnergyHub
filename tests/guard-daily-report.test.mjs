import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  morningWindowStartUtc,
  pushStepSucceeded,
  decideGuardAction,
} from '../scripts/guard-daily-report.mjs';

const utc = s => new Date(s);

test('morningWindowStartUtc：守卫时刻（北京 08:13）→ 当天北京 04:00 = 前一天 UTC 20:00', () => {
  // 北京 2026-09-29 08:13 = UTC 2026-09-29 00:13
  assert.equal(
    morningWindowStartUtc(utc('2026-09-29T00:13:00Z')).toISOString(),
    '2026-09-28T20:00:00.000Z',
  );
});

test('morningWindowStartUtc：守卫本身被延迟到北京 11:00 仍指向当天 04:00', () => {
  // 北京 2026-09-29 11:00 = UTC 03:00
  assert.equal(
    morningWindowStartUtc(utc('2026-09-29T03:00:00Z')).toISOString(),
    '2026-09-28T20:00:00.000Z',
  );
});

test('morningWindowStartUtc：UTC 月初/年界跨日正确', () => {
  // 北京 2027-01-01 08:13 = UTC 2026-12-31 16:13... 实际为 UTC 2027-01-01 00:13
  assert.equal(
    morningWindowStartUtc(utc('2027-01-01T00:13:00Z')).toISOString(),
    '2026-12-31T20:00:00.000Z',
  );
});

test('pushStepSucceeded：推送步骤成功 → true', () => {
  const job = { steps: [
    { name: 'Checkout', conclusion: 'success' },
    { name: 'Push daily hot list to DingTalk', conclusion: 'success' },
  ] };
  assert.equal(pushStepSucceeded(job), true);
});

test('pushStepSucceeded：午间构建 run 成功但推送步骤被 skip → false', () => {
  const job = { steps: [
    { name: 'Commit and push', conclusion: 'success' },
    { name: 'Push daily hot list to DingTalk', conclusion: 'skipped' },
  ] };
  assert.equal(pushStepSucceeded(job), false);
});

test('pushStepSucceeded：步骤失败 / 不存在 / 无 steps → false', () => {
  assert.equal(pushStepSucceeded({ steps: [
    { name: 'Push daily hot list to DingTalk', conclusion: 'failure' },
  ] }), false);
  assert.equal(pushStepSucceeded({ steps: [] }), false);
  assert.equal(pushStepSucceeded(null), false);
});

test('decideGuardAction：有成功推送 → ok', async () => {
  const runs = [{ status: 'completed' }, { status: 'completed' }];
  const action = await decideGuardAction(runs, async run => run === runs[1]);
  assert.equal(action, 'ok');
});

test('decideGuardAction：都推过但没在跑 → dispatch（补发）', async () => {
  const runs = [{ status: 'completed' }];
  assert.equal(await decideGuardAction(runs, async () => false), 'dispatch');
});

test('decideGuardAction：没推过但有在跑 → wait（等第二轮再查）', async () => {
  const runs = [{ status: 'completed' }, { status: 'in_progress' }];
  assert.equal(await decideGuardAction(runs, async () => false), 'wait');
  assert.equal(await decideGuardAction([{ status: 'queued' }], async () => false), 'wait');
});

test('decideGuardAction：空列表 → dispatch', async () => {
  assert.equal(await decideGuardAction([], async () => false), 'dispatch');
});
