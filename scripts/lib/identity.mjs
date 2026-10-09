#!/usr/bin/env node
/**
 * 稳定身份（阶段 B 基建，AIHOT_IMPLEMENTATION_PLAN §5 B-02/B-03）。
 *
 * articleId：文章级稳定身份——保守归一 URL（与 dedup 去重键同口径，保留非跟踪
 *   参数）的哈希，URL 缺失时回退规范化标题。跨日稳定，供人工合并约束
 *   （data/event-overrides.json）引用；内部身份，不写入公开 daily 协议。
 *   guid 不参与（跨源不稳定，且对象型 guid 有 xml2js 坑，见 dedup.mjs 注释）。
 *
 * resolveSourceId：来源身份解析（协议 §10 规则 3）——优先 sources.json 配置 id
 *   与 data/source-aliases.json 显式别名表；公众号各账独立身份（不算
 *   mp.weixin.qq.com 一家）；域名只作兜底（同机构多域名需在别名表归一）；
 *   无法确认身份时保留 unknown 标记，不伪装。
 *
 * 用法：
 *   import { articleId, resolveSourceId, loadSourceAliases, loadIdentityCtx } from './identity.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalUrl, normalizeTitle } from './dedup.mjs';
import { hashId } from './compat.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let aliasesCache = null;

/** 加载 data/source-aliases.json（显式别名表，byName: 别名→身份 id）。缺失/损坏返回空表。 */
export async function loadSourceAliases() {
  if (aliasesCache) return aliasesCache;
  let doc = null;
  try {
    doc = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'source-aliases.json'), 'utf8'));
  } catch {
    doc = null;
  }
  const byName = new Map();
  for (const [name, id] of Object.entries(doc?.byName || {})) {
    if (typeof name === 'string' && name.trim() && typeof id === 'string' && id.trim()) {
      byName.set(name.trim(), id.trim());
    }
  }
  aliasesCache = { byName, schemaVersion: doc?.schemaVersion || 1 };
  return aliasesCache;
}

/**
 * 文章稳定身份：保守归一 URL 的哈希，无 URL 回退规范化标题。
 * @param {{url?:string, title?:string}} item
 * @returns {string} `art_` + 12 位十六进制
 */
export function articleId(item) {
  const key = (item?.url ? canonicalUrl(item.url) : '') || normalizeTitle(item?.title || '');
  return `art_${hashId(key).slice(0, 12)}`;
}

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * 来源身份解析。
 * @param {{name?:string, url?:string, wechat?:boolean}} source
 * @param {{sourceMap?:{byName:Map}, aliases?:{byName:Map}}} ctx loadIdentityCtx() 产物
 * @returns {{ id: string, basis: 'config'|'alias'|'wechat'|'domain'|'unknown' }}
 */
export function resolveSourceId(source, ctx = {}) {
  const name = typeof source?.name === 'string' ? source.name.trim() : '';
  // 1. sources.json 配置 id（长期方向：给 sources.json 增量补 id 字段，loadSourceMap 全量透传）
  const src = ctx.sourceMap?.byName?.get?.(name);
  if (src?.id) return { id: String(src.id), basis: 'config' };
  // 2. 显式别名表：中英文名/公众号名/多域名归一到同一身份 id
  const alias = ctx.aliases?.byName?.get?.(name);
  if (alias) return { id: alias, basis: 'alias' };
  // 3. 公众号各账独立身份：fetch 注入的 source 已是公众号名，稳定可用
  const host = hostOf(source?.url);
  if (source?.wechat === true || host === 'mp.weixin.qq.com') {
    return { id: `wechat:${name || '未知公众号'}`, basis: 'wechat' };
  }
  // 4. 域名兜底（去 www；Google News 链接在此前已解码为真实域名）
  if (host) return { id: host, basis: 'domain' };
  // 5. 无法确认身份：保留未知标记（宁可低估加分，不虚高）
  return { id: 'unknown', basis: 'unknown' };
}

/** 一次性加载来源身份上下文（sources.json 映射 + 别名表），供批量解析复用。 */
export async function loadIdentityCtx() {
  const [{ loadSourceMap }, aliases] = await Promise.all([
    import('./source.mjs'),
    loadSourceAliases()
  ]);
  const sourceMap = await loadSourceMap();
  return { sourceMap, aliases };
}

// CLI 自检：node scripts/lib/identity.mjs [来源名] [url]
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const [name, url] = process.argv.slice(2);
  const ctx = await loadIdentityCtx();
  console.log(JSON.stringify(resolveSourceId({ name, url }, ctx)));
}
