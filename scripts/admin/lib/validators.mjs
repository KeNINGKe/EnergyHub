/**
 * 后台写盘前的结构校验器（P2 先覆盖 sources.json，后续阶段按需扩展）。
 *
 * 约定：errors 非空 = 拒绝落盘；warnings 只提示不拦截。
 * 与 schema.mjs 的分工：schema.mjs 校验构建端协议（enums/overrides 等），
 * 这里只校验后台直接编辑的运营配置文件。
 */

/** @returns {{valid:boolean, errors:string[], warnings:string[]}} */
export function validateSources(doc) {
  const errors = [];
  const warnings = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { valid: false, errors: ['sources.json 顶层必须是对象'], warnings };
  }
  if (typeof doc.version !== 'string' || !doc.version) {
    errors.push('缺少 version 字段');
  }
  if (typeof doc.updatedAt !== 'string' || !doc.updatedAt) {
    errors.push('缺少 updatedAt 字段');
  }
  if (!Array.isArray(doc.categories) || !doc.categories.length) {
    errors.push('categories 必须是非空数组');
    return { valid: false, errors, warnings };
  }

  const catIds = new Set();
  const catNames = new Set();
  const urlOwners = new Map(); // url -> 描述，全局查重
  const badUrl = (u) => !/^https?:\/\/.+/.test(u);

  doc.categories.forEach((cat, ci) => {
    const label = `分类[${ci}]`;
    if (!cat || typeof cat !== 'object') { errors.push(`${label} 不是对象`); return; }
    if (typeof cat.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(cat.id)) {
      errors.push(`${label} id 非法（需小写字母/数字/连杠）: ${JSON.stringify(cat.id)}`);
    } else if (catIds.has(cat.id)) {
      errors.push(`分类 id 重复: ${cat.id}`);
    } else {
      catIds.add(cat.id);
    }
    if (typeof cat.name !== 'string' || !cat.name.trim()) {
      errors.push(`${label}（${cat.id || '?'}）name 不能为空`);
    } else if (catNames.has(cat.name)) {
      errors.push(`分类名重复: ${cat.name}`);
    } else {
      catNames.add(cat.name);
    }
    if (!Array.isArray(cat.sources)) {
      errors.push(`${label} sources 必须是数组`);
      return;
    }

    const namesInCat = new Set();
    cat.sources.forEach((s, si) => {
      const tag = `${label} 第 ${si + 1} 条`;
      if (!s || typeof s !== 'object') { errors.push(`${tag} 不是对象`); return; }
      if (typeof s.name !== 'string' || !s.name.trim()) {
        errors.push(`${tag} name 不能为空`);
      } else if (namesInCat.has(s.name)) {
        errors.push(`分类「${cat.name}」内信源名重复: ${s.name}`);
      } else {
        namesInCat.add(s.name);
      }

      const url = typeof s.url === 'string' ? s.url.trim() : '';
      if (url && badUrl(url)) {
        errors.push(`${tag}「${s.name}」url 必须以 http(s):// 开头: ${url}`);
      } else if (url) {
        if (urlOwners.has(url)) {
          // 历史数据存在跨分类同发行方订阅（BNEF/WoodMac 等）→ 只警告不拦截；
          // 新增/修改时的重复由 sources-ops 的 409 + allowDupUrl 逃生口把守
          warnings.push(`url 重复: ${url}（${urlOwners.get(url)} 与 ${cat.name}/${s.name}）`);
        } else {
          urlOwners.set(url, `${cat.name}/${s.name}`);
        }
      }

      if (s.rss != null && (typeof s.rss !== 'string' || badUrl(s.rss))) {
        errors.push(`${tag}「${s.name}」rss 需为 http(s) 地址或 null`);
      }
      if (s.tags != null && !Array.isArray(s.tags)) {
        errors.push(`${tag}「${s.name}」tags 必须是字符串数组`);
      } else if (Array.isArray(s.tags) && s.tags.some(t => typeof t !== 'string')) {
        errors.push(`${tag}「${s.name}」tags 含非字符串项`);
      }
      for (const k of ['desc', 'region', 'fetchType']) {
        if (s[k] != null && typeof s[k] !== 'string') {
          errors.push(`${tag}「${s.name}」${k} 必须是字符串`);
        }
      }
    });
  });

  // 去重告警噪音（同一信源重复触发）
  return { valid: errors.length === 0, errors, warnings: [...new Set(warnings)] };
}
