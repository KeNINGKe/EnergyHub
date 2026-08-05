import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, normalizeTitle, dedupItems } from '../scripts/lib/dedup.mjs';

test('canonicalUrl：剔除跟踪参数', () => {
  assert.equal(
    canonicalUrl('https://Example.com/news/a?utm_source=twitter&id=5&utm_medium=link'),
    canonicalUrl('https://example.com/news/a?id=5')
  );
});

test('canonicalUrl：去掉尾斜杠与 hash', () => {
  assert.equal(
    canonicalUrl('https://example.com/news/a/'),
    canonicalUrl('https://example.com/news/a#section')
  );
});

test('canonicalUrl：参数顺序不影响键', () => {
  assert.equal(
    canonicalUrl('https://example.com/x?a=1&b=2'),
    canonicalUrl('https://example.com/x?b=2&a=1')
  );
});

test('canonicalUrl：非法 URL 退化为小写原文', () => {
  assert.equal(canonicalUrl('NOT_A_URL'), 'not_a_url');
});

test('normalizeTitle：去掉翻译后缀', () => {
  assert.equal(normalizeTitle('Tesla Megapack shipped【译:特斯拉Megapack出货】'), normalizeTitle('tesla megapack shipped'));
});

test('normalizeTitle：去标点合并空白，大小写无关', () => {
  assert.equal(normalizeTitle('  Solar  Power! Project '), normalizeTitle('solar power project'));
});

test('dedupItems：相同 URL 去重（含跟踪参数）', () => {
  const { kept, removed } = dedupItems([
    { url: 'https://x.com/a?utm_source=rss', title: 'A' },
    { url: 'https://x.com/a', title: 'B' }
  ]);
  assert.equal(kept.length, 1);
  assert.equal(removed[0].reason, 'url');
});

test('dedupItems：相同 GUID 去重', () => {
  const { kept, removed } = dedupItems([
    { url: 'https://x.com/1', guid: 'tag:x,2026:1', title: 'A' },
    { url: 'https://x.com/2', guid: 'tag:x,2026:1', title: 'B' }
  ]);
  assert.equal(kept.length, 1);
  assert.equal(removed[0].reason, 'guid');
});

test('dedupItems：完全相同标题去重', () => {
  const { kept, removed } = dedupItems([
    { url: 'https://x.com/1', title: '  Battery  Storage! Boom ' },
    { url: 'https://x.com/2', title: 'battery storage boom' }
  ]);
  assert.equal(kept.length, 1);
  assert.equal(removed[0].reason, 'title');
});

test('dedupItems：不同条目全部保留', () => {
  const items = [
    { url: 'https://x.com/1', title: 'Alpha' },
    { url: 'https://x.com/2', title: 'Beta' }
  ];
  const { kept, removed } = dedupItems(items);
  assert.equal(kept.length, 2);
  assert.equal(removed.length, 0);
});

test('dedupItems：确定性（相同输入两次结果一致）', () => {
  const items = [
    { url: 'https://x.com/a?utm=x', title: 'A' },
    { url: 'https://x.com/a', title: 'A' },
    { url: 'https://x.com/b', title: 'B' },
    { url: 'https://x.com/c', title: 'C' },
    { url: 'https://x.com/c', title: 'D' }
  ];
  const r1 = dedupItems(items);
  const r2 = dedupItems(items);
  assert.deepEqual(r1.kept.map(i => i.title), r2.kept.map(i => i.title));
  assert.deepEqual(r1.removed.map(r => r.item.title), r2.removed.map(r => r.item.title));
  assert.equal(r1.kept.length, 3);
});
