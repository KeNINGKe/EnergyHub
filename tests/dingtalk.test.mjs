import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dingtalkSign, buildSignedUrl, resolveHotItems, buildHotMessage
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
