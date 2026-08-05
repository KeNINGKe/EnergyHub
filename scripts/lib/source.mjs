#!/usr/bin/env node
/**
 * 来源类型与一手来源识别（B-03）。
 *
 * 配置：data/source-types.json —— tagRules 把 sources.json 的 tags 映射为
 * sourceType（primary/media/research/community），sourceOverrides 按来源名强制覆盖。
 * 判定优先级：sourceOverrides > 第一个命中的类型 tag > defaultType。
 *
 * 用法：
 *   import { loadSourceTypes, loadSourceMap, classifySourceType, isPrimarySource } from './source.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let sourceTypesCache = null;
let sourceMapCache = null;

export async function loadSourceTypes() {
  if (sourceTypesCache) return sourceTypesCache;
  sourceTypesCache = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'source-types.json'), 'utf8'));
  return sourceTypesCache;
}

/** 加载 data/sources.json 并建立 name → source 映射（含分类名）。 */
export async function loadSourceMap() {
  if (sourceMapCache) return sourceMapCache;
  const raw = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'sources.json'), 'utf8'));
  const byName = new Map();
  for (const cat of raw.categories) {
    for (const src of cat.sources) {
      byName.set(src.name, { ...src, category: cat.id });
    }
  }
  sourceMapCache = { byName, total: byName.size };
  return sourceMapCache;
}

/**
 * 判定单个来源的类型。
 * @param {{name:string, tags?:string[]}} source
 * @param {object} types source-types.json 配置
 * @returns {{ type: string, evidence: string }}
 */
export function classifySourceType(source, types) {
  const name = source?.name || '';
  const ov = types.sourceOverrides[name];
  if (ov) return { type: ov, evidence: `override:${name}` };
  for (const tag of source?.tags || []) {
    const t = types.tagRules[tag];
    if (t) return { type: t, evidence: `tag:${tag}` };
  }
  return { type: types.defaultType, evidence: 'default' };
}

/**
 * 按来源名查询类型（未在 sources.json 中的名字返回 defaultType）。
 */
export async function sourceTypeByName(name, types) {
  const { byName } = await loadSourceMap();
  const src = byName.get(name) || { name, tags: [] };
  return classifySourceType(src, types);
}

/**
 * 一手来源识别：primary 类型即视为一手（用于事件主条目排序，B-07）。
 * 事件内 isPrimary 的最终判定在 B-06/B-07（谁是最一手的那条）。
 */
export async function isPrimarySource(name, types) {
  const { type } = await sourceTypeByName(name, types);
  return type === 'primary';
}

// CLI 自检：node scripts/lib/source.mjs "来源名"
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const name = process.argv[2];
  const types = await loadSourceTypes();
  const { type, evidence } = await sourceTypeByName(name, types);
  console.log(`${name} → ${type} (${evidence})`);
}
