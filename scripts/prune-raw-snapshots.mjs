#!/usr/bin/env node
/**
 * 原始输入快照滚动清理（阶段 A，配合 CI RAW_SNAPSHOT_DIR）。
 * samples/raw/ 每天新增一份 gzip 快照（约 60~120KB），超期目录删除，
 * 防止仓库无限增重。默认保留 30 天；实测单日 gzip 后 >150KB 时降为 14 天。
 *
 * 用法: node scripts/prune-raw-snapshots.mjs [--keep=30]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_SNAPSHOT_DIR = path.join(ROOT, 'samples', 'raw');

/** 纯函数：给定现有日期目录名集合与保留天数，返回应删除的日期列表。 */
export function expiredDates(dateNames, keep, todayStr) {
  const today = new Date(`${todayStr}T00:00:00Z`).getTime();
  return dateNames
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .filter(d => {
      const diff = Math.round((today - new Date(`${d}T00:00:00Z`).getTime()) / 86400e3);
      return Number.isFinite(diff) && diff >= keep;
    })
    .sort();
}

async function main() {
  const arg = process.argv.slice(2).find(a => a.startsWith('--keep='));
  const keep = Number(arg?.split('=')[1]) || 30;
  let names;
  try {
    names = await fs.readdir(RAW_SNAPSHOT_DIR);
  } catch (e) {
    if (e?.code === 'ENOENT') { console.log('samples/raw/ 不存在，无需清理。'); return; }
    throw e;
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  const doomed = expiredDates(names, keep, todayStr);
  for (const d of doomed) {
    await fs.rm(path.join(RAW_SNAPSHOT_DIR, d), { recursive: true, force: true });
  }
  console.log(`原始快照清理: 保留 ${keep} 天，删除 ${doomed.length} 个目录${doomed.length ? `（${doomed[0]}…${doomed[doomed.length - 1]}）` : ''}`);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
