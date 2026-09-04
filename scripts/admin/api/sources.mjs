/**
 * 信源管理 API（管理后台 P2）。
 *
 * 与 content API 同一写入铁律：磁盘重读 → 纯函数变更 → validateSources
 * → 错误非空拒写 → writeJson 原子落盘；服务进程不缓存 sources.json。
 *
 * 健康检查：POST /api/check/start 起后台任务（单任务互斥），进度经
 * GET /api/check/jobs/:id 轮询；完成后合并写 scripts/check-results.json
 * （gitignored 巡检产物，缺失则从零建）。任务表是进程内存态，重启即清。
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { PATHS } from '../lib/paths.mjs';
import { readJson, writeJson } from '../lib/jsonfile.mjs';
import { jsonOk, jsonFail, httpError } from '../router.mjs';
import { validateSources } from '../lib/validators.mjs';
import { runSourceCheck } from '../../lib/source-check.mjs';
import {
  addSource, updateSource, deleteSource, moveSource,
  addCategory, renameCategory, deleteCategory,
  wechatReport, mergeCheckResults, buildSourcesPayload, flattenItems, findUrlOwner
} from '../lib/sources-ops.mjs';

async function loadSourcesDoc() {
  const doc = await readJson(PATHS.sources);
  if (!doc || !Array.isArray(doc.categories)) {
    throw httpError(500, 'data/sources.json 缺失或结构损坏');
  }
  return doc;
}

/** 校验候选并原子落盘；失败返回 {ok:false,...}。 */
async function validateAndWrite(candidate) {
  candidate.updatedAt = new Date().toISOString().slice(0, 10);
  const { valid, errors, warnings } = validateSources(candidate);
  if (!valid) return { ok: false, errors, warnings };
  await writeJson(PATHS.sources, candidate, { bak: true });
  return { ok: true };
}

async function loadCheckResults() {
  return readJson(PATHS.checkResults);
}

async function checkResultsMtime() {
  try {
    return (await fs.stat(PATHS.checkResults)).mtime.toISOString();
  } catch {
    return null;
  }
}

/* ===== 健康检查任务表（进程内存） ===== */

const jobs = new Map(); // id -> job
const JOB_TTL_MS = 30 * 60 * 1000;

function gcJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.startedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function jobSnapshot(j) {
  return {
    id: j.id, status: j.status, scope: j.scope,
    done: j.done, total: j.total,
    startedAt: j.startedAt, finishedAt: j.finishedAt,
    error: j.error, counts: j.counts
  };
}

export function register(router) {
  /* ---- 列表（合并健康徽章） ---- */
  router.add('GET', '/api/sources', async (ctx) => {
    const [doc, results] = await Promise.all([loadSourcesDoc(), loadCheckResults()]);
    const payload = buildSourcesPayload(doc, results);
    payload.checkedAt = await checkResultsMtime();
    jsonOk(ctx, payload);
  });

  /* ---- 条目 CRUD（身份 = catId + name + url） ---- */
  router.add('POST', '/api/sources', async (ctx) => {
    const { catId, source, allowDupUrl } = ctx.body || {};
    if (!catId) throw httpError(400, '缺少 catId');
    const doc = await loadSourcesDoc();

    // url 重复不是硬错误（历史数据就有跨分类同发行方订阅）：
    // 先 409 + code=dup-url 让前端确认，allowDupUrl=true 放行
    if (!allowDupUrl) {
      const owner = findUrlOwner(doc, (source?.url || '').trim());
      if (owner) {
        return jsonFail(ctx, 409, {
          error: `url 已被「${owner}」使用：${source.url}`,
          extra: { code: 'dup-url', owner }
        });
      }
    }

    const added = addSource(doc, catId, source || {}, { allowDupUrl });
    const r = await validateAndWrite(doc);
    if (!r.ok) return jsonFail(ctx, 400, { error: '信源校验未通过，未落盘', errors: r.errors, warnings: r.warnings });
    jsonOk(ctx, { added });
  });

  router.add('PUT', '/api/sources/item', async (ctx) => {
    const { catId, name, url, patch, allowDupUrl } = ctx.body || {};
    if (!catId || !name) throw httpError(400, '缺少 catId / name');
    if (!patch || typeof patch !== 'object') throw httpError(400, '缺少 patch');
    const doc = await loadSourcesDoc();

    if (!allowDupUrl && patch.url) {
      const owner = findUrlOwner(doc, String(patch.url).trim(), { catId, name });
      if (owner) {
        return jsonFail(ctx, 409, {
          error: `url 已被「${owner}」使用：${patch.url}`,
          extra: { code: 'dup-url', owner }
        });
      }
    }

    const updated = updateSource(doc, { catId, name, url }, patch, { allowDupUrl });
    const r = await validateAndWrite(doc);
    if (!r.ok) return jsonFail(ctx, 400, { error: '信源校验未通过，未落盘', errors: r.errors, warnings: r.warnings });
    jsonOk(ctx, { updated });
  });

  router.add('DELETE', '/api/sources/item', async (ctx) => {
    const catId = ctx.query.get('catId');
    const name = ctx.query.get('name');
    const url = ctx.query.get('url') || '';
    if (!catId || !name) throw httpError(400, '缺少 catId / name');
    const doc = await loadSourcesDoc();
    const removed = deleteSource(doc, { catId, name, url });
    const r = await validateAndWrite(doc);
    if (!r.ok) return jsonFail(ctx, 400, { error: '信源校验未通过，未落盘', errors: r.errors, warnings: r.warnings });
    jsonOk(ctx, { removed });
  });

  router.add('POST', '/api/sources/move', async (ctx) => {
    const { catId, name, url, toCatId } = ctx.body || {};
    if (!catId || !name || !toCatId) throw httpError(400, '缺少 catId / name / toCatId');
    const doc = await loadSourcesDoc();
    const moved = moveSource(doc, { catId, name, url }, toCatId);
    const r = await validateAndWrite(doc);
    if (!r.ok) return jsonFail(ctx, 400, { error: '移动后校验未通过，未落盘', errors: r.errors, warnings: r.warnings });
    jsonOk(ctx, moved);
  });

  /* ---- 分类增删改 ---- */
  router.add('POST', '/api/sources/category', async (ctx) => {
    const doc = await loadSourcesDoc();
    const cat = addCategory(doc, ctx.body || {});
    const r = await validateAndWrite(doc);
    if (!r.ok) return jsonFail(ctx, 400, { error: '分类校验未通过，未落盘', errors: r.errors });
    jsonOk(ctx, { added: cat });
  });

  router.add('PUT', '/api/sources/category/:catId', async (ctx) => {
    const doc = await loadSourcesDoc();
    const cat = renameCategory(doc, ctx.params.catId, ctx.body?.name);
    const r = await validateAndWrite(doc);
    if (!r.ok) return jsonFail(ctx, 400, { error: '分类校验未通过，未落盘', errors: r.errors });
    jsonOk(ctx, { renamed: { id: cat.id, name: cat.name } });
  });

  router.add('DELETE', '/api/sources/category/:catId', async (ctx) => {
    const doc = await loadSourcesDoc();
    const cat = deleteCategory(doc, ctx.params.catId);
    const r = await validateAndWrite(doc);
    if (!r.ok) return jsonFail(ctx, 400, { error: '分类校验未通过，未落盘', errors: r.errors });
    jsonOk(ctx, { removed: { id: cat.id, name: cat.name } });
  });

  /* ---- 微信公众号源报告 ---- */
  router.add('GET', '/api/sources/wechat-report', async (ctx) => {
    const [doc, results] = await Promise.all([loadSourcesDoc(), loadCheckResults()]);
    jsonOk(ctx, wechatReport(doc, results));
  });

  /* ---- 健康检查任务 ---- */
  router.add('POST', '/api/check/start', async (ctx) => {
    gcJobs();
    for (const j of jobs.values()) {
      if (j.status === 'running') {
        throw httpError(409, `已有检查任务在跑（${j.done}/${j.total}），请等它结束或稍后再试`);
      }
    }

    const doc = await loadSourcesDoc();
    const scope = ctx.body?.scope || 'all';
    let items;
    if (scope === 'all') {
      items = flattenItems(doc);
    } else if (Array.isArray(ctx.body?.urls)) {
      const wanted = new Set(ctx.body.urls.map(String));
      items = flattenItems(doc).filter(it => wanted.has(it.url));
      if (!items.length) throw httpError(400, '给出的 url 没有匹配到任何信源');
    } else {
      items = flattenItems(doc).filter(it => it.catId === scope);
      if (!items.length) throw httpError(400, `分类无信源或不存在: ${scope}`);
    }

    const job = {
      id: randomUUID().slice(0, 8),
      status: 'running', scope,
      done: 0, total: items.length,
      startedAt: Date.now(), finishedAt: null,
      error: null, counts: null
    };
    jobs.set(job.id, job);

    // 后台跑，不阻塞响应；onProgress 直接更新任务表供轮询
    runSourceCheck(items, {
      onProgress: (done) => { job.done = done; }
    }).then(async (results) => {
      const existing = await loadCheckResults();
      await writeJson(PATHS.checkResults, mergeCheckResults(existing, results));
      job.status = 'done';
      job.finishedAt = Date.now();
      job.counts = {
        ok: results.filter(r => r.issue === 'ok').length,
        noLink: results.filter(r => r.issue === 'no-link').length,
        problems: results.filter(r => r.issue && r.issue !== 'ok' && r.issue !== 'no-link').length
      };
    }).catch((e) => {
      job.status = 'error';
      job.finishedAt = Date.now();
      job.error = e.message;
    });

    jsonOk(ctx, jobSnapshot(job));
  });

  router.add('GET', '/api/check/jobs/:id', async (ctx) => {
    gcJobs();
    const j = jobs.get(ctx.params.id);
    if (!j) throw httpError(404, '任务不存在或已过期（服务重启也会清空任务表）');
    jsonOk(ctx, jobSnapshot(j));
  });

  /* 最近一个任务（UI 刷新后找回进行中的任务） */
  router.add('GET', '/api/check/latest', async (ctx) => {
    gcJobs();
    let latest = null;
    for (const j of jobs.values()) {
      if (!latest || j.startedAt > latest.startedAt) latest = j;
    }
    jsonOk(ctx, latest ? jobSnapshot(latest) : null);
  });
}
