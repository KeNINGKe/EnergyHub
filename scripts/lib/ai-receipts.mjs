#!/usr/bin/env node
/**
 * 统一 AI 调用回执与额度控制（阶段 C-02，AIHOT_IMPLEMENTATION_PLAN §6）。
 *
 * 职责：
 *   1. 回执缓存：任务类型 + provider + 模型 + 提示词哈希 + 配置哈希 + 输入哈希
 *      确定缓存键；成功回执跨构建复用（相同输入版本恢复后新增付费调用为 0）。
 *   2. 用量账本：滚动记录调用数/token/估算费用，供 24h 额度检查与费用报告。
 *   3. 额度守卫：每次构建调用数 / 滚动 24h 调用数 / token / 估算费用 / 总耗时
 *      上限，超额抛 BudgetExhaustedError，由调用方确定性降级（不阻断日报）。
 *
 * 存储：`.state/ai/`（env AI_STATE_DIR 可覆盖）——
 *   receipts-<yyyyMM>.json  按月分片的回执 {schemaVersion, entries:{key:receipt}}
 *   usage.json              用量账本 {schemaVersion, entries:[…]}（滚动 7 天清理）
 * 该目录不进 git（.gitignore）、不进部署包；线上经 GitHub Actions artifact
 * `ai-state` 跨运行恢复（fetch-feeds.yml），artifact 方案不保证进程强杀前最后
 * 一次响应一定落远端——不宣称严格「只计费一次」（方案 §6 已声明）。
 *
 * 回执状态机：pending（已发请求未收响应）→ received（响应已落盘，待业务解析）
 *   → completed（业务解析成功，result 可复用）| failed（解析/请求失败，可重试）。
 * 发送后超时记 unknown：本构建不重发（防重复计费），下一构建允许再试（待恢复）。
 * 限流等明确未受理的失败不缓存为阻断态——可直接退避重试（与 jev runPool 协同）。
 *
 * 配置（env，风格与 JEV_* 一致）：
 *   AI_RECEIPTS=off                整体旁路（回执层退化为直调）
 *   AI_STATE_DIR                   状态目录（默认 <repo>/.state/ai）
 *   AI_BUILD_ID                    构建标识（默认进程级生成；CI 传 run_id）
 *   AI_BUDGET_CALLS_PER_BUILD      每次构建调用数上限（默认 800）
 *   AI_BUDGET_CALLS_24H            滚动 24h 调用数上限（默认 1600）
 *   AI_BUDGET_TOKENS_24H           滚动 24h token 上限（默认 4,000,000）
 *   AI_BUDGET_COST_24H             滚动 24h 估算费用上限·美元（默认 2；无单价时
 *                                  该项空转，由调用数硬上限保护——方案 §6 要求）
 *   AI_BUDGET_WALL_MS              本层总耗时上限（默认 12min，与 jev runPool 预算互补）
 *
 * 红线：回执不保存密钥（key 只出现在 HTTP header）；落盘前脱敏断言兜底。
 *
 * 用法：
 *   import { withReceipts, createReceiptStore, createBudgetGuard } from './ai-receipts.mjs';
 *   const { result, fromCache } = await withReceipts(
 *     { task, provider, model, promptHash, configHash, inputHash, store, guard },
 *     async () => ({ value: await doFetch(), usage: { promptTokens, completionTokens } }),
 *   );
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256String } from './digest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
export const DEFAULT_STATE_DIR = path.join(ROOT, '.state', 'ai');

const RECEIPTS_SCHEMA_VERSION = 1;
const USAGE_SCHEMA_VERSION = 1;
const MAX_ENTRIES_PER_SHARD = 2000;   // 超出按 updatedAt 淘汰最旧（容量上限，方案 §6）
const USAGE_KEEP_MS = 7 * 24 * 3600e3; // 账本滚动保留 7 天
const SENSITIVE_KEYS = /^(apikey|api_key|authorization|bearer|secret|token)$/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 进程级构建标识（CI 传 AI_BUILD_ID=run_id 时用之，多进程同 run 也归一）。 */
const processBuildId = `local-${Date.now().toString(36)}-${process.pid}`;
export function currentBuildId() {
  return process.env.AI_BUILD_ID || processBuildId;
}

/**
 * 回执缓存键：六元组 canonical 序列化后 sha256 前 16 位（风格对齐 jev fixtureKey）。
 * promptHash 因 provider 而异（直连=payload 哈希，备胎=翻译提示词哈希），
 * 因此键实质上已区分 provider/模型——provider/model 字段仍显式入键以防
 * 「同提示词不同模型」的未来场景。
 */
export function receiptKey({ task, provider, model, promptHash, configHash, inputHash }) {
  return sha256String(canonicalJson({ task, provider, model, promptHash, configHash, inputHash })).slice(0, 16);
}

/** 落盘前脱敏：递归剥掉疑似密钥字段（回执理论上不该有——兜底断言一道）。 */
export function sanitizeReceipt(value) {
  if (Array.isArray(value)) return value.map(sanitizeReceipt);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.test(k)) continue;
      out[k] = sanitizeReceipt(v);
    }
    return out;
  }
  if (typeof value === 'string' && /^(sk-|apikey_|Bearer )/i.test(value)) return '[redacted]';
  return value;
}

/**
 * 原子写（tmp+rename），Windows 文件锁（EPERM，杀软/同步盘扫描新文件）时退避
 * 重试，仍失败降级直接写——与 jev.mjs writeFixtureFile 同策略。
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, text, 'utf8');
  for (let i = 0; ; i++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      if (e?.code !== 'EPERM' || i >= 5) {
        await fs.writeFile(file, text, 'utf8').catch(err => { throw err; });
        await fs.unlink(tmp).catch(() => {});
        if (e?.code === 'EPERM') console.warn(`AI 回执 rename 持续 EPERM，已降级直接写（${file}）`);
        return;
      }
      await sleep(50 * (i + 1));
    }
  }
}

function monthOf(iso, offsetMonths = 0) {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + offsetMonths);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shardFile(dir, yyyyMM) {
  return path.join(dir, `receipts-${yyyyMM}.json`);
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    // 损坏分片：不毒化整体——记警告按空处理（下次写入会整体重写该分片）
    console.warn(`AI 回执分片不可读，按空处理（${file}）：${e?.message || e}`);
    return null;
  }
}

/**
 * 回执存储。同进程内懒加载当前/上一月分片为内存视图；写入走串行链（并发
 * withReceipts 下防整写竞态，与 jev.mjs recordWriteChain 同法）。
 */
export function createReceiptStore(dir = process.env.AI_STATE_DIR || DEFAULT_STATE_DIR) {
  const shardDocs = new Map(); // yyyyMM → {schemaVersion, entries}
  let writeChain = Promise.resolve();
  let writeError = null;

  async function loadShard(yyyyMM) {
    if (shardDocs.has(yyyyMM)) return shardDocs.get(yyyyMM);
    const doc = (await readJsonOrNull(shardFile(dir, yyyyMM))) ||
      { schemaVersion: RECEIPTS_SCHEMA_VERSION, entries: {} };
    const normalized = doc?.entries && typeof doc.entries === 'object' && !Array.isArray(doc.entries)
      ? doc
      : { schemaVersion: RECEIPTS_SCHEMA_VERSION, entries: {} };
    shardDocs.set(yyyyMM, normalized);
    return normalized;
  }

  /** 查回执：当前月 + 上一月（跨月构建能命中上月末的回执）。 */
  async function get(key) {
    const now = new Date().toISOString();
    for (const yyyyMM of [monthOf(now), monthOf(now, -1)]) {
      const hit = (await loadShard(yyyyMM)).entries[key];
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 写回执（脱敏后）。分片超容量按 updatedAt 淘汰最旧。返回写入链，调用方
   * 关键路径（received/completed）应 await 以保证「先落盘再交业务」。
   */
  function put(receipt) {
    const clean = sanitizeReceipt(receipt);
    const yyyyMM = monthOf(clean.updatedAt || new Date().toISOString());
    writeChain = writeChain.then(async () => {
      const doc = await loadShard(yyyyMM);
      doc.entries[clean.key] = clean;
      const keys = Object.keys(doc.entries);
      if (keys.length > MAX_ENTRIES_PER_SHARD) {
        const byAge = keys
          .map(k => [k, doc.entries[k]?.updatedAt || ''])
          .sort((a, b) => (a[1] < b[1] ? -1 : 1));
        for (const [k] of byAge.slice(0, keys.length - MAX_ENTRIES_PER_SHARD)) delete doc.entries[k];
      }
      await writeAtomic(shardFile(dir, yyyyMM), JSON.stringify(doc, null, 2) + '\n');
    }).catch(e => {
      writeError = writeError || e;
      console.error(`AI 回执写入失败（${dir}）：${String(e?.message || e).slice(0, 150)}`);
    });
    return writeChain;
  }

  return {
    dir,
    get,
    put,
    /** 测试/编排校验用：首个写入错误（写失败不毒化构建，但可被显式检查）。 */
    _writeStatus: () => ({ writeError: writeError ? String(writeError.message || writeError) : null }),
  };
}

/**
 * 用量账本（usage.json，滚动 7 天）。entry：
 *   { at, buildId, task, provider, model, calls, promptTokens?, completionTokens?, costEstimate? }
 */
export function createUsageLedger(dir = process.env.AI_STATE_DIR || DEFAULT_STATE_DIR) {
  const file = path.join(dir, 'usage.json');
  let cache = null;
  let writeChain = Promise.resolve();

  async function load() {
    if (cache) return cache;
    const doc = (await readJsonOrNull(file)) || { schemaVersion: USAGE_SCHEMA_VERSION, entries: [] };
    cache = Array.isArray(doc.entries) ? doc : { schemaVersion: USAGE_SCHEMA_VERSION, entries: [] };
    return cache;
  }

  async function record(entry) {
    const doc = await load();
    doc.entries.push({ at: new Date().toISOString(), buildId: currentBuildId(), calls: 1, ...entry });
    const cutoff = Date.now() - USAGE_KEEP_MS;
    doc.entries = doc.entries.filter(e => new Date(e.at).getTime() >= cutoff);
    writeChain = writeChain.then(() => writeAtomic(file, JSON.stringify(doc, null, 2) + '\n'));
    return writeChain;
  }

  /** 自 now-ms 起的用量聚合（24h 额度检查用；token/cost 缺失按 0 计并如实标注）。 */
  async function since(ms) {
    const doc = await load();
    const cutoff = Date.now() - ms;
    const rows = doc.entries.filter(e => new Date(e.at).getTime() >= cutoff);
    const agg = { calls: 0, promptTokens: 0, completionTokens: 0, costEstimate: 0, tokenRecords: 0 };
    for (const r of rows) {
      agg.calls += Number(r.calls) || 0;
      if (Number.isFinite(r.promptTokens)) { agg.promptTokens += r.promptTokens; agg.tokenRecords++; }
      if (Number.isFinite(r.completionTokens)) agg.completionTokens += r.completionTokens;
      if (Number.isFinite(r.costEstimate)) agg.costEstimate += r.costEstimate;
    }
    return { ...agg, entries: rows.length, hasTokenData: agg.tokenRecords > 0 };
  }

  return { record, since, sinceLast24h: () => since(24 * 3600e3) };
}

/** 额度配置（env 覆盖，默认宽松——当前用量 ~350 调用/天 + 影子评分余量）。 */
export function budgetFromEnv() {
  const num = (name, d) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    maxCallsPerBuild: num('AI_BUDGET_CALLS_PER_BUILD', 800),
    maxCalls24h: num('AI_BUDGET_CALLS_24H', 1600),
    maxTokens24h: num('AI_BUDGET_TOKENS_24H', 4_000_000),
    maxCost24h: num('AI_BUDGET_COST_24H', 2),
    maxWallMs: num('AI_BUDGET_WALL_MS', 12 * 60_000),
  };
}

/** 额度耗尽：调用方捕获后确定性降级（用旧规则，不阻断整个日报）。 */
export class BudgetExhaustedError extends Error {
  constructor(reason, detail) {
    super(`AI 预算耗尽（${reason}）：${detail}`);
    this.name = 'BudgetExhaustedError';
    this.budgetExhausted = true;
    this.reason = reason;
  }
}

/**
 * 额度守卫。beforeCall() 在每次真实调用前检查（抛 BudgetExhaustedError）；
 * recordCall() 在调用结束后记账（无论成败都计调用数——失败也可能已计费）。
 */
export function createBudgetGuard({ budget = budgetFromEnv(), ledger } = {}) {
  const startedAt = Date.now();
  let callsThisBuild = 0;

  return {
    budget,
    usage: () => ({ callsThisBuild, wallMs: Date.now() - startedAt }),
    async beforeCall() {
      if (callsThisBuild >= budget.maxCallsPerBuild) {
        throw new BudgetExhaustedError('calls-per-build', `${callsThisBuild}/${budget.maxCallsPerBuild}`);
      }
      if (Date.now() - startedAt > budget.maxWallMs) {
        throw new BudgetExhaustedError('wall-time', `${Math.round((Date.now() - startedAt) / 1000)}s > ${Math.round(budget.maxWallMs / 1000)}s`);
      }
      const agg = await ledger.sinceLast24h();
      if (agg.calls >= budget.maxCalls24h) {
        throw new BudgetExhaustedError('calls-24h', `${agg.calls}/${budget.maxCalls24h}`);
      }
      if (agg.promptTokens + agg.completionTokens >= budget.maxTokens24h) {
        throw new BudgetExhaustedError('tokens-24h', `${agg.promptTokens + agg.completionTokens}/${budget.maxTokens24h}`);
      }
      if (agg.costEstimate >= budget.maxCost24h) {
        throw new BudgetExhaustedError('cost-24h', `$${agg.costEstimate.toFixed(4)}/$${budget.maxCost24h}`);
      }
    },
    async recordCall(entry) {
      callsThisBuild++;
      await ledger.record(entry);
    },
  };
}

/** 单价估算（USD/1k tokens）；无单价返回 null（费用项空转，由调用数上限保护）。 */
export function estimateCost(usage, pricing) {
  if (!usage || !Number.isFinite(usage.promptTokens) || !pricing) return null;
  const p = (usage.promptTokens / 1000) * (pricing.promptPer1k || 0)
    + ((usage.completionTokens || 0) / 1000) * (pricing.completionPer1k || 0);
  return p > 0 ? Math.round(p * 1e6) / 1e6 : null;
}

const isAbort = (e) => e?.name === 'AbortError' || /aborted|timeout|ETIMEDOUT/i.test(String(e?.message || e));

/**
 * 回执包装的主调用入口。
 *
 * @param {object} opts { task, provider, model, promptHash, configHash, inputHash,
 *   store, guard, pricing? }
 * @param {() => Promise<{value:any, usage?:{promptTokens,completionTokens}}>} fn
 *   真实网络调用；返回 value（响应）与可选 usage。
 * @param {(raw:any) => any} [parse] 业务解析。提供时严格「received 先落盘、再
 *   解析、再 completed」；不提供时 received/completed 合并为一次写（jev 路径：
 *   callJev/callFallback 返回的已是解析结果，两写无信息增量）。
 * @returns {Promise<{result:any, fromCache:boolean, key:string}>}
 */
export async function withReceipts(opts, fn, parse) {
  const { task, provider, model, promptHash, configHash, inputHash, store, guard, pricing } = opts;
  const key = receiptKey({ task, provider, model, promptHash, configHash, inputHash });
  const buildId = currentBuildId();

  const hit = await store.get(key);
  if (hit?.status === 'completed' && hit.result) {
    return { result: structuredClone(hit.result), fromCache: true, key };
  }
  // 同一构建内不重发 unknown/pending（发送后结果未知，防重复计费）；
  // 跨构建视为待恢复，允许再试（方案 §6：unknown 不立即无限重发）。
  if (hit && (hit.status === 'unknown' || hit.status === 'pending') && hit.buildId === buildId) {
    throw new Error(`AI 回执 ${hit.status}（key=${key}）：本构建不重发，跨构建恢复`);
  }
  // failed：明确失败（含限流未受理），不阻断重试。

  await guard.beforeCall();
  const base = { key, task, provider, model, promptHash, configHash, inputHash, buildId };
  const createdAt = hit?.createdAt || new Date().toISOString();
  await store.put({ ...base, createdAt, updatedAt: new Date().toISOString(), status: 'pending' });

  const t0 = Date.now();
  try {
    const { value, usage, respondedBy } = await fn();
    const latencyMs = Date.now() - t0;
    if (parse) {
      await store.put({ ...base, createdAt, updatedAt: new Date().toISOString(), status: 'received', raw: value, usage: usage ?? null, latencyMs, respondedBy: respondedBy || provider });
    }
    const result = parse ? parse(value) : value;
    await store.put({
      ...base, createdAt, updatedAt: new Date().toISOString(), status: 'completed',
      result, usage: usage ?? null, latencyMs, respondedBy: respondedBy || provider,
      costEstimate: estimateCost(usage, pricing),
    });
    await guard.recordCall({ task, provider, model, calls: 1, ...(usage || {}), costEstimate: estimateCost(usage, pricing) });
    return { result, fromCache: false, key };
  } catch (e) {
    const status = isAbort(e) ? 'unknown' : 'failed';
    // unknown（超时等）：可能已被计费——计调用数不虚报 token；failed 同理。
    // BudgetExhaustedError 在 beforeCall 已抛，不会进这里。
    await store.put({
      ...base, createdAt, updatedAt: new Date().toISOString(), status,
      error: String(e?.message || e).slice(0, 300), latencyMs: Date.now() - t0,
    }).catch(() => {});
    await guard.recordCall({ task, provider, model, calls: 1 }).catch(() => {});
    throw e;
  }
}

// ---- 进程级懒单例（jev.mjs 等调用点复用同一 store/guard/ledger） ----
let defaultStore = null, defaultLedger = null, defaultGuard = null;

/** 回执层是否启用：显式关闭或夹具模式（REPLAY/RECORD）时旁路，离线回放保持纯净。 */
export function receiptsEnabled() {
  return process.env.AI_RECEIPTS !== 'off'
    && !process.env.JEV_REPLAY_FILE && !process.env.JEV_RECORD_FILE;
}

export function defaultStoreInstance() {
  if (!defaultStore) defaultStore = createReceiptStore();
  return defaultStore;
}

export function defaultGuardInstance() {
  if (!defaultGuard) {
    defaultLedger = defaultLedger || createUsageLedger();
    defaultGuard = createBudgetGuard({ ledger: defaultLedger });
  }
  return defaultGuard;
}

/** 测试隔离用：清空单例与 env 缓存。 */
export function _resetReceiptsSingleton() {
  defaultStore = null;
  defaultLedger = null;
  defaultGuard = null;
}

// CLI 自检：node scripts/lib/ai-receipts.mjs [state-dir]
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const dir = process.argv[2] || DEFAULT_STATE_DIR;
  const ledger = createUsageLedger(dir);
  const store = createReceiptStore(dir);
  const agg = await ledger.sinceLast24h();
  const { writeError } = store._writeStatus();
  console.log(JSON.stringify({ dir, usage24h: agg, writeError }, null, 2));
}
