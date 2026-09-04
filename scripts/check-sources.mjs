// 健康检查：批量探测 data/sources.json 中所有信息源 URL
// 用法: node scripts/check-sources.mjs
//
// 探测核心已抽到 scripts/lib/source-check.mjs（与管理后台共用）；
// 本文件只负责 CLI 编排：读源 → 跑批 → 按问题类型打印 → 导出 JSON。
import { readFileSync, writeFileSync } from 'node:fs';
import { runSourceCheck, DEFAULT_CONCURRENCY } from './lib/source-check.mjs';

const sources = JSON.parse(readFileSync(new URL('../data/sources.json', import.meta.url), 'utf8'));

const items = [];
for (const cat of sources.categories) {
  for (const s of cat.sources) {
    items.push({ category: cat.name, ...s });
  }
}

console.log(`共 ${items.length} 个信息源，并发 ${DEFAULT_CONCURRENCY} ...\n`);
const results = await runSourceCheck(items);

const bad = results.filter(r => r.issue && r.issue !== 'ok' && r.issue !== 'no-link');
const ok = results.filter(r => r.issue === 'ok');
const nolink = results.filter(r => r.issue === 'no-link');

const order = ['http-404','http-403','http-410','http-500','http-502','http-503','unreachable','timeout','wechat-invalid','parked','err-title','redirected-to-root','thin'];
const byIssue = {};
for (const r of bad) (byIssue[r.issue] ||= []).push(r);

function line(r) {
  const fin = r.finalUrl && r.finalUrl !== r.url ? ` -> ${r.finalUrl}` : '';
  return `  [${r.cat}] ${r.name}\n    URL: ${r.url}${fin}\n    状态: ${r.status ?? '-'}  字节: ${r.bytes}  标题: ${r.title || '(无)'}`;
}

console.log(`\n========== 检查结果 ==========\n正常: ${ok.length}   异常: ${bad.length}   无外链(微信): ${nolink.length}\n`);
for (const key of order) {
  if (!byIssue[key]) continue;
  console.log(`\n--- ${key} (${byIssue[key].length}) ---`);
  for (const r of byIssue[key]) console.log(line(r));
}
// 其它未分类异常
for (const key of Object.keys(byIssue)) {
  if (order.includes(key)) continue;
  console.log(`\n--- ${key} (${byIssue[key].length}) ---`);
  for (const r of byIssue[key]) console.log(line(r));
}

// 导出 JSON 便于后续处理（后台 /api/sources 合并读它出健康徽章）
writeFileSync(new URL('../scripts/check-results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log(`\n详细结果已写入 scripts/check-results.json`);
