#!/usr/bin/env node
/**
 * 事件级人工合并/拆分约束（B-02，AIHOT_IMPLEMENTATION_PLAN §5）。
 *
 * data/event-overrides.json 存跨日文章级约束，articleId 引用（identity.mjs
 * 保守归一 URL 哈希，跨日稳定）：
 *   mustLinkGroups  组内文章必须合并为同一事件（传递闭包，保存时校验无冲突）
 *   cannotLinkPairs 两篇文章禁止合并（即使自动判定/ Jev 仲裁说像）
 *
 * 三处强制点：merge.mjs judgePair 第 1 层与 clusterUnionBlocked（B-01 已接）、
 * overrides.mjs applyOverrides mergeGroups（本阶段接入）。
 *
 * 用法：
 *   import { loadEventOverrides, toLinks } from './event-overrides.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const EVENT_OVERRIDES_PATH = path.join(ROOT, 'data', 'event-overrides.json');

/** 空骨架（缺失/损坏时的回退形态，也是 data/event-overrides.json 的初始内容）。 */
export const EMPTY_EVENT_OVERRIDES = {
  schemaVersion: 1,
  updatedAt: null,
  updatedBy: 'admin',
  mustLinkGroups: [],
  cannotLinkPairs: []
};

/** 读取事件约束；文件缺失或损坏返回空骨架（约束是增强，不因文件问题堵构建）。 */
export async function loadEventOverrides() {
  let doc = null;
  try {
    doc = JSON.parse(await fs.readFile(EVENT_OVERRIDES_PATH, 'utf8'));
  } catch {
    doc = null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return structuredClone(EMPTY_EVENT_OVERRIDES);
  return {
    ...structuredClone(EMPTY_EVENT_OVERRIDES),
    ...doc,
    mustLinkGroups: Array.isArray(doc.mustLinkGroups) ? doc.mustLinkGroups : [],
    cannotLinkPairs: Array.isArray(doc.cannotLinkPairs) ? doc.cannotLinkPairs : []
  };
}

/**
 * 转 merge.mjs links 形态（judgePair / clusterUnionBlocked / applyOverrides 共用）。
 * @returns {{ mustLink: string[][], cannotLink: [string, string][] }}
 */
export function toLinks(doc) {
  const valid = g => Array.isArray(g) && g.every(x => typeof x === 'string' && x);
  const idsOf = e => (e && Array.isArray(e.articleIds) ? e.articleIds : []);
  return {
    mustLink: (doc?.mustLinkGroups || [])
      .map(idsOf)
      .filter(g => valid(g) && g.length >= 2)
      .map(g => [...new Set(g)]),
    cannotLink: (doc?.cannotLinkPairs || [])
      .map(idsOf)
      .filter(g => valid(g) && g.length === 2)
      .filter(g => g[0] !== g[1])
  };
}
