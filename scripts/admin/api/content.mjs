/**
 * 内容运营 API（管理后台 P1）。
 *
 * 写入铁律：每个写端点都是「磁盘重读 → content-ops 纯函数变更 → validateOverrides
 * → 错误非空拒写 → writeJson 原子落盘」，服务进程不缓存任何数据文件。
 * overrides/feeds/daily-v2/featured 的角色见 lib/paths.mjs（daily/featured 只读）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PATHS } from '../lib/paths.mjs';
import { readJson, writeJson } from '../lib/jsonfile.mjs';
import { jsonOk, jsonFail, httpError } from '../router.mjs';
import { loadEnums, validateOverrides } from '../../lib/schema.mjs';
import { applyOverrides } from '../../lib/overrides.mjs';
import { keywordHit } from '../../lib/filter.mjs';
import {
  applyOverrideOp, scanStale, pruneOld, buildTodayPayload
} from '../lib/content-ops.mjs';

const KEEP_DAYS = 3;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function loadDaily() {
  const daily = (await readJson(PATHS.dailyV2)) || (await readJson(PATHS.dailyV1));
  if (!daily) throw httpError(500, 'feeds/daily 数据缺失，请先运行 npm run build:v2');
  if (!daily.date) throw httpError(500, 'daily 数据缺少 date 字段');
  return daily;
}

async function loadOverridesOrEmpty() {
  return (await readJson(PATHS.editorialOverrides)) || { schemaVersion: 1, byDate: {} };
}

/**
 * 覆盖候选校验 + 清理旧日期 + 原子落盘。
 * 校验失败返回 {ok:false, errors, warnings}（调用方据此响应 400），成功返回 {ok:true, config}。
 */
async function validateAndWrite(candidate, daily) {
  const { valid, errors, warnings } = await validateOverrides(candidate, daily);
  if (!valid) return { ok: false, errors, warnings };
  const { config } = pruneOld(candidate, daily.date, KEEP_DAYS);
  await writeJson(PATHS.editorialOverrides, config, { bak: true });
  return { ok: true, config };
}

export function register(router) {
  /* ---- 今日事件 + 覆盖状态 ---- */
  router.add('GET', '/api/content/today', async (ctx) => {
    const [daily, featured, overrides, enums] = await Promise.all([
      loadDaily(),
      readJson(PATHS.featured),
      loadOverridesOrEmpty(),
      loadEnums()
    ]);
    jsonOk(ctx, buildTodayPayload(daily, featured, overrides, enums));
  });

  /* ---- 施加一个覆盖操作 ---- */
  router.add('POST', '/api/content/override', async (ctx) => {
    const { op, id, value, index } = ctx.body || {};
    if (!op) throw httpError(400, '缺少 op');
    if (['hide', 'unhide', 'forceFeature', 'unfeature'].includes(op) && !id) {
      throw httpError(400, `操作 ${op} 需要 id`);
    }
    const daily = await loadDaily();
    const overrides = await loadOverridesOrEmpty();

    let result;
    try {
      result = applyOverrideOp(overrides, overrides.globalHiddenIds || [], daily.date, { op, id, value, index });
    } catch (e) {
      throw httpError(400, e.message);
    }

    const r = await validateAndWrite(result.config, daily);
    if (!r.ok) {
      return jsonFail(ctx, 400, { error: '覆盖配置校验未通过，未落盘', errors: r.errors, warnings: r.warnings });
    }
    jsonOk(ctx, {
      globalIds: result.globalIds,
      todayConfig: r.config.byDate?.[daily.date] || {}
    });
  });

  /* ---- 覆盖生效预览（不落盘）---- */
  router.add('POST', '/api/content/preview', async (ctx) => {
    const daily = await loadDaily();
    const [featured, overrides, enums] = await Promise.all([
      readJson(PATHS.featured),
      loadOverridesOrEmpty(),
      loadEnums()
    ]);
    const todayConf = overrides.byDate?.[daily.date] || {};
    const globalIds = overrides.globalHiddenIds || [];

    const d = structuredClone(daily);
    const f = structuredClone(featured || { observations: [], featuredEventIds: [] });
    const { errors, warnings } = applyOverrides(d, f, todayConf, enums, globalIds);

    jsonOk(ctx, {
      date: daily.date,
      itemCount: { before: daily.items.length, after: d.items.length },
      featuredIds: { before: featured?.featuredEventIds || [], after: f.featuredEventIds },
      hotEventIds: { before: featured?.hotEventIds || [], after: f.hotEventIds || [] },
      observations: f.observations || [],
      pendingHide: globalIds.filter(id => daily.items.some(it => it.id === id)),
      errors,
      warnings
    });
  });

  /* ---- stale 扫描 / 旧配置清理 ---- */
  router.add('GET', '/api/content/stale', async (ctx) => {
    const [daily, overrides] = await Promise.all([loadDaily(), loadOverridesOrEmpty()]);
    jsonOk(ctx, { stale: scanStale(overrides, daily) });
  });

  router.add('POST', '/api/content/prune', async (ctx) => {
    const daily = await loadDaily();
    const overrides = await loadOverridesOrEmpty();
    const keepDays = Number(ctx.body?.keepDays) || KEEP_DAYS;
    const { config, pruned } = pruneOld(overrides, daily.date, keepDays);
    if (pruned.length) await writeJson(PATHS.editorialOverrides, config, { bak: true });
    jsonOk(ctx, { pruned, todayConfig: config.byDate?.[daily.date] || {}, globalIds: config.globalHiddenIds || [] });
  });

  /* ---- 微信公众号种子（管线会回写：写前必重读、按条操作）---- */
  router.add('GET', '/api/content/wechat', async (ctx) => {
    jsonOk(ctx, (await readJson(PATHS.wechatSeeds)) || { version: '1.0.0', updatedAt: null, articles: [] });
  });

  router.add('POST', '/api/content/wechat', async (ctx) => {
    const incoming = Array.isArray(ctx.body?.articles) ? ctx.body.articles : [];
    if (!incoming.length) throw httpError(400, '缺少 articles 数组');
    for (const a of incoming) {
      if (!a.url && !a.sourceName) throw httpError(400, '每条种子至少要有 url 或 sourceName');
    }
    // 磁盘重读，保留管线回写的 fetched/addedAt/title 等字段
    const seed = (await readJson(PATHS.wechatSeeds)) || { version: '1.0.0', updatedAt: null, articles: [] };
    if (!Array.isArray(seed.articles)) seed.articles = [];
    const existing = new Set(seed.articles.map(a => a.url).filter(Boolean));
    let added = 0;
    for (const a of incoming) {
      if (a.url && existing.has(a.url)) continue;
      seed.articles.push({ category: a.category || '', sourceName: a.sourceName || '', url: a.url || '' });
      if (a.url) existing.add(a.url);
      added++;
    }
    seed.updatedAt = new Date().toISOString();
    await writeJson(PATHS.wechatSeeds, seed, { bak: true });
    jsonOk(ctx, { added, articles: seed.articles });
  });

  router.add('DELETE', '/api/content/wechat/:i', async (ctx) => {
    const idx = parseInt(ctx.params.i, 10);
    const seed = await readJson(PATHS.wechatSeeds);
    if (!seed || !Array.isArray(seed.articles)) throw httpError(404, '种子文件不存在或为空');
    if (!(idx >= 0 && idx < seed.articles.length)) throw httpError(404, `序号越界: ${idx}`);
    const [removed] = seed.articles.splice(idx, 1); // 磁盘重读后定点 splice
    seed.updatedAt = new Date().toISOString();
    await writeJson(PATHS.wechatSeeds, seed, { bak: true });
    jsonOk(ctx, { removed, articles: seed.articles });
  });

  /* ---- 深度阅读（url 为键）---- */
  router.add('GET', '/api/content/deep', async (ctx) => {
    jsonOk(ctx, (await readJson(PATHS.deep)) || { mode: 'deep', updatedAt: null, note: '', items: [] });
  });

  router.add('POST', '/api/content/deep', async (ctx) => {
    const item = ctx.body || {};
    if (!item.url || !/^https?:\/\//.test(item.url)) throw httpError(400, '缺少合法 url');
    if (!item.title) throw httpError(400, '缺少 title');
    const doc = (await readJson(PATHS.deep)) || { mode: 'deep', updatedAt: null, note: '', items: [] };
    if (!Array.isArray(doc.items)) doc.items = [];
    const entry = {
      title: String(item.title),
      url: String(item.url),
      source: item.source ? String(item.source) : '',
      summary: item.summary ? String(item.summary) : '',
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      date: item.date || new Date().toISOString().slice(0, 10),
      addedBy: 'admin'
    };
    const i = doc.items.findIndex(x => x.url === entry.url);
    if (i >= 0) doc.items[i] = { ...doc.items[i], ...entry }; // upsert
    else doc.items.push(entry);
    doc.updatedAt = new Date().toISOString().slice(0, 10);
    await writeJson(PATHS.deep, doc, { bak: true });
    jsonOk(ctx, doc);
  });

  router.add('DELETE', '/api/content/deep/:url', async (ctx) => {
    const url = ctx.params.url;
    const doc = await readJson(PATHS.deep);
    if (!doc || !Array.isArray(doc.items)) throw httpError(404, '深研文件不存在或为空');
    const next = doc.items.filter(x => x.url !== url);
    if (next.length === doc.items.length) throw httpError(404, `未找到该 url: ${url}`);
    doc.items = next;
    doc.updatedAt = new Date().toISOString().slice(0, 10);
    await writeJson(PATHS.deep, doc, { bak: true });
    jsonOk(ctx, doc);
  });

  /* ---- 过滤沙箱：候选词 → 命中今日/历史语料哪些条 ---- */
  router.add('POST', '/api/content/sandbox', async (ctx) => {
    const words = (Array.isArray(ctx.body?.words) ? ctx.body.words : [])
      .map(w => String(w).trim()).filter(Boolean);
    if (!words.length) throw httpError(400, '缺少 words 数组');

    const run = (items) => words.map(word => {
      const kills = [];
      for (const it of items) {
        const text = `${it.title || ''} ${it.originalTitle || ''} ${it.summary || ''}`;
        if (keywordHit(text, word)) {
          kills.push({ id: it.id, title: it.title || it.originalTitle || '', source: it.source?.name || '' });
        }
      }
      return { word, killCount: kills.length, kills: kills.slice(0, 20) };
    });

    const daily = await loadDaily();
    const result = { date: daily.date, corpus: { count: daily.items.length }, words: run(daily.items) };

    // 附带最新历史样本（标注其日期，供对照历史误伤）；缺失不影响主结果
    try {
      const dir = path.join(ROOT, 'samples', 'daily');
      const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort();
      const latest = files[files.length - 1];
      if (latest) {
        const sample = JSON.parse(await fs.readFile(path.join(dir, latest), 'utf8'));
        result.sample = {
          date: latest.replace('.json', ''),
          count: (sample.items || []).length,
          words: run(sample.items || [])
        };
      }
    } catch { /* 样本缺失不影响主结果 */ }

    jsonOk(ctx, result);
  });
}
