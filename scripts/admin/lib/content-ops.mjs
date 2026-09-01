/**
 * 内容运营纯函数层（管理后台 P1）。
 *
 * 全部为无副作用函数（返回新对象，不改入参），供 api/content.mjs 与单测复用：
 * - applyOverrideOp   对「今日 config + 全局黑名单」施加一个操作，返回新状态
 * - scanStale         扫描全部覆盖里引用已失效 id 的条目（发布阻断项预警）
 * - pruneOld          清理超过保留期的 byDate 配置
 * - buildTodayPayload 组装内容运营页所需的今日数据
 *
 * 协议见 docs/DATA_PROTOCOL.md §4 与 scripts/lib/overrides.mjs 头注释。
 * 全局黑名单 overrides.globalHiddenIds：文章级永久隐藏（事件 id 是 URL 稳定哈希）。
 */

/** 今日配置里引用事件 id 的字段（值为字符串数组）。 */
const ID_LIST_FIELDS = ['forcedFeaturedIds', 'unfeaturedIds', 'hotEventIds'];
/** 今日配置里 {id: 值} 映射字段。 */
const MAP_FIELDS = ['topics', 'impacts', 'summaries', 'whyItMatters'];

function ensureArr(v) {
  return Array.isArray(v) ? v : [];
}

function newConfig() {
  return { schemaVersion: 1, byDate: {} };
}

/** 取（或创建）某日期的配置对象。 */
function dateConfig(overrides, date, create = false) {
  if (!overrides.byDate || typeof overrides.byDate !== 'object') {
    if (!create) return null;
    overrides.byDate = {};
  }
  let conf = overrides.byDate[date];
  if (!conf || typeof conf !== 'object') {
    if (!create) return null;
    conf = {};
    overrides.byDate[date] = conf;
  }
  return conf;
}

/** 数组去重追加；追加后为操作字段的回调钩子（如互斥清理）。 */
function togglePush(arr, id) {
  if (arr.includes(id)) {
    return arr.filter(x => x !== id);
  }
  arr.push(id);
  return arr;
}

/** 删掉对象里值为空数组的字段（保持文件干净）。 */
function dropEmptyArrayFields(conf, fields) {
  for (const f of fields) {
    if (Array.isArray(conf[f]) && conf[f].length === 0) delete conf[f];
  }
}

/**
 * 施加一个覆盖操作。
 * @param {object} overrides 完整 overrides 对象（会被浅克隆后修改）
 * @param {string[]} globalIds 全局黑名单
 * @param {string} date 今日日期（byDate 键）
 * @param {object} op {op, id?, value?, index?}
 * @returns {{config: object, globalIds: string[]}}
 */
export function applyOverrideOp(overrides, globalIds, date, op) {
  const config = JSON.parse(JSON.stringify(overrides || newConfig()));
  config.schemaVersion = 1;
  if (!config.byDate || typeof config.byDate !== 'object') config.byDate = {};
  let ids = [...ensureArr(globalIds)];

  const conf = dateConfig(config, date, true);

  switch (op.op) {
    case 'forceFeature': {
      conf.forcedFeaturedIds = togglePush(ensureArr(conf.forcedFeaturedIds), op.id);
      // 与取消精选互斥：强制精选时撤掉取消标记
      if (conf.forcedFeaturedIds.includes(op.id)) {
        conf.unfeaturedIds = ensureArr(conf.unfeaturedIds).filter(x => x !== op.id);
      }
      break;
    }
    case 'unfeature': {
      conf.unfeaturedIds = togglePush(ensureArr(conf.unfeaturedIds), op.id);
      if (conf.unfeaturedIds.includes(op.id)) {
        conf.forcedFeaturedIds = ensureArr(conf.forcedFeaturedIds).filter(x => x !== op.id);
      }
      break;
    }
    case 'hide': {
      if (!ids.includes(op.id)) ids.push(op.id);
      // 该 id 已由全局黑名单接管：同步清掉今日配置里的引用——构建时全局先删事件，
      // 今日 forced/hot/map 字段若仍引用它会升级为阻断性错误，堵死部署校验
      for (const f of ID_LIST_FIELDS) {
        if (Array.isArray(conf[f])) conf[f] = conf[f].filter(x => x !== op.id);
      }
      for (const f of MAP_FIELDS) {
        if (conf[f] && typeof conf[f] === 'object') delete conf[f][op.id];
      }
      if (Array.isArray(conf.mergeGroups)) {
        conf.mergeGroups = conf.mergeGroups
          .map(g => g.filter(x => x !== op.id))
          .filter(g => g.length >= 2);
        if (!conf.mergeGroups.length) delete conf.mergeGroups;
      }
      break;
    }
    case 'unhide':
      ids = ids.filter(x => x !== op.id);
      break;
    case 'setTopic':
    case 'setImpact': {
      const field = op.op === 'setTopic' ? 'topics' : 'impacts';
      const map = { ...(conf[field] || {}) };
      if (op.value == null || op.value === '') delete map[op.id];
      else map[op.id] = op.value;
      if (Object.keys(map).length) conf[field] = map;
      else delete conf[field];
      break;
    }
    case 'setSummary':
    case 'setWhy': {
      const field = op.op === 'setSummary' ? 'summaries' : 'whyItMatters';
      const map = { ...(conf[field] || {}) };
      if (op.value == null || op.value === '') delete map[op.id];
      else map[op.id] = String(op.value);
      if (Object.keys(map).length) conf[field] = map;
      else delete conf[field];
      break;
    }
    case 'setObservations': {
      const v = ensureArr(op.value).map(String).slice(0, 5);
      if (v.length) conf.observations = v;
      else delete conf.observations;
      break;
    }
    case 'setHotList': {
      const v = [...new Set(ensureArr(op.value))];
      if (v.length) conf.hotEventIds = v;
      else delete conf.hotEventIds;
      break;
    }
    case 'addMergeGroup': {
      const group = [...new Set(ensureArr(op.value))];
      if (group.length < 2) break; // 非法：调用方 UI 已挡，这里保底忽略
      conf.mergeGroups = ensureArr(conf.mergeGroups);
      const key = [...group].sort().join('|');
      if (!conf.mergeGroups.some(g => [...g].sort().join('|') === key)) {
        conf.mergeGroups.push(group);
      }
      break;
    }
    case 'removeMergeGroup': {
      const groups = ensureArr(conf.mergeGroups);
      if (op.index >= 0 && op.index < groups.length) groups.splice(op.index, 1);
      if (groups.length) conf.mergeGroups = groups;
      else delete conf.mergeGroups;
      break;
    }
    default:
      throw new Error(`未知覆盖操作: ${op.op}`);
  }

  // 清理空数组/空对象字段；若今日配置已全空则整个移除该日期键
  dropEmptyArrayFields(conf, ID_LIST_FIELDS);
  for (const f of MAP_FIELDS) {
    if (conf[f] && typeof conf[f] === 'object' && !Object.keys(conf[f]).length) delete conf[f];
  }
  if (Object.keys(conf).length === 0) delete config.byDate[date];

  // 全局黑名单写回顶层（空则整个移除字段，保持文件干净）
  if (ids.length) config.globalHiddenIds = ids;
  else delete config.globalHiddenIds;

  return { config, globalIds: ids };
}

/**
 * 扫描全部覆盖里引用「当前 daily 不存在 id」的条目。
 * 注意：hiddenIds/mergeGroups/globalHiddenIds 的缺失已降级为可容忍（构建应用后即消失），
 * 这里仍然列出，供 UI 提示"可清理"；forced/hot/map 类缺失才是真阻断项。
 * @returns {Array<{date: string, field: string, id: string, blocking: boolean}>}
 */
export function scanStale(overrides, daily) {
  const out = [];
  if (!overrides || typeof overrides !== 'object') return out;
  const ids = new Set(ensureArr(daily?.items).map(it => it.id));
  const has = (id) => ids.has(id);

  for (const id of ensureArr(overrides.globalHiddenIds)) {
    if (!has(id)) out.push({ date: '全局', field: 'globalHiddenIds', id, blocking: false });
  }

  const byDate = overrides.byDate && typeof overrides.byDate === 'object' ? overrides.byDate : {};
  for (const [date, conf] of Object.entries(byDate)) {
    if (!conf || typeof conf !== 'object') continue;
    for (const f of ID_LIST_FIELDS) {
      for (const id of ensureArr(conf[f])) {
        if (!has(id)) out.push({ date, field: f, id, blocking: f !== 'unfeaturedIds' });
      }
    }
    for (const id of ensureArr(conf.hiddenIds)) {
      if (!has(id)) out.push({ date, field: 'hiddenIds', id, blocking: false });
    }
    for (const f of MAP_FIELDS) {
      for (const id of Object.keys(conf[f] || {})) {
        if (!has(id)) out.push({ date, field: f, id, blocking: true });
      }
    }
    ensureArr(conf.mergeGroups).forEach((group) => {
      for (const id of ensureArr(group)) {
        if (!has(id)) out.push({ date, field: 'mergeGroups', id, blocking: false });
      }
    });
  }
  return out;
}

/**
 * 清理超过保留期的 byDate 配置（全局黑名单不受影响）。
 * @param {object} overrides
 * @param {string} today YYYY-MM-DD
 * @param {number} [keepDays=3]
 * @returns {{config: object, pruned: string[]}}
 */
export function pruneOld(overrides, today, keepDays = 3) {
  const config = JSON.parse(JSON.stringify(overrides || newConfig()));
  if (!config.byDate || typeof config.byDate !== 'object') {
    return { config: { schemaVersion: 1, byDate: {} }, pruned: [] };
  }
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const pruned = [];
  for (const date of Object.keys(config.byDate)) {
    if (date < cutoffStr) {
      delete config.byDate[date];
      pruned.push(date);
    }
  }
  return { config, pruned };
}

/** 单条事件的 UI 投影。 */
function projectItem(ev, featuredSet, hotSet, globalSet, overrideIds) {
  return {
    id: ev.id,
    title: ev.title || '',
    originalTitle: ev.originalTitle || '',
    url: ev.url || '',
    summary: ev.summary || '',
    whyItMatters: ev.whyItMatters || '',
    topic: ev.topic || 'other-energy',
    impact: ev.impact || 'unknown',
    importance: ev.importance ?? 0,
    region: ev.region || '未知',
    source: ev.source?.name || '未知来源',
    publishedAt: ev.publishedAt || null,
    wechat: ev.wechat === true,
    isFeatured: featuredSet.has(ev.id),
    isHot: hotSet.has(ev.id),
    hiddenGlobal: globalSet.has(ev.id),
    hasOverride: overrideIds.has(ev.id)
  };
}

/**
 * 组装内容运营页数据。
 * @returns {{
 *   date, generatedAt, items: object[], todayConfig, globalIds,
 *   topics: {id,label}[], impacts: {id,label}[]
 * }}
 */
export function buildTodayPayload(daily, featured, overrides, enums) {
  const featuredSet = new Set(ensureArr(featured?.featuredEventIds));
  const hotSet = new Set(ensureArr(featured?.hotEventIds));
  const globalSet = new Set(ensureArr(overrides?.globalHiddenIds));

  const todayConf = dateConfig(overrides || {}, daily?.date) || {};
  const overrideIds = new Set();
  for (const f of ID_LIST_FIELDS) for (const id of ensureArr(todayConf[f])) overrideIds.add(id);
  for (const f of MAP_FIELDS) for (const id of Object.keys(todayConf[f] || {})) overrideIds.add(id);
  ensureArr(todayConf.mergeGroups).forEach(g => ensureArr(g).forEach(id => overrideIds.add(id)));

  return {
    date: daily?.date || null,
    generatedAt: daily?.generatedAt || null,
    items: ensureArr(daily?.items).map(ev =>
      projectItem(ev, featuredSet, hotSet, globalSet, overrideIds)),
    todayConfig: todayConf,
    globalIds: [...globalSet],
    // 当前生效值（构建产物），供侧栏展示与编辑草稿初始化
    featuredIds: ensureArr(featured?.featuredEventIds),
    hotIds: ensureArr(featured?.hotEventIds),
    observations: ensureArr(featured?.observations),
    topics: ensureArr(enums?.topics).map(t => ({ id: t.id, label: t.label })),
    impacts: ensureArr(enums?.impacts).map(i => ({ id: i.id, label: i.label }))
  };
}
