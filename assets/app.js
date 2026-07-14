const state = {
  sources: null,
  feeds: { daily: null, weekly: null, deep: null },
  activeTab: 'nav',
  activeCategory: null
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function loadJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function init() {
  setupTabs();

  try {
    state.sources = await loadJSON('data/sources.json');
    $('#updatedAt').textContent = state.sources.updatedAt || '未知';
    renderNav(state.sources);
  } catch (e) {
    console.error(e);
    $('#sourcesArea').innerHTML = `
      <div class="error">
        <strong>加载 sources.json 失败</strong><br>
        ${escapeHtml(e.message)}<br>
        本地预览请运行 <code>npm run preview</code>，然后用 http://localhost:5173 访问。
      </div>`;
    $('#categoryList').innerHTML = '';
  }

  try {
    [state.feeds.daily, state.feeds.weekly, state.feeds.deep] = await Promise.all([
      loadJSON('feeds/daily.json'),
      loadJSON('feeds/weekly.json'),
      loadJSON('feeds/deep.json')
    ]);
    renderFeeds();
  } catch (e) {
    console.error('加载 feeds 失败', e);
    $('#dailyList').innerHTML = renderLoadError(e);
    $('#weeklyList').innerHTML = renderLoadError(e);
    $('#deepList').innerHTML = renderLoadError(e);
  }
}

function renderLoadError(e) {
  return `
    <div class="error">
      加载失败: ${escapeHtml(e.message)}<br>
      本地预览请运行 <code>npm run preview</code>
    </div>`;
}

/* ===== 导航渲染 ===== */
function renderNav(data) {
  const catList = $('#categoryList');
  catList.innerHTML = '';

  data.categories.forEach((cat, idx) => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn' + (idx === 0 ? ' active' : '');
    btn.textContent = cat.name;
    btn.title = `${cat.sources.length} 个源`;
    btn.onclick = () => {
      state.activeCategory = cat.id;
      $$('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderCategory(cat);
    };
    catList.appendChild(btn);
  });

  if (data.categories.length) {
    state.activeCategory = data.categories[0].id;
    renderCategory(data.categories[0]);
  }
}

function renderCategory(cat) {
  const area = $('#sourcesArea');
  area.innerHTML = `
    <h2 class="cat-title">${escapeHtml(cat.name)} <small style="font-size:0.7em;color:var(--text-secondary)">(${cat.sources.length} 个源)</small></h2>
    <div class="source-grid"></div>
  `;
  const grid = area.querySelector('.source-grid');

  cat.sources.forEach(src => {
    const card = document.createElement('a');
    card.className = 'source-card';
    card.href = src.url;
    card.target = '_blank';
    card.rel = 'noopener';
    card.innerHTML = `
      <div class="source-header">
        <span class="source-name">${escapeHtml(src.name)}</span>
        <span class="region-badge ${src.region}">${src.region === 'cn' ? 'CN' : 'Global'}</span>
      </div>
      <p class="source-desc">${escapeHtml(src.desc)}</p>
      <div class="source-tags">${src.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
      ${src.rss ? '<span class="rss-dot" title="已配置 RSS，会自动抓取">●</span>' : ''}
    `;
    grid.appendChild(card);
  });
}

/* ===== Feed 渲染 ===== */
function renderFeeds() {
  const d = state.feeds.daily;
  if (d) {
    $('#dailyDate').textContent = d.date ? `(${d.date})` : '';
    $('#dailyList').innerHTML = renderFeedItems(d.items, 'daily');
  }

  const w = state.feeds.weekly;
  if (w) {
    $('#weeklyRange').textContent = w.dateRange ? `(${w.dateRange})` : (w.week ? `(${w.week})` : '');
    $('#weeklyList').innerHTML = renderFeedItems(w.items, 'weekly');
  }

  const deep = state.feeds.deep;
  if (deep) {
    $('#deepList').innerHTML = deep.items && deep.items.length
      ? deep.items.map(item => renderDeepCard(item)).join('')
      : `<div class="empty">${escapeHtml(deep.note || '暂无深研内容，请在 feeds/deep.json 中填充。')}</div>`;
  }
}

function renderFeedItems(items, mode) {
  if (!items || !items.length) {
    return '<div class="empty">暂无内容，等待首次 RSS 抓取（本地可运行 npm run fetch:daily 测试）。</div>';
  }
  return items.map(item => `
    <article class="feed-item">
      <div class="feed-meta">
        <span class="feed-source">${escapeHtml(item.source || item.sourceName || '未知来源')}</span>
        <span class="feed-date">${escapeHtml(formatDate(item.pubDate || item.date || item.isoDate))}</span>
      </div>
      <h3><a href="${escapeHtml(item.link || item.url || '#')}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3>
      ${item.summary || item.contentSnippet ? `<p class="feed-summary">${escapeHtml(truncate(item.summary || item.contentSnippet, 220))}</p>` : ''}
    </article>
  `).join('');
}

function renderDeepCard(item) {
  return `
    <article class="feed-item deep-item">
      <div class="feed-meta">
        <span class="feed-source">${escapeHtml(item.source || '深研')}</span>
        <span class="feed-date">${escapeHtml(item.date || '')}</span>
      </div>
      <h3><a href="${escapeHtml(item.url || item.link || '#')}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3>
      ${item.summary ? `<p class="feed-summary">${escapeHtml(item.summary)}</p>` : ''}
      ${item.tags && item.tags.length ? `<div class="source-tags">${item.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    </article>
  `;
}

/* ===== Tabs ===== */
function setupTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`#${tab}`).classList.add('active');
      state.activeTab = tab;
    });
  });
}

/* ===== 工具函数 ===== */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

function formatDate(d) {
  if (!d) return '';
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return d;
  }
}

init();
