#!/usr/bin/env node
/**
 * 版本摘要库（阶段 A 基线，AIHOT_IMPLEMENTATION_PLAN §4 A-01）。
 *
 * 目的：基线回放的产物不只依赖输入样本，还依赖代码、配置、提示词与运行环境。
 * collectVersionManifest 把这些的 sha256 摘要集中记录进 manifest，让「这次基线
 * 是在哪套版本上跑出来的」可追溯——B 阶段改动后重跑，摘要变化即定位变量。
 *
 * 纯函数 + 只读 fs/git，不发网络请求。提示词目前是 jev.mjs 内的字面量，
 * 故以该文件 hash 作代理；C 阶段提示词外置到 data/prompts/ 后改为逐条 hash。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** 键排序的稳定序列化（同一对象任何键序 → 同一字符串；也供 jev.mjs 夹具 key 复用）。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256String(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

/** 文件不存在返回 null（可选配置如 editorial-overrides.json 允许缺席）。 */
export async function sha256File(file) {
  try {
    return sha256String(await fs.readFile(file));
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

async function hashFiles(root, relPaths) {
  const out = {};
  for (const rel of relPaths) out[rel] = await sha256File(path.join(root, rel));
  return out;
}

async function listLibFiles(root) {
  try {
    const names = await fs.readdir(path.join(root, 'scripts', 'lib'));
    return names.filter(n => n.endsWith('.mjs')).sort().map(n => `scripts/lib/${n}`);
  } catch {
    return [];
  }
}

function gitInfo(root) {
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    const sha = run(['rev-parse', 'HEAD']);
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = run(['status', '--porcelain']);
    return { sha, short: sha.slice(0, 8), branch, dirty: status.length > 0 };
  } catch (e) {
    return { sha: null, short: null, branch: null, dirty: null, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 影响 Jev 判定结果的运行时开关（其余 env 不进摘要）。 */
function jevEnvSnapshot() {
  return {
    rescueThreshold: process.env.JEV_RESCUE_THRESHOLD || null,
    mergePairs: process.env.JEV_MERGE_PAIRS || null,
    review: process.env.JEV_REVIEW || null,
  };
}

/**
 * 收集本次基线运行的版本摘要。configs 中 null 表示文件缺席（合法），
 * code 中 null 表示文件缺席（异常，调用方应校验）。runtime 由调用方补时长。
 */
export async function collectVersionManifest(root, { generatedAt = new Date().toISOString() } = {}) {
  const codeFiles = ['scripts/build-daily-v2.mjs', ...(await listLibFiles(root))];
  const code = await hashFiles(root, codeFiles);
  const configFiles = [
    'data/sources.json',
    'data/filters.json',
    'data/enums.json',
    'data/source-types.json',
    'data/entities.json',
    'data/regions.json',
    'data/editorial-overrides.json',
  ];
  const configs = await hashFiles(root, configFiles);
  const jevHash = code['scripts/lib/jev.mjs'];
  return {
    schemaVersion: 1,
    generatedAt,
    git: gitInfo(root),
    code,
    codeDigest: sha256String(canonicalJson(code)),
    configs,
    prompts: {
      // 提示词是 jev.mjs 内字面量，以其文件 hash 作版本代理（外置后改逐条 hash）
      note: 'prompt version proxied by scripts/lib/jev.mjs sha256',
      jevMjs: jevHash,
      model: 'jev-latest',
      env: jevEnvSnapshot(),
    },
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
  };
}
