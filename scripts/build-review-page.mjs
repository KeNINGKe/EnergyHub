#!/usr/bin/env node
/**
 * 生成人工标注复核页面（阶段 A-02 复核工具）。
 *
 * 读取 samples/annotations/set.json + labels.json + data/enums.json，
 * 生成一个自包含的 samples/annotations/review.html（双击即可打开，无需服务器）。
 *
 * 设计：导出/复制按钮始终可用；页面不强制「已看过」进度；数据通过
 * <script type="application/json"> 块内嵌（拼接而非模板插值），避免样本内容
 * 中的反引号 / ${ / </script> 破坏页面脚本。
 *
 * 用法:
 *   node scripts/build-review-page.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ANN_DIR = path.join(ROOT, 'samples', 'annotations');

const set = JSON.parse(await fs.readFile(path.join(ANN_DIR, 'set.json'), 'utf8'));
const labelsData = JSON.parse(await fs.readFile(path.join(ANN_DIR, 'labels.json'), 'utf8'));
const enums = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'enums.json'), 'utf8'));

// 内嵌数据转义 <（防止 </script> 提前闭合），字符串拼接注入，不经模板插值
const dataJson = JSON.stringify({
  set,
  labels: labelsData.labels,
  topics: enums.topics.map(t => ({ id: t.id, label: t.label })),
  meta: {
    schemaVersion: labelsData.schemaVersion,
    seed: labelsData.seed,
    perDay: labelsData.perDay,
    note: labelsData.note,
    createdAt: labelsData.createdAt
  }
}).replace(/</g, '\\u003c');

const PAGE_JS = `'use strict';
const DATA = JSON.parse(document.getElementById('app-data').textContent);
const SET = DATA.set, LABELS = DATA.labels, TOPICS = DATA.topics, META = DATA.meta;

function getLabel(id) {
  return LABELS[id] || (LABELS[id] = { relevant: null, topic: null, duplicateOf: null, isPrimary: null, confidence: null, quality: null, note: '' });
}
function esc(t) { return String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function buildCard(s) {
  const L = getLabel(s.id);
  const el = document.createElement('div');
  el.className = 'card' + (L.confidence === 'low' ? ' lowlight' : '');
  el.dataset.id = s.id;
  const topicOpts = ['<option value="">(未选)</option>'].concat(
    TOPICS.map(t => '<option value="' + t.id + '"' + (L.topic === t.id ? ' selected' : '') + '>' + esc(t.label) + ' (' + t.id + ')</option>')
  ).join('');
  const relSel = (v) => L.relevant === v ? ' checked' : '';
  const primSel = (v) => L.isPrimary === v ? ' selected' : '';
  const confSel = (c) => L.confidence === c ? ' selected' : '';
  const srcLink = s.url
    ? '<a class="src" href="' + esc(s.url) + '" target="_blank" rel="noopener nofollow">' + esc(s.source || '(无来源)') + ' ↗</a>'
    : '<span>' + esc(s.source || '') + '</span>';
  el.innerHTML =
    '<div class="meta">' +
      '<span><b>' + esc(s.id) + '</b></span><span>' + esc(s.date) + '</span>' + srcLink +
      (L.duplicateOf ? '<span class="badge dup">重复→' + esc(L.duplicateOf) + '</span>' : '') +
      (L.relevant === 'relevant' ? '<span class="badge rel">相关</span>' : L.relevant === 'irrelevant' ? '<span class="badge irr">无关</span>' : '') +
      (L.confidence === 'low' ? '<span class="badge low">需复核</span>' : '') +
      (L.quality === 'low' ? '<span class="badge lowq">低质量</span>' : '') +
    '</div>' +
    '<div class="title">' + (s.url
      ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener nofollow">' + esc(s.title) + '</a>'
      : esc(s.title)) + '</div>' +
    (s.summary ? '<div class="summary">' + esc(s.summary) + '</div>' : '') +
    '<div class="controls">' +
      '<div class="ctl"><label>相关性</label><div class="radio-row">' +
        '<label><input type="radio" name="' + s.id + '_rel" data-field="relevant" value="relevant"' + relSel('relevant') + '> 相关</label>' +
        '<label><input type="radio" name="' + s.id + '_rel" data-field="relevant" value="irrelevant"' + relSel('irrelevant') + '> 无关</label>' +
      '</div></div>' +
      '<div class="ctl"><label>主题</label><select data-field="topic">' + topicOpts + '</select></div>' +
      '<div class="ctl"><label>重复→样本id</label><input data-field="duplicateOf" value="' + esc(L.duplicateOf || '') + '" placeholder="如 s0027"></div>' +
      '<div class="ctl"><label>主来源</label><select data-field="isPrimary">' +
        '<option value="null"' + primSel(null) + '>—</option>' +
        '<option value="true"' + primSel(true) + '>是</option>' +
        '<option value="false"' + primSel(false) + '>否</option></select></div>' +
      '<div class="ctl"><label>置信度</label><select data-field="confidence">' +
        ['high','medium','low'].map(function(c){ return '<option value="' + c + '"' + confSel(c) + '>' + c + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="ctl"><label>质量</label><select data-field="quality">' +
        '<option value="null"' + (L.quality == null ? ' selected' : '') + '>—（默认）</option>' +
        '<option value="high"' + (L.quality === 'high' ? ' selected' : '') + '>高</option>' +
        '<option value="medium"' + (L.quality === 'medium' ? ' selected' : '') + '>中</option>' +
        '<option value="low"' + (L.quality === 'low' ? ' selected' : '') + '>低</option>' +
      '</select></div>' +
      '<div class="ctl" style="flex:1"><label>备注</label><textarea data-field="note">' + esc(L.note) + '</textarea></div>' +
    '</div>';
  return el;
}

function mark(id, field, value) {
  const L = getLabel(id);
  if (field === 'relevant') L.relevant = value;
  else if (field === 'topic') L.topic = value || null;
  else if (field === 'duplicateOf') L.duplicateOf = value || null;
  else if (field === 'isPrimary') L.isPrimary = value === 'true' ? true : value === 'false' ? false : null;
  else if (field === 'confidence') L.confidence = value;
  else if (field === 'quality') L.quality = value === 'null' ? null : value;
  else if (field === 'note') L.note = value;
  // 任何字段被改动即视为“已人工复核”：low 置信度自动提升为 high（除非显式在置信度下拉选回 low）
  if (field !== 'confidence' && L.confidence === 'low') L.confidence = 'high';
  render();
}

function updateStats() {
  let rel = 0, irr = 0, low = 0, lowq = 0;
  SET.forEach(function (s) {
    const L = LABELS[s.id];
    if (L.relevant === 'relevant') rel++;
    else if (L.relevant === 'irrelevant') irr++;
    if (L.confidence === 'low') low++;
    if (L.quality === 'low') lowq++;
  });
  document.getElementById('total').textContent = SET.length;
  document.getElementById('rel').textContent = rel;
  document.getElementById('irr').textContent = irr;
  document.getElementById('low').textContent = low;
  document.getElementById('lowq').textContent = lowq;
}

function render() {
  const filter = document.getElementById('filter').value;
  const list = document.getElementById('list');
  list.innerHTML = '';
  SET.forEach(function (s) {
    const L = getLabel(s.id);
    if (filter === 'low' && L.confidence !== 'low') return;
    if (filter === 'rel' && L.relevant !== 'relevant') return;
    if (filter === 'irr' && L.relevant !== 'irrelevant') return;
    if (filter === 'lowq' && L.quality !== 'low') return;
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
    navigator.clipboard.writeText(t).then(function(){ alert('已复制到剪贴板'); }, function(){ prompt('复制以下内容：', t); });
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
<title>EnergyHub V1.1 标注复核</title>
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
  .card { border:1px solid #E4E4E7; border-radius:12px; padding:14px 16px; margin-bottom:12px; background:#fff; }
  .card .meta { color:#52525B; font-size:12px; margin-bottom:6px; display:flex; gap:10px; flex-wrap:wrap; }
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
  .lowlight { background:#fff7ed; }
</style>
</head>
<body>
<header>
  <h1>EnergyHub V1.1 标注复核</h1>
  <div class="stat">共 <b id="total">0</b> 条 · 相关 <b id="rel">0</b> / 无关 <b id="irr">0</b> · 低质量 <b id="lowq">0</b> · 待确认(low) <b id="low">0</b></div>
  <div id="filters">
    <select id="filter">
      <option value="all">全部</option>
      <option value="low">只看 low 置信度</option>
      <option value="lowq">只看低质量</option>
      <option value="rel">只看相关</option>
      <option value="irr">只看无关</option>
    </select>
    <button id="copyBtn">复制标注 JSON</button>
    <button id="exportBtn">导出标注 JSON</button>
  </div>
</header>
<main id="list"></main>
<script type="application/json" id="app-data">` + dataJson + `</script>
<script>
` + PAGE_JS + `
</script>
</body>
</html>
`;

await fs.writeFile(path.join(ANN_DIR, 'review.html'), html);
console.log(`✅ 复核页面已重新生成: samples/annotations/review.html`);
console.log(`   导出/复制按钮始终可用，已移除「已看过」相关选项。`);
