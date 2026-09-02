#!/usr/bin/env node
/**
 * 等到指定"北京时间 hh:mm"再继续 —— 用于把钉钉推送卡在每天早上 08:00 整。
 *
 * 背景：GitHub 免费 runner 的 schedule 排队延迟不可控（早晨构建实际在
 * 北京 06:00~08:00 之间完成）。与其靠 cron 猜时间，不如构建完成后在这里
 * 等到目标时刻再推送：早于目标完成就睡到准点，晚于目标完成则立即继续
 * （绝不等到明天）。
 *
 * 用法：
 *   node scripts/lib/wait-until.mjs 08:00
 *
 * 也可被 import 复用：
 *   secondsUntilBeijing(hhmm, now)  距目标的秒数，已过则 0
 *   beijingHhmm(now)                当前北京时间 HH:mm（日志用）
 */
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BEIJING_OFFSET_MIN = 8 * 60; // UTC+8，无夏令时

function parseHhmm(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) throw new Error(`无效时间（应为 HH:mm）: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`无效时间（应为 HH:mm）: ${hhmm}`);
  return h * 60 + min;
}

/** 当前北京时间 HH:mm 字符串。 */
export function beijingHhmm(now = new Date()) {
  const bj = new Date(now.getTime() + BEIJING_OFFSET_MIN * 60 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
}

/**
 * 距下一个"北京时间 hh:mm"的秒数；已过该时刻则返回 0（立即执行，不等明天）。
 * @param {string} hhmm 目标时刻（北京时间，HH:mm）
 * @param {Date} now 供测试注入的当前时间
 */
export function secondsUntilBeijing(hhmm, now = new Date()) {
  const targetMin = parseHhmm(hhmm);
  const bj = new Date(now.getTime() + BEIJING_OFFSET_MIN * 60 * 1000);
  const nowMin = bj.getUTCHours() * 60 + bj.getUTCMinutes() + bj.getUTCSeconds() / 60;
  const diffMin = targetMin - nowMin;
  if (diffMin <= 0) return 0;
  return Math.ceil(diffMin * 60);
}

async function main() {
  const hhmm = process.argv[2] || '08:00';
  const secs = secondsUntilBeijing(hhmm);
  if (secs <= 0) {
    console.log(`当前北京时间 ${beijingHhmm()}，已过 ${hhmm}，不等待，立即继续。`);
    return;
  }
  console.log(`当前北京时间 ${beijingHhmm()}，等待 ${Math.ceil(secs / 60)} 分钟至 ${hhmm} 再继续...`);
  await sleep(secs * 1000);
  console.log('等待结束，继续。');
}

// 仅直接执行时运行（被测试 import 时不应触发副作用）
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
