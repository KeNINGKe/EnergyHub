/**
 * 阶段 C-01：精选评测框架（scripts/eval-selection.mjs 纯函数）。
 * 覆盖：事件组 dev/holdout 划分（确定性 + 无泄漏）、二分类指标（either 不入
 * 分母、分子分母如实）、Top-5 认可率（候选不足不评、覆盖不足按实际数）、
 * 重要事件漏选、样本→事件挂接（canonical URL 对齐）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitGroups, attachEvents, binaryMetrics, top5Approval, missedMajorEvents,
} from '../scripts/eval-selection.mjs';

test('splitGroups: 确定性、组不跨集合、比例约 70/30', () => {
  const groups = Array.from({ length: 20 }, (_, i) => `eg${String(i + 1).padStart(3, '0')}`);
  const a = splitGroups(groups);
  const b = splitGroups(groups);
  assert.deepEqual([...a.dev].sort(), [...b.dev].sort(), '同输入两次划分一致');
  for (const g of a.dev) assert.ok(!a.holdout.has(g), '组不跨集合');
  assert.equal(a.dev.size + a.holdout.size, 20);
  assert.ok(a.dev.size >= 12 && a.dev.size <= 16, `dev 约 70%（实际 ${a.dev.size}）`);
});

test('binaryMetrics: either 不入分母，TP/FP/FN/TN 与分子分母', () => {
  const rows = [
    { id: 'a', label: { decision: 'select' }, matched: { featured: true } },   // TP
    { id: 'b', label: { decision: 'select' }, matched: { featured: false } },  // FN
    { id: 'c', label: { decision: 'select' }, matched: null },                 // FN（未进任何事件）
    { id: 'd', label: { decision: 'reject' }, matched: { featured: true } },   // FP
    { id: 'e', label: { decision: 'reject' }, matched: { featured: false } },  // TN
    { id: 'f', label: { decision: 'either' }, matched: { featured: true } },   // 不计
    { id: 'g', label: { decision: null }, matched: null },                     // 未标不计
  ];
  const m = binaryMetrics(rows);
  assert.equal(m.tp, 1);
  assert.equal(m.fp, 1);
  assert.equal(m.fn, 2);
  assert.equal(m.tn, 1);
  assert.equal(m.either, 1);
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 1 / 3);
  assert.equal(m.fnList.map(r => r.id).join(','), 'b,c');
  // 全 either：无分母 → null 而非 NaN
  const m2 = binaryMetrics([{ label: { decision: 'either' }, matched: null }]);
  assert.equal(m2.precision, null);
  assert.equal(m2.recall, null);
});

test('attachEvents: canonicalUrl 对齐挂接，挂不上 matched=null', () => {
  const urlToEvent = new Map([
    ['https://example.com/a', { eventId: 'evt_1', featured: true }],
    ['https://example.com/b/', { eventId: 'evt_2', featured: false }],
  ]);
  const set = [
    { id: 'q1', url: 'https://example.com/a?utm_source=x' },  // 跟踪参数被 canonicalUrl 剥掉 → 命中
    { id: 'q2', url: 'https://example.com/zzz' },             // 不在基线 → null
    { id: 'q3', url: 'not a url' },                           // 非法 → null
  ];
  const rows = attachEvents(set, { q1: { decision: 'select' } }, urlToEvent);
  assert.equal(rows[0].matched.eventId, 'evt_1');
  assert.equal(rows[0].label.decision, 'select');
  assert.equal(rows[1].matched, null);
  assert.equal(rows[2].matched, null);
});

test('top5Approval: 候选不足 5 不评，覆盖不足按实际条数', () => {
  const mkEv = (id, imp, featured) => ({ id, importance: imp, featured, title: id });
  const byDate = new Map([
    ['2026-08-01', { events: [mkEv('e1', 5, true), mkEv('e2', 4, true), mkEv('e3', 3, true)] }], // 只 3 条精选 → 不评
    ['2026-08-02', { events: [mkEv('f1', 5, true), mkEv('f2', 4, true), mkEv('f3', 3, true), mkEv('f4', 2, true), mkEv('f5', 1, true), mkEv('f6', 0, true)] }],
  ]);
  const rows = [
    { matched: { eventId: 'f1' }, label: { decision: 'select' } },
    { matched: { eventId: 'f2' }, label: { decision: 'reject' } },
    { matched: { eventId: 'f3' }, label: { decision: 'either' } },
    // f4/f5 无标注 → unlabeled 不计入
  ];
  const out = top5Approval(byDate, rows);
  assert.equal(out.length, 1, '候选不足的日期不评');
  assert.equal(out[0].date, '2026-08-02');
  assert.equal(out[0].judged, 2);
  assert.equal(out[0].approved, 1);
  assert.equal(out[0].top5[0].decision, 'select');
  assert.equal(out[0].top5[3].decision, 'unlabeled');
});

test('missedMajorEvents: isMajorEvent=true 且未精选才计', () => {
  const rows = [
    { id: 'a', date: 'd1', title: 'A 大事件未进精选', label: { isMajorEvent: true, decision: 'select' }, matched: { featured: false } },
    { id: 'b', date: 'd1', title: 'B 大事件已进精选', label: { isMajorEvent: true }, matched: { featured: true } },
    { id: 'c', date: 'd1', title: 'C 普通未进精选', label: { isMajorEvent: false, decision: 'reject' }, matched: { featured: false } },
    { id: 'd', date: 'd1', title: 'D 未挂上事件', label: { isMajorEvent: true }, matched: null },
  ];
  const missed = missedMajorEvents(rows);
  assert.equal(missed.length, 2);
  assert.deepEqual(missed.map(x => x.id), ['a', 'd']);
});
