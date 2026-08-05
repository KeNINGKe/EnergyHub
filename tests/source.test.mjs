import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSourceTypes, loadSourceMap, classifySourceType, sourceTypeByName, isPrimarySource } from '../scripts/lib/source.mjs';

const types = await loadSourceTypes();
const { byName } = await loadSourceMap();

function src(name) { return byName.get(name) || { name, tags: [] }; }

test('官方来源 → primary', () => {
  const r = classifySourceType(src('国家能源局 NEA'), types);
  assert.equal(r.type, 'primary');
  assert.equal(r.evidence, 'override:国家能源局 NEA');
});

test('媒体来源 → media（第一个命中 tag 决定）', () => {
  const r = classifySourceType(src('北极星电力网'), types); // tags: 媒体,数据
  assert.equal(r.type, 'media');
  assert.equal(r.evidence, 'tag:媒体');
});

test('研报来源 → research', () => {
  assert.equal(classifySourceType(src('BloombergNEF'), types).type, 'research');
});

test('KOL / newsletter → community', () => {
  assert.equal(classifySourceType(src('Volts'), types).type, 'community');
  assert.equal(classifySourceType(src('Chip Letter'), types).type, 'community');
});

test('override：IEA 强制 research（tags 首个是 官方）', () => {
  assert.equal(classifySourceType(src('IEA'), types).type, 'research');
  assert.equal(classifySourceType(src('IEA'), types).evidence, 'override:IEA');
});

test('override：NVIDIA 公司博客 → primary', () => {
  assert.equal(classifySourceType(src('NVIDIA Blog'), types).type, 'primary');
});

test('default：无类型标签 → media', () => {
  assert.equal(classifySourceType({ name: '某未知源', tags: [] }, types).type, 'media');
});

test('sourceTypeByName：按名字查询', async () => {
  const r = await sourceTypeByName('pv magazine', types);
  assert.equal(r.type, 'media');
});

test('isPrimarySource：一手返回 true', async () => {
  assert.equal(await isPrimarySource('国家能源局 NEA', types), true);
  assert.equal(await isPrimarySource('Electrek', types), false);
});

test('配置完整性：四类类型均有覆盖', async () => {
  const names = [...byName.values()].filter(s => s.rss).map(s => s.name);
  const seen = new Set();
  for (const n of names) {
    seen.add(classifySourceType(src(n), types).type);
  }
  assert.ok(seen.has('primary'), '至少一个 RSS 源为一手');
  assert.ok(seen.has('media'), '至少一个 RSS 源为媒体');
  assert.ok(seen.size >= 3, `应有 ≥3 类，实际 ${[...seen].join(',')}`);
});
