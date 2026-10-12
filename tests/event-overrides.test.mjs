import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLinks, loadEventOverrides } from '../scripts/lib/event-overrides.mjs';
import { loadEnums, validateEventOverrides } from '../scripts/lib/schema.mjs';
import { applyOverrides } from '../scripts/lib/overrides.mjs';
import { applyEventOverrideOp } from '../scripts/admin/lib/content-ops.mjs';
import { articleId } from '../scripts/lib/identity.mjs';

const enums = await loadEnums();

// 任意 URL 的 articleId（与管线同口径），供构造真实格式的约束 id
const aid = (u) => articleId({ url: u });
const URL_A = 'https://x.com/a';
const URL_B = 'https://x.com/b';
const URL_C = 'https://x.com/c';
const URL_D = 'https://x.com/d';

function mkDaily() {
  const mk = (id, url, related = []) => ({
    id,
    title: `T ${id}`, url, topic: 'grid',
    source: { name: 'S', type: 'media', isPrimary: true },
    relatedSources: related.map(u => ({ name: 'R', url: u }))
  });
  return {
    schemaVersion: 2,
    items: [mk('evt_a', URL_A), mk('evt_b', URL_B, [URL_C]), mk('evt_c', URL_D)]
  };
}
const featured = (ids) => ({ observations: [], featuredEventIds: [...ids] });

/* ---- toLinks ---- */

test('toLinks：归一形态 + 非法条目过滤 + 组内去重', () => {
  const links = toLinks({
    mustLinkGroups: [
      { articleIds: [aid(URL_A), aid(URL_B), aid(URL_B)] },
      { articleIds: [aid(URL_C)] },          // <2 个：丢弃
      { articleIds: 'x' },                   // 非法：丢弃
    ],
    cannotLinkPairs: [
      { articleIds: [aid(URL_A), aid(URL_D)] },
      { articleIds: [aid(URL_A)] },          // 不是 2 个：丢弃
      { articleIds: [aid(URL_B), aid(URL_B)] } // 同 id 自环：丢弃
    ]
  });
  assert.deepEqual(links.mustLink, [[aid(URL_A), aid(URL_B)]]);
  assert.deepEqual(links.cannotLink, [[aid(URL_A), aid(URL_D)]]);
});

test('toLinks：空/非法文档返回空 links', () => {
  assert.deepEqual(toLinks(null), { mustLink: [], cannotLink: [] });
  assert.deepEqual(toLinks({}), { mustLink: [], cannotLink: [] });
});

test('loadEventOverrides：缺失/损坏回退空骨架（仓库内骨架文件合法）', async () => {
  const doc = await loadEventOverrides();
  assert.equal(doc.schemaVersion, 1);
  assert.ok(Array.isArray(doc.mustLinkGroups));
  assert.ok(Array.isArray(doc.cannotLinkPairs));
});

/* ---- validateEventOverrides ---- */

test('validateEventOverrides：合法文档通过', async () => {
  const doc = {
    schemaVersion: 1,
    mustLinkGroups: [{ articleIds: [aid(URL_A), aid(URL_B)], reason: '同一事件' }],
    cannotLinkPairs: [{ articleIds: [aid(URL_A), aid(URL_D)], reason: '不同项目' }]
  };
  const r = await validateEventOverrides(doc, mkDaily());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('validateEventOverrides：mustLink 传递闭包 vs cannotLink 冲突 → error', async () => {
  const doc = {
    schemaVersion: 1,
    // a-b、b-c 传递连通 → a/c 同分量；cannotLink(a,c) 矛盾
    mustLinkGroups: [
      { articleIds: [aid(URL_A), aid(URL_B)] },
      { articleIds: [aid(URL_B), aid(URL_C)] }
    ],
    cannotLinkPairs: [{ articleIds: [aid(URL_A), aid(URL_C)] }]
  };
  const r = await validateEventOverrides(doc, mkDaily());
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('传递连通') && e.includes(aid(URL_A)) && e.includes(aid(URL_C))));
});

test('validateEventOverrides：非传递直接的 cannotLink 与 mustLink 并存合法', async () => {
  const doc = {
    schemaVersion: 1,
    mustLinkGroups: [{ articleIds: [aid(URL_A), aid(URL_B)] }],
    cannotLinkPairs: [{ articleIds: [aid(URL_B), aid(URL_D)] }]  // b-d 未被闭包连通
  };
  const r = await validateEventOverrides(doc, mkDaily());
  assert.equal(r.valid, true);
});

test('validateEventOverrides：格式错误（版本/数组长度/articleId 形态/重复）', async () => {
  const r = await validateEventOverrides({
    schemaVersion: 2,
    mustLinkGroups: [{ articleIds: ['art_zzz', 'art_yyy'] }, { articleIds: [aid(URL_A), aid(URL_A)] }],
    cannotLinkPairs: [{ articleIds: [aid(URL_A), aid(URL_B), aid(URL_D)] }]
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('schemaVersion')));
  assert.ok(r.errors.some(e => e.includes('art_zzz') && e.includes('格式')));
  assert.ok(r.errors.some(e => e.includes('重复')));
  assert.ok(r.errors.some(e => e.includes('实际 3 个')));
});

test('validateEventOverrides：articleId 不在当前 daily 仅 warning', async () => {
  const unknown = aid('https://gone.example/x');
  const r = await validateEventOverrides({
    schemaVersion: 1,
    cannotLinkPairs: [{ articleIds: [aid(URL_A), unknown], reason: '' }]
  }, mkDaily());
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some(w => w.includes(unknown) && w.includes('不在当前 daily')));
});

test('validateEventOverrides：relatedSources 里的文章算已知（不误报 warning）', async () => {
  // URL_C 是 evt_b 的 relatedSources 成员
  const r = await validateEventOverrides({
    schemaVersion: 1,
    cannotLinkPairs: [{ articleIds: [aid(URL_A), aid(URL_C)] }]
  }, mkDaily());
  assert.equal(r.valid, true);
  assert.equal(r.warnings.length, 0);
});

/* ---- applyOverrides 第 6 参：mergeGroups cannotLink 强制点 ---- */

test('applyOverrides：mergeGroups 命中 cannotLink 跳过合并 + errors 诊断', () => {
  const daily = mkDaily();
  const links = { mustLink: [], cannotLink: [[aid(URL_A), aid(URL_D)]] };
  const { errors } = applyOverrides(
    daily, featured(['evt_a', 'evt_c']),
    { mergeGroups: [['evt_a', 'evt_c']] }, enums, [], links
  );
  assert.equal(daily.items.length, 3);                       // 未合并
  assert.deepEqual(daily.items.map(e => e.id), ['evt_a', 'evt_b', 'evt_c']);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('evt_c') && errors[0].includes('cannotLink'));
});

test('applyOverrides：cannotLink 命中 relatedSources 里的文章同样拦截', () => {
  // evt_b 的 relatedSources 含 URL_C；主事件 evt_a 并 evt_b 时 a↔c 对受约束
  const daily = mkDaily();
  const links = { mustLink: [], cannotLink: [[aid(URL_A), aid(URL_C)]] };
  const { errors } = applyOverrides(
    daily, featured([]),
    { mergeGroups: [['evt_a', 'evt_b']] }, enums, [], links
  );
  assert.equal(daily.items.length, 3);
  assert.equal(errors.length, 1);
  // evt_c（URL_D）不受影响，可与 evt_a 合并
  const daily2 = mkDaily();
  const r2 = applyOverrides(daily2, featured([]), { mergeGroups: [['evt_a', 'evt_c']] }, enums, [], links);
  assert.equal(r2.errors.length, 0);
  assert.equal(daily2.items.length, 2);
});

test('applyOverrides：主事件文章集随合并累计（后续被并方对先前成员受约束）', () => {
  // 先并 evt_b（无约束），再并 evt_c 时 d↔c 对受约束 → 整组只剩 a+b 合并
  const daily = mkDaily();
  const links = { mustLink: [], cannotLink: [[aid(URL_C), aid(URL_D)]] };  // c∈evt_b 相关, d=evt_c
  const { errors } = applyOverrides(
    daily, featured([]),
    { mergeGroups: [['evt_a', 'evt_b', 'evt_c']] }, enums, [], links
  );
  assert.deepEqual(daily.items.map(e => e.id), ['evt_a', 'evt_c']);  // b 已并入 a，c 被拦
  assert.equal(errors.length, 1);
});

test('applyOverrides：无约束参数时行为不变（默认空）', () => {
  const daily = mkDaily();
  const { errors } = applyOverrides(daily, featured([]), { mergeGroups: [['evt_a', 'evt_c']] }, enums);
  assert.equal(errors.length, 0);
  assert.equal(daily.items.length, 2);
});

/* ---- applyEventOverrideOp（admin 纯函数层）---- */

test('applyEventOverrideOp：addMustLink / addCannotLink + 去重', () => {
  const { doc: d1, changed: c1 } = applyEventOverrideOp(null,
    { op: 'addMustLink', articleIds: [aid(URL_A), aid(URL_B), aid(URL_A)], reason: '同一事件' });
  assert.equal(c1, true);
  assert.deepEqual(d1.mustLinkGroups[0].articleIds, [aid(URL_A), aid(URL_B)]);
  assert.equal(d1.mustLinkGroups[0].reason, '同一事件');
  assert.ok(d1.updatedAt);

  // 同集合重复添加：changed=false 不新增
  const { doc: d2, changed: c2 } = applyEventOverrideOp(d1,
    { op: 'addMustLink', articleIds: [aid(URL_B), aid(URL_A)] });
  assert.equal(c2, false);
  assert.equal(d2.mustLinkGroups.length, 1);

  const { doc: d3 } = applyEventOverrideOp(d2, { op: 'addCannotLink', articleIds: [aid(URL_A), aid(URL_D)] });
  assert.equal(d3.cannotLinkPairs.length, 1);
  // 与 validateEventOverrides 组合：a-b mustLink 与 a-d cannotLink 无冲突，合法
});

test('applyEventOverrideOp：非法入参抛错（数量不足/序号越界/未知 op）', () => {
  assert.throws(() => applyEventOverrideOp(null, { op: 'addMustLink', articleIds: ['art_111111111111'] }),
    /≥2 个 articleIds/);
  assert.throws(() => applyEventOverrideOp(null, { op: 'addCannotLink', articleIds: [aid(URL_A), aid(URL_B), aid(URL_C)] }),
    /恰好 2 个/);
  assert.throws(() => applyEventOverrideOp({ mustLinkGroups: [] }, { op: 'removeMustLink', index: 5 }),
    /序号越界/);
  assert.throws(() => applyEventOverrideOp(null, { op: 'bogus' }), /未知事件约束操作/);
});

test('applyEventOverrideOp：remove 后与 validate 组合仍合法', async () => {
  let { doc } = applyEventOverrideOp(null, { op: 'addMustLink', articleIds: [aid(URL_A), aid(URL_B)] });
  ({ doc } = applyEventOverrideOp(doc, { op: 'removeMustLink', index: 0 }));
  assert.equal(doc.mustLinkGroups.length, 0);
  const r = await validateEventOverrides(doc, mkDaily());
  assert.equal(r.valid, true);
});
