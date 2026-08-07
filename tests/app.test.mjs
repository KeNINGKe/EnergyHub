import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const APP = await readFile(new URL('../assets/app.js', import.meta.url), 'utf8');

/* 加载 app.js（去掉 init 自启动），导出优先级相关纯函数 */
function loadPriority() {
  const code = APP.replace(/\ninit\(\);?\s*$/, '') + `
    ;globalThis.__p = { getPriority, priorityEvents, sortForTimeline, isNorthAmerica, isNuclear };
  `;
  const ctx = vm.createContext({
    document: { querySelector: () => null, querySelectorAll: () => [] },
    location: { hash: '#featured' },
    history: { replaceState() {} },
    fetch: () => Promise.reject(new Error('fetch stub 未覆盖')),
    Date, Math, console, window: null
  });
  vm.runInContext(code, ctx);
  ctx.window = ctx;
  return ctx.__p;
}

const ev = (over) => ({ title: 't', summary: 's', importance: 0.5, region: '未知', topic: 'other-energy', ...over });

test('isNorthAmerica：美国/加拿大为北美，其余不是', () => {
  const t = loadPriority();
  assert.equal(t.isNorthAmerica(ev({ region: '美国' })), true);
  assert.equal(t.isNorthAmerica(ev({ region: '加拿大' })), true);
  assert.equal(t.isNorthAmerica(ev({ region: '北美' })), true);
  assert.equal(t.isNorthAmerica(ev({ region: '中国' })), false);
  assert.equal(t.isNorthAmerica(ev({ region: '未知' })), false);
  assert.equal(t.isNorthAmerica(ev({ region: '全球' })), false);
  assert.equal(t.isNorthAmerica(ev({ region: '欧盟' })), false);
});

test('getPriority：储能/AIDC 最高，北美最优先，发电次级', () => {
  const t = loadPriority();
  const naStorage = t.getPriority(ev({ topic: 'energy-storage', region: '美国' }));
  assert.equal(naStorage.rank, 0, '储能+北美 → rank 0');
  assert.equal(naStorage.label, '储能·北美');

  const cnStorage = t.getPriority(ev({ topic: 'energy-storage', region: '中国' }));
  assert.equal(cnStorage.rank, 1, '储能非北美 → rank 1');
  assert.equal(cnStorage.label, '储能');

  const naAidc = t.getPriority(ev({ topic: 'aidc-project', region: '加拿大' }));
  assert.equal(naAidc.rank, 0);
  assert.equal(naAidc.label, 'AIDC·北美');

  const gas = t.getPriority(ev({ topic: 'gas-backup' }));
  assert.equal(gas.rank, 2, '发电 → rank 2');
  assert.equal(gas.label, '发电');

  const other = t.getPriority(ev({ topic: 'solar-wind' }));
  assert.equal(other.rank, 3, '其他 → rank 3');
  assert.equal(other.label, '');
});

test('priorityEvents：只收储能/AIDC，排除核电，北美优先', () => {
  const t = loadPriority();
  const events = [
    ev({ id: 'a', topic: 'energy-storage', region: '中国', importance: 0.9 }),
    ev({ id: 'b', topic: 'aidc-project', region: '美国', importance: 0.4 }),
    ev({ id: 'c', topic: 'energy-storage', region: '加拿大', importance: 0.3 }),
    ev({ id: 'd', topic: 'nuclear-smr', region: '美国', importance: 0.99 }),
    ev({ id: 'e', topic: 'solar-wind', region: '美国', importance: 0.8 }),
    ev({ id: 'f', topic: 'energy-storage', region: '未知', title: 'nuclear 反应堆', importance: 0.7 })
  ];
  const top = t.priorityEvents(events);
  // Array.from 转回测试域普通数组（vm 返回的数组原型不同，deepStrictEqual 会误报）
  assert.deepEqual(Array.from(top, e => e.id), ['b', 'c', 'a'],
    '北美 rank0 优先（b 美国、c 加拿大），非北美按 importance（a 0.9）');
  assert.ok(!top.some(e => e.id === 'd'), '核电被排除');
  assert.ok(!top.some(e => e.id === 'e'), '非储能/AIDC 被排除');
  assert.ok(!top.some(e => e.id === 'f'), '标题含核电关键词被排除');
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
