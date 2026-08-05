import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSummary, generateWhyItMatters } from '../scripts/lib/clean.mjs';
import { loadEnums } from '../scripts/lib/schema.mjs';

const enums = await loadEnums();

test('cleanSummary：去 HTML 标签', () => {
  assert.equal(cleanSummary('<p>Battery <b>boom</b></p>'), 'Battery boom');
});

test('cleanSummary：实体解码', () => {
  assert.equal(cleanSummary('A &amp; B &lt;3'), 'A & B <3');
});

test('cleanSummary：去样板尾句', () => {
  assert.equal(cleanSummary('Storage growing fast. Read more.'), 'Storage growing fast.');
  assert.equal(cleanSummary('Details here. Continue reading'), 'Details here.');
});

test('cleanSummary：合并空白', () => {
  assert.equal(cleanSummary('  solar   power  project '), 'solar power project');
});

test('cleanSummary：限长截断加省略号', () => {
  const s = cleanSummary('x'.repeat(200), { maxLen: 100 });
  assert.ok(s.length <= 100);
  assert.ok(s.endsWith('…'));
});

test('generateWhyItMatters：含主题/数字/地区/来源', () => {
  const r = generateWhyItMatters({
    topic: 'energy-storage', metrics: [{ value: 1.06, unit: 'GWh' }], entities: [],
    region: '美国', sourceType: 'primary', source: 'EIA'
  }, enums);
  assert.match(r, /储能/);
  assert.match(r, /1\.06GWh/);
  assert.match(r, /美国/);
  assert.match(r, /一手来源/);
});

test('generateWhyItMatters：字段缺失降级', () => {
  const r = generateWhyItMatters({}, enums);
  assert.equal(r, '行业动态');
});

test('generateWhyItMatters：无翻译后缀噪音', () => {
  const r = generateWhyItMatters({ topic: 'solar-wind', region: '中国', sourceType: 'media', source: 'pv magazine' }, enums);
  assert.match(r, /光伏/);
  assert.match(r, /中国/);
  assert.match(r, /媒体 pv magazine/);
});
