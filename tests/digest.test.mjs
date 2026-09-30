import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256String, sha256File, collectVersionManifest } from '../scripts/lib/digest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('canonicalJson: 键排序稳定，原始 JSON.stringify 不稳定时仍同 key', () => {
  const a = { b: 1, a: { y: 2, x: 3 } };
  const b = { a: { x: 3, y: 2 }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"x":3,"y":2},"b":1}');
  assert.equal(canonicalJson([a, 2, null, 'x']), '[{"a":{"x":3,"y":2},"b":1},2,null,"x"]');
  // 对比：原生 stringify 键序敏感（这是 canonicalJson 存在的理由）
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
});

test('sha256String/sha256File: 确定性与文件读取（缺席返回 null）', async () => {
  assert.equal(sha256String('abc'), sha256String('abc'));
  assert.equal(sha256String('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(sha256String('abc'), sha256String('abd'));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'digest-'));
  const f = path.join(dir, 'x.json');
  await fs.writeFile(f, 'hello');
  assert.equal(await sha256File(f), sha256String('hello'));
  assert.equal(await sha256File(path.join(dir, 'absent.json')), null, 'ENOENT → null（可选文件缺席合法）');
});

test('collectVersionManifest: 结构完整，可选配置缺席不炸，git 信息带 dirty 标记', async () => {
  const m = await collectVersionManifest(ROOT);
  assert.equal(m.schemaVersion, 1);
  assert.ok(m.generatedAt);
  assert.match(m.git.sha || '', /^[0-9a-f]{40}$/, '仓库内运行应能取到 SHA');
  assert.equal(typeof m.git.dirty, 'boolean');
  assert.ok(m.code['scripts/build-daily-v2.mjs'], '代码摘要含主管线');
  assert.ok(m.code['scripts/lib/jev.mjs'], '代码摘要含 jev');
  assert.equal(m.codeDigest, sha256String(canonicalJson(m.code)), 'codeDigest 是 code 映射的整体 hash');
  assert.ok(m.configs['data/sources.json'], '配置摘要含 sources');
  // regions / editorial-overrides 允许缺席（null），不抛
  assert.ok('data/regions.json' in m.configs);
  assert.ok('data/editorial-overrides.json' in m.configs);
  assert.equal(m.prompts.model, 'jev-latest');
  assert.equal(m.prompts.jevMjs, m.code['scripts/lib/jev.mjs'], '提示词版本代理 = jev.mjs hash');
  assert.ok(m.runtime.node.startsWith('v'));
});
