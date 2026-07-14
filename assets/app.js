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
  setupWaveform();

  try {
    state.sources = await loadJSON('data/sources.json');
    $('#updatedAt').textContent = state.sources.updatedAt || '未知';
    renderNav(state.sources);
    animateStats(state.sources);
  } catch (e) {
    console.error(e);
    $('#sourcesArea').innerHTML = renderError(
      `加载 sources.json 失败: ${e.message}`,
      '本地预览请运行 python3 -m http.server 5173，然后访问 http://localhost:5173'
    );
    $('#categoryList').innerHTML = '';
  }

  try {
    [state.feeds.daily, state.feeds.weekly, state.feeds.deep] = await Promise.all([
      loadJSON('feeds/daily.json'),
      loadJSON('feeds/weekly.json'),
      loadJSON('feeds/deep.json')
    ]);
    renderFeeds();
    updateTodayStat();
  } catch (e) {
    console.error('加载 feeds 失败', e);
    $('#dailyList').innerHTML = renderError(e.message, '请确认 feeds/ 目录下 JSON 文件存在。');
    $('#weeklyList').innerHTML = renderError(e.message);
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
    <h2 class="section-title">${escapeHtml(cat.name)} <small>${cat.sources.length} SOURCES</small></h2>
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
      <div class="source-footer">
        <div class="source-tags">${src.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>
        <span class="signal-lamp ${src.rss ? 'live' : ''}" title="${src.rss ? '已接入 RSS 自动抓取' : '暂无 RSS，仅导航'}"></span>
      </div>
    `;
    grid.appendChild(card);
  });
}

/* ===== Stats ===== */
function animateStats(data) {
  const rssCount = data.categories.reduce((sum, cat) =>
    sum + cat.sources.filter(s => s.rss).length, 0);
  const totalCount = data.categories.reduce((sum, cat) => sum + cat.sources.length, 0);

  countUp('statSources', totalCount, 800);
  countUp('statRSS', rssCount, 1000);
}

function updateTodayStat() {
  const daily = state.feeds.daily;
  if (daily && typeof daily.count === 'number') {
    countUp('statToday', daily.count, 1200);
  }
}

function countUp(id, target, duration) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = 0;
  const startTime = performance.now();

  function step(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.floor(start + (target - start) * ease).toString();
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ===== Feeds ===== */
function renderFeeds() {
  const d = state.feeds.daily;
  if (d) {
    $('#dailyMeta').innerHTML = `MODE: DAILY · DATE: ${escapeHtml(d.date)} · SOURCES: ${d.successSources}/${d.totalSources} · ITEMS: ${d.count}`;
    $('#dailyList').innerHTML = d.items.length
      ? d.items.map(item => renderFeedItem(item)).join('')
      : renderEmpty('暂无日报内容，运行 npm run fetch:daily 生成。');
  }

  const w = state.feeds.weekly;
  if (w) {
    $('#weeklyMeta').innerHTML = `MODE: WEEKLY · RANGE: ${escapeHtml(w.dateRange || w.week)} · SOURCES: ${w.successSources}/${w.totalSources} · ITEMS: ${w.count}`;
    $('#weeklyList').innerHTML = w.items.length
      ? w.items.map(item => renderFeedItem(item)).join('')
      : renderEmpty('暂无周报内容。');
  }

  const deep = state.feeds.deep;
  if (deep) {
    $('#deepMeta').innerHTML = `MODE: DEEP · UPDATED: ${escapeHtml(deep.updatedAt || '-')}`;
    $('#deepList').innerHTML = deep.items && deep.items.length
      ? deep.items.map(item => renderDeepItem(item)).join('')
      : renderEmpty(deep.note || '暂无深研内容，请在 feeds/deep.json 中填充。');
  }
}

function renderFeedItem(item) {
  return `
    <article class="feed-item">
      <div class="feed-top">
        <span class="feed-source">${escapeHtml(item.source || '未知来源')}</span>
        <span class="feed-date">${escapeHtml(formatDate(item.pubDate || item.date || item.isoDate))}</span>
      </div>
      <h3><a href="${escapeHtml(item.link || item.url || '#')}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3>
      ${item.summary || item.contentSnippet ? `<p class="feed-summary">${escapeHtml(truncate(item.summary || item.contentSnippet, 240))}</p>` : ''}
    </article>
  `;
}

function renderDeepItem(item) {
  return `
    <article class="feed-item deep-item">
      <div class="feed-top">
        <span class="feed-source">${escapeHtml(item.source || '深研')}</span>
        <span class="feed-date">${escapeHtml(item.date || '')}</span>
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

/* ===== Signature waveform ===== */
function setupWaveform() {
  const path = $('.wave-path');
  if (!path) return;

  const width = 1200;
  const height = 120;
  const segments = 80;
  const step = width / segments;

  function generatePath() {
    let d = `M 0 ${height / 2}`;
    for (let i = 1; i <= segments; i++) {
      const x = i * step;
      const noise = Math.sin(i * 0.4) * 15 + Math.sin(i * 0.9) * 8 + Math.sin(i * 1.7) * 5;
      const y = height / 2 + noise + (Math.random() - 0.5) * 8;
      d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d;
  }

  // Initial draw
  path.setAttribute('d', generatePath());

  // Slowly morph the wave every few seconds for ambient life
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setInterval(() => {
      path.setAttribute('d', generatePath());
    }, 4200);
  }
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
  return `<div class="empty-state">${escapeHtml(message)}</div>
  `;
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
