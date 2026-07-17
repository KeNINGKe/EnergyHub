const state = {
  sources: null,
  feeds: { daily: null, deep: null },
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
    $('#updatedAt').textContent = `Updated ${state.sources.updatedAt || '—'}`;
    renderNav(state.sources);
  } catch (e) {
    console.error(e);
    $('#sourcesArea').innerHTML = renderError(
      `加载 sources.json 失败: ${e.message}`,
      '本地预览请运行 python3 -m http.server 5173，然后访问 http://localhost:5173'
    );
    $('#categoryList').innerHTML = '';
  }

  try {
    [state.feeds.daily, state.feeds.deep] = await Promise.all([
      loadJSON('feeds/daily.json'),
      loadJSON('feeds/deep.json')
    ]);
    renderFeeds();
    if (state.feeds.daily && state.feeds.daily.generatedAt) {
      $('#updatedAt').textContent = `数据更新于 ${formatDate(state.feeds.daily.generatedAt)}`;
    }
  } catch (e) {
    console.error('加载 feeds 失败', e);
    $('#dailyList').innerHTML = renderError(e.message, '请确认 feeds/daily.json 存在，运行 npm run fetch 生成。');
    $('#deepList').innerHTML = renderError(e.message);
  }
}

/* ===== Navigation ===== */
function renderNav(data) {
  const catList = $('#categoryList');
  catList.innerHTML = '';

  data.categories.forEach((cat, idx) => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn' + (idx === 0 ? ' active' : '');
    btn.innerHTML = `
      <span>${escapeHtml(cat.name)}</span>
      <span class="cat-count">${cat.sources.length}</span>
    `;
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
    <h2 class="section-title">${escapeHtml(cat.name)} <small>${cat.sources.length}</small></h2>
    <div class="source-grid"></div>
  `;
  const grid = area.querySelector('.source-grid');

  cat.sources.forEach(src => {
    const hasLink = !!src.url;
    const card = document.createElement(hasLink ? 'a' : 'div');
    card.className = 'source-card' + (hasLink ? '' : ' source-card--static');
    if (hasLink) {
      card.href = src.url;
      card.target = '_blank';
      card.rel = 'noopener';
    }
    const tagsHtml = (src.tags || []).map(t => {
      const cls = t === '翻墙' ? 'tag tag--gfw' : 'tag';
      return `<span class="${cls}">${escapeHtml(t)}</span>`;
    }).join('');
    const note = !hasLink
      ? '<span class="wechat-note">微信公众号 · 搜索访问</span>'
      : (src.rss ? '<span class="rss-note">RSS</span>' : '');
    card.innerHTML = `
      <div class="source-header">
        <span class="source-name">${escapeHtml(src.name)}</span>
        <span class="region-badge">${src.region === 'cn' ? 'CN' : 'Global'}</span>
      </div>
      <p class="source-desc">${escapeHtml(src.desc)}</p>
      <div class="source-footer">
        <div class="source-tags">${tagsHtml}</div>
        ${note}
      </div>
    `;
    grid.appendChild(card);
  });
}

/* ===== Feeds ===== */
function renderFeeds() {
  const d = state.feeds.daily;
  if (d) {
    $('#dailyMeta').textContent = `${d.date} · ${d.successSources}/${d.totalSources} 来源 · ${d.count} 条`;
    $('#dailyList').innerHTML = d.items.length
      ? d.items.map(item => renderFeedItem(item)).join('')
      : renderEmpty('暂无日报内容，运行 npm run fetch:daily 生成。');
  }

  const deep = state.feeds.deep;
  if (deep) {
    $('#deepMeta').textContent = `Updated ${deep.updatedAt || '—'}`;
    $('#deepList').innerHTML = deep.items && deep.items.length
      ? deep.items.map(item => renderDeepItem(item)).join('')
      : renderEmpty(deep.note || '暂无深研内容，请在 feeds/deep.json 中填充。');
  }
}

function renderFeedItem(item) {
  return `
    <article class="feed-item">
      <div class="feed-meta">
        <span>${escapeHtml(item.source || '未知来源')}</span>
        <span>${escapeHtml(formatDate(item.pubDate || item.date || item.isoDate))}</span>
      </div>
      <h3><a href="${escapeHtml(item.link || item.url || '#')}" target="_blank" rel="noopener">${escapeHtml(item.translatedTitle || item.title)}</a></h3>
      ${item.translatedTitle ? `<p class="feed-original-title">${escapeHtml(item.title)}</p>` : ''}
      ${item.summary || item.contentSnippet ? `<p class="feed-summary">${escapeHtml(truncate(item.summary || item.contentSnippet, 240))}</p>` : ''}
    </article>
  `;
}

function renderDeepItem(item) {
  return `
    <article class="feed-item">
      <div class="feed-meta">
        <span>${escapeHtml(item.source || '深研')}</span>
        <span>${escapeHtml(item.date || '')}</span>
      </div>
      <h3><a href="${escapeHtml(item.url || item.link || '#')}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3>
      ${item.summary ? `<p class="feed-summary">${escapeHtml(item.summary)}</p>` : ''}
      ${item.tags && item.tags.length ? `<div class="source-tags" style="margin-top:12px">${item.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    </article>
  `;
}

/* ===== Tabs ===== */
function setupTabs() {
  $$('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      $$('.view-tab').forEach(b => b.classList.remove('active'));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`#${tab}`).classList.add('active');
      state.activeTab = tab;
    });
  });
}

/* ===== Utilities ===== */
function renderError(title, hint) {
  return `
    <div class="error-state">
      <strong>${escapeHtml(title)}</strong><br>
      ${hint ? escapeHtml(hint) : ''}
    </div>
  `;
}

function renderEmpty(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

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
