import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRescue, topicCriteria, rescueThreshold, needsTopicArbitration,
  fallbackConfig, fallbackConfigured, buildFallbackPrompt, parseFallbackContent
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
