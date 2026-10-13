#!/usr/bin/env node
/**
 * 精选业务价值评分（阶段 C-01 影子模式，AIHOT_IMPLEMENTATION_PLAN §6）。
 *
 * 问题：假设每天只能给读者看 12 条消息，这条新闻值不值得占一个位置？
 * （与相关性判定不同——相关、真实的消息也可能没有信息增量。）
 *
 * 四维评分（权重见 data/editorial-policy.json，初值 30/25/25/20 须校准）：
 *   业务关联 / 事实增量 / 项目·商业·政策影响 / 证据充分度 → total 0–100。
 * 提示词内嵌于本文件（版本以本文件 sha256 为代理，与 jev.mjs 字面量提示词
 * 同惯例；人工可读细则见 data/prompts/selection-value.md，两处同步修改）。
 *
 * 调用层次（与 jev callJudge 同构）：
 *   1. SHADOW_REPLAY_FILE / SHADOW_RECORD_FILE：基线固定回执夹具
 *      （--shadow-value 离线回放 / 录制，语义同 jev 夹具，未命中硬失败）；
 *   2. live：经 C-02 回执层（lib/ai-receipts.mjs 缓存 + 额度守卫）；
 *   3. 传输复用 jev 备胎网关（fallbackConfig / fallbackEndpoint，OpenAI 兼容
 *      chat/completions）——Jev 直连协议不适配自由 JSON 输出，价值评分只走备胎。
 *
 * 影子硬约束（方案 §9）：结果只写 .state/shadow/（或调用方指定目录），不进
 * feeds、不改正式榜单、不动曝光历史、不触发钉钉。
 *
 * 用法：
 *   import { buildValuePrompt, parseValueContent, scoreBusinessValue, runShadowScoring } from './selection-score.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256String } from './digest.mjs';
import { fallbackConfig, fallbackConfigured, fallbackEndpoint } from './jev.mjs';
import { withReceipts, receiptsEnabled, defaultStoreInstance, defaultGuardInstance } from './ai-receipts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
export const DEFAULT_WEIGHTS = { businessRelevance: 30, factualIncrement: 25, impact: 25, evidence: 20 };
const TIMEOUT_MS = 60_000; // 评分提示词带完整细则+事件简报，glm 类带思维链模型
                      // 实测可超 20s（07-31 录制 18/35 超时）；60s 宽松档
const FIXTURE_SCHEMA_VERSION = 1;

const DIM_LABELS = {
  businessRelevance: '业务关联',
  factualIncrement: '事实增量',
  impact: '项目/商业/政策影响',
  evidence: '证据充分度',
};

/** 评分输入的事件简报（截断防御：摘要 1200、标题/实体原样——标题是核心证据）。 */
export function valueBrief(event) {
  return {
    title: event.title || '',
    originalTitle: event.originalTitle || '',
    summary: String(event.summary || '').slice(0, 1200),
    topic: event.topic || null,
    region: event.region || null,
    entities: (event.entities || []).slice(0, 10),
    metrics: (event.metrics || []).slice(0, 6),
    independentSourceCount: Number.isFinite(event.independentSourceCount) ? event.independentSourceCount : null,
    sourceType: event.source?.type || null,
    sourceName: event.source?.name || null,
    publishedAt: event.publishedAt || null,
  };
}

/** 构建评分提示词（纯函数；版本随本文件 sha256 走）。 */
export function buildValuePrompt(event, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  return [
    '你是能源行业日报的编辑评审。判定问题：假设每天只能给读者看 12 条消息，这条新闻值不值得占一个位置？',
    '读者画像：跟踪储能/PCS/SST/AIDC 供电行业的从业者，关心供需、格局、项目落地与政策变化。',
    '注意：与「是否属于能源领域」的相关性判定不同——相关、真实、写得不错的消息也可能没有信息增量。',
    '',
    '【待评内容】',
    JSON.stringify(valueBrief(event), null, 2),
    '',
    '【评分维度】（四个维度各自独立打分，不得超过各自上限）',
    `1. ${DIM_LABELS.businessRelevance}（0–${w.businessRelevance}）：26+ 直接命中 SST/PCS/EMS、AIDC 供电架构（800VDC/HVDC）、储能系统或重点公司实质动态；中段为有传导影响的外围（电网/光风/核电/燃气/液冷/PPA/政策）；低段仅背景相关；无关为 0。`,
    `2. ${DIM_LABELS.factualIncrement}（0–${w.factualIncrement}）：21+ 新披露的具体事实（新数字/新时间点/新当事方）；中段已知事件的新进展（签约→开工→投产）；低段复述、预告、观点预测；纯转述无增量为 0。`,
    `3. ${DIM_LABELS.impact}（0–${w.impact}）：21+ 改变格局（头部厂商大额订单/扩产/退出、改变成本曲线的技术、影响北美/中国/中东的重点政策）；中段影响单个环节；低段影响有限；软文/营销/招聘/股价日常波动为 0。`,
    `4. ${DIM_LABELS.evidence}（0–${w.evidence}）：16+ 一手来源或多家独立来源交叉印证；中段单家可信媒体且要素齐全；低段要素残缺或仅传言；软文通稿为 0。independentSourceCount 是证据的一部分，但不与来源数线性挂钩——一家权威一手来源胜过五家转载。`,
    '',
    '【负向清单】（符合任一，影响维度记 0：软文/通稿/展会营销/招聘/无具体规模的融资套话；无新事实支撑的观点预测；消费级评测或股价变动；同事件第 N 篇重复报道。）',
    '【边界】数字、公司名、项目名只能依据输入材料，不得臆测；材料没有的事实增量记低分；短期平淡但给出关键节点（认证/交付/投运）的值得高分。',
    '',
    '【输出格式】只输出一个 JSON 对象，不要任何解释或其他文字：',
    '{"scores": {"businessRelevance": 0, "factualIncrement": 0, "impact": 0, "evidence": 0}, "keyFact": "一句话核心新事实，无则空字符串", "rationale": "一句话打分理由，边缘案例写清为什么"}',
    '（total 不用输出，由系统按四维求和。）',
  ].join('\n');
}

/**
 * 解析模型应答（纯函数）。容忍 markdown 围栏与前后杂文字；四维任一缺失/
 * 非数值/超上限 → 整体 null（与调用失败同路径，影子记录 failed）。total 由
 * 系统重算，不信任模型自报。
 */
export function parseValueContent(content, weights = DEFAULT_WEIGHTS) {
  const m = String(content || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const scores = {};
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    const v = Number(obj?.scores?.[k]);
    const cap = Number.isFinite(weights?.[k]) ? weights[k] : DEFAULT_WEIGHTS[k];
    if (!Number.isFinite(v) || v < 0 || v > cap) return null;
    scores[k] = Math.round(v * 10) / 10;
  }
  const total = Math.round(Object.values(scores).reduce((a, b) => a + b, 0) * 10) / 10;
  return {
    scores,
    total,
    keyFact: typeof obj.keyFact === 'string' ? obj.keyFact.slice(0, 200) : '',
    rationale: typeof obj.rationale === 'string' ? obj.rationale.slice(0, 300) : '',
  };
}

// ---- 固定回执夹具（基线 --shadow-value，语义同 jev 夹具） ----

let fixtureState = null; // { path, doc }
let writeChain = Promise.resolve();
let writeError = null;

export function _resetShadowFixtureState() {
  fixtureState = null;
  writeError = null;
}

export function _shadowWriteStatus() {
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
  }).catch(e => {
    writeError = writeError || e;
    console.error(`影子评分夹具写入失败（${file}）：${String(e?.message || e).slice(0, 150)}`);
  });
  return writeChain;
}

// ---- 单事件评分 ----

function shadowKey(event, weights) {
  return sha256String(canonicalJson({
    brief: valueBrief(event),
    weights: { ...DEFAULT_WEIGHTS, ...weights },
    promptVersion: 1,
  })).slice(0, 16);
}

const TRANSIENT_RETRIES = 2;    // 上游瞬时不可用（404/408/429/5xx）重试（同 jev callFallback）
const TRANSIENT_WAIT_MS = 1_500;
const isTransientUpstream = (e) => [404, 408, 429, 500, 502, 503, 504].includes(e?.statusCode)
  || /应答无 content/.test(String(e?.message || e)); // reasoning 烧光预算致 content null：重试可能好（非确定）

/**
 * 单次 chat/completions 调用（超时 20s；瞬时错误短退避重试——聚合网关对同一
 * 模型的路由会间歇 404/5xx 抖动，2026-10-12 备胎录制实测过；返回
 * { value: content, usage }）。
 */
async function callValueOnce(prompt, cfg) {
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, TRANSIENT_WAIT_MS * attempt));
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
          // 带思维链模型（glm-5.3-flash）评分任务推理更长，2000 会被 reasoning
          // 烧光致 content null（07-31 录制实测）；4000 兜底，成本增幅可忽略
          max_tokens: 4000,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const e = new Error(`value-score api ${res.status}: ${body.slice(0, 200)}`);
        e.statusCode = res.status;
        throw e;
      }
      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content) throw new Error('value-score 应答无 content');
      const usage = json?.usage && Number.isFinite(json.usage.prompt_tokens)
        ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens ?? null }
        : null;
      return { value: content, usage };
    } catch (e) {
      lastErr = e;
      if (!isTransientUpstream(e) || attempt >= TRANSIENT_RETRIES) throw e;
      console.warn(`value-score 瞬时错误（${e.statusCode}），退避重试 ${attempt + 1}/${TRANSIENT_RETRIES}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr; // 不可达（throw 在循环内），兜底保形
}

/**
 * 给单事件打业务价值分。
 * 夹具模式（SHADOW_REPLAY_FILE/SHADOW_RECORD_FILE）优先；live 经 C-02 回执层。
 * 失败抛出（调用方记 failed，影子不阻断构建）。
 */
export async function scoreBusinessValue(event, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const replayFile = process.env.SHADOW_REPLAY_FILE;
  const recordFile = process.env.SHADOW_RECORD_FILE;
  if (replayFile && recordFile) throw new Error('SHADOW_REPLAY_FILE 与 SHADOW_RECORD_FILE 不能同时设置');
  const key = shadowKey(event, weights);
  const prompt = buildValuePrompt(event, weights);

  if (replayFile) {
    const entries = await fixtureEntries(replayFile);
    const hit = entries[key];
    if (!hit) throw new Error(`影子评分夹具未命中 key=${key}（${replayFile}）：事件/权重/提示词变更需重录`);
    if (hit.error) throw new Error(hit.error);
    return structuredClone(hit.result);
  }
  if (recordFile && process.env.SHADOW_RECORD_REUSE !== 'off') {
    try {
      const hit = (await fixtureEntries(recordFile))[key];
      if (hit && !hit.error) return structuredClone(hit.result);
    } catch { /* 无夹具文件：全新录制 */ }
  }

  const cfg = opts.config || fallbackConfig();
  if (!cfg.baseUrl || !cfg.apiKey) throw new Error('价值评分需要备胎网关（JEV_FALLBACK_BASE_URL/API_KEY）');

  let parsed, usage;
  if (recordFile) {
    // 录制路径：不走回执层（夹具本身就是持久缓存）
    const raw = await callValueOnce(prompt, cfg);
    usage = raw.usage;
    parsed = parseValueContent(raw.value, weights);
    if (!parsed) {
      await recordFixture(recordFile, key, { error: `value-score 应答无法解析: ${String(raw.value).slice(0, 120)}` });
      throw new Error('value-score 应答无法解析');
    }
    await recordFixture(recordFile, key, { result: parsed });
    return parsed;
  }

  if (receiptsEnabled()) {
    const { result } = await withReceipts(
      {
        task: 'selection-value', provider: 'fallback', model: cfg.model,
        promptHash: sha256String(prompt), configHash: sha256String(canonicalJson({ weights, promptVersion: 1 })),
        inputHash: sha256String(canonicalJson(valueBrief(event))),
        store: opts.store || defaultStoreInstance(), guard: opts.guard || defaultGuardInstance(),
      },
      async () => {
        const raw = await callValueOnce(prompt, cfg);
        usage = raw.usage;
        return { value: raw.value, usage: raw.usage, respondedBy: `fallback:${cfg.model}` };
      },
      (content) => {
        const p = parseValueContent(content, weights);
        if (!p) throw new Error(`value-score 应答无法解析: ${String(content).slice(0, 120)}`);
        return p;
      },
    );
    return result;
  }

  // 回执层旁路（AI_RECEIPTS=off）：直调
  const raw = await callValueOnce(prompt, cfg);
  const p = parseValueContent(raw.value, weights);
  if (!p) throw new Error(`value-score 应答无法解析: ${String(raw.value).slice(0, 120)}`);
  return p;
}

// ---- 影子批量执行（构建端步骤） ----

/** 可复现伪随机（mulberry32，与 build-selection-set.mjs 同实现）。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 影子评分目标：已选 + 近门槛带（importance ≥ ruleThreshold-nearBand 未选）+
 * 截断审计抽样（其余未选事件按日期种子抽 auditSample 条——方案 §6：防候选
 * 截断导致重要事件永远看不见）。
 */
export function pickShadowTargets(events, featuredEventIds, policy = {}) {
  const ruleThreshold = Number.isFinite(policy.ruleThreshold) ? policy.ruleThreshold : 3;
  const nearBand = Number.isFinite(policy.nearBand) ? policy.nearBand : 1;
  const auditSample = Number.isFinite(policy.auditSample) ? policy.auditSample : 5;
  const featured = new Set(featuredEventIds || []);
  const selected = [];
  const nearBandOut = [];
  const rest = [];
  for (const ev of events || []) {
    if (featured.has(ev.id)) selected.push(ev);
    else if (Number.isFinite(ev.importance) && ev.importance >= ruleThreshold - nearBand) nearBandOut.push(ev);
    else rest.push(ev);
  }
  const rng = mulberry32([...(selected[0]?.id || 'seed')].reduce((a, c) => a + c.charCodeAt(0), 0) + rest.length);
  const audit = rest
    .map(ev => ({ ev, r: rng() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, auditSample)
    .map(v => v.ev);
  return { selected, nearBand: nearBandOut, audit };
}

/**
 * 影子评分主入口（串行执行，逐条失败不阻断）。
 * @param {object} opts { date, events, featuredEventIds, policy, outDir, now }
 * @returns {{ scored: number, failed: number, items: Array, summary: object }}
 */
export async function runShadowScoring(opts) {
  const { date, events, featuredEventIds, policy = {}, outDir, now = new Date().toISOString() } = opts;
  const weights = policy.weights || DEFAULT_WEIGHTS;
  const targets = pickShadowTargets(events, featuredEventIds, policy.shadow || policy);
  const items = [];
  let failed = 0;
  const groups = [['selected', targets.selected], ['near-band', targets.nearBand], ['audit', targets.audit]];
  for (const [group, list] of groups) {
    for (const ev of list) {
      let entry = { group, eventId: ev.id, title: String(ev.title || '').slice(0, 120), ruleScore: ev.importance };
      try {
        const v = await scoreBusinessValue(ev, { weights });
        entry = { ...entry, ...v };
      } catch (e) {
        failed++;
        entry = { ...entry, error: String(e?.message || e).slice(0, 200) };
      }
      items.push(entry);
    }
  }
  const scored = items.length - failed;
  // 分歧清单：已选但价值分垫底 / 未选但价值分突出（人工评审第一入口）
  const ok = items.filter(i => !i.error);
  const disagreements = [];
  if (ok.length) {
    const selectedScores = ok.filter(i => i.group === 'selected').map(i => i.total).sort((a, b) => a - b);
    const outside = ok.filter(i => i.group !== 'selected').map(i => i.total).sort((a, b) => b - a);
    const selectedFloor = selectedScores.length ? selectedScores[Math.floor(selectedScores.length * 0.25)] : null;
    const outsideCeil = outside.length ? outside[Math.floor(outside.length * 0.25)] : null;
    if (selectedFloor != null && Number.isFinite(outsideCeil) && outsideCeil > selectedFloor) {
      for (const i of ok) {
        if (i.group !== 'selected' && i.total > selectedFloor) {
          disagreements.push({ kind: 'outside-over-selected-floor', eventId: i.eventId, title: i.title, valueScore: i.total, selectedFloor, rationale: i.rationale });
        }
      }
    }
  }
  const report = {
    schemaVersion: 1,
    date,
    generatedAt: now,
    mode: 'shadow',
    weights,
    counts: { selected: targets.selected.length, nearBand: targets.nearBand.length, audit: targets.audit.length, scored, failed },
    items,
    disagreements,
  };
  if (outDir) {
    try {
      await fs.mkdir(path.dirname(outDir), { recursive: true });
      await fs.writeFile(outDir, JSON.stringify(report, null, 2) + '\n');
    } catch (e) {
      console.warn(`  [影子评分] 报告落盘失败（不影响构建）：${e.message}`);
    }
  }
  return report;
}

// CLI 自检：node scripts/lib/selection-score.mjs（离线跑 parse 纯函数样例）
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const demo = parseValueContent('```json\n{"scores": {"businessRelevance": 28, "factualIncrement": 22, "impact": 20, "evidence": 16}, "keyFact": "Tesla 获 800MWh 订单", "rationale": "头部厂商大额订单"}\n```');
  console.log(JSON.stringify(demo, null, 2));
}
