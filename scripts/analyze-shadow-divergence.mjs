/**
 * 影子分歧对照表生成器（阶段 C-01 辅助，AIHOT_IMPLEMENTATION_PLAN §6）。
 *
 * 读取 samples/baseline/quality-upgrade/_shadow/selection-*.json（影子评分回放产物），
 * 汇总「规则精选 vs LLM 业务价值分」的系统性分歧，输出 Markdown 对照表。
 *
 * 两个方向的分歧：
 *  - 漏选（false negative）：规则没选、但 LLM 价值分高于已选最低分（disagreements 字段，
 *    kind=outside-over-selected-floor）——规则精选漏掉的高价值条目，转 active 的收益所在。
 *  - 误选（false positive）：规则选了、但 LLM 价值分垫底——占着 12 席却没信息增量。
 *
 * 这份清单同时是最有信息量的标注素材：转 active 前人工只需复核这些分歧项，
 * 比盲标 180 条快一个量级。
 *
 * 用法：node scripts/analyze-shadow-divergence.mjs [--out <path>]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHADOW_DIR = join(__dirname, '..', 'samples', 'baseline', 'quality-upgrade', '_shadow');
const DEFAULT_OUT = join(__dirname, '..', 'docs', 'reviews', 'shadow-divergence.md');

function loadShadowFiles(dir) {
  return readdirSync(dir)
    .filter((f) => /^selection-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return { file: f, date: raw.date, data: raw };
    });
}

function cell(text, max = 40) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function summarize(files) {
  const header = [
    '# 影子分歧对照表（规则精选 vs LLM 业务价值分）\n',
    '> 数据源：`samples/baseline/quality-upgrade/_shadow/selection-*.json`（C-01 影子评分回放）。',
    '> 价值分 = 四维加权（业务关联 30 / 事实增量 25 / 影响 25 / 证据 20，满分 100）。',
    '> **漏选** = 规则没选但 LLM 价值分高于当日已选最低分；**误选** = 规则选了但 LLM 价值分垫底。',
    '> 这是转 active 前最该人工复核的标注素材（比盲标 180 条快）。\n',
  ];
  const days = [];
  let totalMiss = 0;
  let totalFalse = 0;

  const summaryRows = [];

  for (const { file, date, data } of files) {
    const items = data.items || [];
    const selected = items.filter((i) => i.group === 'selected');
    const disagreements = data.disagreements || [];
    const selectedFloor = selected.length
      ? Math.min(...selected.map((i) => i.total))
      : 0;
    // 误选 = 已选里价值分垫底的（≤ 已选最低分，即连"漏选清单的准入门槛"都没过）
    const falsePos = selected
      .filter((i) => i.total <= selectedFloor)
      .sort((a, b) => a.total - b.total);

    totalMiss += disagreements.length;
    totalFalse += falsePos.length;
    summaryRows.push({ date, miss: disagreements.length, falsePos: falsePos.length, scored: data.counts?.scored ?? 0 });

    days.push(`## ${date}\n`);
    days.push(`> 评分 ${data.counts?.scored ?? 0} 条 · 已选 ${selected.length} 条 · 漏选 ${disagreements.length} · 误选 ${falsePos.length}\n`);

    days.push('### 漏选（LLM 认为该进、规则没选）\n');
    if (!disagreements.length) {
      days.push('（无）\n');
    } else {
      days.push('| 价值分 | 标题 | LLM 理由 |');
      days.push('|---|---|---|');
      for (const d of disagreements) {
        days.push(`| **${d.valueScore}** | ${cell(d.title, 50)} | ${cell(d.rationale, 60)} |`);
      }
      days.push('');
    }

    days.push('### 误选（规则选了、LLM 价值分垫底）\n');
    if (!falsePos.length) {
      days.push('（无）\n');
    } else {
      days.push('| 规则分 | 价值分 | 标题 |');
      days.push('|---|---|---|');
      for (const f of falsePos) {
        days.push(`| ${f.ruleScore} | **${f.total}** | ${cell(f.title, 60)} |`);
      }
      days.push('');
    }
  }

  // 汇总表放最前（需要先算完所有日）
  const summary = [];
  summary.push('## 汇总\n');
  summary.push('| 日期 | 评分 | 漏选 | 误选 |');
  summary.push('|---|---|---|---|');
  for (const r of summaryRows) {
    summary.push(`| ${r.date} | ${r.scored} | **${r.miss}** | ${r.falsePos} |`);
  }
  summary.push('');
  summary.push(`> 4 日合计：漏选 **${totalMiss}** 条、误选 **${totalFalse}** 条——规则分与价值分确有系统性分歧，影子对比方向成立。\n`);

  return [...header, ...summary, ...days].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : DEFAULT_OUT;

  const files = loadShadowFiles(SHADOW_DIR);
  if (!files.length) {
    console.error('未找到影子回放文件：' + SHADOW_DIR);
    process.exit(1);
  }
  const md = summarize(files);
  writeFileSync(outPath, md, 'utf8');
  console.log(`已生成 ${files.length} 天对照表 → ${outPath}`);
  console.log(`  漏选合计 ${files.reduce((n, f) => n + (f.data.disagreements?.length || 0), 0)} 条、误选合计 ${files.reduce((n, f) => { const s = (f.data.items || []).filter(i => i.group === 'selected'); const fl = s.length ? Math.min(...s.map(i => i.total)) : 0; return n + s.filter(i => i.total <= fl).length; }, 0)} 条`);
}

main();
