/**
 * EnergyHub 管理后台前端（vanilla JS，与主站同风格）。
 *
 * 结构：
 *   1. 工具（esc / api / toast / confirm / modal）
 *   2. 顶部状态条
 *   3. hash 路由 + 视图注册表（各阶段往 VIEWS 里挂实现）
 */
'use strict';

/* ===== 1. 工具 ===== */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** API 调用封装：自动带本地凭证头；失败抛中文 Error（含 errors 明细）。 */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Request': 'energyhub'
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`服务响应异常（HTTP ${res.status}）`);
  }
  if (!res.ok || !json.ok) {
    const detail = json.errors && json.errors.length ? '\n' + json.errors.join('\n') : '';
    const err = new Error((json.error || `HTTP ${res.status}`) + detail);
    err.errors = json.errors || [];
    err.warnings = json.warnings || [];
    err.payload = json; // 结构化错误码（如 dup-url）从这里取
    throw err;
  }
  return json.data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type ? 'toast-' + type : ''}`;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3200);
}

/** 确认弹窗，resolve(true/false)。 */
function confirmDialog(message, opts = {}) {
  return openModal({
    title: opts.title || '请确认',
    danger: opts.danger,
    bodyHtml: `<p style="margin:0">${esc(message)}</p>`,
    actions: [
      { label: '取消' },
      { label: opts.confirmText || '确定', primary: !opts.danger, dangerClass: !!opts.danger, value: true }
    ]
  }).then((v) => v === true);
}

/**
 * 打开模态。
 * @param {{title:string, bodyHtml:string, actions?:Array, danger?:boolean}} cfg
 *   action: {label, primary?, dangerClass?, value?, onClick?(close)}
 * 返回 Promise<action.value | undefined>；点遮罩/取消 resolve(undefined)。
 */
function openModal(cfg) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-mask">
      <div class="modal">
        <h3>${esc(cfg.title)}</h3>
        <div class="modal-body">${cfg.bodyHtml || ''}</div>
        <div class="modal-actions"></div>
      </div>
    </div>`;
  const mask = $('.modal-mask', root);

  return new Promise((resolve) => {
    const close = (value) => {
      root.innerHTML = '';
      resolve(value);
    };
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close(undefined);
    });
    const wrap = $('.modal-actions', root);
    for (const a of cfg.actions || [{ label: '关闭' }]) {
      const btn = document.createElement('button');
      btn.className = a.dangerClass ? 'btn btn-danger' : (a.primary ? 'btn btn-primary' : 'btn');
      btn.textContent = a.label;
      btn.addEventListener('click', () => {
        if (a.onClick) {
          a.onClick(() => close(a.value));
        } else {
          close(a.value);
        }
      });
      wrap.appendChild(btn);
    }
  });
}

/** 把 {valid,errors,warnings} 渲染成提示块 HTML。 */
function validationBlock(v) {
  if (!v || (v.valid && !(v.warnings || []).length)) return '';
  const errs = (v.errors || []).map((e) => `<div>· ${esc(e)}</div>`).join('');
  const warns = (v.warnings || []).map((w) => `<div>· ${esc(w)}</div>`).join('');
  return `
    ${errs ? `<div class="save-errors" style="color:var(--danger);font-size:12px;margin-top:8px">${errs}</div>` : ''}
    ${warns ? `<div style="color:var(--warn);font-size:12px;margin-top:6px">${warns}</div>` : ''}`;
}

/* ===== 2. 顶部状态条 ===== */

let statusTimer = null;

function pill(label, value, cls = '') {
  return `<span class="pill ${cls}">${esc(label)} <b>${esc(value)}</b></span>`;
}

function renderStatus(s) {
  const parts = [];
  parts.push(pill('分支', s.branch));
  if (s.behindCount == null) {
    parts.push('<span class="pill pill-muted">远端状态未知</span>');
  } else if (s.behindCount > 0) {
    parts.push(pill('落后远端', `${s.behindCount} 个提交`, 'pill-warn'));
  }
  if (s.aheadCount > 0) parts.push(pill('待推送', `${s.aheadCount}`, 'pill-warn'));
  parts.push(
    s.dirtyCount > 0
      ? pill('未提交文件', s.dirtyCount, 'pill-warn')
      : '<span class="pill pill-ok">工作区干净</span>'
  );
  if (s.dataDate) parts.push(pill('数据日期', s.dataDate));
  parts.push(
    s.ghAuthed
      ? '<span class="pill pill-ok">gh 已登录</span>'
      : '<span class="pill pill-muted">gh 未登录</span>'
  );
  $('#statusPills').innerHTML = parts.join('');
}

async function refreshStatus() {
  try {
    renderStatus(await api('/api/status'));
  } catch (e) {
    $('#statusPills').innerHTML = `<span class="pill pill-danger">状态获取失败：${esc(e.message)}</span>`;
  }
}

/* ===== 3. 路由与视图 ===== */

const VIEWS = {};

/** 注册视图：name → {title, sub?, async render(area)} */
function registerView(name, def) {
  VIEWS[name] = def;
}

/* —— P0 占位视图（后续阶段替换实现）—— */

/* ===== P2 信源管理 ===== */

const ISSUE_LABEL = {
  'http-404': 'HTTP 404', 'http-403': 'HTTP 403', 'http-410': 'HTTP 410',
  'http-500': 'HTTP 500', 'http-502': 'HTTP 502', 'http-503': 'HTTP 503',
  'unreachable': '连不上', 'timeout': '超时', 'wechat-invalid': '微信失效',
  'parked': '域名停放', 'err-title': '错误页标题', 'redirected-to-root': '重定向到首页',
  'thin': '内容过少'
};
/** 这两类只是疑似（改版/软重定向），标黄不标红 */
const WARN_ISSUES = new Set(['thin', 'redirected-to-root']);

const sourcesState = {
  sub: 'all',        // all | wechat
  catId: '',         // 分类过滤
  q: '',
  issue: '',         // 问题类型过滤
  data: null,
  job: null,         // 进行中的健康检查任务快照
  jobTimer: null
};

registerView('sources', {
  title: '信源管理',
  sub: 'data/sources.json · 健康检查',
  async render(area) {
    await renderSourcesView(area);
  }
});

async function renderSourcesView(area) {
  area.innerHTML = '<div class="loading-state">加载中…</div>';
  const [data, latest] = await Promise.all([api('/api/sources'), api('/api/check/latest')]);
  sourcesState.data = data;
  // 页面刷新后找回进行中的检查任务
  if (latest && latest.status === 'running' && !sourcesState.job) {
    sourcesState.job = latest;
    pollCheckJob();
  }

  const s = data.stats;
  area.innerHTML = `
    <div class="content-toolbar">
      <span class="pill">信源 <b>${s.total}</b></span>
      ${s.ok ? `<span class="pill pill-ok">正常 <b>${s.ok}</b></span>` : ''}
      ${s.problems ? `<span class="pill pill-danger">异常 <b>${s.problems}</b></span>` : ''}
      ${s.noLink ? `<span class="pill">说明卡 <b>${s.noLink}</b></span>` : ''}
      <span class="pill pill-muted">未检查 <b>${s.unchecked}</b></span>
      ${data.checkedAt ? `<span class="pill pill-muted">上次检查 ${esc(new Date(data.checkedAt).toLocaleString())}</span>` : ''}
      <span style="flex:1"></span>
      <button class="btn btn-primary btn-sm" id="srcCheck">运行健康检查</button>
      <button class="btn btn-sm" id="srcAdd">＋ 添加信源</button>
      <button class="btn btn-sm" id="catAdd">＋ 新增分类</button>
    </div>
    <div id="checkProgressBox"></div>
    <div class="subtabs" id="srcSubtabs">
      <button class="subtab ${sourcesState.sub === 'all' ? 'active' : ''}" data-sub="all">全部信源</button>
      <button class="subtab ${sourcesState.sub === 'wechat' ? 'active' : ''}" data-sub="wechat">微信公众号源</button>
    </div>
    <div id="sourcesBody"></div>`;

  $('#srcCheck').addEventListener('click', startCheckAll);
  $('#srcAdd').addEventListener('click', () => openSourceModal(sourcesState.catId || '', null));
  $('#catAdd').addEventListener('click', openCategoryModal);
  $$('#srcSubtabs .subtab').forEach(btn =>
    btn.addEventListener('click', () => { sourcesState.sub = btn.dataset.sub; renderSourcesSub(); }));

  if (sourcesState.job) renderCheckProgress();
  renderSourcesSub();
}

function renderSourcesSub() {
  const el = $('#sourcesBody');
  if (!el) return;
  $$('#srcSubtabs .subtab').forEach(b => b.classList.toggle('active', b.dataset.sub === sourcesState.sub));
  if (sourcesState.sub === 'wechat') renderWechatSourcesView(el);
  else renderSourcesTable(el);
}

/* ---- 主表 + 分类树 ---- */

function healthBadge(src) {
  // 两种形状：/api/sources 的 src.check；wechat-report 的 checked/issue/lastTitle
  const c = src.check || (src.checked ? { issue: src.issue, title: src.lastTitle || '' } : null);
  if (!c) return '<span class="mini-badge">未检查</span>';
  if (c.issue === 'ok') return '<span class="mini-badge mb-ok">正常</span>';
  if (c.issue === 'no-link') return '<span class="mini-badge">说明卡</span>';
  const label = ISSUE_LABEL[c.issue] || c.issue;
  return WARN_ISSUES.has(c.issue)
    ? `<span class="mini-badge mb-warn" title="${esc(c.title || '')}">${esc(label)}</span>`
    : `<span class="mini-badge mb-hot" title="${esc(c.title || '')}">${esc(label)}</span>`;
}

function renderSourcesTable(el) {
  const { data } = sourcesState;
  const q = sourcesState.q.trim().toLowerCase();

  const rows = [];
  for (const cat of data.categories) {
    if (sourcesState.catId && cat.id !== sourcesState.catId) continue;
    for (const src of cat.sources) {
      if (sourcesState.issue && !(src.check && src.check.issue === sourcesState.issue)) continue;
      if (q && !`${src.name} ${src.url} ${src.desc || ''} ${(src.tags || []).join(' ')}`.toLowerCase().includes(q)) continue;
      rows.push(sourceRow(src, cat));
    }
  }

  el.innerHTML = `
    <div class="sources-layout">
      <div class="card">
        <div class="card-title">分类（${data.categories.length}）</div>
        <div class="cat-list">
          <div class="cat-item ${sourcesState.catId === '' ? 'active' : ''}" data-cat="">
            <span class="cat-name">全部</span>
            <span class="cat-count">${data.stats.total}</span>
          </div>
          ${data.categories.map(cat => `
            <div class="cat-item ${sourcesState.catId === cat.id ? 'active' : ''}" data-cat="${esc(cat.id)}" title="${esc(cat.name)}">
              <span class="cat-name">${esc(cat.name)}</span>
              <span class="cat-count">${cat.count}</span>
              <span class="cat-ops">
                <button class="cat-add-src" data-cat="${esc(cat.id)}" title="往此分类添加信源">＋</button>
                <button class="cat-rename" data-cat="${esc(cat.id)}" title="重命名">✎</button>
                <button class="cat-del" data-cat="${esc(cat.id)}" title="删除分类">✕</button>
              </span>
            </div>`).join('')}
        </div>
        <div class="side-actions"><button class="btn btn-sm" id="catAdd2">＋ 新增分类</button></div>
      </div>
      <div>
        <div class="card filter-bar">
          <input id="srcQ" class="filter-input" placeholder="搜索名称 / url / 标签…" value="${esc(sourcesState.q)}">
          ${Object.entries(data.issueCounts).map(([issue, n]) =>
            `<button class="chip ${sourcesState.issue === issue ? 'active' : ''}" data-issue="${esc(issue)}">${esc(ISSUE_LABEL[issue] || issue)} <b>${n}</b></button>`).join('')}
          ${sourcesState.issue ? '<button class="chip" data-issue="">✕ 清除筛选</button>' : ''}
          <span class="filter-count">${rows.length} 条</span>
        </div>
        <div class="card">
          <div class="table-wrap"><table class="evt-table">
            <thead><tr><th>信源</th><th>健康</th><th>属性</th><th>操作</th></tr></thead>
            <tbody>${rows.join('') || '<tr><td colspan="4"><div class="empty-state">没有匹配的信源</div></td></tr>'}</tbody>
          </table></div>
        </div>
      </div>
    </div>`;

  bindSourcesActions(el);
}

function sourceRow(src, cat) {
  const tags = (src.tags || []).map(t => `<span class="mini-badge">${esc(t)}</span>`).join(' ');
  const region = src.region ? `<span class="mini-badge">${esc(src.region)}</span>` : '';
  return `<tr data-cat="${esc(cat.id)}" data-name="${esc(src.name)}" data-url="${esc(src.url || '')}">
    <td class="evt-title">
      ${src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.name)}</a>` : esc(src.name)}
      ${src.rss ? '<span class="mini-badge mb-ok">RSS</span>' : ''}
      <div class="evt-orig">${esc(src.url || '（无外链）')}</div>
      ${src.desc ? `<div class="evt-meta">${esc(src.desc)}</div>` : ''}
    </td>
    <td>${healthBadge(src)}</td>
    <td>${tags} ${region}</td>
    <td class="evt-actions">
      <button class="btn btn-sm act-edit">编辑</button>
      <button class="btn btn-sm act-del btn-danger">删除</button>
    </td></tr>`;
}

function bindSourcesActions(el) {
  // 分类树
  el.querySelectorAll('.cat-item').forEach(item => item.addEventListener('click', (e) => {
    if (e.target.closest('.cat-ops')) return;
    sourcesState.catId = item.dataset.cat;
    renderSourcesTable(el);
  }));
  el.querySelectorAll('.cat-add-src').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation(); openSourceModal(btn.dataset.cat, null);
  }));
  el.querySelectorAll('.cat-rename').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation(); renameCategoryFlow(btn.dataset.cat);
  }));
  el.querySelectorAll('.cat-del').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation(); deleteCategoryFlow(btn.dataset.cat);
  }));
  $('#catAdd2').addEventListener('click', openCategoryModal);

  // 问题 chips
  el.querySelectorAll('.chip[data-issue]').forEach(chip => chip.addEventListener('click', () => {
    sourcesState.issue = chip.dataset.issue === sourcesState.issue ? '' : chip.dataset.issue;
    renderSourcesTable(el);
  }));

  // 搜索（重绘后保焦点）
  $('#srcQ').addEventListener('input', () => {
    sourcesState.q = $('#srcQ').value;
    renderSourcesTable(el);
    const box = $('#srcQ'); box.focus(); box.setSelectionRange(box.value.length, box.value.length);
  });

  // 行操作
  el.querySelectorAll('tr[data-name]').forEach(tr => {
    const ref = () => ({ catId: tr.dataset.cat, name: tr.dataset.name, url: tr.dataset.url });
    tr.querySelector('.act-edit').addEventListener('click', () => {
      const src = findSourceInState(ref());
      openSourceModal(ref().catId, src, ref());
    });
    tr.querySelector('.act-del').addEventListener('click', async () => {
      if (!(await confirmDialog(`删除信源「${ref().name}」？`, { danger: true }))) return;
      try {
        await api(`/api/sources/item?${new URLSearchParams(ref())}`, { method: 'DELETE' });
        toast('已删除', 'success');
        await reloadSourcesData();
      } catch (e) { toast(`删除失败：${e.message}`, 'error'); }
    });
  });
}

function findSourceInState(ref) {
  for (const cat of sourcesState.data.categories) {
    if (cat.id !== ref.catId) continue;
    const src = cat.sources.find(s => s.name === ref.name && (s.url || '') === (ref.url || ''));
    if (src) return src;
  }
  return null;
}

async function reloadSourcesData() {
  sourcesState.data = await api('/api/sources');
  renderSourcesSub();
  refreshStatus();
}

/* ---- 健康检查任务 ---- */

async function startCheckAll() {
  const total = sourcesState.data.stats.total;
  if (!(await confirmDialog(`对全部 ${total} 个信源做健康检查？\n并发 10，约需 1-2 分钟，期间可继续其他操作。`))) return;
  try {
    const job = await api('/api/check/start', { method: 'POST', body: { scope: 'all' } });
    sourcesState.job = job;
    renderCheckProgress();
    pollCheckJob();
  } catch (e) { toast(`启动失败：${e.message}`, 'error'); }
}

function renderCheckProgress() {
  const box = $('#checkProgressBox');
  if (!box) return;
  const j = sourcesState.job;
  if (!j) { box.innerHTML = ''; return; }
  const pct = j.total ? Math.round(j.done / j.total * 100) : 0;
  const statusText = j.status === 'running' ? '检查中' : j.status === 'done' ? '已完成' : '失败';
  box.innerHTML = `
    <div class="check-progress">
      <span class="pill ${j.status === 'done' ? 'pill-ok' : j.status === 'error' ? 'pill-danger' : ''}">${statusText}</span>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <span class="evt-imp">${j.done}/${j.total}</span>
    </div>`;
}

function pollCheckJob() {
  if (sourcesState.jobTimer) clearInterval(sourcesState.jobTimer);
  sourcesState.jobTimer = setInterval(async () => {
    const j = sourcesState.job;
    if (!j) { clearInterval(sourcesState.jobTimer); return; }
    try {
      const snap = await api(`/api/check/jobs/${j.id}`);
      sourcesState.job = snap;
      renderCheckProgress();
      if (snap.status === 'done') {
        clearInterval(sourcesState.jobTimer);
        sourcesState.job = null;
        renderCheckProgress();
        const c = snap.counts || {};
        toast(`检查完成：正常 ${c.ok ?? '-'}，异常 ${c.problems ?? '-'}，说明卡 ${c.noLink ?? '-'}`, 'success');
        await reloadSourcesData();
      } else if (snap.status === 'error') {
        clearInterval(sourcesState.jobTimer);
        sourcesState.job = null;
        renderCheckProgress();
        toast(`检查失败：${snap.error || '未知错误'}`, 'error');
      }
    } catch { /* 轮询抖动忽略，下轮再试 */ }
  }, 2000);
}

/* ---- 信源编辑模态 ---- */

function openSourceModal(catId, src, origRef) {
  const isEdit = !!src;
  const cats = sourcesState.data.categories;
  const cat = cats.find(c => c.id === (src ? src.catId : catId));
  const s = src || {};
  openModal({
    title: isEdit ? `编辑信源（${esc(cat ? cat.name : '')}）` : '添加信源',
    bodyHtml: `
      <div class="form-row">
        <label class="field">名称<input id="fName" type="text" value="${esc(s.name || '')}"></label>
        <label class="field">分类<select id="fCat">${cats.map(c =>
          `<option value="${esc(c.id)}" ${(c.id === (src ? src.catId : catId)) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      </div>
      <label class="field">url<input id="fUrl" type="url" value="${esc(s.url || '')}" placeholder="https://…（微信说明卡可留空）"></label>
      <label class="field">RSS 地址<input id="fRss" type="url" value="${esc(s.rss || '')}" placeholder="可留空"></label>
      <label class="field">描述<input id="fDesc" type="text" value="${esc(s.desc || '')}"></label>
      <div class="form-row">
        <label class="field">标签（逗号分隔）<input id="fTags" type="text" value="${esc((s.tags || []).join(', '))}"></label>
        <label class="field">区域<input id="fRegion" type="text" value="${esc(s.region || '')}" placeholder="cn / global…"></label>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: isEdit ? '保存' : '添加', primary: true,
        onClick: async (close) => {
          const body = {
            name: $('#fName').value.trim(),
            url: $('#fUrl').value.trim(),
            rss: $('#fRss').value.trim() || null,
            desc: $('#fDesc').value.trim(),
            tags: $('#fTags').value.split(/[,，]/).map(x => x.trim()).filter(Boolean),
            region: $('#fRegion').value.trim()
          };
          if (!body.name) { toast('名称不能为空', 'error'); return; }
          const targetCat = $('#fCat').value;
          const ref = origRef || { catId: catId || targetCat, name: '', url: '' };
          try {
            if (isEdit) {
              // 先移动（身份不变），再改字段
              if (targetCat !== ref.catId) {
                await api('/api/sources/move', { method: 'POST', body: { ...ref, toCatId: targetCat } });
                ref.catId = targetCat;
              }
              await api('/api/sources/item', { method: 'PUT', body: { ...ref, patch: body } });
            } else {
              await api('/api/sources', { method: 'POST', body: { catId: targetCat, source: body } });
            }
            toast(isEdit ? '已保存' : '已添加', 'success');
            close(undefined);
            await reloadSourcesData();
          } catch (e) {
            if (e.payload && e.payload.code === 'dup-url') {
              const goOn = await confirmDialog(`${e.message}\n\n跨分类重复链接有时是故意的（同一发行方服务不同领域）。仍要保存吗？`);
              if (goOn) {
                try {
                  if (isEdit) {
                    await api('/api/sources/item', { method: 'PUT', body: { ...ref, patch: body, allowDupUrl: true } });
                  } else {
                    await api('/api/sources', { method: 'POST', body: { catId: $('#fCat').value, source: body, allowDupUrl: true } });
                  }
                  toast('已保存（允许重复链接）', 'success');
                  close(undefined);
                  await reloadSourcesData();
                } catch (e2) { toast(`保存失败：${e2.message}`, 'error'); }
              }
            } else {
              toast(`保存失败：${e.message}`, 'error');
            }
          }
        }
      }
    ]
  });
}

/* ---- 分类操作 ---- */

function openCategoryModal() {
  openModal({
    title: '新增分类',
    bodyHtml: `
      <label class="field">分类 id（小写字母/数字/连杠）<input id="cId" type="text" placeholder="energy-storage"></label>
      <label class="field">分类名<input id="cName" type="text" placeholder="储能"></label>`,
    actions: [
      { label: '取消' },
      { label: '创建', primary: true, onClick: async (close) => {
          try {
            await api('/api/sources/category', { method: 'POST', body: { id: $('#cId').value.trim(), name: $('#cName').value.trim() } });
            toast('分类已创建', 'success');
            close(undefined);
            await reloadSourcesData();
          } catch (e) { toast(`创建失败：${e.message}`, 'error'); }
        } }
    ]
  });
}

function renameCategoryFlow(catId) {
  const cat = sourcesState.data.categories.find(c => c.id === catId);
  if (!cat) return;
  openModal({
    title: `重命名分类「${esc(cat.name)}」`,
    bodyHtml: `<label class="field">新分类名<input id="cName" type="text" value="${esc(cat.name)}"></label>`,
    actions: [
      { label: '取消' },
      { label: '保存', primary: true, onClick: async (close) => {
          try {
            await api(`/api/sources/category/${encodeURIComponent(catId)}`, { method: 'PUT', body: { name: $('#cName').value.trim() } });
            toast('已重命名', 'success');
            close(undefined);
            await reloadSourcesData();
          } catch (e) { toast(`重命名失败：${e.message}`, 'error'); }
        } }
    ]
  });
}

async function deleteCategoryFlow(catId) {
  const cat = sourcesState.data.categories.find(c => c.id === catId);
  if (!cat) return;
  if (!(await confirmDialog(`删除分类「${cat.name}」？（有信源时会被拒绝）`, { danger: true }))) return;
  try {
    await api(`/api/sources/category/${encodeURIComponent(catId)}`, { method: 'DELETE' });
    if (sourcesState.catId === catId) sourcesState.catId = '';
    toast('分类已删除', 'success');
    await reloadSourcesData();
  } catch (e) { toast(`删除失败：${e.message}`, 'error'); }
}

/* ---- 子页：微信公众号源 ---- */

async function renderWechatSourcesView(el) {
  el.innerHTML = '<div class="loading-state">加载中…</div>';
  const report = await api('/api/sources/wechat-report');
  if (!report.total) {
    el.innerHTML = `<div class="card"><div class="empty-state">当前没有微信公众号类信源（mp.weixin 链接或无外链说明卡）</div></div>`;
    return;
  }
  el.innerHTML = `
    <div class="card">
      <div class="card-title">微信公众号源（${report.total}，其中异常 ${report.invalid.length}）</div>
      <p class="muted-note">含 mp.weixin.qq.com 链接与无外链说明卡；文章被删除/违规的会在健康检查后给出建议。</p>
      <div class="table-wrap"><table class="evt-table">
        <thead><tr><th>信源</th><th>分类</th><th>状态</th><th>建议</th><th></th></tr></thead>
        <tbody>${report.items.map(it => `
          <tr data-cat="${esc(it.catId)}" data-name="${esc(it.name)}" data-url="${esc(it.url)}">
            <td class="evt-title">${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.name)}</a>` : esc(it.name)}
              ${it.lastTitle ? `<div class="evt-orig">${esc(it.lastTitle)}</div>` : ''}</td>
            <td>${esc(it.catName)}</td>
            <td>${healthBadge(it)}</td>
            <td class="evt-meta">${esc(it.suggestion)}</td>
            <td class="evt-actions"><button class="btn btn-sm btn-danger wx-del">删除</button></td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>`;

  el.querySelectorAll('.wx-del').forEach(btn => btn.addEventListener('click', async () => {
    const tr = btn.closest('tr');
    const ref = { catId: tr.dataset.cat, name: tr.dataset.name, url: tr.dataset.url };
    if (!(await confirmDialog(`删除信源「${ref.name}」？`, { danger: true }))) return;
    try {
      await api(`/api/sources/item?${new URLSearchParams(ref)}`, { method: 'DELETE' });
      toast('已删除', 'success');
      renderWechatSourcesView(el);
    } catch (e) { toast(`删除失败：${e.message}`, 'error'); }
  }));
}

registerView('content', {
  title: '内容运营',
  sub: 'editorial-overrides · 微信种子 · 深度阅读 · 过滤沙箱',
  async render(area) {
    await renderContentView(area);
  }
});

/* ===== P1 内容运营 ===== */

const contentState = {
  sub: 'events',            // events | wechat | deep | sandbox
  data: null,               // GET /api/content/today
  stale: [],
  previewOn: false,
  preview: null,
  filters: { q: '', topic: '', impact: '', featuredOnly: false, hiddenOnly: false },
  hotDraft: null,           // 热点榜编辑草稿（id 数组）
  obsDraft: null            // 今日观察编辑草稿（字符串）
};

async function renderContentView(area) {
  area.innerHTML = '<div class="loading-state">加载中…</div>';
  const [data, staleRes] = await Promise.all([
    api('/api/content/today'),
    api('/api/content/stale')
  ]);
  contentState.data = data;
  contentState.stale = staleRes.stale || [];
  if (contentState.hotDraft === null) contentState.hotDraft = [...data.hotIds];
  if (contentState.obsDraft === null) contentState.obsDraft = data.observations.join('\n');
  if (contentState.previewOn) contentState.preview = await api('/api/content/preview', { method: 'POST' }).catch(() => null);

  area.innerHTML = `
    <div class="content-toolbar">
      <span class="pill ${data.date ? 'pill-ok' : 'pill-warn'}">数据日期 <b>${esc(data.date || '未知')}</b></span>
      ${data.globalIds.length ? `<span class="pill pill-warn">永久黑名单 <b>${data.globalIds.length}</b></span>` : ''}
      ${contentState.stale.length ? `<span class="pill pill-danger">失效引用 <b>${contentState.stale.length}</b></span>` : ''}
      <label class="checkbox-line"><input type="checkbox" id="previewToggle" ${contentState.previewOn ? 'checked' : ''}> 覆盖预览</label>
    </div>
    <div class="subtabs" id="contentSubtabs">
      <button class="subtab ${contentState.sub === 'events' ? 'active' : ''}" data-sub="events">今日事件（${data.items.length}）</button>
      <button class="subtab ${contentState.sub === 'wechat' ? 'active' : ''}" data-sub="wechat">微信种子</button>
      <button class="subtab ${contentState.sub === 'deep' ? 'active' : ''}" data-sub="deep">深度阅读</button>
      <button class="subtab ${contentState.sub === 'sandbox' ? 'active' : ''}" data-sub="sandbox">过滤沙箱</button>
    </div>
    <div id="contentBody"></div>`;

  $('#previewToggle').addEventListener('change', async (e) => {
    contentState.previewOn = e.target.checked;
    if (contentState.previewOn) {
      contentState.preview = await api('/api/content/preview', { method: 'POST' });
    } else {
      contentState.preview = null;
    }
    renderContentSub();
  });
  $$('#contentSubtabs .subtab').forEach(btn =>
    btn.addEventListener('click', () => { contentState.sub = btn.dataset.sub; renderContentSub(); }));

  renderContentSub();
}

/** 只重绘 subtab 内容区（不动工具栏）。 */
function renderContentSub() {
  const el = $('#contentBody');
  const { sub } = contentState;
  $$('#contentSubtabs .subtab').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  if (sub === 'events') renderEventsView(el);
  else if (sub === 'wechat') renderWechatView(el);
  else if (sub === 'deep') renderDeepView(el);
  else renderSandboxView(el);
}

/** 覆盖操作统一入口：POST → toast → 重拉数据重绘。 */
async function doOverride(op, extra = {}, okMsg = '已保存') {
  try {
    await api('/api/content/override', { method: 'POST', body: { op, ...extra } });
    toast(okMsg, 'success');
    await reloadContentData();
  } catch (e) {
    toast(`操作失败：${e.message}`, 'error');
  }
}

async function reloadContentData() {
  const [data, staleRes] = await Promise.all([api('/api/content/today'), api('/api/content/stale')]);
  contentState.data = data;
  contentState.stale = staleRes.stale || [];
  contentState.hotDraft = [...data.hotIds];
  contentState.obsDraft = data.observations.join('\n');
  if (contentState.previewOn) {
    contentState.preview = await api('/api/content/preview', { method: 'POST' }).catch(() => null);
  }
  renderContentSub();
  refreshStatus();
}

/* ---- 子页 1：今日事件 ---- */

function renderEventsView(el) {
  const { data } = contentState;
  const itemById = Object.fromEntries(data.items.map(i => [i.id, i]));
  const f = contentState.filters;
  const q = f.q.trim().toLowerCase();

  let items = data.items.filter(i =>
    (!f.topic || i.topic === f.topic) &&
    (!f.impact || i.impact === f.impact) &&
    (!f.featuredOnly || i.isFeatured) &&
    (!f.hiddenOnly || i.hiddenGlobal || i.hasOverride) &&
    (!q || `${i.title} ${i.originalTitle} ${i.source}`.toLowerCase().includes(q)));

  const previewHtml = contentState.previewOn && contentState.preview ? previewCard(contentState.preview) : '';

  el.innerHTML = `
    ${previewHtml}
    <div class="content-layout">
      <div>
        <div class="card filter-bar">
          <input id="fQ" class="filter-input" placeholder="搜索标题 / 来源…" value="${esc(f.q)}">
          <select id="fTopic" class="inline-select">
            <option value="">全部主题</option>
            ${data.topics.map(t => `<option value="${esc(t.id)}" ${f.topic === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
          <select id="fImpact" class="inline-select">
            <option value="">全部影响</option>
            ${data.impacts.map(i => `<option value="${esc(i.id)}" ${f.impact === i.id ? 'selected' : ''}>${esc(i.label)}</option>`).join('')}
          </select>
          <label class="checkbox-line"><input type="checkbox" id="fFeatured" ${f.featuredOnly ? 'checked' : ''}> 仅精选</label>
          <label class="checkbox-line"><input type="checkbox" id="fHidden" ${f.hiddenOnly ? 'checked' : ''}> 仅覆盖/隐藏</label>
          <span class="filter-count">${items.length} / ${data.items.length} 条</span>
        </div>
        <div class="table-wrap"><table class="evt-table">
          <thead><tr><th>标题</th><th>主题</th><th>影响</th><th>重要度</th><th>徽章</th><th>操作</th></tr></thead>
          <tbody>
            ${items.map(i => eventRow(i)).join('') || '<tr><td colspan="6"><div class="empty-state">没有匹配的事件</div></td></tr>'}
          </tbody>
        </table></div>
      </div>
      <div class="content-side">
        ${sideCardObservations()}
        ${sideCardHotlist(itemById)}
        ${sideCardGlobal(itemById)}
      </div>
    </div>`;

  bindEventActions(el, itemById);
}

function eventRow(i) {
  const badges = [
    i.isFeatured ? '<span class="mini-badge mb-star">精选</span>' : '',
    i.isHot ? '<span class="mini-badge mb-hot">热点</span>' : '',
    i.hasOverride ? '<span class="mini-badge mb-ov">覆盖</span>' : '',
    i.hiddenGlobal ? '<span class="mini-badge mb-hide">黑名单</span>' : '',
    i.wechat ? '<span class="mini-badge mb-wechat">公众号</span>' : ''
  ].filter(Boolean).join(' ');
  return `<tr data-id="${esc(i.id)}">
    <td class="evt-title"><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>
      ${i.originalTitle ? `<div class="evt-orig">${esc(i.originalTitle)}</div>` : ''}
      <div class="evt-meta">${esc(i.source)} · ${esc(i.region)}${i.publishedAt ? ' · ' + esc(i.publishedAt.slice(0, 10)) : ''}</div></td>
    <td><select class="inline-select act-topic" data-id="${esc(i.id)}">
      ${contentState.data.topics.map(t => `<option value="${esc(t.id)}" ${i.topic === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
    </select></td>
    <td><select class="inline-select act-impact" data-id="${esc(i.id)}">
      ${contentState.data.impacts.map(x => `<option value="${esc(x.id)}" ${i.impact === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}
    </select></td>
    <td class="evt-imp">${i.importance}</td>
    <td>${badges}</td>
    <td class="evt-actions">
      <button class="btn btn-sm ${i.isFeatured ? '' : 'btn-primary'} act-feature" data-id="${esc(i.id)}">${i.isFeatured ? '取消精选' : '强制精选'}</button>
      <button class="btn btn-sm ${i.hiddenGlobal ? '' : 'btn-danger'} act-hide" data-id="${esc(i.id)}">${i.hiddenGlobal ? '解除隐藏' : '隐藏'}</button>
      <button class="btn btn-sm act-edit" data-id="${esc(i.id)}">改摘要/理由</button>
    </td></tr>`;
}

function previewCard(p) {
  const arrDiff = (b, a) => `${b.length} → ${b.length === a.length ? a.length : `<b>${a.length}</b>`}`;
  return `<div class="card preview-card">
    <div class="card-title">覆盖预览（${esc(p.date)}，未落盘）</div>
    <div class="preview-line">事件数：${p.itemCount.before} → ${p.itemCount.before === p.itemCount.after ? p.itemCount.after : `<b>${p.itemCount.after}</b>`}（构建重跑后生效）</div>
    <div class="preview-line">精选：${arrDiff(p.featuredIds.before, p.featuredIds.after)} ｜ 热点榜：${arrDiff(p.hotEventIds.before, p.hotEventIds.after)}
      ${p.pendingHide.length ? ` ｜ 待生效隐藏：${p.pendingHide.length} 条` : ''}</div>
    ${p.errors.length ? `<div class="save-errors">错误：${p.errors.map(esc).join('；')}</div>` : ''}
    ${p.warnings.length ? `<div class="preview-warn">警告：${p.warnings.map(esc).join('；')}</div>` : ''}
  </div>`;
}

function sideCardObservations() {
  return `<div class="card">
    <div class="card-title">今日观察（≤5 条，每行一条）</div>
    <textarea id="obsDraft" rows="5" style="width:100%">${esc(contentState.obsDraft)}</textarea>
    <div class="side-actions"><button class="btn btn-sm btn-primary" id="obsSave">保存</button></div>
  </div>`;
}

function sideCardHotlist(itemById) {
  const rows = contentState.hotDraft.map((id, idx) => {
    const it = itemById[id];
    return `<li data-id="${esc(id)}"><span class="hot-name">${it ? esc(it.title) : `<i>${esc(id)}（不在今日）</i>`}</span>
      <span class="hot-ops">
        <button class="btn btn-sm hot-up" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-sm hot-down" ${idx === contentState.hotDraft.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-sm hot-del">✕</button>
      </span></li>`;
  }).join('');
  const overridden = !!contentState.data.todayConfig.hotEventIds;
  return `<div class="card">
    <div class="card-title">热点榜（当前 ${contentState.hotDraft.length} 条${overridden ? ' · 已人工覆盖' : ' · 自动生成'}）</div>
    <ol class="hotlist" id="hotList">${rows || '<div class="empty-state">空</div>'}</ol>
    <div class="side-actions">
      <button class="btn btn-sm btn-primary" id="hotSave">保存榜序</button>
      <button class="btn btn-sm" id="hotReset">恢复自动</button>
    </div>
  </div>`;
}

function sideCardGlobal(itemById) {
  const { globalIds } = contentState.data;
  if (!globalIds.length) return '';
  const rows = globalIds.map(id => {
    const it = itemById[id];
    return `<li data-id="${esc(id)}"><span class="hot-name">${it ? esc(it.title) : `<i>${esc(id)}（已过期）</i>`}</span>
      <button class="btn btn-sm act-unhide" data-id="${esc(id)}">恢复</button></li>`;
  }).join('');
  return `<div class="card">
    <div class="card-title">永久黑名单（${globalIds.length}）</div>
    <ul class="hotlist">${rows}</ul>
  </div>`;
}

/** 事件绑定：全部直接绑在本次 innerHTML 产生的新鲜元素上（勿绑到长寿命容器，
 *  否则每次重渲染都会叠加监听器导致一次点击触发多次请求）。 */
function bindEventActions(el, itemById) {
  const f = contentState.filters;
  const readFilters = () => {
    f.q = $('#fQ').value; f.topic = $('#fTopic').value; f.impact = $('#fImpact').value;
    f.featuredOnly = $('#fFeatured').checked; f.hiddenOnly = $('#fHidden').checked;
  };
  $('#fQ').addEventListener('input', () => {
    readFilters(); renderEventsView(el);
    const box = $('#fQ'); box.focus(); box.setSelectionRange(box.value.length, box.value.length);
  });
  for (const id of ['fTopic', 'fImpact', 'fFeatured', 'fHidden']) {
    $(`#${id}`).addEventListener('change', () => { readFilters(); renderEventsView(el); });
  }

  const cur = (id) => contentState.data.items.find(x => x.id === id);
  el.querySelectorAll('.act-feature').forEach(btn => btn.addEventListener('click', async () => {
    const c = cur(btn.dataset.id);
    await doOverride('forceFeature', { id: btn.dataset.id }, c && c.isFeatured ? '已取消强制精选' : '已强制精选');
  }));
  el.querySelectorAll('.act-hide').forEach(btn => btn.addEventListener('click', async () => {
    const c = cur(btn.dataset.id);
    if (c && c.hiddenGlobal) {
      if (await confirmDialog('解除永久隐藏？下一次构建该文章将重新参与评选。')) {
        await doOverride('unhide', { id: btn.dataset.id }, '已解除隐藏');
      }
    } else if (await confirmDialog(`永久隐藏该文章？\n${itemById[btn.dataset.id]?.title || btn.dataset.id}\n\n将从当前与未来所有日报移除（可在此恢复）。`, { danger: true })) {
      await doOverride('hide', { id: btn.dataset.id }, '已加入永久黑名单');
    }
  }));
  el.querySelectorAll('.act-edit').forEach(btn => btn.addEventListener('click', () => openEditModal(itemById[btn.dataset.id])));
  el.querySelectorAll('.act-unhide').forEach(btn => btn.addEventListener('click', () =>
    doOverride('unhide', { id: btn.dataset.id }, '已解除隐藏')));
  el.querySelectorAll('.act-topic').forEach(sel => sel.addEventListener('change', () =>
    doOverride('setTopic', { id: sel.dataset.id, value: sel.value || null }, '主题已更新')));
  el.querySelectorAll('.act-impact').forEach(sel => sel.addEventListener('change', () =>
    doOverride('setImpact', { id: sel.dataset.id, value: sel.value || null }, '影响已更新')));

  $('#obsSave').addEventListener('click', async () => {
    const lines = $('#obsDraft').value.split('\n').map(s => s.trim()).filter(Boolean);
    await doOverride('setObservations', { value: lines }, `今日观察已保存（${lines.length} 条）`);
  });

  const move = (id, delta) => {
    const a = contentState.hotDraft; const i = a.indexOf(id); const j = i + delta;
    if (i >= 0 && j >= 0 && j < a.length) { [a[i], a[j]] = [a[j], a[i]]; }
  };
  el.querySelectorAll('.hot-up').forEach(btn => btn.addEventListener('click', () => {
    move(btn.closest('li[data-id]').dataset.id, -1); renderEventsView(el);
  }));
  el.querySelectorAll('.hot-down').forEach(btn => btn.addEventListener('click', () => {
    move(btn.closest('li[data-id]').dataset.id, 1); renderEventsView(el);
  }));
  el.querySelectorAll('.hot-del').forEach(btn => btn.addEventListener('click', () => {
    contentState.hotDraft = contentState.hotDraft.filter(x => x !== btn.closest('li[data-id]').dataset.id);
    renderEventsView(el);
  }));
  $('#hotSave').addEventListener('click', () =>
    doOverride('setHotList', { value: contentState.hotDraft }, `热点榜已覆盖（${contentState.hotDraft.length} 条）`));
  $('#hotReset').addEventListener('click', () =>
    doOverride('setHotList', { value: [] }, '已恢复自动热点榜'));
}

function openEditModal(item) {
  if (!item) return;
  openModal({
    title: '改摘要 / 推荐理由',
    bodyHtml: `
      <div style="margin-bottom:6px"><b>${esc(item.title)}</b></div>
      <label class="field">摘要<textarea id="editSummary" rows="3" style="width:100%">${esc(item.summary)}</textarea></label>
      <label class="field">推荐理由<textarea id="editWhy" rows="3" style="width:100%">${esc(item.whyItMatters)}</textarea></label>`,
    actions: [
      { label: '取消' },
      { label: '清空覆盖', onClick: async (close) => {
          await doOverride('setSummary', { id: item.id, value: null });
          await doOverride('setWhy', { id: item.id, value: null }, '已恢复自动摘要/理由');
          close(undefined);
        } },
      { label: '保存', primary: true, onClick: async (close) => {
          const s = $('#editSummary').value.trim();
          const w = $('#editWhy').value.trim();
          if (!s && !w) { toast('两者不能同时为空（如需还原请点"清空覆盖"）', 'error'); return; }
          if (s) await api('/api/content/override', { method: 'POST', body: { op: 'setSummary', id: item.id, value: s } });
          if (w) await api('/api/content/override', { method: 'POST', body: { op: 'setWhy', id: item.id, value: w } });
          toast('已保存', 'success');
          await reloadContentData();
          close(undefined);
        } }
    ]
  });
}

/* ---- 子页 2：微信种子 ---- */

async function renderWechatView(el) {
  el.innerHTML = '<div class="loading-state">加载中…</div>';
  const seed = await api('/api/content/wechat');
  el.innerHTML = `
    <div class="card">
      <div class="card-title">微信公众号文章种子（${seed.articles.length} 条）</div>
      <p class="muted-note">种子在每次构建时被抓取并回写状态（fetched / 3 天清理 / 标题回填）。
        北京时间 05:00 / 12:00 构建窗口内建议缓改；空 url = 占位账号（暂不抓取）。</p>
      <div class="side-actions"><button class="btn btn-primary btn-sm" id="wechatAdd">＋ 添加种子</button></div>
      <div class="table-wrap"><table class="evt-table">
        <thead><tr><th>#</th><th>分类</th><th>账号</th><th>url</th><th>状态</th><th></th></tr></thead>
        <tbody>${seed.articles.map((a, idx) => `<tr>
          <td>${idx}</td><td>${esc(a.category || '')}</td><td>${esc(a.sourceName || '')}</td>
          <td class="evt-title">${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url.slice(0, 60))}</a>` : '<i>占位</i>'}
            ${a.title ? `<div class="evt-orig">${esc(a.title)}</div>` : ''}</td>
          <td>${a.fetched ? '<span class="mini-badge mb-ok">已抓</span>' : '<span class="mini-badge">待抓</span>'}</td>
          <td><button class="btn btn-sm btn-danger wechat-del" data-i="${idx}">删除</button></td>
        </tr>`).join('') || '<tr><td colspan="6"><div class="empty-state">暂无种子</div></td></tr>'}</tbody>
      </table></div>
    </div>`;

  $('#wechatAdd').addEventListener('click', () => {
    openModal({
      title: '添加微信种子',
      bodyHtml: `
        <label class="field">分类<input id="wCat" style="width:100%" placeholder="储能 / 发电 / 电力/新能源…"></label>
        <label class="field">账号名<input id="wName" style="width:100%"></label>
        <label class="field">文章 url<input id="wUrl" style="width:100%" placeholder="https://mp.weixin.qq.com/s/…（可留空作占位）"></label>`,
      actions: [
        { label: '取消' },
        { label: '添加', primary: true, onClick: async (close) => {
            const body = { articles: [{ category: $('#wCat').value.trim(), sourceName: $('#wName').value.trim(), url: $('#wUrl').value.trim() }] };
            try {
              const r = await api('/api/content/wechat', { method: 'POST', body });
              toast(`已添加（新增 ${r.added} 条）`, 'success');
              close(undefined); renderWechatView(el); refreshStatus();
            } catch (e) { toast(`添加失败：${e.message}`, 'error'); }
          } }
      ]
    });
  });

  el.querySelectorAll('.wechat-del').forEach(btn => btn.addEventListener('click', async () => {
    if (await confirmDialog('删除这条种子？', { danger: true })) {
      try {
        await api(`/api/content/wechat/${btn.dataset.i}`, { method: 'DELETE' });
        toast('已删除', 'success'); renderWechatView(el); refreshStatus();
      } catch (err) { toast(`删除失败：${err.message}`, 'error'); }
    }
  }));
}

/* ---- 子页 3：深度阅读 ---- */

async function renderDeepView(el) {
  el.innerHTML = '<div class="loading-state">加载中…</div>';
  const doc = await api('/api/content/deep');
  el.innerHTML = `
    <div class="card">
      <div class="card-title">深度阅读（${doc.items.length} 篇）</div>
      <div class="side-actions"><button class="btn btn-primary btn-sm" id="deepAdd">＋ 添加</button></div>
      <div class="table-wrap"><table class="evt-table">
        <thead><tr><th>标题</th><th>来源</th><th>标签</th><th>日期</th><th></th></tr></thead>
        <tbody>${doc.items.map(it => `<tr>
          <td class="evt-title"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
            ${it.summary ? `<div class="evt-orig">${esc(it.summary)}</div>` : ''}</td>
          <td>${esc(it.source || '')}</td>
          <td>${(it.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join(' ')}</td>
          <td>${esc(it.date || '')} <div class="evt-orig">${esc(it.addedBy || '')}</div></td>
          <td><button class="btn btn-sm btn-danger deep-del" data-url="${esc(it.url)}">删除</button></td>
        </tr>`).join('') || '<tr><td colspan="5"><div class="empty-state">暂无内容</div></td></tr>'}</tbody>
      </table></div>
    </div>`;

  $('#deepAdd').addEventListener('click', () => {
    openModal({
      title: '添加深度阅读',
      bodyHtml: `
        <label class="field">标题<input id="dTitle" style="width:100%"></label>
        <label class="field">url<input id="dUrl" style="width:100%"></label>
        <label class="field">来源<input id="dSource" style="width:100%"></label>
        <label class="field">标签（逗号分隔）<input id="dTags" style="width:100%"></label>
        <label class="field">摘要<textarea id="dSummary" rows="3" style="width:100%"></textarea></label>`,
      actions: [
        { label: '取消' },
        { label: '保存', primary: true, onClick: async (close) => {
            try {
              await api('/api/content/deep', { method: 'POST', body: {
                title: $('#dTitle').value.trim(), url: $('#dUrl').value.trim(),
                source: $('#dSource').value.trim(),
                tags: $('#dTags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
                summary: $('#dSummary').value.trim()
              } });
              toast('已保存', 'success'); close(undefined); renderDeepView(el); refreshStatus();
            } catch (e) { toast(`保存失败：${e.message}`, 'error'); }
          } }
      ]
    });
  });

  el.querySelectorAll('.deep-del').forEach(btn => btn.addEventListener('click', async () => {
    if (await confirmDialog('删除这篇深读？', { danger: true })) {
      try {
        await api(`/api/content/deep/${encodeURIComponent(btn.dataset.url)}`, { method: 'DELETE' });
        toast('已删除', 'success'); renderDeepView(el); refreshStatus();
      } catch (err) { toast(`删除失败：${err.message}`, 'error'); }
    }
  }));
}

/* ---- 子页 4：过滤沙箱 ---- */

async function renderSandboxView(el) {
  el.innerHTML = `
    <div class="card">
      <div class="card-title">过滤沙箱 — 试负面词会误伤谁</div>
      <p class="muted-note">输入候选负面词（逗号或换行分隔），对「今日日报（${esc(contentState.data.date)}）」与最新历史样本逐词试杀。
        大量命中正经内容 = 误伤预警；确认可用后手动加进 data/filters.json 的 negative（本页不改配置文件）。</p>
      <textarea id="sbWords" rows="3" style="width:100%" placeholder="例如：deal, percent off, 促销"></textarea>
      <div class="side-actions"><button class="btn btn-primary btn-sm" id="sbRun">试跑</button></div>
      <div id="sbResult"></div>
    </div>`;

  $('#sbRun').addEventListener('click', async () => {
    const words = $('#sbWords').value.split(/[\n,，]/).map(s => s.trim()).filter(Boolean);
    if (!words.length) { toast('请先输入候选词', 'error'); return; }
    $('#sbResult').innerHTML = '<div class="loading-state">试跑中…</div>';
    try {
      const r = await api('/api/content/sandbox', { method: 'POST', body: { words } });
      $('#sbResult').innerHTML = sandboxResult(r);
    } catch (e) {
      $('#sbResult').innerHTML = `<div class="empty-state" style="color:var(--danger)">试跑失败：${esc(e.message)}</div>`;
    }
  });
}

function sandboxResult(r) {
  const section = (title, words) => `
    <div class="sb-section"><div class="card-title">${title}</div>
    ${words.map(w => `
      <div class="sb-word ${w.killCount > 10 ? 'sb-overkill' : ''}">
        <b>${esc(w.word)}</b> — 命中 ${w.killCount} 条${w.killCount > 10 ? '（疑似过宽，慎用）' : ''}
        ${w.kills.length ? `<div class="kill-list">${w.kills.map(k =>
          `<div>· ${esc(k.title)}<span class="evt-orig">（${esc(k.source)}）</span></div>`).join('')}</div>` : ''}
      </div>`).join('')}
    </div>`;
  return section(`今日日报（${esc(r.date)}，${r.corpus.count} 条语料）`, r.words) +
    (r.sample ? section(`历史样本（${esc(r.sample.date)}，${r.sample.count} 条）`, r.sample.words) : '');
}

registerView('config', {
  title: '配置调整',
  sub: 'enums · filters · source-types …',
  async render(area) {
    area.innerHTML = '<div class="card"><div class="placeholder">配置编辑建设中（P3）</div></div>';
  }
});

registerView('analytics', {
  title: '流量监控',
  sub: '百度统计 · 文章点击量',
  async render(area) {
    area.innerHTML = '<div class="card"><div class="placeholder">流量监控建设中（P5）</div></div>';
  }
});

registerView('publish', {
  title: '发布',
  sub: '校验 · 提交 · 推送 · 触发构建',
  async render(area) {
    area.innerHTML = '<div class="card"><div class="placeholder">发布流建设中（P4）</div></div>';
  }
});

let currentView = null;

function currentRoute() {
  const h = location.hash.replace(/^#\//, '');
  return VIEWS[h] ? h : 'sources';
}

async function activateView(name) {
  if (!VIEWS[name]) name = 'sources';
  currentView = name;

  $$('.side-nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  const def = VIEWS[name];
  const area = $('#viewArea');

  document.title = `${def.title} · EnergyHub 管理后台`;
  area.innerHTML = `<div class="view-head">
      <h2>${esc(def.title)}</h2>
      ${def.sub ? `<span class="sub">${esc(def.sub)}</span>` : ''}
    </div><div id="viewBody"><div class="loading-state">加载中…</div></div>`;

  try {
    await def.render($('#viewBody'));
  } catch (e) {
    $('#viewBody').innerHTML =
      `<div class="card"><div class="empty-state" style="color:var(--danger)">加载失败：${esc(e.message)}</div></div>`;
  }
}

window.addEventListener('hashchange', () => activateView(currentRoute()));

/* ===== 启动 ===== */

refreshStatus();
statusTimer = setInterval(refreshStatus, 30000);
activateView(currentRoute());
