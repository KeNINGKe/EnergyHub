import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const APP = await readFile(new URL('../assets/app.js', import.meta.url), 'utf8');

/* 加载 app.js（去掉 init 自启动），导出优先级相关纯函数 */
function loadPriority() {
  const code = APP.replace(/\ninit\(\);?\s*$/, '') + `
    ;globalThis.__p = { getPriority, renderHotList, sortForTimeline, sortChronological, groupByDay, renderTimeline, renderTimelineItem, isValidFeatured, state };
  `;
  const els = new Map();
  const ctx = vm.createContext({
    document: {
      querySelector: (sel) => { if (!els.has(sel)) els.set(sel, { innerHTML: '', textContent: '', hidden: false }); return els.get(sel); },
      querySelectorAll: () => []
    },
    location: { hash: '#featured' },
    history: { replaceState() {} },
    fetch: () => Promise.reject(new Error('fetch stub 未覆盖')),
    Date, Math, console, window: null
  });
  vm.runInContext(code, ctx);
  ctx.window = ctx;
  return { ...ctx.__p, __els: els };
}

const ev = (over) => ({ title: 't', summary: 's', importance: 0.5, region: '未知', topic: 'other-energy', ...over });

test('isValidFeatured：拒绝缺失、结构错误和跨日期数据', () => {
  const t = loadPriority();
  const daily = { date: '2026-08-10' };
  assert.equal(t.isValidFeatured(null, daily), false);
  assert.equal(t.isValidFeatured({ schemaVersion: 1, date: '2026-08-10', observations: [], featuredEventIds: [] }, daily), true);
  assert.equal(t.isValidFeatured({ schemaVersion: 1, date: '2026-08-09', observations: [], featuredEventIds: [] }, daily), false);
  assert.equal(t.isValidFeatured({ schemaVersion: 1, date: '2026-08-10', observations: null, featuredEventIds: [] }, daily), false);
});

test('getPriority：rank 只表达主题档位，北美是标注/软加分而非硬分档', () => {
  const t = loadPriority();
  // rank 现在等于主题档位：0=热点主题 1=次级 2=其他（北美不再单独分档）
  assert.equal(t.getPriority(ev({ topic: 'energy-storage', region: '美国' })).rank, 0);
  assert.equal(t.getPriority(ev({ topic: 'energy-storage', region: '中国' })).rank, 0);
  assert.equal(t.getPriority(ev({ topic: 'gas-backup' })).rank, 1);
  assert.equal(t.getPriority(ev({ topic: 'solar-wind' })).rank, 2);
  // na 标记 + 徽章文案
  const na = t.getPriority(ev({ topic: 'energy-storage', region: '美国' }));
  assert.equal(na.na, true);
  assert.equal(na.label, '储能·北美');
  const cn = t.getPriority(ev({ topic: 'energy-storage', region: '中国' }));
  assert.equal(cn.na, false);
  assert.equal(cn.label, '储能');
  assert.equal(t.getPriority(ev({ topic: 'aidc-project', region: '加拿大' })).label, 'AIDC·北美');
});

test('sortForTimeline：内容分为主，北美 +0.5 软加分不硬置顶', () => {
  const t = loadPriority();
  const mk = (over) => ev({ publishedAt: '2026-09-04T02:00:00Z', ...over });
  const sorted = t.sortForTimeline([
    mk({ id: 'cn5', topic: 'energy-storage', region: '中国', importance: 5 }),
    mk({ id: 'us4', topic: 'energy-storage', region: '美国', importance: 4 }),   // 4+0.5
    mk({ id: 'eu4', topic: 'energy-storage', region: '德国', importance: 4 }),
    mk({ id: 'gas', topic: 'gas-backup', region: '美国', importance: 9 })        // 次级主题仍在热点主题之后
  ]);
  assert.deepEqual([...sorted.map(x => x.id)], ['cn5', 'us4', 'eu4', 'gas']);
});

test('renderHotList：按构建端 featured.hotEventIds 渲染，空/缺失时返回空串', () => {
  const t = loadPriority();
  const a = ev({ id: 'a', topic: 'energy-storage', region: '中国', importance: 0.9, url: 'https://a.com/1', title: '储能A' });
  const b = ev({ id: 'b', topic: 'aidc-project', region: '美国', importance: 0.4, url: 'https://b.com/2', title: 'AIDC B' });
  t.state.eventMap = new Map([['a', a], ['b', b]]);
  t.state.featured = { hotEventIds: ['b', 'a'] };
  const html = t.renderHotList();
  assert.ok(html.includes('储能A') && html.includes('AIDC B'), '两条热点均渲染');
  assert.ok(html.indexOf('AIDC B') < html.indexOf('储能A'), '按构建端给定的顺序渲染');
  t.state.featured = { hotEventIds: [] };
  assert.equal(t.renderHotList(), '', '空榜单返回空串');
  t.state.featured = null;
  assert.equal(t.renderHotList(), '', 'featured 缺失时返回空串');
});

test('sortForTimeline：北美储能/AIDC → 储能/AIDC → 发电 → 其他', () => {
  const t = loadPriority();
  const events = [
    ev({ id: 'o', topic: 'solar-wind', region: '美国' }),
    ev({ id: 'g', topic: 'gas-backup' }),
    ev({ id: 's', topic: 'energy-storage', region: '中国' }),
    ev({ id: 'n', topic: 'aidc-project', region: '美国' })
  ];
  const sorted = t.sortForTimeline(events);
  assert.deepEqual(Array.from(sorted, e => e.id), ['n', 's', 'g', 'o']);
});

test('sortChronological：纯时间倒序，最新在前，与优先级序无关', () => {
  const t = loadPriority();
  const events = [
    ev({ id: 'old', publishedAt: '2026-08-01T00:00:00Z', importance: 0.9 }),
    ev({ id: 'new', publishedAt: '2026-08-07T00:00:00Z', importance: 0.3 }),
    ev({ id: 'mid', publishedAt: '2026-08-03T00:00:00Z', importance: 0.5 })
  ];
  const sorted = t.sortChronological(events);
  assert.deepEqual(Array.from(sorted, e => e.id), ['new', 'mid', 'old']);
});

test('groupByDay/renderTimeline：日期分组始终最新在前，不被优先级序打乱', () => {
  const t = loadPriority();
  // 旧日期的高优先级事件（储能）排在前面时，日期分组仍须按时间倒序（用正午 UTC 避免时区漂移）
  const events = [
    ev({ id: 'a', topic: 'energy-storage', region: '中国', publishedAt: '2026-08-08T12:00:00Z' }),
    ev({ id: 'b', topic: 'energy-storage', region: '中国', publishedAt: '2026-08-07T12:00:00Z' }),
    ev({ id: 'c', topic: 'other-energy', publishedAt: '2026-08-09T12:00:00Z' }),
    ev({ id: 'd', topic: 'other-energy', publishedAt: '2026-08-10T12:00:00Z' })
  ];
  const groups = t.groupByDay(t.sortForTimeline(events));
  assert.deepEqual(
    Array.from(groups, g => g.date.getUTCDate()),
    [10, 9, 8, 7],
    '日期分组必须按时间倒序'
  );
  const html = t.renderTimeline(events, null);
  const pos = [10, 9, 8, 7].map(d => html.indexOf(`8月${d}日`));
  assert.ok(pos.every(p => p >= 0), '四个日期标题均存在');
  for (let i = 1; i < pos.length; i++) {
    assert.ok(pos[i - 1] < pos[i], '日期标题按最新在前排列');
  }
});

test('renderTimelineItem：微信事件融进时间线并带公众号徽章', () => {
  const t = loadPriority();
  const html = t.renderTimelineItem(
    ev({ id: 'w', wechat: true, title: '微信储能文章', url: 'https://mp.weixin.qq.com/s/x',
        source: '储能100人', summary: '正文摘要', importance: 0.8,
        publishedAt: '2026-08-07T03:00:00Z' }),
    false
  );
  assert.ok(html.includes('公众号'), '微信事件渲染公众号徽章');
  assert.ok(html.includes('微信储能文章'), '微信标题正常渲染');
  assert.ok(html.includes('mp.weixin.qq.com'), '链接指向微信原文');

  const plain = t.renderTimelineItem(ev({ id: 'n', wechat: false, title: '普通新闻', importance: 0.5 }), false);
  assert.ok(!plain.includes('公众号'), '非微信事件无公众号徽章');
});
