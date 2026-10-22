#!/usr/bin/env node
/**
 * 一次性演示：对今日精选 top-3 事件生成「事实/影响/待跟踪」并打印（阶段 D）。
 *
 * 不走完整构建、不写任何 feeds/榜单/曝光——只读 feeds/daily-v2.json +
 * feeds/featured.json，调 observe.mjs 生成观察后打印到终端。用于本地肉眼验证
 * 观察生成效果（配好 JEV_FALLBACK_* 后跑）。
 *
 * 用法：
 *   JEV_FALLBACK_BASE_URL=... JEV_FALLBACK_API_KEY=... JEV_FALLBACK_MODEL=... \
 *     node scripts/demo-observe.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateObservations } from './lib/observe.mjs';
import { fallbackConfigured } from './lib/jev.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const featured = JSON.parse(await fs.readFile(path.join(ROOT, 'feeds', 'featured.json'), 'utf8'));
const daily = JSON.parse(await fs.readFile(path.join(ROOT, 'feeds', 'daily-v2.json'), 'utf8'));

if (!fallbackConfigured()) {
  console.error('未配置备胎网关：请先设置 JEV_FALLBACK_BASE_URL + JEV_FALLBACK_API_KEY（可加 JEV_FALLBACK_MODEL）。');
  process.exit(1);
}

const { observations, counts } = await generateObservations(daily.items || [], featured.featuredEventIds || []);
console.log(`观察生成：目标 ${counts.targeted} · 生成 ${counts.generated} · 回退 ${counts.fallback} · 失败 ${counts.failed}\n`);
for (const o of observations) {
  console.log('─'.repeat(64));
  console.log(`[${o.topic}] ${o.title}`);
  console.log(`事实：${o.fact || '(空)'}`);
  if (o.implication) console.log(`影响：${o.implication}`);
  if (o.watchNext) console.log(`待跟踪：${o.watchNext}`);
  if (o.evidenceUrls?.length) console.log(`引用：${o.evidenceUrls.join(' ')}`);
  if (o.mode === 'fallback') console.log(`（回退模式）`);
  if (o.error) console.log(`[失败] ${o.error}`);
}
