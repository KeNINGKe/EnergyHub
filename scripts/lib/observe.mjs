#!/usr/bin/env node
/**
 * 有依据的今日观察生成（阶段 D，AIHOT_IMPLEMENTATION_PLAN §7）。
 *
 * 问题：给已入选「今日观察」的事件，写「事实 / 影响 / 待跟踪」，而非重复标题。
 * 与精选价值评分（selection-score.mjs）是两个不同任务：评分问「值不值得占位」，
 * 观察问「发生了什么、意味着什么、接下来盯什么」。
 *
 * 事实约束（§7）：
 *  - 数字/单位/日期/公司名/项目名只能依据输入材料，不得臆测；
 *  - 原文事实与推断分开，不得把签约写成投产、规划写成已建成；
 *  - evidenceUrls 只能从输入 URL 白名单（主 URL + relatedSources）里选；
 *  - 材料不足或调用失败 → 回退完整标题，mode=fallback。
 *
 * 调用层次（与 selection-score 同构）：
 *   1. OBSERVATION_REPLAY_FILE / OBSERVATION_RECORD_FILE：固定回执夹具；
 *   2. live：经 C-02 回执层（lib/ai-receipts.mjs 缓存 + 额度守卫）；
 *   3. 传输复用 jev 备胎网关（fallbackConfig / fallbackEndpoint，OpenAI 兼容）。
 *
 * 影子硬约束（方案 §9）：shadow 结果只写 .state/shadow/，不进 feeds、不推钉钉。
 *
 * 用法：
 *   import { buildObservationPrompt, parseObservationContent, fallbackObservation,
 *            observeEvent, generateObservations, runShadowObservation } from './observe.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256String } from './digest.mjs';
import { fallbackConfig, fallbackConfigured, fallbackEndpoint } from './jev.mjs';
import { withReceipts, receiptsEnabled, defaultStoreInstance, defaultGuardInstance } from './ai-receipts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const TIMEOUT_MS = 60_000; // 观察提示词带完整材料 + 约束，glm 类带思维链模型可超 20s
const FIXTURE_SCHEMA_VERSION = 1;

/** 输入材料里「可引用链接」白名单 = 主 URL + relatedSources 全部 URL（去重保序）。 */
export function evidenceUrlsOf(event) {
  const urls = [];
  const push = (u) => { if (typeof u === 'string' && u && !urls.includes(u)) urls.push(u); };
  push(event?.url);
  for (const s of event?.relatedSources || []) {
    push(typeof s === 'string' ? s : s?.url);
  }
  return urls;
}

/** 观察输入的材料简报（标题/摘要截断防御；evidenceUrls 供白名单约束）。 */
export function observationBrief(event) {
  return {
    title: event.title || '',
    originalTitle: event.originalTitle || '',
    summary: String(event.summary || '').slice(0, 1200),
    topic: event.topic || null,
    region: event.region || null,
    entities: (event.entities || []).slice(0, 10),
    metrics: (event.metrics || []).slice(0, 6),
    sourceName: event.source?.name || null,
    publishedAt: event.publishedAt || null,
    evidenceUrls: evidenceUrlsOf(event),
  };
}

/** 构建观察提示词（纯函数；版本随本文件 sha256 走）。 */
export function buildObservationPrompt(event) {
  const brief = observationBrief(event);
  const evidence = brief.evidenceUrls || [];
  return [
    '你是能源行业日报的观察撰稿人。为一条已入选「今日观察」的事件写结构化观察。',
    '读者画像：跟踪储能/PCS/SST/AIDC 供电行业的从业者。',
    '',
    '【事件材料】',
    JSON.stringify({
      title: brief.title,
      originalTitle: brief.originalTitle,
      summary: brief.summary,
      topic: brief.topic,
      region: brief.region,
      entities: brief.entities,
      metrics: brief.metrics,
      sourceName: brief.sourceName,
      publishedAt: brief.publishedAt,
    }, null, 2),
    '',
    '【可引用链接白名单】（evidenceUrls 只能从下面选，不能新增，可为空数组）',
    evidence.length ? evidence.join('\n') : '（空）',
    '',
    '【输出要求】',
    '1. fact：事件主体、动作及已披露的关键事实。数字/单位/日期/公司名/项目名只能依据上面材料，不得臆测。',
    '2. implication：与供电架构、设备需求或项目交付有关的有限推断；材料不足以支撑时留空字符串。',
    '3. watchNext：需要继续核对的交付/认证/实施节点；没有明确节点则留空字符串。',
    '4. 事实与推断分开展示：不得把签约写成投产、规划写成已建成。',
    '5. 材料不足以支撑任何推断时，implication 与 watchNext 都留空，只写 fact。',
    '',
    '只输出一个 JSON 对象，不要任何解释或其他文字：',
    '{"fact":"一句话","implication":"一句话，无则空","watchNext":"一句话，无则空","evidenceUrls":["白名单中的链接"]}',
  ].join('\n');
}

/**
 * 解析模型应答（纯函数）。容忍 markdown 围栏与前后杂文字；fact 必填，否则 null
 * （与调用失败同路径 → fallback）。evidenceUrls 过滤到白名单内（防模型编造链接，
 * 但非白名单链接只丢弃、不判整体失败——fact 本身可能仍有效）。
 */
export function parseObservationContent(content, whitelist = []) {
  const m = String(content || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const fact = typeof obj.fact === 'string' ? obj.fact.trim() : '';
  const implication = typeof obj.implication === 'string' ? obj.implication.trim() : '';
  const watchNext = typeof obj.watchNext === 'string' ? obj.watchNext.trim() : '';
  if (!fact) return null;
  const allowed = new Set(whitelist);
  const evidenceUrls = (Array.isArray(obj.evidenceUrls) ? obj.evidenceUrls : [])
    .filter((u) => typeof u === 'string' && u && allowed.has(u))
    .slice(0, 3);
  return {
    fact: fact.slice(0, 300),
    implication: implication.slice(0, 300),
    watchNext: watchNext.slice(0, 200),
    evidenceUrls,
  };
}

/** 回退观察：完整标题作 fact，其余留空（§7：内容不足/失败时回退完整标题）。 */
export function fallbackObservation(event) {
  return {
    fact: String(event?.title || '').trim(),
    implication: '',
    watchNext: '',
    evidenceUrls: [],
    mode: 'fallback',
  };
}

// ---- 固定回执夹具（基线 --observation，语义同 selection-score/jev 夹具） ----

let fixtureState = null; // { path, doc }
let writeChain = Promise.resolve();
let writeError = null;

export function _resetObserveFixtureState() {
  fixtureState = null;
  writeError = null;
}

export function _observeWriteStatus() {
  return { writeError: writeError ? String(writeError.message || writeError) : null };
}

async function loadFixtureDoc(file) {
  let doc;
  try {
    doc = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    doc = null;
  }
  if (doc?.schemaVersion !== FIXTURE_SCHEMA_VERSION || !doc?.entries || typeof doc.entries !== 'object') {
    doc = { schemaVersion: FIXTURE_SCHEMA_VERSION, recordedAt: new Date().toISOString(), source: 'fallback', entries: {} };
  }
  return doc;
}

async function fixtureEntries(file) {
  if (fixtureState?.path === file) return fixtureState.doc.entries;
  const doc = await loadFixtureDoc(file);
  fixtureState = { path: file, doc };
  return doc.entries;
}

async function writeFixtureFile(file, doc) {
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2));
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    if (e?.code !== 'EPERM') { await fs.unlink(tmp).catch(() => {}); throw e; }
    await fs.writeFile(file, JSON.stringify(doc, null, 2)).catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  }
}

function recordFixture(file, key, outcome) {
  writeChain = writeChain.then(async () => {
    if (fixtureState?.path !== file) fixtureState = { path: file, doc: await loadFixtureDoc(file) };
    fixtureState.doc.entries[key] = outcome;
    await writeFixtureFile(file, fixtureState.doc);
  }).catch((e) => {
    writeError = writeError || e;
    console.error(`观察夹具写入失败（${file}）：${String(e?.message || e).slice(0, 150)}`);
  });
  return writeChain;
}

// ---- 单事件观察生成 ----

function observationKey(event) {
  return sha256String(canonicalJson({
    brief: observationBrief(event),
    promptVersion: 1,
  })).slice(0, 16);
}

const TRANSIENT_RETRIES = 2;    // 上游瞬时不可用重试（同 selection-score callValueOnce）
const TRANSIENT_WAIT_MS = 1_500;
const isTransientUpstream = (e) => [404, 408, 429, 500, 502, 503, 504].includes(e?.statusCode)
  || /应答无 content/.test(String(e?.message || e));

/** 单次 chat/completions 调用（超时 60s；瞬时错误短退避重试）。 */
async function callObserveOnce(prompt, cfg) {
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, TRANSIENT_WAIT_MS * attempt));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(fallbackEndpoint(cfg.baseUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          // 带思维链模型（glm-5.3-flash）观察任务同样会烧预算致 content null /
          // JSON 截断（selection-score 同款坑）；4000 兜底，成本增幅可忽略
          max_tokens: 4000,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const e = new Error(`observation api ${res.status}: ${body.slice(0, 200)}`);
        e.statusCode = res.status;
        throw e;
      }
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content) throw new Error('observation 应答无 content');
      const usage = json?.usage && Number.isFinite(json.usage.prompt_tokens)
        ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens ?? null }
        : null;
      return { value: content, usage };
    } catch (e) {
      lastErr = e;
      if (!isTransientUpstream(e) || attempt >= TRANSIENT_RETRIES) throw e;
      console.warn(`observation 瞬时错误（${e.statusCode}），退避重试 ${attempt + 1}/${TRANSIENT_RETRIES}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * 给单事件生成结构化观察。夹具模式优先；live 经 C-02 回执层；失败抛出
 * （调用方记 fallback，不阻断构建）。
 * @returns {{fact:string, implication:string, watchNext:string, evidenceUrls:string[], mode:'generated'}}
 */
export async function observeEvent(event, opts = {}) {
  const replayFile = process.env.OBSERVATION_REPLAY_FILE;
  const recordFile = process.env.OBSERVATION_RECORD_FILE;
  if (replayFile && recordFile) throw new Error('OBSERVATION_REPLAY_FILE 与 OBSERVATION_RECORD_FILE 不能同时设置');
  const key = observationKey(event);
  const prompt = buildObservationPrompt(event);
  const whitelist = evidenceUrlsOf(event);

  if (replayFile) {
    const entries = await fixtureEntries(replayFile);
    const hit = entries[key];
    if (!hit) throw new Error(`观察夹具未命中 key=${key}（${replayFile}）：事件/提示词变更需重录`);
    if (hit.error) throw new Error(hit.error);
    return structuredClone(hit.result);
  }
  if (recordFile && process.env.OBSERVATION_RECORD_REUSE !== 'off') {
    try {
      const hit = (await fixtureEntries(recordFile))[key];
      if (hit && !hit.error) return structuredClone(hit.result);
    } catch { /* 无夹具文件：全新录制 */ }
  }

  const cfg = opts.config || fallbackConfig();
  if (!cfg.baseUrl || !cfg.apiKey) throw new Error('观察生成需要备胎网关（JEV_FALLBACK_BASE_URL/API_KEY）');

  if (recordFile) {
    const raw = await callObserveOnce(prompt, cfg);
    const parsed = parseObservationContent(raw.value, whitelist);
    if (!parsed) {
      await recordFixture(recordFile, key, { error: `观察应答无法解析: ${String(raw.value).slice(0, 120)}` });
      throw new Error('观察应答无法解析');
    }
    const result = { ...parsed, mode: 'generated' };
    await recordFixture(recordFile, key, { result });
    return result;
  }

  if (receiptsEnabled()) {
    const { result } = await withReceipts(
      {
        task: 'observation', provider: 'fallback', model: cfg.model,
        promptHash: sha256String(prompt), configHash: sha256String(canonicalJson({ promptVersion: 1 })),
        inputHash: sha256String(canonicalJson(observationBrief(event))),
        store: opts.store || defaultStoreInstance(), guard: opts.guard || defaultGuardInstance(),
      },
      async () => {
        const raw = await callObserveOnce(prompt, cfg);
        return { value: raw.value, usage: raw.usage, respondedBy: `fallback:${cfg.model}` };
      },
      (content) => {
        const p = parseObservationContent(content, whitelist);
        if (!p) throw new Error(`观察应答无法解析: ${String(content).slice(0, 120)}`);
        return { ...p, mode: 'generated' };
      },
    );
    return result;
  }

  const raw = await callObserveOnce(prompt, cfg);
  const p = parseObservationContent(raw.value, whitelist);
  if (!p) throw new Error(`观察应答无法解析: ${String(raw.value).slice(0, 120)}`);
  return { ...p, mode: 'generated' };
}

// ---- 批量执行（构建端步骤） ----

/** 观察目标 = 入选集按 importance 降序取前 N（同现行 observations 的口径）。 */
export function pickObservationTargets(events, featuredEventIds, max = 3) {
  const featured = new Set(featuredEventIds || []);
  return (events || [])
    .filter((ev) => featured.has(ev.id))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, max);
}

/**
 * 生成入选集的观察（串行，逐条失败回退 fallback，不阻断）。
 * @param {object[]} events 构建事件列表
 * @param {string[]} featuredEventIds 精选事件 ID
 * @param {object} opts 透传给 observeEvent
 * @returns {{observations: object[], counts: {targeted, generated, fallback, failed}}}
 */
export async function generateObservations(events, featuredEventIds, opts = {}) {
  const targets = pickObservationTargets(events, featuredEventIds);
  const observations = [];
  let generated = 0, fallback = 0, failed = 0;
  for (const ev of targets) {
    let entry = { eventId: ev.id, title: String(ev.title || '').slice(0, 120), topic: ev.topic || 'other-energy' };
    try {
      const r = await observeEvent(ev, opts);
      entry = { ...entry, ...r };
      if (r.mode === 'fallback') fallback++; else generated++;
    } catch (e) {
      failed++;
      entry = { ...entry, ...fallbackObservation(ev), error: String(e?.message || e).slice(0, 200) };
      fallback++;
    }
    observations.push(entry);
  }
  return { observations, counts: { targeted: targets.length, generated, fallback, failed } };
}

/**
 * 影子观察主入口（只写 outDir，不碰 feeds/钉钉）。
 * @param {object} opts { date, events, featuredEventIds, outDir, now }
 * @returns {{schemaVersion, date, generatedAt, mode, counts, observations}}
 */
export async function runShadowObservation(opts) {
  const { date, outDir, now = new Date().toISOString() } = opts;
  const { observations, counts } = await generateObservations(opts.events, opts.featuredEventIds, opts);
  const report = {
    schemaVersion: 1,
    date,
    generatedAt: now,
    mode: 'shadow',
    counts,
    observations,
  };
  if (outDir) {
    try {
      await fs.mkdir(path.dirname(outDir), { recursive: true });
      await fs.writeFile(outDir, JSON.stringify(report, null, 2) + '\n');
    } catch (e) {
      console.warn(`  [影子观察] 报告落盘失败（不影响构建）：${e.message}`);
    }
  }
  return report;
}

// CLI 自检：node scripts/lib/observe.mjs（离线跑 parse 纯函数样例）
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const demo = parseObservationContent('```json\n{"fact": "上能电气 1.1GW 构网型储能 PCS 陆续发货", "implication": "构网型 PCS 出海放量", "watchNext": "交付节点", "evidenceUrls": []}\n```', []);
  console.log(JSON.stringify(demo, null, 2));
}
