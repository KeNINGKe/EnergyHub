#!/usr/bin/env node
/**
 * 提取 git 历史中的 daily.json 快照，作为回放测试样本夹具（阶段 A-01）。
 *
 * daily.json 的 date 字段按北京时间（UTC+8）计算，一天可能有多班更新
 * （05:00 / 12:00 CST），因此按 date 字段分组，每个日期只保留最新一次提交
 * 的版本，保证「连续 N 天、每天一份」的稳定样本。
 *
 * 用法:
 *   node scripts/extract-samples.mjs [--days=7] [--out=samples]
 *
 * 输出:
 *   <out>/daily/<date>.json   每天一份原始 daily.json 快照
 *   <out>/manifest.json       样本清单（日期、commit、抓取统计）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const days = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] || '7', 10);
const outDir = args.find(a => a.startsWith('--out='))?.split('=')[1] || 'samples';

async function git(...cmd) {
  const { stdout } = await execFileAsync('git', cmd, { maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

async function main() {
  // 1. 所有修改过 feeds/daily.json 的提交（含提交时间戳）
  const rawLog = await git('log', '--format=%H %ct', '--', 'feeds/daily.json');
  const commits = rawLog.split('\n').filter(Boolean).map(line => {
    const [hash, ct] = line.trim().split(' ');
    return { hash, ct: Number(ct) };
  });
  if (!commits.length) throw new Error('git 历史中找不到 feeds/daily.json 的提交');

  // 2. 读取每个提交的 daily.json 的 date 字段，按日期保留最新版本
  const byDate = new Map(); // date -> { hash, ct, data }
  for (const { hash, ct } of commits) {
    let raw;
    try {
      raw = await git('show', `${hash}:feeds/daily.json`);
    } catch {
      continue; // 该提交可能删除过该文件或路径不同
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!data || typeof data.date !== 'string') continue;
    const prev = byDate.get(data.date);
    if (!prev || prev.ct < ct) byDate.set(data.date, { hash, ct, data });
  }

  // 3. 取最近的 N 天（date 为 YYYY-MM-DD 字符串，可直接排序）
  const dates = [...byDate.keys()].sort().slice(-days);
  if (!dates.length) throw new Error('未解析到任何带 date 字段的样本');

  // 4. 写入 daily/<date>.json 并构建 manifest
  const dailyDir = path.join(outDir, 'daily');
  await fs.mkdir(dailyDir, { recursive: true });

  const samples = [];
  let totalItems = 0;
  for (const date of dates) {
    const { hash, data } = byDate.get(date);
    const file = path.join('daily', `${date}.json`);
    await fs.writeFile(path.join(outDir, file), JSON.stringify(data, null, 2) + '\n');
    totalItems += Array.isArray(data.items) ? data.items.length : 0;
    samples.push({
      date,
      file,
      commit: hash,
      commitShort: hash.slice(0, 7),
      generatedAt: data.generatedAt || null,
      totalSources: data.totalSources ?? null,
      successSources: data.successSources ?? null,
      count: data.count ?? (Array.isArray(data.items) ? data.items.length : 0)
    });
    console.log(`  ${date}  commit=${hash.slice(0, 7)}  items=${samples[samples.length - 1].count}  success=${data.successSources}/${data.totalSources}`);
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    note: 'A-01 回放测试样本：从 git 历史提取的 daily.json 快照，每天保留最新版本。',
    sourceRepo: 'KeNINGKe/EnergyHub@main',
    sourceFile: 'feeds/daily.json',
    extraction: {
      script: 'scripts/extract-samples.mjs',
      args,
      days,
      dedupeRule: '按 date 字段（北京时间）分组，每天取提交时间最新的版本'
    },
    samples,
    stats: {
      dates: dates.length,
      totalItems,
      avgItemsPerDay: Math.round((totalItems / dates.length) * 10) / 10
    }
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(`\n✅ 已提取 ${dates.length} 天样本 -> ${path.resolve(outDir)}/`);
  console.log(`   样本清单: ${path.join(outDir, 'manifest.json')}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
