import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventFingerprint, isRecentlyExposed, exposedUrlSet, recordExposure, pruneExposure
} from '../scripts/lib/exposure.mjs';

const ev = (over = {}) => ({ id: 'evt_x', url: 'https://a.com/news/1', relatedSources: [], ...over });

test('eventFingerprint：主 URL + relatedSources，canonical 归一去 query/fragment', () => {
  assert.deepEqual(
    eventFingerprint(ev({
      url: 'https://a.com/news/1?utm_source=rss',
      relatedSources: [{ name: 'B', url: 'https://b.com/x' }, { name: 'C', url: 'https://c.com/y#frag' }]
    })),
    ['https://a.com/news/1', 'https://b.com/x', 'https://c.com/y'],
    '跨日 utm 差异应归一掉'
  );
  assert.deepEqual(eventFingerprint({ url: '' }), [], '无 URL 得空指纹（不被判曝光）');
  assert.deepEqual(eventFingerprint(null), []);
});

test('isRecentlyExposed：主 URL 或 relatedSources 任一命中即曝光', () => {
  const seen = new Set(['https://a.com/news/1']);
  assert.equal(isRecentlyExposed(ev({ url: 'https://a.com/news/1?x=1' }), seen), true, 'query 差异归一后命中');
  assert.equal(
    isRecentlyExposed(ev({ url: 'https://z.com/other', relatedSources: [{ url: 'https://a.com/news/1' }] }), seen),
    true, '同事件跨站点：relatedSources 收编了昨天的主文也能命中'
  );
  assert.equal(isRecentlyExposed(ev({ url: 'https://z.com/other' }), seen), false);
  assert.equal(isRecentlyExposed(ev(), new Set()), false, '空历史不误判');
  assert.equal(isRecentlyExposed(ev(), undefined), false, '无历史参数不误判');
});

test('exposedUrlSet：窗口边界（同日到 days-1 命中，days 及更早放行）', () => {
  const history = { exposed: {
    'https://a.com/today': '2026-09-08', // 差 0 → 命中（同日第二次构建不重复第一次榜单）
    'https://a.com/d1': '2026-09-07',    // 差 1 → 命中
    'https://a.com/d2': '2026-09-06',    // 差 2（days-1）→ 命中
    'https://a.com/d3': '2026-09-05',    // 差 3（days）→ 放行
    'https://a.com/bad': 'not-a-date'    // 非法日期忽略
  } };
  const s = exposedUrlSet(history, '2026-09-08', 3);
  assert.equal(s.size, 3);
  assert.ok(s.has('https://a.com/today') && s.has('https://a.com/d1') && s.has('https://a.com/d2'));
  assert.equal(s.has('https://a.com/d3'), false, '满 3 天的旧曝光放行（可重新上榜）');
  assert.equal(s.has('https://a.com/bad'), false);
  assert.equal(exposedUrlSet(null, '2026-09-08', 3).size, 0, '无历史得空集合');
});

test('recordExposure：并入指纹并刷新日期，不改入参', () => {
  const before = { exposed: { 'https://old.com/1': '2026-09-01' } };
  const events = [ev({ url: 'https://old.com/1', relatedSources: [{ url: 'https://new.com/2' }] })];
  const after = recordExposure(before, events, '2026-09-08');
  assert.equal(after.exposed['https://old.com/1'], '2026-09-08', '已存在的 URL 刷新曝光日期');
  assert.equal(after.exposed['https://new.com/2'], '2026-09-08', 'relatedSources 一并记录');
  assert.equal(before.exposed['https://old.com/1'], '2026-09-01', '入参历史不被修改');
  assert.equal(recordExposure(null, events, '2026-09-08').exposed['https://new.com/2'], '2026-09-08', '从空历史开始');
});

test('pruneExposure：清窗口外与非法条目，体积超限保留最近', () => {
  const history = { exposed: {
    'https://a.com/fresh': '2026-09-08',
    'https://a.com/stale': '2026-09-01', // 窗口外
    'https://a.com/bad': 'oops'          // 非法日期
  } };
  assert.deepEqual(Object.keys(pruneExposure(history, '2026-09-08', 3).exposed), ['https://a.com/fresh']);
  const big = { exposed: {} };
  for (let i = 0; i < 30; i++) big.exposed[`https://a.com/${String(i).padStart(2, '0')}`] = i < 10 ? '2026-09-08' : '2026-09-07';
  const capped = pruneExposure(big, '2026-09-08', 3, 15);
  assert.equal(Object.keys(capped.exposed).length, 15);
  assert.ok(!capped.exposed['https://a.com/29'], '超限时较旧的先被裁');
});
