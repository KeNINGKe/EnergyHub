import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSource, updateSource, deleteSource, moveSource,
  addCategory, renameCategory, deleteCategory,
  normalizeSource, findUrlOwner, srcKey,
  wechatReport, mergeCheckResults, buildSourcesPayload
} from '../../scripts/admin/lib/sources-ops.mjs';
import { validateSources } from '../../scripts/admin/lib/validators.mjs';

function mkDoc() {
  return {
    version: '1.0.0', updatedAt: '2026-09-04',
    categories: [
      { id: 'cat-a', name: '分类A', sources: [{ name: 'S1', url: 'https://s1.com' }] },
      { id: 'cat-b', name: '分类B', sources: [{ name: 'S2', url: 'https://s2.com', rss: 'https://s2.com/rss' }] },
      { id: 'cat-c', name: '分类C', sources: [] }
    ]
  };
}

/** 断言 fn 抛错（可选校验 statusCode）；不抛则失败。 */
const fails = (fn, status) => {
  try { fn(); } catch (e) {
    if (status && e.statusCode !== status) throw new Error(`期望 ${status}，实际 ${e.statusCode}: ${e.message}`);
    return;
  }
  throw new Error('应当抛错');
};

test('normalizeSource：必填校验 / url 协议 / 字段裁剪', () => {
  assert.throws(() => normalizeSource({ name: '  ' }), /name 不能为空/);
  assert.throws(() => normalizeSource({ name: 'X', url: 'ftp://x' }), /http\(s\)/);
  assert.throws(() => normalizeSource({ name: 'X', rss: 'not-a-url' }), /http\(s\)/);
  const s = normalizeSource({ name: ' X ', url: ' https://x.com ', desc: ' d ', tags: [' a ', ''], region: ' cn ', rss: null });
  assert.deepEqual(s, { name: 'X', url: 'https://x.com', desc: 'd', tags: ['a'], region: 'cn' });
});

test('addSource：同名 409、跨分类重名允许、url 查重与 allowDupUrl', () => {
  const doc = mkDoc();
  fails(() => addSource(doc, 'cat-a', { name: 'S1', url: 'https://z.com' }), 409);
  // 跨分类同名允许
  addSource(doc, 'cat-b', { name: 'S1', url: 'https://s1-b.com' });
  fails(() => addSource(doc, 'cat-a', { name: 'S9', url: 'https://s2.com' }), 409);
  assert.equal(findUrlOwner(doc, 'https://s2.com'), '分类B/S2'); // 409 的来源可解释
  addSource(doc, 'cat-a', { name: 'S9', url: 'https://s2.com' }, { allowDupUrl: true }); // 逃生口
});

test('updateSource：身份定位、字段合并、搬 url 冲突检测', () => {
  const doc = mkDoc();
  const merged = updateSource(doc, { catId: 'cat-a', name: 'S1', url: 'https://s1.com' }, { desc: '新描述' });
  assert.equal(merged.desc, '新描述');
  fails(() =>
    updateSource(doc, { catId: 'cat-a', name: 'S1', url: 'https://s1.com' }, { url: 'https://s2.com' }), 409);
  // 自身不动不算冲突
  updateSource(doc, { catId: 'cat-a', name: 'S1', url: 'https://s1.com' }, { url: 'https://s1.com' });
});

test('deleteSource / moveSource：删除与跨分类移动', () => {
  const doc = mkDoc();
  deleteSource(doc, { catId: 'cat-a', name: 'S1', url: 'https://s1.com' });
  assert.equal(doc.categories[0].sources.length, 0);
  fails(() => moveSource(doc, { catId: 'cat-a', name: 'S1', url: 'https://s1.com' }, 'cat-b'), 404);
  moveSource(doc, { catId: 'cat-b', name: 'S2', url: 'https://s2.com' }, 'cat-c');
  assert.equal(doc.categories[2].sources[0].name, 'S2');
  fails(() => moveSource(doc, { catId: 'cat-c', name: 'S2', url: 'https://s2.com' }, 'cat-c'), 400);
});

test('分类：id 规范、重名拒绝、非空分类拒删', () => {
  const doc = mkDoc();
  addCategory(doc, { id: 'cat-d', name: '分类D' });
  fails(() => addCategory(doc, { id: 'cat-d', name: 'X' }), 409);
  fails(() => addCategory(doc, { id: 'Bad_Id', name: 'Y' }), 400);
  renameCategory(doc, 'cat-d', '分类D2');
  assert.equal(doc.categories[3].name, '分类D2');
  fails(() => deleteCategory(doc, 'cat-a'), 409);
  deleteCategory(doc, 'cat-c'); // 空分类可删
  assert.equal(doc.categories.length, 3);
});

test('validateSources：合法文档通过；历史重复 url 只警告；坏结构报错', () => {
  const doc = mkDoc();
  doc.categories[1].sources.push({ name: 'S2b', url: 'https://s2.com' }); // 历史 url 重复
  const v = validateSources(doc);
  assert.equal(v.valid, true);
  assert.ok(v.warnings.some(w => w.includes('url 重复')));

  const bad = mkDoc();
  bad.categories[0].sources.push({ name: 'S1', url: 'https://x.com' }); // 分类内同名
  assert.equal(validateSources(bad).valid, false);

  const badUrl = mkDoc();
  badUrl.categories[0].sources.push({ name: 'X', url: 'javascript:alert(1)' });
  assert.equal(validateSources(badUrl).valid, false);
});

test('wechatReport：mp.weixin / 无外链 / 巡检结论建议', () => {
  const doc = mkDoc();
  doc.categories[0].sources.push({ name: 'WX', url: 'https://mp.weixin.qq.com/s/abc' });
  doc.categories[0].sources.push({ name: '卡', url: '' });
  const results = [
    { cat: '分类A', name: 'WX', url: 'https://mp.weixin.qq.com/s/abc', issue: 'wechat-invalid', title: '已被发布者删除' },
    { cat: '分类A', name: 'S1', url: 'https://s1.com', issue: 'ok' }
  ];
  const r = wechatReport(doc, results);
  assert.equal(r.total, 2);
  assert.equal(r.invalid.length, 1);
  assert.ok(r.invalid[0].suggestion.includes('换链'));
  const card = r.items.find(x => x.name === '卡');
  assert.ok(card.suggestion.includes('说明卡'));
  const unchecked = wechatReport(doc, null);
  // 有链接的项显示「尚未巡检」；无外链卡的建议与巡检无关
  assert.ok(unchecked.items.filter(x => x.url).every(x => x.suggestion.includes('尚未巡检')));
});

test('mergeCheckResults：按身份键替换、保留未覆盖记录', () => {
  const old = [
    { cat: '分类A', name: 'S1', url: 'https://s1.com', issue: 'unreachable' },
    { cat: '分类B', name: 'S2', url: 'https://s2.com', issue: 'ok' }
  ];
  const merged = mergeCheckResults(old, [
    { cat: '分类A', name: 'S1', url: 'https://s1.com', issue: 'ok' }
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find(r => r.name === 'S1').issue, 'ok');
  assert.equal(merged.find(r => r.name === 'S2').issue, 'ok');
});

test('buildSourcesPayload：stats / issueCounts / check 字段', () => {
  const doc = mkDoc();
  doc.categories[0].sources.push({ name: '坏源', url: 'https://bad.com' });
  const results = [
    { cat: '分类A', name: 'S1', url: 'https://s1.com', issue: 'ok' },
    { cat: '分类A', name: '坏源', url: 'https://bad.com', issue: 'http-404', status: 404, title: 'x', bytes: 0, finalUrl: null },
    { cat: '分类B', name: 'S2', url: 'https://s2.com', issue: 'no-link' }
  ];
  const p = buildSourcesPayload(doc, results);
  assert.deepEqual(p.stats, { total: 3, ok: 1, problems: 1, noLink: 1, unchecked: 0 });
  assert.deepEqual(p.issueCounts, { 'http-404': 1 });
  const bad = p.categories[0].sources.find(s => s.name === '坏源');
  assert.equal(bad.check.issue, 'http-404');
  assert.equal(p.categories[1].sources[0].check.issue, 'no-link');
});

test('srcKey：空 url 参与身份（无外链卡）', () => {
  assert.equal(srcKey('A', 'X', ''), srcKey('A', 'X'));
  assert.notEqual(srcKey('A', 'X', ''), srcKey('A', 'X', 'https://x.com'));
});
