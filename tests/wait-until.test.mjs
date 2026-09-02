import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { beijingHhmm, secondsUntilBeijing } from '../scripts/lib/wait-until.mjs';

const execFileAsync = promisify(execFile);

const utc = s => new Date(s);

test('secondsUntilBeijing：北京 00:30 距 08:00 还有 7.5 小时', () => {
  // 北京 2026-09-02 00:30 = UTC 2026-09-01 16:30
  assert.equal(secondsUntilBeijing('08:00', utc('2026-09-01T16:30:00Z')), 7.5 * 3600);
});

test('secondsUntilBeijing：北京 07:30 距 08:00 还有 30 分钟', () => {
  assert.equal(secondsUntilBeijing('08:00', utc('2026-09-01T23:30:00Z')), 1800);
});

test('secondsUntilBeijing：恰好 08:00 视为已过，立即执行', () => {
  assert.equal(secondsUntilBeijing('08:00', utc('2026-09-02T00:00:00Z')), 0);
});

test('secondsUntilBeijing：过了目标时刻返回 0（不等明天）', () => {
  // 北京 12:00 = UTC 04:00
  assert.equal(secondsUntilBeijing('08:00', utc('2026-09-02T04:00:00Z')), 0);
});

test('secondsUntilBeijing：不足 1 秒向上取整为 1', () => {
  // 北京 07:59:59.4 = UTC 23:59:59.4，差 0.6 秒
  assert.equal(secondsUntilBeijing('08:00', utc('2026-09-01T23:59:59.400Z')), 1);
});

test('secondsUntilBeijing：当天目标已过不跨天等待（23:00 → 0）', () => {
  // 北京 23:00（UTC 15:00）当天 08:00 已过：立即执行，绝不等到明天
  assert.equal(secondsUntilBeijing('08:00', utc('2026-09-01T15:00:00Z')), 0);
});

test('beijingHhmm：UTC 转北京时间', () => {
  assert.equal(beijingHhmm(utc('2026-09-01T16:30:00Z')), '00:30');
  assert.equal(beijingHhmm(utc('2026-09-01T23:30:00Z')), '07:30');
  assert.equal(beijingHhmm(utc('2026-09-01T15:59:05Z')), '23:59');
});

test('secondsUntilBeijing：非法输入抛错', () => {
  assert.throws(() => secondsUntilBeijing('8点'));
  assert.throws(() => secondsUntilBeijing('25:00'));
  assert.throws(() => secondsUntilBeijing('08:60'));
  assert.throws(() => secondsUntilBeijing(''));
});

test('CLI 冒烟：目标 00:00 恒已过，应立即退出且退出码 0', async () => {
  const cli = fileURLToPath(new URL('../scripts/lib/wait-until.mjs', import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [cli, '00:00'], { timeout: 30000 });
  assert.match(stdout, /已过/);
});
