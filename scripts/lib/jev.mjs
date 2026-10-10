#!/usr/bin/env node
/**
 * Jev 概率决策模型接入（TypeSafe AI 直连 API）。
 *
 * 职责一（复审捞回）：关键词硬过滤（filter.mjs）被拒的条目交 Jev 复判
 * 「是否真的无关」，高置信相关的捞回，降低关键词误杀。
 * 职责二（主题仲裁）：关键词主题提取（extract.mjs extractTopics）给出
 * 空主题或兜底档 other-energy 时，交 Jev Choice 归入具体主题。
 *
 * 配置：
 *   TYPESAFE_API_KEY    TypeSafe API 密钥（apikey_ 前缀；未配置则整体跳过，行为同旧版）
 *   JEV_REVIEW=off      显式关闭 Jev 全部介入
 *   JEV_RESCUE_THRESHOLD  捞回阈值，relevant 概率 ≥ 该值才捞回（默认 0.65，校准见 scripts/jev-calibrate.mjs）
 *   JEV_FALLBACK_BASE_URL / JEV_FALLBACK_API_KEY / JEV_FALLBACK_MODEL
 *                       Plan B 备胎（OpenAI 兼容网关，如 LiteLLM）。Jev 调用失败
 *                       （限流/欠费/服务不可用）时自动降级：问题结构翻译成提示词，
 *                       应答解析回 Jev answers 同构格式，三处调用点零改动。
 *                       默认模型 Jereh-qwen3.5-flash-no-think（实测 1~2s、概率两极
 *                       分布，0.65 阈值可直接沿用；备胎转正时应重跑校准）。
 *   JEV_REPLAY_FILE / JEV_RECORD_FILE
 *                       固定回执夹具（阶段 A 基线回放，AIHOT_IMPLEMENTATION_PLAN §4）。
 *                       两者互斥，且都不能与 TYPESAFE_API_KEY 半在线混用（record 除外）。
 *                       REPLAY：离线回放已录制的判定回执，绝不发网络请求；未命中
 *                       硬失败（静默降级会让基线无感知漂移）。
 *                       RECORD：真实调用后把回执原子落盘。记录的是本次实际使用的
 *                       回执——无直连 key 且备胎（JEV_FALLBACK_*）已配置时直接走备胎，
 *                       夹具 header 的 source 字段标注来源（jev-direct / fallback:<模型>）。
 *                       key = canonicalJson(payload) 的 sha256 前 16 位，payload 变
 *                       （提示词/enums/输入）即失效需重录。
 *
 * 传输（2026-09-21 由 Vercel AI Gateway 免费档切换为直连）：
 *   - 免费档网关对该模型限流极紧（并发 3 连发约 4 条即封、封锁数分钟），
 *     只能串行 + 15s 间隔 + 8min 预算，112 条校准要 30~45 分钟；
 *   - 直连实测：单条 1~2s，4 并发连发无 429（2026-09-21），故改为小并发池；
 *   - 仍保留 429/529 退避与总预算：Jev 是增益，不能阻塞构建。
 *
 * 容错：单条失败/超时/限流放弃 → 该条维持原判定（被拒维持被拒，
 * 无主题维持 other-energy）。
 *
 * 用法：
 *   import { jevConfigured, reviewRejected, shouldRescue, reviewTopics } from './jev.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { canonicalJson } from './digest.mjs';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const CONCURRENCY = 4;              // 小并发池：直连实测 4 并发无 429
const RATE_LIMIT_WAIT_MS = 20_000;  // 429/529 后退避等待（按次翻倍）
const MAX_RATE_LIMIT_RETRIES = 2;   // 单条最多退避重试次数
const BUDGET_MS = 8 * 60_000;      // 整批复审总预算：超时放弃剩余条目（CI 保护）
const TIMEOUT_MS = 20_000;         // 单条超时；超时视为「无 verdict」

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Jev 复审是否启用（有 key、离线回放夹具或录制模式，且未被显式关闭）。 */
export function jevConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY || process.env.JEV_REPLAY_FILE || process.env.JEV_RECORD_FILE) && process.env.JEV_REVIEW !== 'off';
}

/** 捞回阈值（可通过 JEV_RESCUE_THRESHOLD 覆盖）。 */
export function rescueThreshold() {
  const v = Number(process.env.JEV_RESCUE_THRESHOLD);
  // 0.65：2026-09-21 直连 API 校准（112 条标注，samples/annotations/jev-calibration.json）
  // 精确率 0.96 / 召回率 0.65——0.8 时精确率 1.00 但漏掉固态电池/数据中心供电等
  // 硬货；0.6 以下灰区真假各半。下游 importance 评分会再筛软误报。
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.65;
}

/** verdict 是否达到捞回标准。 */
export function shouldRescue(verdict, threshold = rescueThreshold()) {
  return Boolean(verdict && verdict.relevant && verdict.probability >= threshold);
}

/** 由 enums.json 构建主题 Choice 的 criteria（id → 中文说明）。 */
export function topicCriteria(enums) {
  const out = {};
  for (const t of enums?.topics || []) {
    out[t.id] = t.label || t.id;
  }
  return out;
}

async function callJev(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`jev api ${res.status}: ${body.slice(0, 200)}`);
      e.statusCode = res.status;
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const isRateLimit = (e) => e?.statusCode === 429 || e?.statusCode === 529 || /rate.?limit/i.test(String(e?.message || e));

// ---- Plan B 备胎：OpenAI 兼容网关（LiteLLM 等） ----
// Jev 失败时降级。备胎是普通 LLM：问题结构翻译成提示词（buildFallbackPrompt），
// 应答 JSON 解析回 Jev answers 同构格式（parseFallbackContent），下游零改动。
const FALLBACK_MODEL_DEFAULT = 'Jereh-qwen3.5-flash-no-think';

/** 备胎配置（env 运行时读取，便于测试覆盖）。 */
export function fallbackConfig() {
  return {
    baseUrl: process.env.JEV_FALLBACK_BASE_URL || '',
    apiKey: process.env.JEV_FALLBACK_API_KEY || '',
    model: process.env.JEV_FALLBACK_MODEL || FALLBACK_MODEL_DEFAULT,
  };
}

/** 备胎是否已配置。 */
export function fallbackConfigured() {
  const c = fallbackConfig();
  return Boolean(c.baseUrl && c.apiKey);
}

/**
 * 把 Jev 问题结构翻译成备胎 LLM 提示词（纯函数，便于测试）。
 * noul → {"<id>": {"value": bool, "probability": 0~1}}；
 * choice → {"<id>": {"choice": "选项 id"}}。
 */
export function buildFallbackPrompt(payload) {
  const parts = [
    '你是自动判定程序。根据「内容」逐条回答「问题」，只输出一个 JSON 对象，不要任何解释或其他文字。',
    '',
    '【内容】',
    JSON.stringify(payload.state ?? {}),
    '',
    '【问题】',
  ];
  const fmt = [];
  for (const [id, q] of Object.entries(payload.questions || {})) {
    if (q.type === 'noul') {
      parts.push(`- ${id}：${q.instructions || ''} 判 true 的标准：${q.criteria?.true ?? ''}；判 false 的标准：${q.criteria?.false ?? ''}。`);
      fmt.push(`"${id}": {"value": true或false, "probability": 0~1 的 true 概率}`);
    } else if (q.type === 'choice') {
      const opts = Object.entries(q.criteria || {}).map(([k, v]) => `${k}=${v}`).join('；');
      parts.push(`- ${id}：${q.instructions || ''} 选项：${opts}。`);
      fmt.push(`"${id}": {"choice": "选项 id"}`);
    }
  }
  parts.push('', `【输出格式】\n{${fmt.join(', ')}}`);
  return parts.join('\n');
}

/**
 * 解析备胎应答为 Jev answers 同构结构（纯函数，便于测试）。
 * 容忍 markdown 代码围栏与前后杂文字；任一问题缺失/非法 → 整体 null
 * （与 Jev 失败同路径：该条维持原判定）。
 */
export function parseFallbackContent(content, payload) {
  const m = String(content || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const answers = {};
  for (const [id, q] of Object.entries(payload.questions || {})) {
    const a = obj[id];
    if (!a || typeof a !== 'object') return null;
    if (q.type === 'noul') {
      const p = Number(a.probability);
      if (!Number.isFinite(p) || p < 0 || p > 1) return null;
      answers[id] = { noul: p };
    } else if (q.type === 'choice') {
      if (!a.choice || !(q.criteria || {})[a.choice]) return null;
      answers[id] = { choice: a.choice };
    } else {
      return null;
    }
  }
  return { answers };
}

/** 调备胎网关（OpenAI 兼容 chat/completions），返回 Jev 同构 result 或抛错。 */
async function callFallback(payload, cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: buildFallbackPrompt(payload) }],
        temperature: 0,
        // 带 reasoning 的模型（如 glm-5.3-flash）思维链会先烧输出预算，
        // 300 会把 content 挤成 null；1000 足够覆盖推理+JSON（实测 <$0.0001/条）
        max_tokens: 1000,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`fallback api ${res.status}: ${body.slice(0, 200)}`);
      e.statusCode = res.status;
      throw e;
    }
    const json = await res.json();
    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    const parsed = parseFallbackContent(content, payload);
    if (!parsed) {
      const hint = choice?.finish_reason === 'length' ? '（finish_reason=length：输出被 max_tokens 截断）' : '';
      throw new Error(`fallback 应答无法解析${hint}: ${String(content).slice(0, 120)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

let fallbackWarned = false;

// ---- 固定回执夹具（阶段 A 基线回放，AIHOT_IMPLEMENTATION_PLAN §4）----
// 回放离线复现录制回执；录制把真实回执落盘。key 稳定的前提是 payload 由
// 字面量构造（键序确定）+ canonicalJson 再排序兜底。payload 不含 API key
// （key 只出现在 HTTP header），夹具天然脱敏。

/** 夹具条目 key：canonicalJson(payload) 的 sha256 前 16 位。 */
export function fixtureKey(payload) {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex').slice(0, 16);
}

const FIXTURE_SCHEMA_VERSION = 1;

/** 读取并校验夹具文件，返回完整文档 {schemaVersion, recordedAt, model, entries}。 */
export async function loadFixtureEntries(file) {
  let doc;
  try {
    doc = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    throw new Error(`Jev 夹具文件不可读（${file}）：${e.message}`);
  }
  if (doc?.schemaVersion !== FIXTURE_SCHEMA_VERSION || !doc || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) {
    throw new Error(`Jev 夹具文件格式非法（${file}）：期望 {schemaVersion:${FIXTURE_SCHEMA_VERSION}, entries:{}}`);
  }
  return doc;
}

// 模块级夹具状态（按 env 路径缓存；测试用 _resetFixtureState 清空）。
let fixtureState = null;

/** 清空夹具缓存与写入错误（测试隔离/换日期用：改 env 后必须调用）。 */
export function _resetFixtureState() {
  fixtureState = null;
  recordWriteError = null;
}

async function replayEntries(replayFile) {
  if (fixtureState?.path === replayFile) return fixtureState.doc.entries;
  const doc = await loadFixtureEntries(replayFile);
  fixtureState = { path: replayFile, doc };
  return doc.entries;
}

// 录制写入串行链：runPool 并发下避免整写竞态（后写覆盖前写丢条目）。
// 单次写失败（如 Windows 文件锁 EPERM）不得 poison 整条链让后续静默跳过——
// 记住首个错误，链继续跑；编排脚本（build-quality-baseline）在每日结束时
// 校验夹具文件真实存在且有条目，杜绝「报成功实际没落盘」。
let recordWriteChain = Promise.resolve();
let recordWriteError = null;

export function _fixtureWriteStatus() {
  return { writeError: recordWriteError ? String(recordWriteError.message || recordWriteError) : null };
}

/**
 * 夹具落盘：tmp+rename 原子写，Windows 文件锁（EPERM，杀软/同步盘扫描
 * 新文件）时退避重试，仍失败则降级直接写目标文件（非原子但可用——下次
 * 写入会整体重写，损坏文件在 loadFixtureEntries 处显式暴露）。
 */
async function writeFixtureFile(file, doc) {
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2));
  for (let i = 0; ; i++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      if (e?.code !== 'EPERM' || i >= 5) {
        // rename 持续失败：直接写目标（接受非原子），别让整条录制链挂掉
        await fs.writeFile(file, JSON.stringify(doc, null, 2));
        await fs.unlink(tmp).catch(() => {});
        if (e?.code === 'EPERM') {
          console.warn(`Jev 夹具 rename 持续 EPERM，已降级直接写（${file}）`);
        }
        return;
      }
      await sleep(50 * (i + 1));
    }
  }
}

function recordFixture(recordFile, payload, outcome) {
  const key = fixtureKey(payload);
  recordWriteChain = recordWriteChain.then(async () => {
    if (fixtureState?.path !== recordFile) {
      let doc;
      try {
        doc = await loadFixtureEntries(recordFile);
      } catch {
        // header 标注回执来源：直连 or 备胎（无直连 key 时走备胎录制的场景）
        const fb = fallbackConfigured() ? fallbackConfig() : null;
        doc = {
          schemaVersion: FIXTURE_SCHEMA_VERSION,
          recordedAt: new Date().toISOString(),
          model: fb ? fb.model : MODEL,
          source: fb ? `fallback:${fb.model}` : 'jev-direct',
          entries: {},
        };
      }
      fixtureState = { path: recordFile, doc };
    }
    fixtureState.doc.entries[key] = outcome;
    await writeFixtureFile(recordFile, fixtureState.doc);
  }).catch(e => {
    recordWriteError = recordWriteError || e;
    console.error(`Jev 夹具写入失败（${recordFile}）：${String(e?.message || e).slice(0, 150)}`);
  });
  return recordWriteChain;
}

/**
 * 判定入口：夹具拦截 → Jev 直连 → 失败且备胎已配置时降级备胎
 * （限流/欠费/服务不可用/超时）。备胎同样失败则抛出，由 runPool 按既有容错处理。
 * 录制（JEV_RECORD_FILE）记录的是本次实际使用的回执——配置了备胎且直连无 key
 * 时直接走备胎（直连必 401 没必要白打），夹具 header 的 source 字段标注来源。
 */
async function callJudge(payload) {
  const replayFile = process.env.JEV_REPLAY_FILE;
  const recordFile = process.env.JEV_RECORD_FILE;
  if (replayFile && recordFile) {
    throw new Error('JEV_REPLAY_FILE 与 JEV_RECORD_FILE 不能同时设置');
  }
  if (replayFile) {
    if (process.env.TYPESAFE_API_KEY) {
      throw new Error('JEV_REPLAY_FILE 与 TYPESAFE_API_KEY 不能同时设置（防「半在线」回放）');
    }
    const entries = await replayEntries(replayFile);
    const key = fixtureKey(payload);
    const hit = entries[key];
    if (!hit) {
      throw new Error(`Jev 夹具未命中 key=${key}（${replayFile}）：代码/提示词/enums/输入变更已使回执失效，需用 --record 重录`);
    }
    if (hit.error) throw new Error(hit.error);
    return structuredClone(hit.result);
  }
  try {
    // 无直连 key 且备胎已配置：跳过注定 401 的直连，直接备胎（录制备胎回执场景）
    const result = (process.env.TYPESAFE_API_KEY || !fallbackConfigured())
      ? await callJev(payload)
      : await callFallback(payload, fallbackConfig());
    if (recordFile) await recordFixture(recordFile, payload, { result });
    return result;
  } catch (e) {
    if (!fallbackConfigured()) {
      if (recordFile) await recordFixture(recordFile, payload, { error: String(e?.message || e) });
      throw e;
    }
    if (!fallbackWarned) {
      fallbackWarned = true;
      console.warn(`Jev 调用失败，本次构建降级 Plan B 备胎（${fallbackConfig().model}）：${String(e?.message || e).slice(0, 150)}`);
    }
    try {
      const fbResult = await callFallback(payload, fallbackConfig());
      if (recordFile) await recordFixture(recordFile, payload, { result: fbResult });
      return fbResult;
    } catch (e2) {
      if (recordFile) await recordFixture(recordFile, payload, { error: String(e2?.message || e2) });
      throw e2;
    }
  }
}

/**
 * 单条判定：relevant 布尔 + 主题 Choice，一次请求并行回答。
 * 出错时抛出（含限流/超时错误），由调用方决定退避/放弃。
 */
export async function reviewOne(item, enums) {
  const state = {
    title: item.translatedTitle || item.title || '',
    summary: String(item.summary || '').slice(0, 1200),
    source: item.source || '',
  };
  if (!state.title && !state.summary) return null;

  const result = await callJudge({
    model: MODEL,
    state,
    questions: {
      relevant: {
        type: 'noul',
        instructions:
          '这是否是一条值得收录进能源/电力行业信息站的新闻？' +
          '覆盖：储能、PCS/逆变器、固态变压器(SST)、AIDC数据中心供电与配电、' +
          '电网/输配电、光伏风电、核电SMR、燃气备用电源、温控散热、' +
          '绿电PPA、电力市场与政策、芯片与算力供给。' +
          '纯招聘/广告/股市行情/与能源无关的科技新闻为 false。',
        criteria: {
          true: '主题或主体与上述能源/电力领域明确相关',
          false: '与能源/电力领域无实质关联，或仅为泛科技/财经内容',
        },
      },
      topic: {
        type: 'choice',
        instructions: '把这条内容归入最贴切的一个主题。',
        criteria: topicCriteria(enums),
      },
    },
  });
  if (!result?.answers?.relevant) return null;

  const rel = result.answers.relevant;
  const topicAns = result.answers.topic;
  const p = rel.noul;
  if (typeof p !== 'number') return null;
  return {
    relevant: p >= 0.5,
    probability: p,
    topic: topicAns?.choice && enums.topics?.some(t => t.id === topicAns.choice)
      ? topicAns.choice
      : null,
  };
}

/**
 * 通用批量执行：小并发池 + 限流退避 + 总预算。
 * task 抛错（限流除外）该条放弃保持 null；返回与 items 等长的结果数组。
 */
async function runPool(items, task, opts = {}) {
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const what = opts.label || 'Jev';
  const results = new Array(items.length).fill(null);
  const startedAt = Date.now();
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length || Date.now() - startedAt > budgetMs) return;
      for (let attempt = 0; ; attempt++) {
        try {
          results[i] = await task(items[i]);
          break;
        } catch (e) {
          if (isRateLimit(e) && attempt < MAX_RATE_LIMIT_RETRIES) {
            const wait = RATE_LIMIT_WAIT_MS * (attempt + 1);
            console.warn(`${what}: 第 ${i + 1} 条触发限流，退避 ${wait / 1000}s 重试（${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}）`);
            await sleep(wait);
            continue;
          }
          break; // 超时/其他错误：该条放弃
        }
      }
    }
  }

  if (!items.length) return results;
  if (Date.now() - startedAt > budgetMs) {
    console.warn(`${what}: 总预算 ${budgetMs / 60000}min 已耗尽，全部 ${items.length} 条跳过`);
  } else {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    const skipped = items.length - Math.min(next, items.length);
    if (skipped > 0) {
      console.warn(`${what}: 预算耗尽，剩余 ${skipped} 条跳过`);
    }
  }
  return results;
}

/**
 * 批量复判被拒条目（小并发池 + 限流退避 + 总预算）。
 * 返回与 items 等长的 verdict 数组（失败/放弃位为 null）。
 * @param {Array<object>} items 关键词过滤被拒的原始条目
 * @param {object} enums data/enums.json（提供主题枚举）
 */
export async function reviewRejected(items, enums, opts = {}) {
  return runPool(items, (item) => reviewOne(item, enums), { ...opts, label: 'Jev 复审' });
}

/**
 * 是否需要主题仲裁：Jev 已判过主题（捞回条目）不重复；关键词
 * 给出具体主题（非空且非兜底档 other-energy）时无需仲裁。
 * @param {{topics: string[]}} ex extractItem 的提取结果
 * @param {object} item 原始条目（看 _jev 标记）
 */
export function needsTopicArbitration(ex, item) {
  if (item?._jev?.topic) return false;
  const first = ex?.topics?.[0];
  return !first || first === 'other-energy';
}

/**
 * 单条主题仲裁：Choice 归入最贴切主题，返回主题 id（校验过枚举）或 null。
 * other-energy 留在 criteria 里：Jev 也认为无具体主题时可显式归入兜底档。
 */
export async function reviewTopic(item, enums) {
  const state = {
    title: item.translatedTitle || item.title || '',
    summary: String(item.summary || '').slice(0, 1200),
    source: item.source || '',
  };
  if (!state.title && !state.summary) return null;

  const result = await callJudge({
    model: MODEL,
    state,
    questions: {
      topic: {
        type: 'choice',
        instructions:
          '把这条内容归入最贴切的一个主题。优先选择具体主题（按主题说明判断主体内容）；' +
          '仅当确实无法归入任何具体主题时才选 other-energy。',
        criteria: topicCriteria(enums),
      },
    },
  });
  const choice = result?.answers?.topic?.choice;
  return enums.topics?.some(t => t.id === choice) ? choice : null;
}

/**
 * 批量主题仲裁。返回与 items 等长的主题 id 数组（失败/放弃位为 null）。
 * @param {Array<object>} items 需要仲裁的条目
 * @param {object} enums data/enums.json（提供主题枚举）
 */
export async function reviewTopics(items, enums, opts = {}) {
  return runPool(items, (item) => reviewTopic(item, enums), { ...opts, label: 'Jev 主题仲裁' });
}

/**
 * 单对判定：两条内容是否报道同一个具体事件。
 * @returns {number|null} noul 概率（1=同一事件），失败/无有效回答为 null
 */
/**
 * 同事件判定 payload（导出供测试构造夹具 key；reviewPair 专用结构）。
 * @param {object} a,b 条目 { title, originalTitle, summary, source, publishedAt }
 */
export function pairJudgePayload(a, b) {
  const brief = (x) => ({
    title: x.title || '',
    originalTitle: x.originalTitle || '',
    summary: String(x.summary || '').slice(0, 600),
    source: x.source || '',
    publishedAt: x.publishedAt || null,
  });
  return {
    model: MODEL,
    state: { first: brief(a), second: brief(b) },
    questions: {
      same: {
        type: 'noul',
        instructions:
          'first 和 second 是否报道同一个具体事件（同一公告/同一项目/同一笔交易/' +
          '同一事故等）？同主题但主体不同（如两家公司各自独立的储能项目、' +
          '同系列的不同型号发布）为 false。originalTitle 是标题的英文原文，' +
          '与 title（中文译名）指同一篇报道。',
        criteria: {
          true: '两条报道的核心事实指向同一事件，只是措辞/语言/详略不同',
          false: '两条是不同事件，或分别报道同类事件的不同主体',
        },
      },
    },
  };
}

export async function reviewPair(a, b) {
  const result = await callJudge(pairJudgePayload(a, b));
  const n = result?.answers?.same?.noul;
  return typeof n === 'number' ? n : null;
}

/**
 * 批量同事件判定（灰区配对语义合并仲裁）。
 * @param {Array<[object, object]>} pairs 条目对
 * @returns {Array<number|null>} 每对的 noul 概率（失败/放弃位为 null）
 */
export async function reviewPairs(pairs, opts = {}) {
  return runPool(pairs, ([a, b]) => reviewPair(a, b), { ...opts, label: 'Jev 语义合并' });
}

// CLI 自检：node scripts/lib/jev.mjs "测试标题"（需 TYPESAFE_API_KEY）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!jevConfigured()) {
    console.error('未配置 TYPESAFE_API_KEY');
    process.exit(1);
  }
  const enums = JSON.parse(await fs.readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/enums.json'), 'utf8'));
  const title = process.argv[2] || 'NVIDIA unveils 800 VDC power architecture for AI data centers';
  try {
    const v = await reviewOne({ title, summary: '', source: 'manual' }, enums);
    console.log(JSON.stringify(v, null, 2));
  } catch (e) {
    console.error('失败:', e?.message || e);
    process.exit(1);
  }
}
