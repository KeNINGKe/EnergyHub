#!/usr/bin/env node
/**
 * 摘要清洗 + 推荐理由生成（B-09）。
 *
 * - cleanSummary：去 HTML 标签、去样板尾句（Read more / 原文链接等）、合并空白、限长
 * - generateWhyItMatters：基于主题/数字/实体/地区生成可解释的推荐理由候选
 *   （可解释：人能看懂为什么推荐；编辑可经 B-11 覆盖）
 *
 * 用法：
 *   import { cleanSummary, generateWhyItMatters } from './clean.mjs';
 */

const TAIL_PATTERNS = [
  /read more[.\s]*$/i,
  /continue reading[.\s]*$/i,
  /click here[.\s]*$/i,
  /\[?\s*(source|via|origin):.*$/i,
  /加载全文.*$/,
  /阅读原文.*$/,
  /查看详情.*$/,
  /\s?→+\s*$/,
  /\s?›+\s*$/
];

/** 清洗 RSS 摘要：去标签、样板、合并空白、限长。 */
export function cleanSummary(raw, { maxLen = 140 } = {}) {
  let s = String(raw || '');
  s = s.replace(/<[^>]+>/g, ' ');           // HTML 标签
  s = s.replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'")
       .replace(/&nbsp;/g, ' ');            // 实体解码
  for (const re of TAIL_PATTERNS) s = s.replace(re, '');
  s = s.replace(/\s+/g, ' ').trim();        // 合并空白
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  return s;
}

/**
 * 生成可解释的推荐理由候选。
 * @param {object} item 含 topic / metrics / entities / region / sourceType / source
 * @param {object} enums data/enums.json
 * @returns {string}
 */
export function generateWhyItMatters(item, enums) {
  const parts = [];
  const topic = enums.topics.find(t => t.id === item.topic);
  if (topic) parts.push(topic.label);
  if (item.metrics?.length) {
    parts.push(`关键数字 ${item.metrics.slice(0, 3).map(m => `${m.value}${m.unit}`).join('、')}`);
  }
  if (item.entities?.length) {
    parts.push(`关联 ${item.entities.slice(0, 3).join('、')}`);
  }
  if (item.region && item.region !== '未知') parts.push(`地区 ${item.region}`);
  const typeLabel = { primary: '一手来源', research: '研究机构', media: '媒体', community: '社区' }[item.sourceType] || '';
  if (typeLabel && item.source) parts.push(`${typeLabel} ${item.source}`);
  if (!parts.length) parts.push('行业动态');
  return parts.join('；');
}

// CLI 自检
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  console.log(cleanSummary(process.argv[2] || ''));
}
