import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseObservationContent,
  fallbackObservation,
  evidenceUrlsOf,
  observationBrief,
  buildObservationPrompt,
  pickObservationTargets,
} from '../scripts/lib/observe.mjs';

test('parseObservationContent：正常解析 + evidenceUrls 过滤到白名单', () => {
  const r = parseObservationContent(
    '{"fact":"上能电气 1.1GW 构网型储能 PCS 发货","implication":"出海放量","watchNext":"交付","evidenceUrls":["https://a.com/1","https://evil.com"]}',
    ['https://a.com/1']
  );
  assert.equal(r.fact, '上能电气 1.1GW 构网型储能 PCS 发货');
  assert.equal(r.implication, '出海放量');
  assert.equal(r.watchNext, '交付');
  assert.deepEqual(r.evidenceUrls, ['https://a.com/1']); // evil.com 被丢弃
});

test('parseObservationContent：容忍 markdown 围栏与前后杂文字', () => {
  const r = parseObservationContent('```json\n{"fact":"事实","implication":"","watchNext":"","evidenceUrls":[]}\n```', []);
  assert.equal(r.fact, '事实');
});

test('parseObservationContent：fact 缺失/非 JSON → null（触发 fallback）', () => {
  assert.equal(parseObservationContent('{"fact":"","implication":"x"}', []), null);
  assert.equal(parseObservationContent('{"implication":"x"}', []), null);
  assert.equal(parseObservationContent('hello', []), null);
});

test('parseObservationContent：implication/watchNext 缺失仍有效（可空字段）', () => {
  const r = parseObservationContent('{"fact":"事实","evidenceUrls":[]}', []);
  assert.equal(r.implication, '');
  assert.equal(r.watchNext, '');
});

test('evidenceUrlsOf：主 URL + relatedSources 去重保序', () => {
  const ev = { url: 'https://main.com/x', relatedSources: [{ url: 'https://a.com/1' }, 'https://b.com/2', { url: 'https://a.com/1' }] };
  assert.deepEqual(evidenceUrlsOf(ev), ['https://main.com/x', 'https://a.com/1', 'https://b.com/2']);
});

test('fallbackObservation：完整标题作 fact，其余留空，mode=fallback', () => {
  const r = fallbackObservation({ title: '某标题' });
  assert.deepEqual(r, { fact: '某标题', implication: '', watchNext: '', evidenceUrls: [], mode: 'fallback' });
});

test('observationBrief：截断摘要、带白名单；buildObservationPrompt 含白名单链接', () => {
  const ev = { title: 'T', summary: 'x'.repeat(2000), url: 'https://main.com/x', relatedSources: [{ url: 'https://a.com/1' }] };
  const brief = observationBrief(ev);
  assert.equal(brief.summary.length, 1200);
  assert.deepEqual(brief.evidenceUrls, ['https://main.com/x', 'https://a.com/1']);
  const prompt = buildObservationPrompt(ev);
  assert.ok(prompt.includes('https://a.com/1'));
  assert.ok(prompt.includes('fact'));
});

test('pickObservationTargets：入选集按 importance 降序取前 3', () => {
  const events = [
    { id: 'a', importance: 5 },
    { id: 'b', importance: 6 },
    { id: 'c', importance: 4 },
    { id: 'd', importance: 7 },
    { id: 'e', importance: 1 }, // 未入选
  ];
  const targets = pickObservationTargets(events, ['a', 'b', 'c', 'd']);
  assert.deepEqual(targets.map(t => t.id), ['d', 'b', 'a']);
});
