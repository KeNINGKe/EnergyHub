/**
 * 信源管理纯操作（管理后台 P2）——供 api/sources.mjs 与测试复用。
 *
 * 约定：函数直接操作调用方传入的 doc（API 层保证是磁盘新鲜读取的副本），
 * 变更后由 API 层走 validateSources → 原子落盘。找不到目标 / 冲突时抛
 * 带 statusCode 的 Error（httpError 语义），由统一错误处理转 JSON。
 *
 * 信源身份定位：分类内「name + url」二元组（url 允许为空串，配合微信说明卡）。
 * 不用数组下标定位——CI bot 与后台并发编辑时下标会漂移。
 */
import { httpError } from '../router.mjs';

/** 与 check-results.json / API 对外一致的身份键。 */
export function srcKey(catName, name, url) {
  return `${catName} ${name} ${url || ''}`;
}

/** 扁平化：[{catId, catName, catIndex, srcIndex, ...src}] */
export function flattenItems(doc) {
  const out = [];
  (doc?.categories || []).forEach((cat, catIndex) => {
    (cat.sources || []).forEach((s, srcIndex) => {
      out.push({ catId: cat.id, catName: cat.name, catIndex, srcIndex, ...s });
    });
  });
  return out;
}

function locate(doc, ref) {
  const { catId, name, url } = ref || {};
  const cat = (doc.categories || []).find(c => c.id === catId);
  if (!cat) throw httpError(404, `分类不存在: ${catId}`);
  const idx = (cat.sources || []).findIndex(s =>
    s.name === name && (s.url || '') === (url || ''));
  if (idx < 0) throw httpError(404, `分类「${cat.name}」中未找到信源: ${name}`);
  return { cat, idx, src: cat.sources[idx] };
}

/** 规范化一条信源：只保留协议字段，trim 必填项。url 可为空（无外链卡）。 */
export function normalizeSource(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw httpError(400, '信源 name 不能为空');
  const url = String(input.url || '').trim();
  if (url && !/^https?:\/\/.+/.test(url)) throw httpError(400, `url 必须以 http(s):// 开头: ${url}`);
  const rss = input.rss ? String(input.rss).trim() : null;
  if (rss && !/^https?:\/\/.+/.test(rss)) throw httpError(400, `rss 必须以 http(s):// 开头: ${rss}`);
  const out = { name, url };
  if (input.desc) out.desc = String(input.desc).trim();
  if (Array.isArray(input.tags) && input.tags.length) out.tags = input.tags.map(t => String(t).trim()).filter(Boolean);
  if (input.region) out.region = String(input.region).trim();
  if (rss) out.rss = rss;
  if (input.fetchType) out.fetchType = String(input.fetchType).trim();
  return out;
}

/** 全局 url 查重（不含 ref 自身）。命中返回占用者描述，否则 null。 */
export function findUrlOwner(doc, url, except) {
  if (!url) return null;
  for (const cat of doc.categories || []) {
    for (const s of cat.sources || []) {
      if (s.url === url && !(except && except.catId === cat.id && except.name === s.name)) {
        return `${cat.name}/${s.name}`;
      }
    }
  }
  return null;
}

export function addSource(doc, catId, input, opts = {}) {
  const cat = (doc.categories || []).find(c => c.id === catId);
  if (!cat) throw httpError(404, `分类不存在: ${catId}`);
  const src = normalizeSource(input);
  if ((cat.sources || []).some(s => s.name === src.name)) {
    throw httpError(409, `分类「${cat.name}」内已有同名信源: ${src.name}`);
  }
  if (!opts.allowDupUrl) {
    const owner = findUrlOwner(doc, src.url);
    if (owner) throw httpError(409, `url 已被「${owner}」使用: ${src.url}`);
  }
  (cat.sources ||= []).push(src);
  return src;
}

export function updateSource(doc, ref, patch, opts = {}) {
  const { cat, idx, src } = locate(doc, ref);
  const merged = normalizeSource({ ...src, ...patch });
  const dup = (cat.sources || []).some((s, i) => i !== idx && s.name === merged.name);
  if (dup) throw httpError(409, `分类「${cat.name}」内已有同名信源: ${merged.name}`);
  if (!opts.allowDupUrl) {
    const owner = findUrlOwner(doc, merged.url, { catId: cat.id, name: ref.name });
    if (owner) throw httpError(409, `url 已被「${owner}」使用: ${merged.url}`);
  }
  cat.sources[idx] = merged;
  return merged;
}

export function deleteSource(doc, ref) {
  const { cat, idx, src } = locate(doc, ref);
  cat.sources.splice(idx, 1);
  return src;
}

/** 移动信源到另一分类（追加到末尾）。 */
export function moveSource(doc, ref, toCatId) {
  const { src } = locate(doc, ref);
  if (ref.catId === toCatId) throw httpError(400, '目标分类与当前相同');
  const to = (doc.categories || []).find(c => c.id === toCatId);
  if (!to) throw httpError(404, `目标分类不存在: ${toCatId}`);
  deleteSource(doc, ref);
  (to.sources ||= []).push(src);
  return { src, toCat: to.name };
}

export function addCategory(doc, { id, name }) {
  id = String(id || '').trim();
  name = String(name || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw httpError(400, `分类 id 需为小写字母/数字/连杠: ${id}`);
  if (!name) throw httpError(400, '分类名不能为空');
  if ((doc.categories || []).some(c => c.id === id)) throw httpError(409, `分类 id 已存在: ${id}`);
  if ((doc.categories || []).some(c => c.name === name)) throw httpError(409, `分类名已存在: ${name}`);
  doc.categories.push({ id, name, sources: [] });
  return { id, name };
}

export function renameCategory(doc, catId, name) {
  const cat = (doc.categories || []).find(c => c.id === catId);
  if (!cat) throw httpError(404, `分类不存在: ${catId}`);
  name = String(name || '').trim();
  if (!name) throw httpError(400, '分类名不能为空');
  if ((doc.categories || []).some(c => c.id !== catId && c.name === name)) {
    throw httpError(409, `分类名已存在: ${name}`);
  }
  cat.name = name;
  return cat;
}

/** 删除分类；非空拒绝（防止连带误删一批信源）。 */
export function deleteCategory(doc, catId) {
  const cat = (doc.categories || []).find(c => c.id === catId);
  if (!cat) throw httpError(404, `分类不存在: ${catId}`);
  if ((cat.sources || []).length) {
    throw httpError(409, `分类「${cat.name}」还有 ${cat.sources.length} 个信源，先移走或删除它们`);
  }
  doc.categories = doc.categories.filter(c => c.id !== catId);
  return cat;
}

/**
 * 微信公众号源报告：mp.weixin 链接源 + 无外链说明卡，附最近巡检结论与建议动作。
 * @param {object} doc sources.json 文档
 * @param {Array|null} checkResults scripts/check-results.json 内容（缺失传 null）
 */
export function wechatReport(doc, checkResults) {
  const byKey = new Map((checkResults || []).map(r => [srcKey(r.cat, r.name, r.url), r]));
  const items = flattenItems(doc)
    .filter(it => (it.url || '').includes('mp.weixin.qq.com') || !it.url)
    .map((it) => {
      const r = byKey.get(srcKey(it.catName, it.name, it.url));
      const issue = r ? r.issue : null;
      let suggestion;
      if (!it.url) {
        suggestion = '无外链说明卡：确认是否还需要，不需要可删除';
      } else if (issue === 'wechat-invalid') {
        suggestion = '文章已被删除/违规：换链到新文章或删除该源';
      } else if (issue && issue !== 'ok' && issue !== 'no-link') {
        suggestion = `巡检异常（${issue}）：核对链接后处理`;
      } else {
        suggestion = r ? '最近巡检正常' : '尚未巡检';
      }
      return {
        catId: it.catId, catName: it.catName, name: it.name, url: it.url || '',
        checked: !!r, issue, lastTitle: r ? r.title : '', suggestion
      };
    });
  return {
    total: items.length,
    invalid: items.filter(x => x.issue && x.issue !== 'ok' && x.issue !== 'no-link'),
    items
  };
}

/**
 * 合并巡检结果进已有结果集（按身份键替换，保留未覆盖的旧记录）。
 * @returns {Array} 合并后的完整结果集（写回 check-results.json 的格式）
 */
export function mergeCheckResults(existing, incoming) {
  const byKey = new Map((existing || []).map(r => [srcKey(r.cat, r.name, r.url), r]));
  for (const r of incoming || []) byKey.set(srcKey(r.cat, r.name, r.url), r);
  return [...byKey.values()];
}

/**
 * GET /api/sources 的视图组装：合并健康徽章与统计。
 * @param {object} doc sources.json
 * @param {Array|null} checkResults
 */
export function buildSourcesPayload(doc, checkResults) {
  const byKey = new Map((checkResults || []).map(r => [srcKey(r.cat, r.name, r.url), r]));
  const stats = { total: 0, ok: 0, problems: 0, noLink: 0, unchecked: 0 };
  const issueCounts = {};

  const categories = (doc.categories || []).map((cat) => ({
    id: cat.id,
    name: cat.name,
    count: (cat.sources || []).length,
    sources: (cat.sources || []).map((s) => {
      stats.total++;
      const r = byKey.get(srcKey(cat.name, s.name, s.url));
      let check = null;
      if (!r) stats.unchecked++;
      else if (r.issue === 'ok') stats.ok++;
      else if (r.issue === 'no-link') stats.noLink++;
      else {
        stats.problems++;
        issueCounts[r.issue] = (issueCounts[r.issue] || 0) + 1;
      }
      if (r) check = { issue: r.issue, status: r.status, title: r.title, bytes: r.bytes, finalUrl: r.finalUrl };
      return { ...s, catId: cat.id, catName: cat.name, check };
    })
  }));

  return {
    version: doc.version,
    updatedAt: doc.updatedAt,
    categories,
    stats,
    issueCounts
  };
}
