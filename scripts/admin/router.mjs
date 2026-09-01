/**
 * 极简 API 路由。
 *
 * - 路由模式：'/api/check/jobs/:id'，:name 捕获一段路径。
 * - 统一响应封装：成功 {ok:true,data}；失败 {ok:false,error,errors?,warnings?}。
 * - 请求体：JSON，限长 2MB。
 */

const BODY_LIMIT = 2 * 1024 * 1024;

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const keys = [];
    const regexSrc = pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        // 字面段做正则转义
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    routes.push({ method: method.toUpperCase(), regex: new RegExp(`^${regexSrc}$`), keys, handler });
  }

  /** 命中返回 {handler, params}，否则 null。 */
  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== method.toUpperCase()) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }

  return { add, match };
}

/** 读 JSON 请求体；超限或非法抛错。GET/HEAD 返回 undefined。 */
export function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('请求体超过 2MB 上限'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** 成功响应。 */
export function jsonOk(ctx, data) {
  ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  ctx.res.end(JSON.stringify({ ok: true, data }));
}

/**
 * 失败响应。
 * @param {number} status HTTP 状态码（400 参数问题 / 403 禁止 / 409 冲突 / 500 内部错误）
 */
export function jsonFail(ctx, status, desc) {
  const payload = { ok: false, error: desc?.error || '未知错误' };
  if (desc?.errors?.length) payload.errors = desc.errors;
  if (desc?.warnings?.length) payload.warnings = desc.warnings;
  if (desc?.extra) Object.assign(payload, desc.extra);
  ctx.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  ctx.res.end(JSON.stringify(payload));
}

/** 抛给统一错误处理的状态化错误。 */
export function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}
