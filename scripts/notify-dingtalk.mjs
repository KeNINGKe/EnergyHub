#!/usr/bin/env node
/**
 * 每日热点 → 钉钉群机器人推送（加签 + markdown，发到群里，不 @ 人）。
 *
 * 读 feeds/featured.json + feeds/daily-v2.json（缺则回退 daily.json），
 * 组「热点榜 + 今日观察」markdown，POST 到钉钉自定义机器人。
 *
 * 用法：
 *   node scripts/notify-dingtalk.mjs             # 真实发送（需 DINGTALK_WEBHOOK）
 *   node scripts/notify-dingtalk.mjs --dry-run   # 只打印消息，不发送
 *
 * 环境变量：
 *   DINGTALK_WEBHOOK          完整 webhook URL（含 access_token）— 真实发送必填
 *   DINGTALK_WEBHOOK_SECRET   加签 secret（SEC…）；空则不签名（关键词/白名单模式）
 *   ENERGYHUB_URL             站点链接（默认 https://keningke.github.io/EnergyHub）
 *
 * 退出码：0 = 成功 / 未配置跳过 / --dry-run；1 = 数据缺失或发送失败
 *         （CI 侧用 continue-on-error 兜底，推送失败不阻塞抓取/部署）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSignedUrl, buildHotMessage } from './lib/dingtalk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SITE_URL = 'https://keningke.github.io/EnergyHub';

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function loadData() {
  const featured = await readJson(path.join(ROOT, 'feeds', 'featured.json'));
  const daily = (await readJson(path.join(ROOT, 'feeds', 'daily-v2.json')))
    || (await readJson(path.join(ROOT, 'feeds', 'daily.json')));
  return { featured, daily };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const { featured, daily } = await loadData();
  if (!featured || !daily) {
    console.error('缺少 feeds/featured.json 或 daily 数据，无法推送。请先运行 npm run build:v2。');
    process.exit(1);
  }

  const siteUrl = process.env.ENERGYHUB_URL || DEFAULT_SITE_URL;
  const { title, text } = buildHotMessage(featured, daily, { siteUrl });

  if (dryRun) {
    console.log('===== --dry-run：以下为将发送的 markdown（未发送）=====\n');
    console.log('title:', title);
    console.log('-----\n');
    console.log(text);
    return;
  }

  const webhook = process.env.DINGTALK_WEBHOOK || '';
  if (!webhook) {
    console.log('未配置 DINGTALK_WEBHOOK，跳过钉钉推送。');
    return;
  }

  const secret = process.env.DINGTALK_WEBHOOK_SECRET || '';
  const url = buildSignedUrl(webhook, secret, Date.now());
  const body = {
    msgtype: 'markdown',
    markdown: { title, text }
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error(`钉钉推送网络错误：${e.message}`);
    process.exit(1);
  }

  const json = await res.json().catch(() => null);
  if (res.ok && json && json.errcode === 0) {
    console.log(`✅ 已推送热点到钉钉（${title}）`);
    return;
  }
  console.error(`钉钉推送失败：HTTP ${res.status}${json ? ` errcode=${json.errcode} errmsg=${json.errmsg}` : ''}`);
  process.exit(1);
}

// 仅直接执行时才运行（被测试 import 时不应触发副作用）
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
