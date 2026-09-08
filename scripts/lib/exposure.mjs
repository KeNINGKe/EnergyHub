/**
 * 跨日曝光记忆（纯函数，无 IO；文件读写由 build-daily-v2.mjs 负责）。
 *
 * 解决：每日构建互不知情，同一新闻事件连续多日霸占精选/热点榜。
 * 2026-09-08 实测：当天热点榜 5 条里 4 条是前一天上榜过的——
 *   ① 同一 evt_ id 原样重现（Google News 检索源连续多日重发同一批文章）；
 *   ② 同事件跨站点换 ID（昨天 eet-china 版、今天 wedoany 版，主 URL 不同
 *      → eventId 不同，按 id 拦不住）。
 * 指纹：事件的 主URL + relatedSources 全部 URL（canonical 归一，去 query 防
 * 跨日 utm 差异）。同事件跨站点时主 URL 变了，但 relatedSources 往往互相
 * 收编了对方的文章（实测阳光电源埃及 3 个 URL 全部重叠），集合交集即可命中。
 *
 * 数据文件 feeds/exposure-history.json（随每日 bot commit 跨日传递）：
 *   { "exposed": { "<canonical url>": "YYYY-MM-DD" } }
 */
import { canonicalUrl } from './compat.mjs';

/** 事件的 URL 指纹集合：主 URL + relatedSources 的 URL，canonical 归一、去空。 */
export function eventFingerprint(ev) {
  const urls = [ev?.url, ...(ev?.relatedSources || []).map(r => r.url)]
    .map(u => canonicalUrl(u))
    .filter(Boolean);
  return [...new Set(urls)];
}

/** 日历日差（today - dateStr，单位天）。dateStr 为 YYYY-MM-DD；非法/未来日期返回 NaN。 */
function dayDiff(today, dateStr) {
  const t = new Date(`${today}T00:00:00Z`).getTime();
  const d = new Date(`${dateStr}T00:00:00Z`).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(d)) return NaN;
  return Math.round((t - d) / 86400e3);
}

/**
 * 事件是否在近 N 天内已曝光过（任一指纹 URL 命中 exposedUrls 即算）。
 * @param {object} ev 事件对象（url / relatedSources）
 * @param {Set<string>} exposedUrls canonical URL 集合（exposedUrlSet 的产物）
 */
export function isRecentlyExposed(ev, exposedUrls) {
  if (!exposedUrls || !exposedUrls.size) return false;
  return eventFingerprint(ev).some(u => exposedUrls.has(u));
}

/**
 * 从历史文件数据取「近 days 天已曝光」的 URL 集合。
 * 同日（差 0 天）也算曝光——每天构建 2 次，第二次构建不应重复第一次的榜单。
 * @param {{exposed?: Record<string,string>}} history
 * @param {string} today YYYY-MM-DD（北京日历日，toISODate 产出）
 * @param {number} days 窗口天数
 */
export function exposedUrlSet(history, today, days = 3) {
  const out = new Set();
  const exposed = history?.exposed || {};
  for (const [url, date] of Object.entries(exposed)) {
    const diff = dayDiff(today, date);
    if (Number.isFinite(diff) && diff >= 0 && diff < days) out.add(url);
  }
  return out;
}

/**
 * 记录曝光：把事件们的指纹并入历史（已存在的 URL 刷新日期），不改变入参。
 * @returns {object} 新历史对象 { exposed: {url: date} }
 */
export function recordExposure(history, events, date) {
  const exposed = { ...(history?.exposed || {}) };
  for (const ev of events || []) {
    for (const u of eventFingerprint(ev)) exposed[u] = date;
  }
  return { exposed };
}

/**
 * 清理窗口外的旧条目并限制总体积（防止历史文件无限膨胀）。
 * @returns {object} 新历史对象
 */
export function pruneExposure(history, today, days = 3, maxEntries = 1000) {
  const entries = Object.entries(history?.exposed || {})
    .filter(([, date]) => {
      const diff = dayDiff(today, date);
      return Number.isFinite(diff) && diff >= 0 && diff < days;
    })
    // 体积超限时保留最近的（日期大的在前；同日按 key 稳定排序）
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : (a[0] < b[0] ? -1 : 1)))
    .slice(0, maxEntries);
  return { exposed: Object.fromEntries(entries) };
}
