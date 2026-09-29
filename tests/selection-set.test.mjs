import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  suggestDecision,
  buildEventGroups,
  pickStratified,
} from '../scripts/build-selection-set.mjs';

test('suggestDecision：无关/低质量建议 reject，相关不给建议', () => {
  assert.equal(suggestDecision({ relevant: 'irrelevant' }), 'reject');
  assert.equal(suggestDecision({ relevant: 'relevant', quality: 'low' }), 'reject');
  assert.equal(suggestDecision({ relevant: 'relevant', quality: null }), null);
  assert.equal(suggestDecision({ relevant: 'relevant', quality: 'high' }), null);
  assert.equal(suggestDecision(null), null);
  assert.equal(suggestDecision({}), null);
});

test('buildEventGroups：duplicateOf 指向后序样本也能连上（曾因单遍扫描丢边）', () => {
  const oldSet = [{ id: 's0094' }, { id: 's0111' }];
  const oldLabels = { s0094: { duplicateOf: 's0111' } };
  const groups = buildEventGroups(oldSet, oldLabels);
  assert.equal(groups.get('s0094'), groups.get('s0111'));
});

test('buildEventGroups：链式 duplicateOf A→B→C 传递合并为一组', () => {
  const oldSet = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const oldLabels = { a: { duplicateOf: 'b' }, b: { duplicateOf: 'c' } };
  const groups = buildEventGroups(oldSet, oldLabels);
  assert.equal(groups.get('a'), groups.get('b'));
  assert.equal(groups.get('b'), groups.get('c'));
  assert.notEqual(groups.get('a'), groups.get('d'));
});

test('buildEventGroups：无重复关系时各条目独立成组，组号确定性', () => {
  const oldSet = [{ id: 'x' }, { id: 'y' }];
  const g1 = buildEventGroups(oldSet, {});
  const g2 = buildEventGroups(oldSet, {});
  assert.notEqual(g1.get('x'), g1.get('y'));
  assert.deepEqual(g1, g2);
});

test('pickStratified：相关/无关全留，未标注补齐到目标，同种子可复现', () => {
  const entries = [
    ...Array.from({ length: 5 }, (_, i) => ({ stratum: 'labeled-relevant', i })),
    ...Array.from({ length: 3 }, (_, i) => ({ stratum: 'labeled-irrelevant', i: 100 + i })),
    ...Array.from({ length: 10 }, (_, i) => ({ stratum: 'unlabeled', i: 200 + i })),
  ];
  const a = pickStratified(entries, 12, mulberry32(42));
  const b = pickStratified(entries, 12, mulberry32(42));
  assert.equal(a.length, 12);
  assert.equal(a.filter(e => e.stratum === 'labeled-relevant').length, 5);
  assert.equal(a.filter(e => e.stratum === 'labeled-irrelevant').length, 3);
  assert.equal(a.filter(e => e.stratum === 'unlabeled').length, 4);
  assert.deepEqual(a, b, '同种子两次抽样结果应完全一致');
});

test('pickStratified：目标小于已标注层总数时已标注层仍全留', () => {
  const entries = [
    ...Array.from({ length: 5 }, () => ({ stratum: 'labeled-relevant' })),
    ...Array.from({ length: 3 }, () => ({ stratum: 'labeled-irrelevant' })),
    ...Array.from({ length: 4 }, () => ({ stratum: 'unlabeled' })),
  ];
  const a = pickStratified(entries, 4, mulberry32(1));
  assert.equal(a.length, 8); // 5+3 全留，不补 unlabeled
  assert.equal(a.filter(e => e.stratum === 'unlabeled').length, 0);
});

test('mulberry32：确定性且落在 [0,1)', () => {
  const r1 = mulberry32(7), r2 = mulberry32(7);
  for (let i = 0; i < 100; i++) {
    const v = r1();
    assert.ok(v >= 0 && v < 1);
    assert.equal(v, r2());
  }
});
