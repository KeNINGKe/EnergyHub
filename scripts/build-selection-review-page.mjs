#!/usr/bin/env node
/**
 * 生成精选价值标注页面（内容质量升级方案 C-01 标注工具）。
 *
 * 读取 samples/selection/set.json + labels.json，生成自包含的
 * samples/selection/review.html（双击打开，无需服务器）。
 * 结构沿用 build-review-page.mjs：数据内嵌 <script type="application/json">
 * 块（拼接而非模板插值），导出/复制按钮始终可用。
 *
 * 标注字段：decision（select/reject/either）、isMajorEvent、eventGroupId、
 * reason、confidence。preAnnotation（旧相关性标注线索）只展示为徽标，
 * 不参与标注结果。
 *
 * 用法:
 *   node scripts/build-selection-review-page.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEL_DIR = path.join(ROOT, 'samples', 'selection');

const set = JSON.parse(await fs.readFile(path.join(SEL_DIR, 'set.json'), 'utf8'));
const labelsData = JSON.parse(await fs.readFile(path.join(SEL_DIR, 'labels.json'), 'utf8'));

// 内嵌数据转义 <（防止 </script> 提前闭合）
const dataJson = JSON.stringify({
  set,
  labels: labelsData.labels,
  meta: {
    schemaVersion: labelsData.schemaVersion,
    seed: labelsData.seed,
    target: labelsData.target,
    note: labelsData.note,
    createdAt: labelsData.createdAt,
  },
}).replace(/</g, '\\u003c');

const PAGE_JS = `'use strict';
const DATA = JSON.parse(document.getElementById('app-data').textContent);
const SET = DATA.set, LABELS = DATA.labels, META = DATA.meta;

function getLabel(id) {
  return LABELS[id] || (LABELS[id] = { decision: null, isMajorEvent: null, eventGroupId: null, reason: '', confidence: null });
}
function esc(t) { return String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildCard(s) {
  const L = getLabel(s.id);
  const pre = s.preAnnotation;
  const el = document.createElement('div');
  el.className = 'card' + (s.stratum === 'labeled-irrelevant' ? ' dim' : '');
  el.dataset.id = s.id;
  const decSel = (v) => L.decision === v ? ' checked' : '';
  const majSel = (v) => L.isMajorEvent === v ? ' selected' : '';
  const confSel = (c) => L.confidence === c ? ' selected' : '';
  const srcLink = s.url
    ? '<a class="src" href="' + esc(s.url) + '" target="_blank" rel="noopener nofollow">' + esc(s.source || '(无来源)') + ' ↗</a>'
    : '<span>' + esc(s.source || '') + '</span>';
  el.innerHTML =
    '<div class="meta">' +
      '<span><b>' + esc(s.id) + '</b></span><span>' + esc(s.date) + '</span>' + srcLink +
      '<span class="badge stratum">' + esc(s.stratum === 'labeled-relevant' ? '旧标·相关' : s.stratum === 'labeled-irrelevant' ? '旧标·无关' : '未标注层') + '</span>' +
      (pre?.relevant === 'relevant' ? '<span class="badge rel">旧:相关</span>' : '') +
      (pre?.relevant === 'irrelevant' ? '<span class="badge irr">旧:无关</span>' : '') +
      (pre?.quality === 'low' ? '<span class="badge lowq">旧:低质量</span>' : '') +
      (pre?.suggestedDecision === 'reject' ? '<span class="badge low">建议 reject</span>' : '') +
      (L.decision === 'select' ? '<span class="badge sel">已标 select</span>' : L.decision === 'reject' ? '<span class="badge irr">已标 reject</span>' : L.decision === 'either' ? '<span class="badge dup">已标 either</span>' : '') +
      (L.isMajorEvent === true ? '<span class="badge major">重要事件</span>' : '') +
    '</div>' +
    '<div class="title">' + (s.url
      ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener nofollow">' + esc(s.title) + '</a>'
      : esc(s.title)) + '</div>' +
    (s.summary ? '<div class="summary">' + esc(s.summary) + '</div>' : '') +
    '<div class="controls">' +
      '<div class="ctl"><label>决定（该不该进每日精选）</label><div class="radio-row">' +
        '<label><input type="radio" name="' + s.id + '_dec" data-field="decision" value="select"' + decSel('select') + '> select</label>' +
        '<label><input type="radio" name="' + s.id + '_dec" data-field="decision" value="reject"' + decSel('reject') + '> reject</label>' +
        '<label><input type="radio" name="' + s.id + '_dec" data-field="decision" value="either"' + decSel('either') + '> either</label>' +
      '</div></div>' +
      '<div class="ctl"><label>重要事件</label><select data-field="isMajorEvent">' +
        '<option value="null"' + majSel(null) + '>—</option>' +
        '<option value="true"' + majSel(true) + '>是</option>' +
        '<option value="false"' + majSel(false) + '>否</option></select></div>' +
      '<div class="ctl"><label>事件组（同一事件填同一组号）</label><input data-field="eventGroupId" value="' + esc(L.eventGroupId || '') + '" placeholder="如 eg027"></div>' +
      '<div class="ctl"><label>置信度</label><select data-field="confidence">' +
        ['high','medium','low'].map(function(c){ return '<option value="' + c + '"' + confSel(c) + '>' + c + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="ctl" style="flex:1"><label>理由</label><textarea data-field="reason">' + esc(L.reason) + '</textarea></div>' +
    '</div>';
  return el;
}

function mark(id, field, value) {
  const L = getLabel(id);
  if (field === 'decision') L.decision = value;
  else if (field === 'isMajorEvent') L.isMajorEvent = value === 'true' ? true : value === 'false' ? false : null;
  else if (field === 'eventGroupId') L.eventGroupId = value || null;
  else if (field === 'confidence') L.confidence = value;
  else if (field === 'reason') L.reason = value;
  render();
}

function updateStats() {
  let sel = 0, rej = 0, eith = 0, maj = 0;
  SET.forEach(function (s) {
    const L = LABELS[s.id];
    if (L?.decision === 'select') sel++;
    else if (L?.decision === 'reject') rej++;
    else if (L?.decision === 'either') eith++;
    if (L?.isMajorEvent === true) maj++;
  });
  document.getElementById('total').textContent = SET.length;
  document.getElementById('done').textContent = sel + rej + eith;
  document.getElementById('sel').textContent = sel;
  document.getElementById('rej').textContent = rej;
  document.getElementById('eith').textContent = eith;
  document.getElementById('maj').textContent = maj;
}

function render() {
  const filter = document.getElementById('filter').value;
  const list = document.getElementById('list');
  list.innerHTML = '';
  SET.forEach(function (s) {
    const L = getLabel(s.id);
    if (filter === 'todo' && L.decision != null) return;
    if (filter === 'select' && L.decision !== 'select') return;
    if (filter === 'reject' && L.decision !== 'reject') return;
    if (filter === 'either' && L.decision !== 'either') return;
    if (filter === 'major' && L.isMajorEvent !== true) return;
    if (filter === 'suggest' && s.preAnnotation?.suggestedDecision !== 'reject') return;
    list.appendChild(buildCard(s));
  });
  updateStats();
}

function exportJson() {
  return JSON.stringify(Object.assign({}, META, { labels: LABELS }), null, 2);
}

// 事件委托：避免内联 handler 的全局作用域问题
document.getElementById('list').addEventListener('change', function (e) {
  const cardEl = e.target.closest('.card');
  if (!cardEl || !e.target.dataset.field) return;
  mark(cardEl.dataset.id, e.target.dataset.field, e.target.value);
});
document.getElementById('filter').addEventListener('change', render);
document.getElementById('exportBtn').addEventListener('click', function () {
  const blob = new Blob([exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'labels.json';
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
});
document.getElementById('copyBtn').addEventListener('click', function () {
  const t = exportJson();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(function(){ alert('已复制到剪贴板，粘贴覆盖 samples/selection/labels.json 即可保存'); }, function(){ prompt('复制以下内容：', t); });
  } else {
    prompt('复制以下内容：', t);
  }
});

render();
`;

const html =
`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EnergyHub 精选价值标注</title>
<style>
  * { box-sizing:border-box; }
  body { font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; margin:0; background:#fff; color:#18181B; }
  header { position:sticky; top:0; background:#fff; border-bottom:1px solid #E4E4E7; padding:12px 20px; display:flex; align-items:center; gap:16px; flex-wrap:wrap; z-index:10; }
  header h1 { font-size:16px; margin:0; }
  .stat { color:#52525B; }
  .stat b { color:#18181B; }
  #filters { display:flex; gap:8px; align-items:center; }
  #filters select, #filters button { padding:5px 10px; border:1px solid #E4E4E7; border-radius:8px; background:#fff; cursor:pointer; font-size:13px; }
  #exportBtn { background:#F97316; color:#000; border:none; }
  #copyBtn { color:#18181B; }
  main { max-width:860px; margin:0 auto; padding:20px; }
  .guide { max-width:860px; margin:16px auto 0; padding:12px 16px; border:1px solid #E4E4E7; border-radius:12px; background:#FAFAFA; color:#52525B; font-size:13px; }
  .card { border:1px solid #E4E4E7; border-radius:12px; padding:14px 16px; margin-bottom:12px; background:#fff; }
  .card.dim { opacity:.75; }
  .card .meta { color:#52525B; font-size:12px; margin-bottom:6px; display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .card .title { font-weight:600; margin-bottom:4px; }
  .card .title a { color:#18181B; text-decoration:none; }
  .card .title a:hover { color:#F97316; text-decoration:underline; }
  .card .summary { color:#52525B; font-size:13px; margin-bottom:10px; white-space:pre-wrap; }
  .src { color:#52525B; text-decoration:underline dotted; }
  .src:hover { color:#F97316; }
  .controls { display:flex; flex-wrap:wrap; gap:14px; align-items:flex-end; border-top:1px dashed #E4E4E7; padding-top:10px; }
  .ctl { display:flex; flex-direction:column; gap:4px; }
  .ctl label { font-size:12px; color:#52525B; }
  .ctl input, .ctl select, .ctl textarea { border:1px solid #E4E4E7; border-radius:6px; padding:4px 8px; font:inherit; background:#fff; }
  .ctl textarea { width:100%; min-height:44px; resize:vertical; }
  .radio-row { display:flex; gap:10px; }
  .radio-row label { display:flex; gap:4px; align-items:center; cursor:pointer; color:#18181B; }
  .badge { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; }
  .badge.rel { background:#ecfdf5; color:#059669; }
  .badge.irr { background:#fef2f2; color:#dc2626; }
  .badge.dup { background:#eff6ff; color:#2563eb; }
  .badge.low { background:#fffbeb; color:#d97706; }
  .badge.lowq { background:#f5f5f4; color:#57534e; }
  .badge.sel { background:#ecfdf5; color:#059669; }
  .badge.major { background:#fdf4ff; color:#a21caf; }
  .badge.stratum { background:#f0f9ff; color:#0369a1; }
</style>
</head>
<body>
<header>
  <h1>EnergyHub 精选价值标注</h1>
  <div class="stat">共 <b id="total">0</b> 条 · 已标 <b id="done">0</b> · select <b id="sel">0</b> / reject <b id="rej">0</b> / either <b id="eith">0</b> · 重要事件 <b id="maj">0</b></div>
  <div id="filters">
    <select id="filter">
      <option value="all">全部</option>
      <option value="todo">只看未标</option>
      <option value="select">只看 select</option>
      <option value="reject">只看 reject</option>
      <option value="either">只看 either</option>
      <option value="major">只看重要事件</option>
      <option value="suggest">只看建议 reject（快速过）</option>
    </select>
    <button id="copyBtn">复制标注 JSON</button>
    <button id="exportBtn">导出标注 JSON</button>
  </div>
</header>
<div class="guide">
  <b>怎么标：</b>假设你只能给读者看 12 条当天消息——这条值不值得占一个位置？
  值得 = select，不值得 = reject，拿不准/两可 = either（不计入准确率，别勉强）。
  带「旧:无关」「建议 reject」徽标的条目大概率是 reject，可用「只看建议 reject」过滤器快速过。
  发现两条是同一事件时，把它们的「事件组」填成同一个组号（预填的 eg 编号可沿用）。
  具体判定标准见 samples/selection/README.md。
</div>
<main id="list"></main>
<script type="application/json" id="app-data">` + dataJson + `</script>
<script>
` + PAGE_JS + `
</script>
</body>
</html>
`;

await fs.writeFile(path.join(SEL_DIR, 'review.html'), html);
const done = Object.values(labelsData.labels).filter(l => l.decision != null).length;
console.log(`✅ 精选标注页面已生成: samples/selection/review.html`);
console.log(`   双击打开即可标注；导出的 labels.json 覆盖 samples/selection/labels.json 保存。当前已标 ${done}/${set.length} 条。`);
