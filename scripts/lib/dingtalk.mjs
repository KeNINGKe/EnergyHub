/**
 * 钉钉群自定义机器人推送（加签 + markdown）——纯函数。
 *
 * 供 scripts/notify-dingtalk.mjs（CLI）与 tests/dingtalk.test.mjs 复用：
 * - dingtalkSign     计算加签（HmacSHA256 → base64，未 url 编码）
 * - buildSignedUrl   webhook + timestamp + sign 拼最终请求 URL
 * - resolveHotItems  featured/daily → 热点事件对象列表（含缺失回退）
 * - buildHotMessage  组 { title, text }（钉钉 markdown 子集，不用表格/代码块）
 *
 * 钉钉机器人约定：
 *   stringToSign = timestamp + "\n" + secret
 *   sign         = urlencode(base64(HmacSHA256(stringToSign, secret)))
 */
import { createHmac } from 'node:crypto';

/**
 * 计算加签，返回 base64 串（未 url 编码）。
 * @param {string} secret 加签密钥（机器人安全设置里的 SEC…）
 * @param {number|string} timestamp 毫秒级时间戳
 */
export function dingtalkSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
}

/**
 * 拼最终请求 URL。用 URL/searchParams 保证 timestamp/sign 正确百分号编码。
 * secret 为空（关键词 / IP 白名单模式）时原样返回，不加签。
 */
export function buildSignedUrl(webhook, secret, timestamp) {
  if (!secret) return webhook;
  const u = new URL(webhook);
  u.searchParams.set('timestamp', String(timestamp));
  u.searchParams.set('sign', dingtalkSign(secret, timestamp));
  return u.toString();
}

/**
 * 从 featured + daily 取热点事件对象列表。
 * 优先 featured.hotEventIds；缺失/空回退 featuredEventIds 前 max 条。
 * 过滤掉 daily.items 里找不到的 id（陈旧引用）。
 * @returns {object[]} 事件对象（含 title/url/source 等）
 */
export function resolveHotItems(featured, daily, max = 5) {
  const items = daily?.items || [];
  const byId = new Map(items.map(it => [it.id, it]));
  const ids = (Array.isArray(featured?.hotEventIds) && featured.hotEventIds.length)
    ? featured.hotEventIds
    : (featured?.featuredEventIds || []).slice(0, max);
  return ids.slice(0, max).map(id => byId.get(id)).filter(Boolean);
}

/**
 * 组「热点榜」消息。
 * @param {object} featured feeds/featured.json（date/hotEventIds/featuredEventIds）
 * @param {object} daily feeds/daily-v2.json（items[]）
 * @param {{siteUrl?:string}} opts
 * @returns {{title:string, text:string}}
 */
export function buildHotMessage(featured, daily, opts = {}) {
  const { siteUrl = '' } = opts;
  const date = featured?.date || '';
  const hot = resolveHotItems(featured, daily, 5);

  const lines = [];
  lines.push(`## ⚡ EnergyHub 热点（${date}）`);
  lines.push('');
  lines.push('**热点榜**');
  hot.forEach((it, i) => {
    const src = it.source?.name ? `｜${it.source.name}` : '';
    lines.push(`${i + 1}. [${it.title}](${it.url})${src}`);
  });
  if (siteUrl) {
    lines.push('');
    lines.push(`[查看完整日报 →](${siteUrl})`);
  }

  return { title: `EnergyHub · ${date} 热点`, text: lines.join('\n') };
}
