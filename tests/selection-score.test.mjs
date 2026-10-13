/**
 * 阶段 C-01：影子业务价值评分（scripts/lib/selection-score.mjs）。
 * 覆盖：提示词构建（含事件简报与权重上限）、应答解析（围栏容忍/维度校验/
 * total 重算）、夹具录制-回放、pickShadowTargets 三层目标、live 走回执层缓存。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildValuePrompt, parseValueContent, scoreBusinessValue,
  pickShadowTargets, runShadowScoring, DEFAULT_WEIGHTS,
  _resetShadowFixtureState,
} from '../scripts/lib/selection-score.mjs';
import { _resetReceiptsSingleton } from '../scripts/lib/ai-receipts.mjs';

const EV = {
  id: 'evt_abc123',
  title: '特斯拉获得德州 800MWh Megapack 订单',
  originalTitle: 'Tesla wins 800MWh Megapack order in Texas',
  summary: 'Tesla 与某开发商签署 800MWh 储能系统供货协议，2027 年交付。',
  topic: 'energy-storage',
  region: '美国',
  entities: ['Tesla', 'Megapack'],
  metrics: [{ label: '容量', value: 800, unit: 'MWh' }],
  independentSourceCount: 3,
  source: { name: 'ESN', type: 'media' },
  publishedAt: '2026-08-05T00:00:00Z',
  importance: 5.5,
};

test('buildValuePrompt：含事件简报、四维上限与输出协议', () => {
  const p = buildValuePrompt(EV);
  assert.ok(p.includes('800MWh'));
  assert.ok(p.includes('"independentSourceCount": 3') || p.includes('"independentSourceCount":3'));
  assert.ok(p.includes('0–30'), '业务关联上限');
  assert.ok(p.includes('0–25'), '事实增量/影响上限');
  assert.ok(p.includes('0–20'), '证据上限');
  assert.ok(p.includes('"scores"'), '输出协议');
  // 权重覆盖时上限跟着变
  const p2 = buildValuePrompt(EV, { businessRelevance: 40, factualIncrement: 20, impact: 25, evidence: 15 });
  assert.ok(p2.includes('0–40'));
  assert.ok(!p2.includes('0–30'));
});

test('parseValueContent：容忍围栏、total 重算、超上限/缺失拒绝', () => {
  const ok = parseValueContent('```json\n{"scores": {"businessRelevance": 28, "factualIncrement": 22, "impact": 20, "evidence": 16}, "keyFact": "800MWh 订单", "rationale": "头部厂商大单"}\n```');
  assert.deepEqual(ok.scores, { businessRelevance: 28, factualIncrement: 22, impact: 20, evidence: 16 });
  assert.equal(ok.total, 86, 'total 由系统重算');
  assert.equal(ok.keyFact, '800MWh 订单');

  assert.equal(parseValueContent('毫无 JSON'), null);
  assert.equal(parseValueContent('{"scores": {"businessRelevance": 28}}'), null, '维度缺失');
  assert.equal(parseValueContent('{"scores": {"businessRelevance": 31, "factualIncrement": 0, "impact": 0, "evidence": 0}}'), null, '超上限');
  assert.equal(parseValueContent('{"scores": {"businessRelevance": -1, "factualIncrement": 0, "impact": 0, "evidence": 0}}'), null, '负分');
  // 自定义权重下上限随之变化
  const w = { businessRelevance: 35, factualIncrement: 25, impact: 25, evidence: 15 };
  assert.equal(parseValueContent('{"scores": {"businessRelevance": 32, "factualIncrement": 0, "impact": 0, "evidence": 0}}', w).total, 32);
  assert.equal(parseValueContent('{"scores": {"businessRelevance": 36, "factualIncrement": 0, "impact": 0, "evidence": 0}}', w), null);
});

test('pickShadowTargets：已选 + 近门槛带 + 截断审计抽样', () => {
  const mk = (id, imp) => ({ id, importance: imp, title: `t-${id}` });
  const events = [
    mk('a', 5), mk('b', 4), mk('c', 3.5),  // 已选
    mk('d', 2.5), mk('e', 2.0),             // 近门槛带（importance ≥ threshold-nearBand = 2）
    mk('f', 1), mk('g', 0.5),               // 审计池
  ];
  const t = pickShadowTargets(events, ['a', 'b', 'c'], { ruleThreshold: 3, nearBand: 1, auditSample: 2 });
  assert.deepEqual(t.selected.map(e => e.id), ['a', 'b', 'c']);
  assert.deepEqual(t.nearBand.map(e => e.id), ['d', 'e']);
  assert.equal(t.audit.length, 2, '审计抽样条数');
  assert.ok(t.audit.every(e => ['f', 'g'].includes(e.id)));
  // 同输入确定性（种子稳定）
  const t2 = pickShadowTargets(events, ['a', 'b', 'c'], { ruleThreshold: 3, nearBand: 1, auditSample: 2 });
  assert.deepEqual(t.audit.map(e => e.id), t2.audit.map(e => e.id));
});

test('夹具录制-回放：record 落盘、replay 命中、未命中硬失败', async () => {
  const saved = { ...process.env };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-fx-'));
  try {
    const fx = path.join(dir, 'fx.json');
    // 录制路径（直调 callValueOnce 需要 stub fetch）
    process.env.SHADOW_RECORD_FILE = fx;
    delete process.env.SHADOW_REPLAY_FILE;
    delete process.env.JEV_REPLAY_FILE;
    delete process.env.JEV_RECORD_FILE;
    delete process.env.TYPESAFE_API_KEY;
    process.env.JEV_FALLBACK_BASE_URL = 'https://gw.example';
    process.env.JEV_FALLBACK_API_KEY = 'sk-test';
    _resetShadowFixtureState();

    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"scores": {"businessRelevance": 25, "factualIncrement": 20, "impact": 22, "evidence": 18}, "keyFact": "k", "rationale": "r"}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }), { status: 200 });
    };
    try {
      const v = await scoreBusinessValue(EV);
      assert.equal(v.total, 85);
      assert.equal(fetchCalls, 1);
      // 增量复用：同事件重录不再调用
      const v2 = await scoreBusinessValue(EV);
      assert.equal(fetchCalls, 1);
      assert.deepEqual(v2, v);
      // 落盘核验
      const doc = JSON.parse(await fs.readFile(fx, 'utf8'));
      assert.equal(doc.schemaVersion, 1);
      assert.equal(Object.keys(doc.entries).length, 1);

      // 回放：换另一进程视角（无网络）也应命中
      delete process.env.SHADOW_RECORD_FILE;
      process.env.SHADOW_REPLAY_FILE = fx;
      _resetShadowFixtureState();
      globalThis.fetch = async () => { throw new Error('回放模式不允许网络'); };
      const v3 = await scoreBusinessValue(EV);
      assert.equal(v3.total, 85);

      // 未命中硬失败
      await assert.rejects(() => scoreBusinessValue({ ...EV, title: '另一条新闻' }), /夹具未命中/);
    } finally {
      globalThis.fetch = undefined;
    }
  } finally {
    Object.assign(process.env, saved);
    for (const k of ['SHADOW_RECORD_FILE', 'SHADOW_REPLAY_FILE', 'JEV_FALLBACK_BASE_URL', 'JEV_FALLBACK_API_KEY']) {
      if (saved[k] === undefined) delete process.env[k];
    }
    _resetShadowFixtureState();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runShadowScoring：逐条失败不阻断、分歧清单、报告落盘', async () => {
  const saved = { ...process.env };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-run-'));
  try {
    const fx = path.join(dir, 'fx.json');
    const mk = (id, imp) => ({ ...EV, id, importance: imp, title: `事件${id}` });
    const events = [mk('a', 5), mk('b', 2.5), mk('c', 1)];
    // 录 a/b 两条夹具；c 走回放未命中 → failed（不阻断）
    process.env.JEV_FALLBACK_BASE_URL = 'https://gw.example';
    process.env.JEV_FALLBACK_API_KEY = 'sk-test';
    process.env.SHADOW_RECORD_FILE = fx;
    delete process.env.SHADOW_REPLAY_FILE;
    _resetShadowFixtureState();
    let n = 0;
    globalThis.fetch = async () => {
      n++;
      const scoresByCall = {
        1: { businessRelevance: 28, factualIncrement: 22, impact: 20, evidence: 10 }, // a → 80（已选高分）
        2: { businessRelevance: 25, factualIncrement: 20, impact: 17, evidence: 8 },  // b → 70
      };
      const s = scoresByCall[n] || { businessRelevance: 20, factualIncrement: 15, impact: 10, evidence: 5 };
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ scores: s, keyFact: '', rationale: 'r' }) } }],
      }), { status: 200 });
    };
    try {
      // 先录 a、b
      await scoreBusinessValue(events[0]);
      await scoreBusinessValue(events[1]);
      delete process.env.SHADOW_RECORD_FILE;
      process.env.SHADOW_REPLAY_FILE = fx;
      _resetShadowFixtureState();
      globalThis.fetch = async () => { throw new Error('回放模式不允许网络'); };

      const report = await runShadowScoring({
        date: '2026-08-05',
        events,
        featuredEventIds: ['a'],
        policy: { weights: DEFAULT_WEIGHTS, shadow: { ruleThreshold: 3, nearBand: 1, auditSample: 2 } },
        outDir: path.join(dir, 'selection-2026-08-05.json'),
      });
      assert.equal(report.counts.selected, 1);
      assert.equal(report.counts.nearBand, 1);
      assert.equal(report.counts.audit, 1);
      assert.equal(report.counts.failed, 1, 'c 未录夹具 → 回放失败计数');
      assert.equal(report.counts.scored, 2);
      assert.ok(Array.isArray(report.disagreements));
      // 报告落盘核验
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'selection-2026-08-05.json'), 'utf8'));
      assert.equal(onDisk.mode, 'shadow');
      assert.equal(onDisk.counts.scored, 2);
    } finally {
      globalThis.fetch = undefined;
    }
  } finally {
    Object.assign(process.env, saved);
    for (const k of ['SHADOW_RECORD_FILE', 'SHADOW_REPLAY_FILE', 'JEV_FALLBACK_BASE_URL', 'JEV_FALLBACK_API_KEY']) {
      if (saved[k] === undefined) delete process.env[k];
    }
    _resetShadowFixtureState();
    _resetReceiptsSingleton();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
