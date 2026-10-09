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
 * 钉钉 markdown 消息字节预算（B-04，AIHOT_IMPLEMENTATION_PLAN §5）。
 * 钉钉 markdown text 上限约 20000 字节，留余量取 18000。
 */
export const MAX_TEXT_BYTES = 18000;

/**
 * 字节预算内装下尽可能多的条目：从 entryLines 尾部逐条丢弃（调用方保证
 * 排列顺序 = 丢弃优先级，research 尾 → hot 倒序），保底 1 条；header/tail
 * （站点链接等）始终保留。单行永不按字符截断——标题中的数字/单位天然完整。
 * @param {string[]} headerLines 头部行（标题 + 「**热点榜**」）
 * @param {string[]} entryLines 条目行（已编号，尾部优先丢弃）
 * @param {string[]} tailLines 尾部行（空行 + 站点链接）
 * @param {number} maxBytes 字节上限
 * @returns {string[]} 装配后的完整行数组（调用方 join('\n')）
 */
export function fitLines(headerLines, entryLines, tailLines, maxBytes = MAX_TEXT_BYTES) {
  const kept = [...entryLines];
  const total = (n) => Buffer.byteLength(
    [...headerLines, ...(n ? kept.slice(0, n) : []), ...tailLines].join('\n'), 'utf8'
  );
  while (kept.length > 1 && total(kept.length) > maxBytes) kept.pop();
  return [...headerLines, ...kept, ...tailLines];
}

/**
 * 句边界截取：超长文本按 。！？；.!?; 回退到最后一个完整句边界，保留结尾标点；
 * 找不到任何句边界（首个边界就超限）时硬截。供阶段 D 观察详情复用；热点榜
 * 条目只有标题链接，不走此函数（减条目优先于截断）。
 * @param {string} text 原文
 * @param {number} max 最大字符数
 * @returns {string}
 */
export function truncateAtSentence(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const m = cut.match(/^.*[。！？；.!?;]/s);
  return m ? m[0] : cut;
}

/**
 * 组「热点榜」消息（科研内容融合版）。
 * 热点榜 = featured.hotEventIds 前 5 条 + research 标记事件按重要性取前 3
 * 接续编号（每日 5~8 条，整体仍是一张榜，不单列科研小节）。
 * 沿革：2026-09-17 科研内容曾单列「科研速递」一节（当时热点榜只收储能/AIDC
 * 主题，sst/pcs 科研动态进不了榜）；2026-09-21 用户反馈改为融合进热点榜、
 * 去掉「科研速递」标题——前 5 条不变，科研条目排在其后。
 * B-04：整体消息加字节预算——超限时从尾部减条目（research 尾 → hot 倒序，
 * 保底榜单第 1 条），不在句中截断数字与单位。
 * @param {object} featured feeds/featured.json（date/hotEventIds/featuredEventIds）
 * @param {object} daily feeds/daily-v2.json（items[]）
 * @param {{siteUrl?:string, maxBytes?:number}} opts
 * @returns {{title:string, text:string}}
 */
export function buildHotMessage(featured, daily, opts = {}) {
  const { siteUrl = '', maxBytes = MAX_TEXT_BYTES } = opts;
  const date = featured?.date || '';
  const hot = resolveHotItems(featured, daily, 5);
  const hotIds = new Set(hot.map(it => it.id));
  const research = (daily?.items || [])
    .filter(it => it.research === true && !hotIds.has(it.id))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, 3);

  const headerLines = [`## EnergyHub 热点（${date}）`, '', '**热点榜**'];
  const entryLines = [...hot, ...research].map((it, i) => {
    const src = it.source?.name ? `｜${it.source.name}` : '';
    return `${i + 1}. [${it.title}](${it.url})${src}`;
  });
  const tailLines = siteUrl ? ['', `[查看完整日报 →](${siteUrl})`] : [];

  const lines = fitLines(headerLines, entryLines, tailLines, maxBytes);
  return { title: `EnergyHub · ${date} 热点`, text: lines.join('\n') };
}
