import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dingtalkSign, buildSignedUrl, resolveHotItems, buildHotMessage,
  fitLines, truncateAtSentence, MAX_TEXT_BYTES
} from '../scripts/lib/dingtalk.mjs';

test('dingtalkSign：固定向量（HmacSHA256 → base64）', () => {
  const sign = dingtalkSign('test-secret', 1700000000000);
  assert.equal(sign, 'BYMqUCZnSqbfPf1GCfZftO7Rg2g6P+Rp3/4+bLNtSGA=');
});

test('buildSignedUrl：带签名，timestamp/sign 正确写入且可被 URL 解析', () => {
  const url = buildSignedUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', 'test-secret', 1700000000000);
  const u = new URL(url);
  assert.equal(u.searchParams.get('access_token'), 'abc');
  assert.equal(u.searchParams.get('timestamp'), '1700000000000');
  assert.equal(u.searchParams.get('sign'), 'BYMqUCZnSqbfPf1GCfZftO7Rg2g6P+Rp3/4+bLNtSGA=');
});

test('buildSignedUrl：未配 secret 时原样返回（关键词/白名单模式）', () => {
  const webhook = 'https://oapi.dingtalk.com/robot/send?access_token=abc';
  assert.equal(buildSignedUrl(webhook, '', 123), webhook);
});

test('resolveHotItems：优先使用 hotEventIds', () => {
  const featured = { hotEventIds: ['a', 'b'], featuredEventIds: ['c', 'd', 'e', 'f', 'g', 'h'] };
  const daily = { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  assert.deepEqual(resolveHotItems(featured, daily).map(x => x.id), ['a', 'b']);
});

test('resolveHotItems：hotEventIds 缺失回退 featuredEventIds 前 5 条', () => {
  const featured = { featuredEventIds: ['c', 'd', 'e', 'f', 'g', 'h'] };
  const daily = { items: ['c', 'd', 'e', 'f', 'g', 'h'].map(id => ({ id })) };
  assert.deepEqual(resolveHotItems(featured, daily).map(x => x.id), ['c', 'd', 'e', 'f', 'g']);
});

test('resolveHotItems：hotEventIds 为空数组也回退', () => {
  const featured = { hotEventIds: [], featuredEventIds: ['c', 'd'] };
  const daily = { items: [{ id: 'c' }, { id: 'd' }] };
  assert.deepEqual(resolveHotItems(featured, daily).map(x => x.id), ['c', 'd']);
});

test('resolveHotItems：跳过 daily 中不存在的陈旧 id', () => {
  const featured = { hotEventIds: ['a', 'missing'] };
  const daily = { items: [{ id: 'a' }] };
  assert.deepEqual(resolveHotItems(featured, daily).map(x => x.id), ['a']);
});

test('buildHotMessage：含标题链接、来源、站点链接，且不含今日观察', () => {
  const featured = {
    date: '2026-09-01',
    observations: ['【储能】观察A'],
    hotEventIds: ['a']
  };
  const daily = { items: [{ id: 'a', title: '热点标题', url: 'https://x.com/a', source: { name: 'pv magazine' } }] };
  const { title, text } = buildHotMessage(featured, daily, { siteUrl: 'https://site.example' });
  assert.equal(title, 'EnergyHub · 2026-09-01 热点');
  assert.ok(text.includes('2026-09-01'));
  assert.ok(text.includes('[热点标题](https://x.com/a)'));
  assert.ok(text.includes('｜pv magazine'));
  assert.ok(!text.includes('今日观察'));
  assert.ok(!text.includes('观察A'));
  assert.ok(text.includes('[查看完整日报 →](https://site.example)'));
});

test('buildHotMessage：无站点链接时不输出站点链接', () => {
  const featured = { date: '2026-09-01', hotEventIds: ['a'] };
  const daily = { items: [{ id: 'a', title: 'T', url: 'https://x.com/a' }] };
  const { text } = buildHotMessage(featured, daily, {});
  assert.ok(!text.includes('查看完整日报'));
  assert.ok(text.includes('[T](https://x.com/a)'));
});

test('buildHotMessage：research 标记事件融合进热点榜，按重要性接续编号取前 3', () => {
  const mk = (id, importance, research) => ({
    id, importance, research, title: `标题${id}`, url: `https://x.com/${id}`, source: { name: `S${id}` }
  });
  const featured = { date: '2026-09-21', hotEventIds: ['a'] };
  const daily = { items: [
    mk('a', 4, false),
    mk('r1', 5.5, true),   // arXiv/科研检索源事件
    mk('r2', 4, true),
    mk('r3', 3.5, true),
    mk('r4', 2.9, true),   // 第 4 条科研事件被截掉
    mk('m1', 5, false)
  ] };
  const { text } = buildHotMessage(featured, daily, {});
  assert.ok(!text.includes('科研速递'), '不再单列科研小节');
  assert.ok(text.includes('[标题r1](https://x.com/r1)'));
  assert.ok(text.includes('[标题r2](https://x.com/r2)'));
  assert.ok(text.includes('[标题r3](https://x.com/r3)'));
  assert.ok(!text.includes('标题r4'), '只取前 3 条科研');
  assert.ok(!text.includes('标题m1'), '非科研事件不进榜尾');
  // 接续编号：热点第 1 条后科研从 2 开始
  assert.ok(text.includes('1. [标题a]'));
  assert.ok(text.includes('2. [标题r1]'));
  // 无科研事件时榜单只有热点条目
  const noResearch = buildHotMessage(featured, { items: [mk('a', 4, false)] }, {});
  assert.ok(noResearch.text.includes('1. [标题a]'));
  assert.ok(!noResearch.text.includes('2. '));
});

test('buildHotMessage：已在热点榜前 5 的科研事件不重复出现', () => {
  const mk = (id, importance, research) => ({
    id, importance, research, title: `标题${id}`, url: `https://x.com/${id}`
  });
  const featured = { date: '2026-09-21', hotEventIds: ['r1'] };
  const daily = { items: [mk('r1', 5.5, true), mk('r2', 4, true), mk('r3', 3, true), mk('r4', 2, true)] };
  const { text } = buildHotMessage(featured, daily, {});
  assert.equal(text.split('[标题r1]').length - 1, 1, 'r1 只出现一次');
  assert.ok(text.includes('[标题r4]'), '去重后空出的名额由第 4 条科研补上');
});

/* ===== B-04 字节预算与句边界截取 ===== */

test('fitLines：预算内全保留', () => {
  const lines = fitLines(['H'], ['1. a', '2. b'], ['tail'], 1000);
  assert.deepEqual(lines, ['H', '1. a', '2. b', 'tail']);
});

test('fitLines：超预算从尾部减条目，保底 1 条，header/tail 常留', () => {
  const lines = fitLines(['H'], ['1. aaaaaaaaaa', '2. bbbbbbbbbb', '3. cccccccccc', '4. dddddddddd'], ['tail'], 40);
  // 40 字节装得下 header+tail+2 条（34B），第 3 条起超限（48B）丢弃
  assert.deepEqual(lines, ['H', '1. aaaaaaaaaa', '2. bbbbbbbbbb', 'tail']);
});

test('fitLines：保底 1 条也不够时仍保留该条（单行永不截断）', () => {
  const huge = 'x'.repeat(100);
  const lines = fitLines(['H'], [huge], ['tail'], 10);
  assert.deepEqual(lines, ['H', huge, 'tail']);
});

test('buildHotMessage：超长消息先砍 research 尾、再砍 hot 倒序，保底榜单第 1 条', () => {
  const mk = (id, importance, research) => ({
    id, importance, research, title: `超长标题${id}${'内容'.repeat(60)}`, url: `https://x.com/${id}`, source: { name: `S${id}` }
  });
  const featured = { date: '2026-09-21', hotEventIds: ['h1', 'h2', 'h3'] };
  const daily = { items: [mk('h1', 9, false), mk('h2', 8, false), mk('h3', 7, false), mk('r1', 6, true), mk('r2', 5, true)] };
  const { text } = buildHotMessage(featured, daily, { siteUrl: 'https://site.example', maxBytes: 600 });
  // 丢弃序：r2（research 尾）→ r1 → h3 → h2；h1 保底
  assert.ok(text.includes('[超长标题h1'), '榜单第 1 条保底');
  assert.ok(!text.includes('超长标题h2'), 'hot 倒序先砍');
  assert.ok(!text.includes('超长标题r2'), 'research 尾最先砍');
  assert.ok(text.includes('[查看完整日报 →](https://site.example)'), '站点链接常留');
  assert.ok(text.includes('1. [超长标题h1'), '编号连续');
  assert.ok(Buffer.byteLength(text, 'utf8') > 400, '该装的都装下（非异常缩水）');
});

test('buildHotMessage：默认预算 18000 字节内不改变正常消息', () => {
  const mk = (id, i) => ({ id, importance: i, title: `标题${id}`, url: `https://x.com/${id}` });
  const featured = { date: '2026-09-21', hotEventIds: ['a', 'b'] };
  const daily = { items: [mk('a', 5), mk('b', 4)] };
  const { text } = buildHotMessage(featured, daily, { siteUrl: 'https://site.example' });
  assert.ok(text.includes('[标题a](https://x.com/a)'));
  assert.ok(text.includes('[标题b](https://x.com/b)'));
  assert.ok(Buffer.byteLength(text, 'utf8') < MAX_TEXT_BYTES);
});

test('truncateAtSentence：max 为硬上限，在 max 内回退到最后完整句边界', () => {
  const s = '第一句。第二句更长的内容继续说。第三句被截';
  const t = truncateAtSentence(s, 12);
  // 前 12 字符「第一句。第二句更长的内」内最后句边界是第一个「。」
  assert.equal(t, '第一句。');
  // max 内含完整边界时尽量多保留
  assert.equal(truncateAtSentence(s, 16), '第一句。第二句更长的内容继续说。');
});

test('truncateAtSentence：无句边界时硬截为前 max 字符', () => {
  assert.equal(truncateAtSentence('没有任何标点的超长内容', 5), '没有任何标');
});

test('truncateAtSentence：短文本原样返回', () => {
  assert.equal(truncateAtSentence('短。', 10), '短。');
});
