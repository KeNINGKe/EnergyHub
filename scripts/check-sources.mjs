// 健康检查：批量探测 data/sources.json 中所有信息源 URL
// 用法: node scripts/check-sources.mjs
import { readFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT = 18000;
const CONCURRENCY = 10;

const sources = JSON.parse(readFileSync(new URL('../data/sources.json', import.meta.url), 'utf8'));

const items = [];
for (const cat of sources.categories) {
  for (const s of cat.sources) {
    items.push({ category: cat.name, ...s });
  }
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 140) : '';
}

const WECHAT_ERR = [
  '已被发布者删除', '该内容已被删除', '参数错误', '无法访问',
  'visit count', '环境异常', '此内容因违规', '该公众号已迁移',
];
const PARK_ERR = ['域名出售', 'domain for sale', 'buy this domain', '此页面不存在', ' parked ', 'hugedomains', 'dan.com'];
const ERR_TITLE = /^(404|403|500|not found|page not found|页面不存在|无法找到|无法访问|无法显示|error|访问出错|链接已失效|site can|抱歉，找不到)/i;

function origin(u) {
  try { return new URL(u).origin; } catch { return u; }
}

async function check(item) {
  const r = { cat: item.category, name: item.name, url: item.url, status: null, finalUrl: null, title: '', bytes: 0, issue: null };
  if (!item.url) { r.issue = 'no-link'; return r; } // 微信说明型卡片，无外链
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(item.url, {
      headers: {
        'User-Agent': UA,
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

console.log(`共 ${items.length} 个信息源，并发 ${CONCURRENCY} ...\n`);
const results = await pool(items, CONCURRENCY, check);

const bad = results.filter(r => r.issue && r.issue !== 'ok' && r.issue !== 'no-link');
const ok = results.filter(r => r.issue === 'ok');
const nolink = results.filter(r => r.issue === 'no-link');

const order = ['http-404','http-403','http-410','http-500','http-502','http-503','unreachable','timeout','wechat-invalid','parked','err-title','redirected-to-root','thin'];
const byIssue = {};
for (const r of bad) (byIssue[r.issue] ||= []).push(r);

function line(r) {
  const fin = r.finalUrl && r.finalUrl !== r.url ? ` -> ${r.finalUrl}` : '';
  return `  [${r.cat}] ${r.name}\n    URL: ${r.url}${fin}\n    状态: ${r.status ?? '-'}  字节: ${r.bytes}  标题: ${r.title || '(无)'}`;
}

console.log(`\n========== 检查结果 ==========\n正常: ${ok.length}   异常: ${bad.length}   无外链(微信): ${nolink.length}\n`);
for (const key of order) {
  if (!byIssue[key]) continue;
  console.log(`\n--- ${key} (${byIssue[key].length}) ---`);
  for (const r of byIssue[key]) console.log(line(r));
}
// 其它未分类异常
for (const key of Object.keys(byIssue)) {
  if (order.includes(key)) continue;
  console.log(`\n--- ${key} (${byIssue[key].length}) ---`);
  for (const r of byIssue[key]) console.log(line(r));
}

// 导出 JSON 便于后续处理
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../scripts/check-results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log(`\n详细结果已写入 scripts/check-results.json`);
