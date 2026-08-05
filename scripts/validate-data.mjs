#!/usr/bin/env node
/**
 * 校验当前正式数据（daily.json / featured.json / editorial-overrides.json）。
 * 用法: npm run validate
 *
 * 退出码: 0 = 通过（旧版 V1 数据过渡期也返回 0，仅提示差异）；1 = 校验失败。
 */
import { validateCurrentData } from './lib/schema.mjs';

function printReport(name, report) {
  console.log(`\n=== ${name} ===`);
  if (!report.errors.length && !report.warnings.length) {
    console.log('  ✅ 通过');
    return;
  }
  for (const e of report.errors) console.log(`  ❌ ${e}`);
  for (const w of report.warnings) console.log(`  ⚠️  ${w}`);
}

const { valid, reports } = await validateCurrentData();

printReport('feeds/daily.json', reports.daily);
printReport('feeds/featured.json', reports.featured);
printReport('data/editorial-overrides.json', reports.overrides);

console.log('\n结果：', valid ? '✅ 通过' : '❌ 存在致命错误');
process.exit(valid ? 0 : 1);
