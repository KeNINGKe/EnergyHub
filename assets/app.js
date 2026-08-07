const state = {
  sources: null,
  enums: null,
  featured: null,
  dataSource: null,     // daily-v2 (V2) 或 daily (V1) 的整份数据
  allEvents: [],        // 全部动态列表（V2 事件优先，V1 条目降级）
  isV2: false,
  eventMap: null,       // Map<id|url, event>
  byTitle: null,        // Map<title, event>
  topicMap: {},
  impactMap: {},
  sourceTypeMap: {},
  dataDate: '',
  dataGeneratedAt: null,
  stale: false,
  activeTab: null,
  activeCategory: null,
};

const VALID_TABS = ['featured', 'all', 'sources'];

const FALLBACK_TOPICS = {
  'data-center-power': '数据中心电力需求',
  'aidc-project': 'AIDC 项目与区域布局',
  'grid': '电网与并网',
  'energy-storage': '储能',
  'solar-wind': '光伏与风电',
  'nuclear-smr': '核电与 SMR',
  'gas-backup': '天然气与备用电源',
  'cooling-pue': '冷却、UPS 与 PUE',
  'ppa-green-power': '绿电采购与 PPA',
  'power-market-policy': '电力市场与政策',
  'chips-compute': '芯片、服务器与算力基础设施',
  'other-energy': '其他能源动态'
};
const FALLBACK_IMPACTS = { positive: '利好', negative: '利空', neutral: '中性', watch: '待观察', unknown: '未知' };
const FALLBACK_SOURCE_TYPES = { primary: '一手来源', media: '媒体', research: '研究机构', community: '社区/KOL' };
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/* 优先级：储能 / AIDC 为最高（其中北美最优先），发电为次级 */
const PRIORITY_TOPICS = {
  'energy-storage': '储能',
  'aidc-project': 'AIDC'
};
const PRIORITY_SECONDARY_TOPICS = {
  'gas-backup': '发电',
  'nuclear-smr': '发电'
};
const PRIORITY_KEYWORDS = [
  { re: /燃气轮机|燃气发电|燃气机组|燃气联合循环|gas\s*turbine|turbine/i, label: '发电' },
  { re: /\bPCS\b|储能变流器|变流器/i, label: '发电' },
  { re: /\bSST\b|固态变压器|solid\s*state\s*transformer/i, label: '发电' }
];

/* 北美判定：region 字段为 美国 / 加拿大（含北美/usa/canada） */
function isNorthAmerica(ev) {
  const r = (ev && ev.region) || '';
  return /美国|加拿大|北美|USA|Canada|\bUS\b/i.test(r);
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function loadJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/* ===== Hash 路由（C-02） ===== */
function normalizeTab(h) {
  const s = String(h || '').replace(/^#/, '').trim().toLowerCase().replace(/\/$/, '');
  return VALID_TABS.includes(s) ? s : 'featured';
}

function activateTab(tab) {
  state.activeTab = tab;
  $$('.view-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === tab));
  if (location.hash !== '#' + tab) {
    history.replaceState(null, '', '#' + tab);
  }
}

function onHashChange() {
  activateTab(normalizeTab(location.hash));
}

function setupTabs() {
  $$('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      location.hash = '#' + btn.dataset.tab;
    });
  });
}

/* ===== 数据加载层 ===== */
function labelMap(arr) {
  const m = {};
  (arr || []).forEach(x => { if (x && x.id) m[x.id] = x.label; });
  return m;
}

function getTopicLabel(id) { return state.topicMap[id] || FALLBACK_TOPICS[id] || id; }
function getImpactLabel(id) { return state.impactMap[id] || FALLBACK_IMPACTS[id] || id; }
function getSourceTypeLabel(id) { return state.sourceTypeMap[id] || FALLBACK_SOURCE_TYPES[id] || id; }

async function loadData() {
  const [sources, enums, featured, dailyV2, dailyV1] = await Promise.allSettled([
    loadJSON('data/sources.json'),
    loadJSON('data/enums.json'),
    loadJSON('feeds/featured.json'),
    loadJSON('feeds/daily-v2.json'),
    loadJSON('feeds/daily.json')
  ]);

  state.sources = sources.status === 'fulfilled' ? sources.value : null;
  state.enums = enums.status === 'fulfilled' ? enums.value : null;
  state.featured = featured.status === 'fulfilled' ? featured.value : null;

  state.topicMap = labelMap(state.enums && state.enums.topics);
  state.impactMap = labelMap(state.enums && state.enums.impacts);
  state.sourceTypeMap = labelMap(state.enums && state.enums.sourceTypes);

  const v2 = (dailyV2.status === 'fulfilled' && dailyV2.value && dailyV2.value.schemaVersion === 2 && Array.isArray(dailyV2.value.items))
    ? dailyV2.value : null;
  const v1 = (dailyV1.status === 'fulfilled' && dailyV1.value && Array.isArray(dailyV1.value.items))
    ? dailyV1.value : null;

  state.isV2 = !!v2;
  state.dataSource = v2 || v1 || null;
  state.allEvents = state.dataSource ? state.dataSource.items : [];
  state.dataDate = (state.dataSource && state.dataSource.date) || (state.featured && state.featured.date) || '';
  state.dataGeneratedAt = (state.dataSource && state.dataSource.generatedAt) || (state.featured && state.featured.generatedAt) || null;
  state.stale = isDataStale(state.dataGeneratedAt);

  // 事件索引：V2 用 id，V1 用 url/link
  state.eventMap = new Map();
  state.byTitle = new Map();
  for (const it of state.allEvents) {
    const key = it.id || it.url || it.link;
    if (key && !state.eventMap.has(key)) state.eventMap.set(key, it);
    if (it.title && !state.byTitle.has(it.title)) state.byTitle.set(it.title, it);
  }
}

function isDataStale(iso) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return false;
  return (Date.now() - t) > 24 * 3600 * 1000;
}

/* ===== 信息源页 ===== */
function renderSources() {
  const catList = $('#categoryList');
  if (!state.sources) {
    catList.innerHTML = '';
    $('#sourcesArea').innerHTML = renderError(
      '加载 sources.json 失败',
      '本地预览请运行 python -m http.server 5173，然后访问 http://localhost:5173'
    );
    return;
  }
  renderNav(state.sources);
}

function renderNav(data) {
  const catList = $('#categoryList');
  catList.innerHTML = '';

  const cats = (data.categories || [])
    .map(cat => ({ cat, sources: cat.sources || [] }))
    .filter(x => x.sources.length > 0);

  cats.forEach(({ cat, sources }, idx) => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn' + (idx === 0 ? ' active' : '');
    btn.innerHTML = `
      <span>${escapeHtml(cat.name)}</span>
      <span class="cat-count">${sources.length}</span>
    `;
    btn.onclick = () => {
      state.activeCategory = cat.id;
      $$('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderCategory(cat);
    };
    catList.appendChild(btn);
  });

  if (cats.length) {
    state.activeCategory = cats[0].cat.id;
    renderCategory(cats[0].cat);
  } else {
    $('#sourcesArea').innerHTML = '<div class="loading-state">该筛选下暂无来源</div>';
  }
}

function renderCategory(cat) {
  const sources = cat.sources || [];
  const area = $('#sourcesArea');
  area.innerHTML = `
    <h2 class="section-title">${escapeHtml(cat.name)} <small>${sources.length}</small></h2>
    <div class="source-grid"></div>
  `;
  const grid = area.querySelector('.source-grid');

  sources.forEach(src => {
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
      ? '<span class="wechat-note">无公开链接 · 搜索访问</span>'
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

/* ===== 优先级判定（储能/AIDC 最高，其中北美最优先；发电次级） ===== */
function getPriority(ev) {
  const topic = ev && ev.topic;
  let label = '';
  let tier = 2;                 // 0=储能/AIDC，1=发电，2=其他
  if (topic && PRIORITY_TOPICS[topic]) {
    label = PRIORITY_TOPICS[topic];
    tier = 0;
  } else if (topic && PRIORITY_SECONDARY_TOPICS[topic]) {
    label = PRIORITY_SECONDARY_TOPICS[topic];
    tier = 1;
  } else {
    const hay = [ev.title, ev.originalTitle, ev.summary, (ev.entities || []).join(' ')]
      .filter(Boolean).join(' ');
    for (const k of PRIORITY_KEYWORDS) {
      if (k.re.test(hay)) { label = k.label; tier = 1; break; }
    }
  }
  // 储能/AIDC 且北美 → rank 0（最优先）；储能/AIDC 非北美 → rank 1；发电 → 2；其他 → 3
  const na = tier === 0 && isNorthAmerica(ev);
  const rank = na ? 0 : (tier === 0 ? 1 : (tier === 1 ? 2 : 3));
  return { rank, label: na ? `${label}·北美` : label, tier };
}

/* 核电判定：topic 或标题/摘要含核电关键词（不进今日热点） */
function isNuclear(ev) {
  if (!ev) return false;
  if (ev.topic === 'nuclear-smr') return true;
  const hay = [ev.title, ev.originalTitle, ev.summary, (ev.entities || []).join(' ')]
    .filter(Boolean).join(' ');
  return /核电|核电站|核反应堆|核电机组|小型模块化反应堆|\bSMR\b|nuclear/i.test(hay);
}

/* 今日热点候选：仅储能 / AIDC（北美 rank 0 优先，再按推荐分） */
function priorityEvents(events) {
  return (events || [])
    .map(ev => ({ ev, p: getPriority(ev) }))
    .filter(x => x.p.tier === 0 && !isNuclear(x.ev))
    .sort((a, b) => {
      if (a.p.rank !== b.p.rank) return a.p.rank - b.p.rank;
      return (b.ev.importance || 0) - (a.ev.importance || 0);
    })
    .map(x => x.ev);
}

function formatScore(imp) {
  const s = Math.round((imp || 0) * 20);
  return Math.min(100, Math.max(0, s));
}

/* ===== 时间线排布（参考 aihot.virxact.com，保留本站视觉） ===== */
function sortForTimeline(events) {
  return [...(events || [])].sort((a, b) => {
    const pa = getPriority(a).rank;
    const pb = getPriority(b).rank;
    if (pa !== pb) return pa - pb;
    const ta = new Date(a.publishedAt || a.pubDate || a.isoDate || a.date).getTime() || 0;
    const tb = new Date(b.publishedAt || b.pubDate || b.isoDate || b.date).getTime() || 0;
    if (tb !== ta) return tb - ta;
    return (b.importance || 0) - (a.importance || 0);
  });
}

/* 全部动态：纯时间倒序（最新在前），与精选的优先级序区分开 */
function sortChronological(events) {
  return [...(events || [])].sort((a, b) => {
    const ta = new Date(a.publishedAt || a.pubDate || a.isoDate || a.date).getTime() || 0;
    const tb = new Date(b.publishedAt || b.pubDate || b.isoDate || b.date).getTime() || 0;
    if (tb !== ta) return tb - ta;
    return (b.importance || 0) - (a.importance || 0);
  });
}

function groupByDay(sortedEvents) {
  const groups = new Map();
  for (const ev of sortedEvents) {
    const t = new Date(ev.publishedAt || ev.pubDate || ev.isoDate || ev.date);
    if (isNaN(t.getTime())) continue;
    const key = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}`;
    if (!groups.has(key)) groups.set(key, { date: t, items: [] });
    groups.get(key).items.push(ev);
  }
  return [...groups.values()];
}

function renderTimeline(events, featuredIds, sorter = sortForTimeline) {
  const groups = groupByDay(sorter(events));
  if (!groups.length) return '';
  return groups.map(g => {
    const d = g.date;
    const items = g.items.map(ev =>
      renderTimelineItem(ev, featuredIds && featuredIds.has(ev.id))).join('');
    return `
    <section class="timeline-day">
      <div class="timeline-day-head">
        <h2 class="timeline-date">${d.getMonth() + 1}月${d.getDate()}日</h2>
        <div class="timeline-day-meta">${WEEKDAYS[d.getDay()]} · ${g.items.length} 条</div>
      </div>
      <div class="timeline-day-items">${items}</div>
    </section>`;
  }).join('');
}

function renderTimelineItem(ev, isFeatured) {
  const srcName = typeof ev.source === 'string' ? ev.source
    : (ev.source && ev.source.name) || '未知来源';
  const url = ev.url || ev.link || '#';
  const title = ev.title || ev.translatedTitle || '';
  const t = new Date(ev.publishedAt || ev.pubDate || ev.isoDate || ev.date);
  const time = isNaN(t.getTime()) ? ''
    : t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

  const p = getPriority(ev);
  const badges = [];
  if (isFeatured) badges.push('<span class="timeline-selected-badge">精选</span>');
  if (ev.wechat) badges.push('<span class="timeline-wechat-badge">公众号</span>');
  if (p.tier === 0) badges.push(`<span class="timeline-priority-badge">${escapeHtml(p.label)}</span>`);
  const topicBadge = ev.topic
    ? `<span class="timeline-topic-badge">${escapeHtml(getTopicLabel(ev.topic))}</span>` : '';

  const score = formatScore(ev.importance);
  const scoreCls = score >= 80 ? 'score-high' : (score >= 60 ? 'score-mid' : 'score-low');

  const related = (ev.relatedSources || []).filter(r => r && r.name && r.url);
  const dupHtml = related.length
    ? `<span class="timeline-dup-count">另有 ${related.length} 家信源报道</span>` : '';
  const summary = ev.summary || ev.contentSnippet || '';
  const summaryHtml = summary ? `<p class="timeline-summary">${escapeHtml(truncate(summary, 200))}</p>` : '';
  const reasonHtml = ev.whyItMatters
    ? `<div class="timeline-reason"><span class="timeline-reason-label">推荐理由：</span>${escapeHtml(ev.whyItMatters)}</div>` : '';
  const originalHtml = ev.originalTitle && ev.originalTitle !== title
    ? `<p class="feed-original-title">${escapeHtml(ev.originalTitle)}</p>` : '';

  return `
    <div class="timeline-item">
      <div class="timeline-time">${time}</div>
      <div class="timeline-rail" aria-hidden="true"><span class="timeline-dot"></span></div>
      <article class="timeline-card">
        <div class="timeline-card-head">
          <div class="timeline-head-left">${topicBadge}<span class="timeline-source">${escapeHtml(srcName)}</span>${badges.join('')}</div>
          <div class="timeline-head-right"><span class="timeline-score ${scoreCls}" title="推荐分">${score}</span></div>
        </div>
        <h3 class="timeline-title"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(title)}</a></h3>
        ${originalHtml}
        ${summaryHtml}
        ${dupHtml}
        ${reasonHtml}
      </article>
    </div>`;
}

/* ===== 今日热点榜 ===== */
function renderHotList(events) {
  const top = priorityEvents(events).slice(0, 5);
  if (!top.length) return '';
  return top.map((ev, i) => `
      <li class="hot-card-item">
        <span class="hot-rank">${i + 1}</span>
        <a class="hot-title" href="${escapeHtml(ev.url || ev.link || '#')}" target="_blank" rel="noopener">${escapeHtml(ev.title || ev.translatedTitle || '')}</a>
        <span class="hot-score">${formatScore(ev.importance)}</span>
      </li>`).join('');
}

/* ===== 微信公众号区块 ===== */
function renderWechatBlock() {
  const block = $('#wechatBlock');
  if (!block) return;
  const wechatEvents = state.allEvents.filter(ev => ev.wechat === true);
  if (!wechatEvents.length) {
    block.hidden = true;
    return;
  }
  $('#wechatList').innerHTML = wechatEvents.map(renderWechatCard).join('');
  block.hidden = false;
}

function renderWechatCard(ev) {
  const url = ev.url || ev.link || '#';
  const t = new Date(ev.publishedAt || ev.pubDate || ev.isoDate || ev.date);
  const valid = !isNaN(t.getTime());
  const dateStr = valid ? `${t.getMonth() + 1}月${t.getDate()}日` : '';
  const time = valid ? t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const src = typeof ev.source === 'string' ? ev.source : (ev.source && ev.source.name) || '微信公众号';
  const topic = ev.topic ? getTopicLabel(ev.topic) : '';
  const summary = ev.summary ? `<p class="wechat-card-summary">${escapeHtml(truncate(ev.summary, 140))}</p>` : '';
  return `
      <li class="wechat-card">
        <a class="wechat-card-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(ev.title || ev.translatedTitle || '')}</a>
        <div class="wechat-card-meta">
          <span class="wechat-card-src">${escapeHtml(src)}</span>
          ${topic ? `<span class="wechat-card-topic">${escapeHtml(topic)}</span>` : ''}
          ${dateStr ? `<span class="wechat-card-time">${dateStr}${time ? ' ' + time : ''}</span>` : ''}
          <span class="wechat-card-score">${formatScore(ev.importance)}</span>
        </div>
        ${summary}
      </li>`;
}

/* ===== 精选页（C-03 ~ C-08） ===== */
function renderFeatured() {
  const meta = $('#featuredMeta');
  let parts = [];
  if (state.dataDate) parts.push(`数据日期 ${state.dataDate}`);
  if (state.dataGeneratedAt) parts.push(`更新于 ${formatTime(state.dataGeneratedAt)}`);
  meta.innerHTML = escapeHtml(parts.join(' · ')) + (state.stale ? ' <span class="stale-badge">数据已过期</span>' : '');

  // 今日热点榜：储能 / AIDC（北美 rank 0 优先）中推荐分最高的前 5
  const hotBlock = $('#hotListBlock');
  const hotHtml = renderHotList(state.allEvents);
  if (hotHtml) {
    hotBlock.hidden = false;
    $('#hotList').innerHTML = hotHtml;
  } else {
    hotBlock.hidden = true;
  }

  // 微信公众号区块：当日数据里所有微信文章单独列出，避免被埋没
  renderWechatBlock();

  const timelineEl = $('#featuredTimeline');
  const featuredIds = new Set(state.featured ? (state.featured.featuredEventIds || []) : []);
  // 精选页只展示每日精选的条目（featuredEventIds）；微信文章已在公众号区块展示，这里排除避免重复
  const featuredEvents = state.allEvents.filter(ev => featuredIds.has(ev.id) && !ev.wechat);
  if (featuredEvents.length) {
    timelineEl.innerHTML = renderTimeline(featuredEvents, featuredIds);
  } else {
    timelineEl.innerHTML = renderEmpty(
      (state.dataDate ? state.dataDate + ' ' : '') + '今日暂无精选内容。'
    );
  }

  $('#featuredViewAll').innerHTML = state.allEvents.length
    ? `<a href="#all" class="view-all-link">查看全部 ${state.allEvents.length} 条动态 →</a>`
    : '';
}

/* ===== 全部动态（C-01 支撑，V2 优先 / V1 降级） ===== */
function renderAll() {
  const meta = $('#allMeta');
  if (!state.allEvents.length) {
    meta.textContent = state.dataDate ? `${state.dataDate} · 暂无数据` : '';
    $('#allTimeline').innerHTML = renderEmpty('暂无动态数据。');
    return;
  }
  const src = state.dataSource;
  if (state.isV2 && src.stats) {
    const s = src.stats;
    meta.textContent = `${state.dataDate} · ${s.sourcesSucceeded}/${s.sourcesTotal} 来源 · ${s.articlesFetched} 条原始 · ${s.eventsPublished} 个事件`;
  } else {
    meta.textContent = `${state.dataDate} · ${state.allEvents.length} 条`;
  }
  $('#allTimeline').innerHTML = renderTimeline(state.allEvents, null, sortChronological);
}

/* ===== Footer ===== */
function renderFooter() {
  if (state.dataGeneratedAt) {
    $('#updatedAt').textContent = `数据更新于 ${formatDate(state.dataGeneratedAt)}`;
  } else if (state.sources && state.sources.updatedAt) {
    $('#updatedAt').textContent = `Updated ${state.sources.updatedAt}`;
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

function formatTime(d) {
  if (!d) return '';
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return d;
  }
}

/* ===== Init ===== */
async function init() {
  setupTabs();
  window.addEventListener('hashchange', onHashChange);
  activateTab(normalizeTab(location.hash));

  await loadData();
  renderSources();
  renderFeatured();
  renderAll();
  renderFooter();
}

init();
