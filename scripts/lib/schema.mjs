/**
 * V1.1 数据协议校验（阶段 A-03）
 *
 * 校验 `daily.json` V2、`featured.json` 与 `data/editorial-overrides.json` 三份数据。
 * 纯函数模块，可被生成脚本、CI 校验入口与测试复用。
 *
 * 约定：
 * - 校验不负责生成数据，只负责判定合法/非法并给出可定位的错误。
 * - 所有校验返回 { valid, errors, warnings }；errors 为致命问题，warnings 为软问题。
 * - 枚举取自 data/enums.json（阶段 A-05 固化），与前端共享同一数据源。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ENUMS_PATH = path.resolve(__dirname, '../../data/enums.json');

let _enums = null;

/** 加载并缓存 data/enums.json，返回含 Set 的规范化枚举。 */
export async function loadEnums() {
  if (_enums) return _enums;
  const raw = await fs.readFile(ENUMS_PATH, 'utf8');
  const data = JSON.parse(raw);
  _enums = {
    topics: data.topics || [],
    sourceTypes: data.sourceTypes || [],
    impacts: data.impacts || [],
    regions: data.regions || {},
    priorityTopics: data.priorityTopics || [],
    hot: data.hot || null,             // 今日热点榜配置（构建端 selectHot / 前端徽章共用）
    categories: data.categories || [], // 精选页分类配置（前端分类栏）
    topicIds: new Set((data.topics || []).map(t => t.id)),
    sourceTypeIds: new Set((data.sourceTypes || []).map(t => t.id)),
    impactIds: new Set((data.impacts || []).map(t => t.id))
  };
  return _enums;
}

/* ===== 基础工具 ===== */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const EVENT_ID_RE = /^evt_[a-z0-9]{8,}$/;

export function isHttpUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isIsoDate(v) {
  if (typeof v !== 'string' || !v) return false;
  const t = Date.parse(v);
  return !Number.isNaN(t);
}

function push(list, item) {
  list.push(item);
}

function checkNonEmptyString(obj, field, errors, where) {
  const v = obj?.[field];
  if (typeof v !== 'string' || !v.trim()) {
    push(errors, `${where}: 字段 "${field}" 缺失或为空字符串`);
    return false;
  }
  return true;
}

function checkStringArray(obj, field, errors, where) {
  const v = obj?.[field];
  if (v == null) return true; // 可选数组
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
    push(errors, `${where}: 字段 "${field}" 应为字符串数组`);
    return false;
  }
  return true;
}

/* ===== daily.json V2 ===== */

/**
 * 校验 daily.json V2。
 * @param {object} daily
 * @param {object} [enums] 可选，避免重复加载
 */
export async function validateDailyV2(daily, enums) {
  const errors = [];
  const warnings = [];
  const E = enums || (await loadEnums());

  if (!daily || typeof daily !== 'object' || Array.isArray(daily)) {
    return { valid: false, errors: ['daily 数据不是对象'], warnings };
  }

  if (daily.schemaVersion !== 2) {
    push(errors, `schemaVersion 应为 2，实际为 ${JSON.stringify(daily.schemaVersion)}`);
  }
  if (typeof daily.date !== 'string' || !DATE_RE.test(daily.date)) {
    push(errors, `date 应为 YYYY-MM-DD，实际为 ${JSON.stringify(daily.date)}`);
  }
  if (!isIsoDate(daily.generatedAt)) {
    push(errors, `generatedAt 缺失或非法：${JSON.stringify(daily.generatedAt)}`);
  }
  if (typeof daily.status !== 'string' || !daily.status) {
    push(errors, `status 缺失`);
  }

  const stats = daily.stats;
  if (!stats || typeof stats !== 'object') {
    push(errors, `stats 缺失`);
  } else {
    for (const f of ['sourcesTotal', 'sourcesSucceeded', 'articlesFetched', 'eventsPublished']) {
      if (typeof stats[f] !== 'number' || stats[f] < 0) {
        push(errors, `stats.${f} 应为非负数字，实际为 ${JSON.stringify(stats[f])}`);
      }
    }
  }

  const items = daily.items;
  if (!Array.isArray(items)) {
    push(errors, `items 缺失或不是数组`);
    return { valid: errors.length === 0, errors, warnings };
  }

  const seenIds = new Set();
  const seenUrls = new Set();
  items.forEach((it, i) => {
    const where = `items[${i}]${it.id ? ` (${it.id})` : ''}`;

    // id：稳定、格式合法、不重复
    if (!checkNonEmptyString(it, 'id', errors, where)) {
      // 继续检查其它字段，便于一次性修复
    } else if (!EVENT_ID_RE.test(it.id)) {
      push(errors, `${where}: id "${it.id}" 不符合格式 evt_[a-z0-9]{8,}`);
    } else if (seenIds.has(it.id)) {
      push(errors, `${where}: id "${it.id}" 重复`);
    } else {
      seenIds.add(it.id);
    }

    // url：必须可访问的 http(s) 链接
    if (!isHttpUrl(it.url)) {
      push(errors, `${where}: url "${JSON.stringify(it.url)}" 非法，必须为 http(s) 外链`);
    } else if (seenUrls.has(it.url)) {
      warnings.push(`${where}: url "${it.url}" 与其他条目重复`);
    } else {
      seenUrls.add(it.url);
    }

    // title
    checkNonEmptyString(it, 'title', errors, where);
    // summary / whyItMatters 允许为空字符串
    for (const f of ['summary', 'whyItMatters']) {
      const v = it?.[f];
      if (v != null && typeof v !== 'string') {
        push(errors, `${where}: 字段 "${f}" 应为字符串`);
      }
    }

    // topic：主主题必须来自固定枚举
    if (!checkNonEmptyString(it, 'topic', errors, where)) {
      // 已报错
    } else if (!E.topicIds.has(it.topic)) {
      push(errors, `${where}: topic "${it.topic}" 不在枚举 ${[...E.topicIds].join('/')} 中`);
    }

    // tags：补充标签
    checkStringArray(it, 'tags', errors, where);

    // region：非空；已知集合建议，开放允许（PRD 6.2）
    if (!checkNonEmptyString(it, 'region', errors, where)) {
      // 已报错
    } else if (E.regions?.kind === 'open-with-known-set' && E.regions.known && !E.regions.known.includes(it.region)) {
      warnings.push(`${where}: region "${it.region}" 不在已知集合，请确认是否应使用「全球」或「未知」`);
    }

    // entities：字符串数组
    checkStringArray(it, 'entities', errors, where);

    // metrics：{ label, value, unit? } 数组
    if (it.metrics != null) {
      if (!Array.isArray(it.metrics)) {
        push(errors, `${where}: metrics 应为数组`);
      } else {
        it.metrics.forEach((m, j) => {
          const mw = `${where}.metrics[${j}]`;
          if (!checkNonEmptyString(m, 'label', errors, mw)) {
            // 已报错
          }
          if (m.value == null || (typeof m.value !== 'string' && typeof m.value !== 'number')) {
            push(errors, `${mw}: value 应为字符串或数字，实际为 ${JSON.stringify(m.value)}`);
          }
          if (m.unit != null && typeof m.unit !== 'string') {
            push(errors, `${mw}: unit 应为字符串`);
          }
        });
      }
    }

    // impact：固定枚举
    if (it.impact != null && !E.impactIds.has(it.impact)) {
      push(errors, `${where}: impact "${it.impact}" 不在枚举 ${[...E.impactIds].join('/')} 中`);
    }

    // importance：内部排序用数字
    if (it.importance != null && typeof it.importance !== 'number') {
      push(errors, `${where}: importance 应为数字`);
    }

    // source：名称 + 类型 + 是否一手
    const src = it.source;
    if (!src || typeof src !== 'object') {
      push(errors, `${where}: source 缺失`);
    } else {
      checkNonEmptyString(src, 'name', errors, `${where}.source`);
      if (!checkNonEmptyString(src, 'type', errors, `${where}.source`)) {
        // 已报错
      } else if (!E.sourceTypeIds.has(src.type)) {
        push(errors, `${where}.source: type "${src.type}" 不在枚举 ${[...E.sourceTypeIds].join('/')} 中`);
      }
      if (typeof src.isPrimary !== 'boolean') {
        push(errors, `${where}.source: isPrimary 应为布尔值`);
      } else if (src.isPrimary !== (src.type === 'primary')) {
        push(errors, `${where}.source: isPrimary 应与 type="primary" 保持一致`);
      }
    }

    // 时间字段
    if (it.publishedAt != null && !isIsoDate(it.publishedAt)) {
      push(errors, `${where}: publishedAt "${JSON.stringify(it.publishedAt)}" 非法 ISO 时间`);
    }
    if (it.discoveredAt != null && !isIsoDate(it.discoveredAt)) {
      push(errors, `${where}: discoveredAt "${JSON.stringify(it.discoveredAt)}" 非法 ISO 时间`);
    }

    // relatedSources：数组，元素至少含 url/name
    if (it.relatedSources != null) {
      if (!Array.isArray(it.relatedSources)) {
        push(errors, `${where}: relatedSources 应为数组`);
      } else {
        it.relatedSources.forEach((rs, j) => {
          const rw = `${where}.relatedSources[${j}]`;
          if (!rs || typeof rs !== 'object') {
            push(errors, `${rw}: 应为对象`);
          } else {
            checkNonEmptyString(rs, 'name', errors, rw);
            if (!isHttpUrl(rs.url)) {
              push(errors, `${rw}: url 非法，必须为 http(s) 外链`);
            }
          }
        });
      }
    }
  });

  return { valid: errors.length === 0, errors, warnings };
}

/* ===== featured.json ===== */

/**
 * 校验 featured.json。
 * @param {object} featured
 * @param {object} [daily] 同日期 daily.json，用于校验精选 ID 存在性
 * @param {object} [enums]
 */
export async function validateFeatured(featured, daily, enums) {
  const errors = [];
  const warnings = [];
  void enums;

  if (!featured || typeof featured !== 'object' || Array.isArray(featured)) {
    return { valid: false, errors: ['featured 数据不是对象'], warnings };
  }
  if (featured.schemaVersion !== 1) {
    push(errors, `schemaVersion 应为 1，实际为 ${JSON.stringify(featured.schemaVersion)}`);
  }
  if (typeof featured.date !== 'string' || !DATE_RE.test(featured.date)) {
    push(errors, `date 应为 YYYY-MM-DD`);
  }
  if (!isIsoDate(featured.generatedAt)) {
    push(errors, `generatedAt 缺失或非法`);
  }
  if (!Array.isArray(featured.observations)) {
    push(errors, `observations 应为字符串数组`);
  } else if (featured.observations.some(o => typeof o !== 'string')) {
    push(errors, `observations 应全部为字符串`);
  } else if (featured.observations.length > 5) {
    warnings.push(`observations 为 ${featured.observations.length} 条，超过今日观察上限 5 条`);
  }

  if (!Array.isArray(featured.featuredEventIds)) {
    push(errors, `featuredEventIds 应为字符串数组`);
  } else {
    const dup = new Set();
    for (const id of featured.featuredEventIds) {
      if (typeof id !== 'string' || !id) {
        push(errors, `featuredEventIds 含空值`);
        continue;
      }
      if (dup.has(id)) {
        warnings.push(`featuredEventIds 含重复 id: ${id}`);
      }
      dup.add(id);
      if (daily && Array.isArray(daily.items)) {
        if (!daily.items.some(it => it.id === id)) {
          push(errors, `精选 id "${id}" 不存在于同日期 daily.json items 中`);
        }
      }
    }
    // 数量目标为软约束：不足时如实减少（PRD 7.2）；上限与生成器 maxFeatured 一致
    if (featured.featuredEventIds.length > 12) {
      warnings.push(`精选 ${featured.featuredEventIds.length} 条，超过目标上限 12 条`);
    }
  }

  // hotEventIds：可选（旧版 featured 无此字段），存在时校验引用与去重
  if (featured.hotEventIds != null) {
    if (!Array.isArray(featured.hotEventIds) || featured.hotEventIds.some(x => typeof x !== 'string')) {
      push(errors, `hotEventIds 应为字符串数组`);
    } else {
      const dupHot = new Set();
      for (const id of featured.hotEventIds) {
        if (!id) {
          push(errors, `hotEventIds 含空值`);
          continue;
        }
        if (dupHot.has(id)) warnings.push(`hotEventIds 含重复 id: ${id}`);
        dupHot.add(id);
        if (daily && Array.isArray(daily.items) && !daily.items.some(it => it.id === id)) {
          push(errors, `热点 id "${id}" 不存在于同日期 daily.json items 中`);
        }
      }
      if (featured.hotEventIds.length > 10) {
        warnings.push(`热点榜 ${featured.hotEventIds.length} 条，超过展示上限 10 条`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/* ===== editorial-overrides.json ===== */

/**
 * 校验人工覆盖配置（PRD 7.3）。
 * 支持按日期：强制精选、取消精选、改摘要/推荐理由/主题、合并/拆分、今日观察。
 * @param {object} overrides
 * @param {object} [daily] 提供时校验引用的 id 是否存在
 */
export async function validateOverrides(overrides, daily) {
  const errors = [];
  const warnings = [];

  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { valid: false, errors: ['overrides 数据不是对象'], warnings };
  }
  if (overrides.schemaVersion !== 1) {
    push(errors, `overrides.schemaVersion 应为 1，实际为 ${JSON.stringify(overrides.schemaVersion)}`);
  }
  const byDate = overrides.byDate;
  if (!byDate || typeof byDate !== 'object' || Array.isArray(byDate)) {
    push(errors, `overrides.byDate 缺失或不是对象`);
    return { valid: false, errors, warnings };
  }

  for (const [date, conf] of Object.entries(byDate)) {
    const where = `byDate["${date}"]`;
    if (!DATE_RE.test(date)) {
      push(errors, `${where}: 日期键 "日期" 应为 YYYY-MM-DD`);
    }
    if (!conf || typeof conf !== 'object') {
      push(errors, `${where}: 配置应为对象`);
      continue;
    }

    const stringIdArray = (field) => {
      const v = conf[field];
      if (v == null) return;
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
        push(errors, `${where}.${field}: 应为字符串数组`);
        return;
      }
      for (const id of v) {
        if (daily && Array.isArray(daily.items) && !daily.items.some(it => it.id === id)) {
          push(errors, `${where}.${field}: id "${id}" 不存在于 daily items`);
        }
      }
    };
    stringIdArray('forcedFeaturedIds');
    stringIdArray('hiddenIds');
    stringIdArray('unfeaturedIds');
    stringIdArray('hotEventIds');   // 整体替换今日热点榜

    const E = await loadEnums();
    const mapField = (field, allowedSet, label) => {
      const v = conf[field];
      if (v == null) return;
      if (typeof v !== 'object' || Array.isArray(v)) {
        push(errors, `${where}.${field}: 应为 { id: 新值 } 对象`);
        return;
      }
      for (const [id, val] of Object.entries(v)) {
        if (daily && !daily.items.some(it => it.id === id)) {
          push(errors, `${where}.${field}: id "${id}" 不存在于 daily items`);
        }
        if (allowedSet && !allowedSet.has(val)) {
          push(errors, `${where}.${field}: id "${id}" 的新 ${label} "${val}" 非法`);
        }
      }
    };
    mapField('topics', E.topicIds, 'topic');
    mapField('impacts', E.impactIds, 'impact');

    const textField = (field) => {
      const v = conf[field];
      if (v == null) return;
      if (typeof v !== 'object' || Array.isArray(v)) {
        push(errors, `${where}.${field}: 应为 { id: 文本 } 对象`);
        return;
      }
      for (const [id, val] of Object.entries(v)) {
        if (typeof val !== 'string') {
          push(errors, `${where}.${field}: id "${id}" 的值应为字符串`);
        }
        if (daily && !daily.items.some(it => it.id === id)) {
          push(errors, `${where}.${field}: id "${id}" 不存在于 daily items`);
        }
      }
    };
    textField('summaries');
    textField('whyItMatters');

    if (conf.observations != null) {
      if (!Array.isArray(conf.observations) || conf.observations.some(o => typeof o !== 'string')) {
        push(errors, `${where}.observations: 应为字符串数组`);
      }
    }
    if (conf.mergeGroups != null) {
      if (!Array.isArray(conf.mergeGroups)) {
        push(errors, `${where}.mergeGroups: 应为数组`);
      } else {
        conf.mergeGroups.forEach((g, gi) => {
          if (!Array.isArray(g) || g.length < 2) {
            push(errors, `${where}.mergeGroups[${gi}]: 应为至少含 2 个 id 的数组`);
          } else if (daily && Array.isArray(daily.items)) {
            for (const id of g) {
              if (!daily.items.some(it => it.id === id)) {
                push(errors, `${where}.mergeGroups[${gi}]: id "${id}" 不存在于 daily items`);
              }
            }
          }
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/* ===== 汇总入口 ===== */

/**
 * 校验当前正式数据文件（CLI/CI 使用）。
 * @returns {Promise<{valid: boolean, reports: object}>}
 */
export async function validateCurrentData() {
  const root = path.resolve(__dirname, '../..');
  const readJson = async (p) => {
    try {
      return JSON.parse(await fs.readFile(p, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  };

  // 与前端加载顺序一致：优先校验 daily-v2，缺失时再回退 daily。
  const dailyV2 = await readJson(path.join(root, 'feeds/daily-v2.json'));
  const daily = dailyV2 || await readJson(path.join(root, 'feeds/daily.json'));
  const featured = await readJson(path.join(root, 'feeds/featured.json'));
  const overrides = await readJson(path.join(root, 'data/editorial-overrides.json'));

  const reports = {};
  let valid = true;

  if (daily) {
    if (daily.schemaVersion === 2) {
      reports.daily = await validateDailyV2(daily);
      if (!reports.daily.valid) valid = false;
    } else {
      // 过渡期：旧版 V1 数据不阻断部署，但记录与 V2 协议的差异供阶段 B 参考
      const full = await validateDailyV2(daily);
      const diffs = full.errors.slice(0, 5);
      reports.daily = {
        valid: true,
        legacy: true,
        errors: [],
        warnings: [
          '当前 daily.json 为 V1 旧版结构（缺少 schemaVersion=2），V2 严格校验暂不阻断；' +
            '待阶段 B 生成器升级。与 V2 协议不符的字段差异（前 5 条，仅参考）：'
        ].concat(diffs, full.errors.length > 5 ? [`... 其余 ${full.errors.length - 5} 条略`] : [])
      };
    }
  } else {
    reports.daily = { valid: false, errors: ['feeds/daily.json 不存在'], warnings: [] };
    valid = false;
  }

  if (featured) {
    reports.featured = await validateFeatured(featured, daily);
    if (!reports.featured.valid) valid = false;
  } else if (daily?.schemaVersion === 2) {
    reports.featured = { valid: false, errors: ['feeds/featured.json 不存在，V2 精选页无法加载'], warnings: [] };
    valid = false;
  } else {
    // 仅 V1 兼容模式允许 featured 暂缺。
    reports.featured = { valid: true, errors: [], warnings: ['feeds/featured.json 不存在（V1.1 尚未生成，属于正常）'] };
  }

  if (overrides) {
    reports.overrides = await validateOverrides(overrides, daily);
    if (!reports.overrides.valid) valid = false;
  } else {
    reports.overrides = { valid: true, errors: [], warnings: [] };
  }

  return { valid, reports };
}
