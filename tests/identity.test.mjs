import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleId, resolveSourceId } from '../scripts/lib/identity.mjs';

test('articleId：同 URL 不同参数序/尾斜杠/大小写 host → 同一身份', () => {
  const a = articleId({ url: 'https://Example.com/news/a?id=2&page=1' });
  const b = articleId({ url: 'https://example.com/news/a/?page=1&id=2' });
  assert.equal(a, b);
  assert.match(a, /^art_[a-z0-9]{12}$/);
});

test('articleId：跟踪参数不影响身份', () => {
  const a = articleId({ url: 'https://example.com/news/a?utm_source=rss' });
  const b = articleId({ url: 'https://example.com/news/a' });
  assert.equal(a, b);
});

test('articleId：不同 URL → 不同身份', () => {
  const a = articleId({ url: 'https://example.com/news/a' });
  const b = articleId({ url: 'https://example.com/news/b' });
  assert.notEqual(a, b);
});

test('articleId：无 URL 回退规范化标题（跨日稳定）', () => {
  const a = articleId({ title: 'Tesla Megapack 项目在德州!' });
  const b = articleId({ title: 'tesla megapack 项目在德州' });
  assert.equal(a, b);
  assert.match(a, /^art_[a-z0-9]{12}$/);
});

test('articleId：URL 优先于标题（同一文章标题改动不换身份）', () => {
  const a = articleId({ url: 'https://example.com/news/a', title: '旧标题' });
  const b = articleId({ url: 'https://example.com/news/a', title: '新标题' });
  assert.equal(a, b);
});

test('resolveSourceId：sources.json 配置 id 优先', () => {
  const ctx = { sourceMap: { byName: new Map([['Reuters', { id: 'reuters', name: 'Reuters' }]]) }, aliases: { byName: new Map() } };
  const r = resolveSourceId({ name: 'Reuters', url: 'https://other.example.com/x' }, ctx);
  assert.deepEqual(r, { id: 'reuters', basis: 'config' });
});

test('resolveSourceId：别名表归一中英文名/多域名', () => {
  const ctx = {
    sourceMap: { byName: new Map() },
    aliases: { byName: new Map([['路透社能源', 'reuters'], ['Reuters Energy', 'reuters']]) }
  };
  assert.deepEqual(resolveSourceId({ name: '路透社能源', url: 'https://reuters.example/x' }, ctx), { id: 'reuters', basis: 'alias' });
  assert.deepEqual(resolveSourceId({ name: 'Reuters Energy' }, ctx), { id: 'reuters', basis: 'alias' });
});

test('resolveSourceId：公众号各账独立身份，不算 mp.weixin.qq.com 一家', () => {
  const r1 = resolveSourceId({ name: '高工储能', url: 'https://mp.weixin.qq.com/s/abc', wechat: true }, {});
  assert.deepEqual(r1, { id: 'wechat:高工储能', basis: 'wechat' });
  const r2 = resolveSourceId({ name: '储能严究院', url: 'https://mp.weixin.qq.com/s/def' }, {});
  assert.deepEqual(r2, { id: 'wechat:储能严究院', basis: 'wechat' });
  assert.notEqual(r1.id, r2.id);
  const r3 = resolveSourceId({ name: '', url: 'https://mp.weixin.qq.com/s/x' }, {});
  assert.equal(r3.id, 'wechat:未知公众号');
});

test('resolveSourceId：域名兜底（去 www）', () => {
  const r = resolveSourceId({ name: '某未知源', url: 'https://www.energy-news.example.com/a' }, {});
  assert.deepEqual(r, { id: 'energy-news.example.com', basis: 'domain' });
});

test('resolveSourceId：无 name 无 url → unknown 标记（不伪装）', () => {
  assert.deepEqual(resolveSourceId({}, {}), { id: 'unknown', basis: 'unknown' });
  assert.deepEqual(resolveSourceId({ name: '   ' }, {}), { id: 'unknown', basis: 'unknown' });
});
