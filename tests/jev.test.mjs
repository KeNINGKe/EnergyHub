import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  shouldRescue, topicCriteria, rescueThreshold, needsTopicArbitration,
  fallbackConfig, fallbackConfigured, buildFallbackPrompt, parseFallbackContent,
  jevConfigured, reviewOne, fixtureKey, loadFixtureEntries, _resetFixtureState
} from '../scripts/lib/jev.mjs';

test('shouldRescue: relevant 且概率达阈值才捞回', () => {
  assert.equal(shouldRescue({ relevant: true, probability: 0.87 }), true);
  assert.equal(shouldRescue({ relevant: true, probability: 0.65 }), true);
  assert.equal(shouldRescue({ relevant: true, probability: 0.64 }), false);
  assert.equal(shouldRescue({ relevant: false, probability: 0.99 }), false);
});

test('shouldRescue: null/残缺 verdict 不捞回（失败维持被拒）', () => {
  assert.equal(shouldRescue(null), false);
  assert.equal(shouldRescue(undefined), false);
  assert.equal(shouldRescue({ probability: 0.99 }), false);
  assert.equal(shouldRescue({ relevant: true }), false);
});

test('shouldRescue: 阈值可通过参数覆盖', () => {
  assert.equal(shouldRescue({ relevant: true, probability: 0.6 }, 0.5), true);
  assert.equal(shouldRescue({ relevant: true, probability: 0.6 }, 0.7), false);
});

test('rescueThreshold: 默认 0.65（2026-09-21 校准），非法 env 回落默认', () => {
  assert.equal(rescueThreshold(), 0.65);
  process.env.JEV_RESCUE_THRESHOLD = '0.7';
  assert.equal(rescueThreshold(), 0.7);
  process.env.JEV_RESCUE_THRESHOLD = 'abc';
  assert.equal(rescueThreshold(), 0.65);
  process.env.JEV_RESCUE_THRESHOLD = '1.5';
  assert.equal(rescueThreshold(), 0.65);
  delete process.env.JEV_RESCUE_THRESHOLD;
});

test('topicCriteria: enums.topics 映射为 id→label', () => {
  const enums = { topics: [{ id: 'sst', label: '固态变压器' }, { id: 'pcs', label: 'PCS/储能变流器' }] };
  assert.deepEqual(topicCriteria(enums), { sst: '固态变压器', pcs: 'PCS/储能变流器' });
  assert.deepEqual(topicCriteria({}), {});
  assert.deepEqual(topicCriteria(null), {});
});

test('needsTopicArbitration: 空/兜底档要仲裁，具体主题不仲裁', () => {
  assert.equal(needsTopicArbitration({ topics: [] }, {}), true);
  assert.equal(needsTopicArbitration({ topics: null }, {}), true);
  assert.equal(needsTopicArbitration({}, {}), true);
  assert.equal(needsTopicArbitration({ topics: ['other-energy'] }, {}), true);
  assert.equal(needsTopicArbitration({ topics: ['grid', 'pcs'] }, {}), false);
  // Jev 已判过主题（捞回条目）不重复仲裁
  assert.equal(needsTopicArbitration({ topics: [] }, { _jev: { topic: 'grid' } }), false);
});

// ---- Plan B 备胎（OpenAI 兼容网关）----

test('fallbackConfig: env 运行时读取，未配置时 fallbackConfigured=false', () => {
  const saved = { ...process.env };
  try {
    delete process.env.JEV_FALLBACK_BASE_URL;
    delete process.env.JEV_FALLBACK_API_KEY;
    delete process.env.JEV_FALLBACK_MODEL;
    assert.equal(fallbackConfigured(), false);
    assert.equal(fallbackConfig().model, 'Jereh-qwen3.5-flash-no-think', '默认模型');
    process.env.JEV_FALLBACK_BASE_URL = 'https://litellm.example.cn/';
    assert.equal(fallbackConfigured(), false, '只有 baseUrl 没有 key 也不算配置');
    process.env.JEV_FALLBACK_API_KEY = 'sk-x';
    process.env.JEV_FALLBACK_MODEL = 'other-model';
    assert.equal(fallbackConfigured(), true);
    assert.equal(fallbackConfig().baseUrl, 'https://litellm.example.cn/');
    assert.equal(fallbackConfig().model, 'other-model');
  } finally {
    Object.assign(process.env, saved);
    for (const k of ['JEV_FALLBACK_BASE_URL', 'JEV_FALLBACK_API_KEY', 'JEV_FALLBACK_MODEL']) {
      if (saved[k] === undefined) delete process.env[k];
    }
  }
});

const FB_PAYLOAD = {
  state: { title: '宁德时代发布新一代储能电芯', summary: '能量密度提升 15%' },
  questions: {
    relevant: { type: 'noul', instructions: '是否能源相关', criteria: { true: '与能源相关', false: '无关' } },
    topic: { type: 'choice', instructions: '归类主题', criteria: { storage: '储能', grid: '电网' } },
  },
};

test('buildFallbackPrompt: 含内容 JSON、各问题说明/选项、输出格式', () => {
  const p = buildFallbackPrompt(FB_PAYLOAD);
  assert.ok(p.includes('【内容】'));
  assert.ok(p.includes('宁德时代发布新一代储能电芯'));
  assert.ok(p.includes('是否能源相关'));
  assert.ok(p.includes('storage=储能'));
  assert.ok(p.includes('"relevant"'), '输出格式含 noul 问题 id');
  assert.ok(p.includes('"topic"'), '输出格式含 choice 问题 id');
});

test('parseFallbackContent: 正常/带围栏/杂文字都能解析，noul 归一为 answers 同构', () => {
  const ok = parseFallbackContent(
    '{"relevant": {"value": true, "probability": 0.93}, "topic": {"choice": "storage"}}', FB_PAYLOAD);
  assert.deepEqual(ok, { answers: { relevant: { noul: 0.93 }, topic: { choice: 'storage' } } });

  const fenced = parseFallbackContent(
    '```json\n{"relevant": {"value": true, "probability": 0.9}, "topic": {"choice": "grid"}}\n```', FB_PAYLOAD);
  assert.equal(fenced?.answers?.topic?.choice, 'grid', 'markdown 围栏容忍');
});

test('parseFallbackContent: 缺字段/非法选项/概率越界/非 JSON → 整体 null', () => {
  assert.equal(parseFallbackContent('{"relevant": {"value": true}}', FB_PAYLOAD), null, '缺 topic');
  assert.equal(
    parseFallbackContent('{"relevant": {"probability": 0.9}, "topic": {"choice": "不存在"}}', FB_PAYLOAD),
    null, 'choice 不在 criteria 里');
  assert.equal(
    parseFallbackContent('{"relevant": {"probability": 1.5}, "topic": {"choice": "grid"}}', FB_PAYLOAD),
    null, '概率越界');
  assert.equal(parseFallbackContent('抱歉我不能回答', FB_PAYLOAD), null, '非 JSON');
  assert.equal(parseFallbackContent(null, FB_PAYLOAD), null, '空应答');
});

test('parseFallbackContent: 语义合并配对（single noul）同构解析', () => {
  const pairPayload = { state: { first: {}, second: {} }, questions: { same: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } } };
  const r = parseFallbackContent('{"same": {"value": true, "probability": 0.88}}', pairPayload);
  assert.deepEqual(r, { answers: { same: { noul: 0.88 } } });
});

// ---- 固定回执夹具（阶段 A 基线回放）----

/** env save/restore + 夹具状态复位（每个夹具用例的固定样板）。 */
function fixtureEnv(vars) {
  const saved = { ...process.env };
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.JEV_FALLBACK_BASE_URL;
  delete process.env.JEV_FALLBACK_API_KEY;
  Object.assign(process.env, vars);
  _resetFixtureState();
  return () => {
    Object.assign(process.env, saved);
    for (const k of Object.keys(process.env)) {
      if (saved[k] === undefined && k.startsWith('JEV_')) delete process.env[k];
    }
    if (saved.TYPESAFE_API_KEY === undefined) delete process.env.TYPESAFE_API_KEY;
    _resetFixtureState();
  };
}

async function tmpFixtureFile(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-fixture-'));
  return path.join(dir, name);
}

const FX_ENUMS = { topics: [{ id: 'storage', label: '储能' }, { id: 'grid', label: '电网' }] };
const FX_ITEM = {
  title: 'Fluence 与台达电签署储能系统供货协议',
  summary: '计划 2027 年交付 500MWh',
  source: 'TestMedia',
};

test('fixtureKey: 同 payload 同 key，键序不同也同 key（canonicalJson 排序兜底）', () => {
  const a = { model: 'jev-latest', state: { title: 'x', summary: 'y' }, questions: { relevant: { type: 'noul' }, topic: { type: 'choice' } } };
  const b = { questions: { topic: { type: 'choice' }, relevant: { type: 'noul' } }, state: { summary: 'y', title: 'x' }, model: 'jev-latest' };
  assert.equal(fixtureKey(a), fixtureKey(b));
  assert.match(fixtureKey(a), /^[0-9a-f]{16}$/);
  assert.notEqual(fixtureKey(a), fixtureKey({ ...a, state: { title: 'x2', summary: 'y' } }), '内容变 key 变');
});

test('夹具 record→replay 回路：录制真实调用回执后，离线回放零 fetch 且结果一致', async () => {
  const file = await tmpFixtureFile('fixtures.json');
  const fakeAnswers = { answers: { relevant: { noul: 0.91 }, topic: { choice: 'storage' } } };

  // 1) record：stub fetch 假装 Jev 直连成功
  const restore = fixtureEnv({ TYPESAFE_API_KEY: 'apikey_test_record', JEV_RECORD_FILE: file });
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => structuredClone(fakeAnswers) });
    const recorded = await reviewOne(FX_ITEM, FX_ENUMS);
    assert.equal(recorded.relevant, true);
    assert.equal(recorded.topic, 'storage');

    const doc = await loadFixtureEntries(file);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.source, 'jev-direct', '无备胎录制标注直连来源');
    assert.equal(Object.keys(doc.entries).length, 1, '一条回执一个条目');
    const firstKey = Object.keys(doc.entries)[0];
    const raw = await fs.readFile(file, 'utf8');
    assert.ok(!raw.includes('apikey_test_record'), '夹具不得含 API key');

    // 2) replay：无 key，fetch 一旦被调用即失败
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_RECORD_FILE;
    process.env.JEV_REPLAY_FILE = file;
    _resetFixtureState();
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error('回放模式不应发起网络请求'); };
    const replayed = await reviewOne(FX_ITEM, FX_ENUMS);
    assert.equal(fetchCalls, 0, '离线回放零网络请求');
    assert.deepEqual(replayed, { relevant: true, probability: 0.91, topic: 'storage' });

    // 3) 回放结果是深拷贝：调用方篡改不污染夹具
    replayed.probability = 0.01;
    assert.deepEqual((await loadFixtureEntries(file)).entries[firstKey].result, fakeAnswers);
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});

test('夹具 replay miss：硬失败并提示重录（不静默降级）', async () => {
  const file = await tmpFixtureFile('miss.json');
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, recordedAt: '2026-09-30T00:00:00Z', model: 'jev-latest', entries: {} }));
  const restore = fixtureEnv({ JEV_REPLAY_FILE: file });
  try {
    await assert.rejects(() => reviewOne(FX_ITEM, FX_ENUMS), /夹具未命中.*重录/);
  } finally { restore(); }
});

test('夹具 error 条目：回放时重抛同型错误（runPool null-降级逐条复现）', async () => {
  const file = await tmpFixtureFile('error.json');
  const restore = fixtureEnv({ TYPESAFE_API_KEY: 'apikey_test_record', JEV_RECORD_FILE: file });
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    await assert.rejects(() => reviewOne(FX_ITEM, FX_ENUMS), /jev api 429/);
    const doc = await loadFixtureEntries(file);
    const key = Object.keys(doc.entries)[0];
    assert.ok(doc.entries[key].error, '异常也落盘');

    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_RECORD_FILE;
    process.env.JEV_REPLAY_FILE = file;
    _resetFixtureState();
    await assert.rejects(() => reviewOne(FX_ITEM, FX_ENUMS), /jev api 429/);
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});

test('夹具互斥：REPLAY 与 RECORD 同设、REPLAY 与真实 key 同设均拒绝', async () => {
  const file = await tmpFixtureFile('mutex.json');
  const restore = fixtureEnv({ JEV_REPLAY_FILE: file, JEV_RECORD_FILE: file });
  try {
    await assert.rejects(() => reviewOne(FX_ITEM, FX_ENUMS), /不能同时设置/);
    delete process.env.JEV_RECORD_FILE;
    process.env.TYPESAFE_API_KEY = 'apikey_test_half_online';
    await assert.rejects(() => reviewOne(FX_ITEM, FX_ENUMS), /半在线/);
  } finally { restore(); }
});

test('jevConfigured: 仅设 JEV_REPLAY_FILE 也启用（离线回放走 Jev 路径），off 仍可全关', () => {
  const restore = fixtureEnv({ JEV_REPLAY_FILE: 'x.json' });
  try {
    assert.equal(jevConfigured(), true, '无 key、有夹具 → 启用');
    process.env.JEV_REVIEW = 'off';
    assert.equal(jevConfigured(), false, 'off 一票否决');
  } finally { restore(); }
});
