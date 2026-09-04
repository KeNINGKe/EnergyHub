/**
 * 信源健康检查核心（从 scripts/check-sources.mjs 抽出，供 CLI 与管理后台共用）。
 *
 * 探测一个条目 = GET 其 URL，按响应分类 issue：
 *   ok | no-link(无外链的微信说明卡) | timeout | unreachable | http-NNN |
 *   parked | err-title | redirected-to-root | thin | wechat-invalid
 *
 * 用法：
 *   import { runSourceCheck } from './source-check.mjs';
 *   const results = await runSourceCheck(items, { concurrency, timeout, onProgress });
 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const DEFAULT_TIMEOUT = 18000;
export const DEFAULT_CONCURRENCY = 10;

const WECHAT_ERR = [
  '已被发布者删除', '该内容已被删除', '参数错误', '无法访问',
  'visit count', '环境异常', '此内容因违规', '该公众号已迁移',
];
const PARK_ERR = ['域名出售', 'domain for sale', 'buy this domain', '此页面不存在', ' parked ', 'hugedomains', 'dan.com'];
const ERR_TITLE = /^(404|403|500|not found|page not found|页面不存在|无法找到|无法访问|无法显示|error|访问出错|链接已失效|site can|抱歉，找不到)/i;

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 140) : '';
}

function origin(u) {
  try { return new URL(u).origin; } catch { return u; }
}

async function check(item, timeout) {
  const r = { cat: item.category, name: item.name, url: item.url, status: null, finalUrl: null, title: '', bytes: 0, issue: null };
  if (!item.url) { r.issue = 'no-link'; return r; } // 微信说明型卡片，无外链
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(item.url, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    r.status = res.status;
    r.finalUrl = res.url;
    const text = await res.text();
    r.bytes = text.length;
    r.title = extractTitle(text);

    if (item.url.includes('mp.weixin.qq.com') && WECHAT_ERR.some(e => text.includes(e))) {
      r.issue = 'wechat-invalid'; return r;
    }
    if (res.status >= 400) { r.issue = 'http-' + res.status; return r; }
    if (PARK_ERR.some(e => text.toLowerCase().includes(e.toLowerCase()))) { r.issue = 'parked'; return r; }
    if (r.title && ERR_TITLE.test(r.title)) { r.issue = 'err-title'; return r; }
    // deep link redirected to site root -> likely 404 soft-redirect
    const deep = new URL(item.url).pathname.replace(/\/+$/, '');
    if (deep && deep !== '' && origin(item.url) === origin(res.url)) {
      const finalPath = new URL(res.url).pathname.replace(/\/+$/, '');
      if (finalPath === '' && !item.url.endsWith(res.url)) { r.issue = 'redirected-to-root'; return r; }
    }
    if (r.bytes < 600) { r.issue = 'thin'; return r; }
    r.issue = 'ok';
    return r;
  } catch (e) {
    r.issue = e.name === 'AbortError' ? 'timeout' : 'unreachable';
    r.title = (e.cause?.code || e.message || '').slice(0, 80);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

/** 简单并发池，保序输出。 */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 批量探测。
 * @param {Array<{category:string,name:string,url?:string}>} items 待探测条目
 * @param {{concurrency?:number, timeout?:number, onProgress?:(done:number,total:number)=>void}} [opts]
 * @returns {Promise<Array>} 结果数组（与输入同序），元素含 cat/name/url/status/finalUrl/title/bytes/issue
 */
export async function runSourceCheck(items, opts = {}) {
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  let done = 0;
  const total = items.length;
  return pool(items, concurrency, async (item) => {
    const r = await check(item, timeout);
    done++;
    if (opts.onProgress) opts.onProgress(done, total);
    return r;
  });
}
