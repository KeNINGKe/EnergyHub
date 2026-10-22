/**
 * 阶段 C-02：AI 调用回执缓存与额度控制（scripts/lib/ai-receipts.mjs）。
 * 覆盖：缓存命中不再真实调用、pending→completed 落盘、unknown 本构建不重发/
 * 跨构建恢复、failed 可重试、额度耗尽（per-build / 24h）、用量账本聚合、
 * 分片跨月命中、脱敏（无密钥残留）、respondedBy 标注、jev.mjs 集成。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  receiptKey, sanitizeReceipt, withReceipts, estimateCost,
  createReceiptStore, createUsageLedger, createBudgetGuard, budgetFromEnv,
  BudgetExhaustedError, currentBuildId, _resetReceiptsSingleton,
} from '../scripts/lib/ai-receipts.mjs';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ai-receipts-'));
}

/** 标准 opts + 注入计数的 fn。 */
function makeHarness(dir, { budget } = {}) {
  const store = createReceiptStore(dir);
  const ledger = createUsageLedger(dir);
  const guard = createBudgetGuard({ ledger, budget: budget || budgetFromEnv() });
  const identity = {
    task: 'test:judge', provider: 'fallback', model: 'm1',
    promptHash: 'p'.repeat(16), configHash: 'c'.repeat(16), inputHash: 'i'.repeat(16),
  };
  let calls = 0;
  const fn = async () => {
    calls++;
    return { value: { answers: { ok: true } }, usage: { promptTokens: 10, completionTokens: 5 } };
  };
  return { store, ledger, guard, identity, fn, callCount: () => calls };
}

test('receiptKey: 同六元组稳定，任一字段变化即换键', () => {
  const a = { task: 't', provider: 'p', model: 'm', promptHash: 'ph', configHash: 'ch', inputHash: 'ih' };
  assert.equal(receiptKey(a), receiptKey({ ...a }));
  assert.notEqual(receiptKey(a), receiptKey({ ...a, model: 'm2' }));
  assert.notEqual(receiptKey(a), receiptKey({ ...a, promptHash: 'ph2' }));
  assert.match(receiptKey(a), /^[0-9a-f]{16}$/);
});

test('sanitizeReceipt: 剥密钥字段与 sk-/apikey_ 前缀字符串', () => {
  const clean = sanitizeReceipt({
    apiKey: 'sk-secret', Authorization: 'Bearer x', nested: { token: 't', ok: 1 },
    list: [{ api_key: 'k', v: 2 }],
  });
  assert.equal(clean.apiKey, undefined);
  assert.equal(clean.Authorization, undefined);
  assert.equal(clean.nested.token, undefined);
  assert.equal(clean.nested.ok, 1);
  assert.equal(clean.list[0].api_key, undefined);
  assert.equal(sanitizeReceipt('sk-or-v1-abc'), '[redacted]');
  assert.equal(sanitizeReceipt('apikey_213'), '[redacted]');
  assert.equal(sanitizeReceipt('normal'), 'normal');
});

test('withReceipts: 首调落盘 completed，二次调用命中缓存不再真实调用', async () => {
  const dir = await tempDir();
  const h = makeHarness(dir);
  const r1 = await withReceipts({ ...h.identity, store: h.store, guard: h.guard }, h.fn);
  assert.equal(r1.fromCache, false);
  assert.equal(h.callCount(), 1);
  await h.guard.recordCall({ task: 'x' }); // 无关记账，推进链

  const h2 = { ...h, fn: async () => { throw new Error('缓存命中不该真实调用'); } };
  const r2 = await withReceipts({ ...h.identity, store: h.store, guard: h.guard }, h2.fn);
  assert.equal(r2.fromCache, true);
  assert.deepEqual(r2.result, r1.result);

  // 落盘核验：分片文件真实存在且状态 completed
  const files = (await fs.readdir(dir)).filter(f => f.startsWith('receipts-'));
  assert.equal(files.length, 1);
  const doc = JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'));
  const entries = Object.values(doc.entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'completed');
  assert.equal(entries[0].usage.promptTokens, 10);
  assert.equal(entries[0].respondedBy, 'fallback');
});

test('withReceipts: failed 状态可重试（限流/失败不缓存为阻断）', async () => {
  const dir = await tempDir();
  let n = 0;
  const store = createReceiptStore(dir);
  const guard = createBudgetGuard({ ledger: createUsageLedger(dir), budget: budgetFromEnv() });
  const fn = async () => {
    n++;
    if (n === 1) throw new Error('fallback api 500: boom');
    return { value: 'ok' };
  };
  await assert.rejects(() => withReceipts({ ...makeHarness(dir).identity, store, guard }, fn), /500/);
  const r2 = await withReceipts({ ...makeHarness(dir).identity, store, guard }, fn);
  assert.equal(r2.fromCache, false);
  assert.equal(r2.result, 'ok');
  assert.equal(n, 2);
});

test('withReceipts: unknown（超时）本构建不重发，跨构建允许恢复', async () => {
  const saved = { ...process.env };
  try {
    process.env.AI_BUILD_ID = 'build-A';
    const dir = await tempDir();
    const store = createReceiptStore(dir);
    const guard = createBudgetGuard({ ledger: createUsageLedger(dir), budget: budgetFromEnv() });
    const identity = makeHarness(dir).identity;
    let n = 0;
    const abortFn = async () => {
      n++;
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      throw e;
    };
    await assert.rejects(() => withReceipts({ ...identity, store, guard }, abortFn), /abort/i);
    assert.equal(n, 1);

    // 同一构建：直接抛「不重发」，fn 不再被调
    await assert.rejects(() => withReceipts({ ...identity, store, guard }, abortFn), /本构建不重发/);
    assert.equal(n, 1);

    // 跨构建：允许再试（改成成功）
    process.env.AI_BUILD_ID = 'build-B';
    const okFn = async () => ({ value: 'recovered' });
    const r = await withReceipts({ ...identity, store, guard }, okFn);
    assert.equal(r.fromCache, false);
    assert.equal(r.result, 'recovered');
  } finally {
    Object.assign(process.env, saved);
    if (saved.AI_BUILD_ID === undefined) delete process.env.AI_BUILD_ID;
  }
});

test('withReceipts: parse 路径 received 先落盘、解析失败记 failed', async () => {
  const dir = await tempDir();
  const store = createReceiptStore(dir);
  const guard = createBudgetGuard({ ledger: createUsageLedger(dir), budget: budgetFromEnv() });
  const identity = { ...makeHarness(dir).identity, task: 'parse-path' };

  const badParse = () => { throw new Error('无法解析'); };
  await assert.rejects(() =>
    withReceipts({ ...identity, store, guard }, async () => ({ value: 'raw-response' }), badParse), /无法解析/);

  const key = receiptKey(identity);
  const final = await store.get(key);
  assert.equal(final.status, 'failed');
  assert.match(final.error, /无法解析/);

  // 成功路径：completed 持有 parse 后的 result
  const r = await withReceipts(
    { ...identity, store, guard },
    async () => ({ value: 'raw-2' }),
    v => ({ parsed: v.length }),
  );
  assert.deepEqual(r.result, { parsed: 5 });
  assert.equal((await store.get(key)).status, 'completed');
});

test('额度守卫: per-build 调用数上限，超额抛 BudgetExhaustedError 且不写 pending', async () => {
  const dir = await tempDir();
  const h = makeHarness(dir, { budget: { ...budgetFromEnv(), maxCallsPerBuild: 1, maxCalls24h: 9999, maxTokens24h: 1e9, maxCost24h: 1e9, maxWallMs: 60e3 } });
  const r1 = await withReceipts({ ...h.identity, store: h.store, guard: h.guard }, h.fn);
  assert.equal(r1.fromCache, false);

  const identity2 = { ...h.identity, task: 'second' };
  await assert.rejects(
    () => withReceipts({ ...identity2, store: h.store, guard: h.guard }, h.fn),
    e => e instanceof BudgetExhaustedError && e.reason === 'calls-per-build',
  );
  assert.equal(h.callCount(), 1);
  // 被额度挡下的调用不落 pending（下次额度恢复可直接发起）
  const blocked = await h.store.get(receiptKey(identity2));
  assert.equal(blocked, null);
});

test('额度守卫: 滚动 24h 调用数上限（账本预置）', async () => {
  const dir = await tempDir();
  const ledger = createUsageLedger(dir);
  // 预置 24h 内已满额（maxCalls24h=1）
  await ledger.record({ at: new Date(Date.now() - 3600e3).toISOString(), calls: 1, task: 'old' });
  const guard = createBudgetGuard({ ledger, budget: { ...budgetFromEnv(), maxCallsPerBuild: 10, maxCalls24h: 1, maxTokens24h: 1e9, maxCost24h: 1e9, maxWallMs: 60e3 } });
  await assert.rejects(() => guard.beforeCall(), e => e.reason === 'calls-24h');
});

test('额度守卫: 24h token / 费用上限与账本聚合', async () => {
  const dir = await tempDir();
  const ledger = createUsageLedger(dir);
  const at = new Date(Date.now() - 60e3).toISOString();
  await ledger.record({ at, calls: 1, promptTokens: 300, completionTokens: 200, costEstimate: 0.5 });
  await ledger.record({ at, calls: 1, promptTokens: 100, costEstimate: 0.25 });
  // 7 天前的旧记录不计入滚动窗口
  await ledger.record({ at: new Date(Date.now() - 8 * 86400e3).toISOString(), calls: 99, promptTokens: 9999 });
  const agg = await ledger.sinceLast24h();
  assert.equal(agg.calls, 2);
  assert.equal(agg.promptTokens, 400);
  assert.equal(agg.completionTokens, 200);
  assert.equal(agg.costEstimate, 0.75);

  const mk = (over) => createBudgetGuard({
    ledger,
    budget: { ...budgetFromEnv(), maxCallsPerBuild: 10, maxCalls24h: 10, maxTokens24h: over ? 500 : 1e9, maxCost24h: over ? 1e9 : 0.5, maxWallMs: 60e3 },
  });
  await assert.rejects(() => mk(true).beforeCall(), e => e.reason === 'tokens-24h');
  await assert.rejects(() => mk(false).beforeCall(), e => e.reason === 'cost-24h');
});

test('budgetFromEnv: 空串/未设用默认，显式 0 仍是 0（CI 空串事故回归）', () => {
  // fetch-feeds.yml 把未配置的 vars.AI_BUDGET_* 以空串传入 env——
  // 曾被解析成上限 0，线上所有 LLM 调用发出前即被拦（且不落回执，无迹可查）
  const names = ['AI_BUDGET_CALLS_PER_BUILD', 'AI_BUDGET_CALLS_24H', 'AI_BUDGET_TOKENS_24H', 'AI_BUDGET_COST_24H', 'AI_BUDGET_WALL_MS'];
  const saved = Object.fromEntries(names.map(n => [n, process.env[n]]));
  try {
    for (const n of names) process.env[n] = '';
    let b = budgetFromEnv();
    assert.equal(b.maxCallsPerBuild, 800);
    assert.equal(b.maxCalls24h, 1600);
    assert.equal(b.maxTokens24h, 4_000_000);
    assert.equal(b.maxCost24h, 2);
    assert.equal(b.maxWallMs, 12 * 60_000);

    for (const n of names) delete process.env[n];
    b = budgetFromEnv();
    assert.equal(b.maxCallsPerBuild, 800);

    // 显式 0 是合法配置（想彻底关掉），不能被空串规则吞掉
    process.env.AI_BUDGET_CALLS_PER_BUILD = '0';
    b = budgetFromEnv();
    assert.equal(b.maxCallsPerBuild, 0);

    // 非法值仍回落默认
    process.env.AI_BUDGET_CALLS_PER_BUILD = 'abc';
    b = budgetFromEnv();
    assert.equal(b.maxCallsPerBuild, 800);
  } finally {
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n]; else process.env[n] = v;
    }
  }
});

test('分片: 按月分片写入，跨月仍能命中上月回执', async () => {
  const dir = await tempDir();
  const store = createReceiptStore(dir);
  // 直接伪造一条 updatedAt 在上月的回执（跨月构建场景）
  const prev = new Date();
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  await store.put({
    key: 'old-month-key', task: 't', provider: 'p', model: 'm', promptHash: 'x', configHash: 'x', inputHash: 'x',
    buildId: 'b', createdAt: prev.toISOString(), updatedAt: prev.toISOString(),
    status: 'completed', result: { v: 1 },
  });
  assert.equal((await store.get('old-month-key')).result.v, 1);

  const files = (await fs.readdir(dir)).filter(f => /^receipts-\d{6}\.json$/.test(f));
  assert.equal(files.length, 1, '只写了上月分片');
});

test('脱敏: 回执落盘不含密钥材料', async () => {
  const dir = await tempDir();
  const store = createReceiptStore(dir);
  await store.put({
    key: 'k', task: 't', provider: 'p', model: 'm', promptHash: 'x', configHash: 'x', inputHash: 'x',
    buildId: 'b', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'completed', result: { apiKey: 'sk-or-v1-secret', nested: { authorization: 'Bearer t' } },
  });
  const files = (await fs.readdir(dir)).filter(f => f.startsWith('receipts-'));
  const text = await fs.readFile(path.join(dir, files[0]), 'utf8');
  assert.ok(!text.includes('sk-or-v1-secret'), 'sk- 前缀 key 不得落盘');
  assert.ok(!text.includes('Bearer t'), 'authorization 不得落盘');
});

test('estimateCost: 无单价或无 usage 返回 null（费用项空转由调用数保护）', () => {
  assert.equal(estimateCost(null, { promptPer1k: 0.1 }), null);
  assert.equal(estimateCost({ promptTokens: 100, completionTokens: 100 }), null);
  assert.equal(estimateCost({ promptTokens: 1000, completionTokens: 1000 }, { promptPer1k: 0.1, completionPer1k: 0.4 }), 0.5);
});

test('currentBuildId: env 覆盖优先（CI 传 run_id 归一多进程）', () => {
  const saved = process.env.AI_BUILD_ID;
  try {
    process.env.AI_BUILD_ID = 'run-123';
    assert.equal(currentBuildId(), 'run-123');
    delete process.env.AI_BUILD_ID;
    assert.match(currentBuildId(), /^local-/);
  } finally {
    if (saved !== undefined) process.env.AI_BUILD_ID = saved;
  }
});

// ---- jev.mjs 集成：live 调用经回执层，二次同输入 0 真实调用 ----

test('集成: reviewOne 走回执层，同输入第二次缓存命中', async () => {
  const saved = { ...process.env };
  const item = { title: 'Tesla Megapack 800MWh project in Texas', summary: 'Grid storage deployment', source: 'ESN' };
  const enums = { topics: [{ id: 'energy-storage', label: '储能' }] };
  const { reviewOne, _resetFixtureState } = await import('../scripts/lib/jev.mjs');
  try {
    const dir = await tempDir();
    process.env.AI_STATE_DIR = dir;
    process.env.AI_BUILD_ID = 'it-build';
    process.env.JEV_FALLBACK_BASE_URL = 'https://gw.example/';
    process.env.JEV_FALLBACK_API_KEY = 'sk-test-key';
    process.env.JEV_FALLBACK_MODEL = 'test-model';
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_REPLAY_FILE;
    delete process.env.JEV_RECORD_FILE;
    _resetFixtureState();
    _resetReceiptsSingleton();

    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"relevant": {"value": true, "probability": 0.9}, "topic": {"choice": "energy-storage"}}' } }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }), { status: 200 });
    };

    const v1 = await reviewOne(item, enums);
    assert.equal(fetchCalls, 1, '首次真实调用');
    assert.equal(v1.relevant, true);
    assert.equal(v1.topic, 'energy-storage');

    const v2 = await reviewOne(item, enums);
    assert.equal(fetchCalls, 1, '第二次命中缓存，不再真实调用');
    assert.deepEqual(v2, v1);

    // 回执落盘核验：completed + usage 记账
    const shard = (await fs.readdir(dir)).find(f => f.startsWith('receipts-'));
    const doc = JSON.parse(await fs.readFile(path.join(dir, shard), 'utf8'));
    const receipt = Object.values(doc.entries)[0];
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.task, 'jev:review');
    assert.equal(receipt.usage.promptTokens, 120);
    assert.ok(!JSON.stringify(doc).includes('sk-test-key'), 'key 不落盘');
  } finally {
    globalThis.fetch = undefined;
    Object.assign(process.env, saved);
    for (const k of ['AI_STATE_DIR', 'AI_BUILD_ID', 'JEV_FALLBACK_BASE_URL', 'JEV_FALLBACK_API_KEY', 'JEV_FALLBACK_MODEL']) {
      if (saved[k] === undefined) delete process.env[k];
    }
    _resetReceiptsSingleton();
    (await import('../scripts/lib/jev.mjs'))._resetFixtureState();
  }
});
