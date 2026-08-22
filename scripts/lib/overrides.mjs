#!/usr/bin/env node
/**
 * 人工覆盖配置应用（B-11）。
 *
 * 读取 data/editorial-overrides.json 的 byDate[date]，应用到已生成的
 * daily（事件级）与 featured。配置错误（引用不存在的 id、非法枚举）→
 * 忽略错误条目并记录日志，不破坏自动结果。
 *
 * 支持：
 *   forcedFeaturedIds  强制入选精选（必须存在于 daily）
 *   hiddenIds          从全部动态隐藏（同步移出精选与热点榜）
 *   unfeaturedIds      取消精选
 *   hotEventIds        整体替换今日热点榜（必须存在于 daily）
 *   topics / impacts   修正字段（枚举合法才生效）
 *   summaries / whyItMatters 覆盖文本
 *   observations       覆盖今日观察
 *   mergeGroups        合并事件（保留第一个为主，其余并入 relatedSources）
 *
 * 用法：
 *   import { loadOverrides, applyOverrides } from './overrides.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OVERRIDES_PATH = path.join(ROOT, 'data', 'editorial-overrides.json');

/** 读取覆盖配置；文件缺失或非法返回空配置。 */
export async function loadOverrides() {
  try {
    return JSON.parse(await fs.readFile(OVERRIDES_PATH, 'utf8'));
  } catch {
    return { schemaVersion: 1, byDate: {} };
  }
}

/**
 * 应用某日期的覆盖配置。
 * @param {object} daily daily V2（含 items）
 * @param {object} featured featured
 * @param {object} config 覆盖配置对象（byDate[date] 部分）
 * @param {object} enums 枚举（用于校验 topic/impact 合法性）
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function applyOverrides(daily, featured, config, enums) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== 'object') return { errors, warnings };

  const byId = new Map();
  for (const ev of daily.items) byId.set(ev.id, ev);

  const validTopic = new Set(enums.topics.map(t => t.id));
  const validImpact = new Set(enums.impacts.map(i => i.id));

  const ensure = (list) => Array.isArray(list) ? list : [];

  // 1. 隐藏事件（同步移出精选与热点榜，避免引用悬空导致校验失败）
  for (const id of ensure(config.hiddenIds)) {
    const ev = byId.get(id);
    if (!ev) { errors.push(`hiddenIds 引用不存在的 id: ${id}`); continue; }
    daily.items = daily.items.filter(e => e.id !== id);
    byId.delete(id);
    featured.featuredEventIds = featured.featuredEventIds.filter(x => x !== id);
    if (Array.isArray(featured.hotEventIds)) {
      featured.hotEventIds = featured.hotEventIds.filter(x => x !== id);
    }
  }

  // 1.5 今日热点榜整体替换（在隐藏之后执行，引用仍存在的 id）
  if (config.hotEventIds != null) {
    if (!Array.isArray(config.hotEventIds)) {
      errors.push('hotEventIds 应为字符串数组');
    } else {
      const next = [];
      for (const id of config.hotEventIds) {
        if (!byId.has(id)) { errors.push(`hotEventIds 引用不存在的 id: ${id}`); continue; }
        if (!next.includes(id)) next.push(id);
      }
      featured.hotEventIds = next;
    }
  }

  // 2. 强制精选（存在才加入，且不重复）
  if (Array.isArray(config.forcedFeaturedIds)) {
    for (const id of config.forcedFeaturedIds) {
      if (!byId.has(id)) { errors.push(`forcedFeaturedIds 引用不存在的 id: ${id}`); continue; }
      if (!featured.featuredEventIds.includes(id)) featured.featuredEventIds.push(id);
    }
  }

  // 3. 取消精选
  for (const id of ensure(config.unfeaturedIds)) {
    if (!featured.featuredEventIds.includes(id)) { warnings.push(`unfeaturedIds 不在精选: ${id}`); }
    featured.featuredEventIds = featured.featuredEventIds.filter(x => x !== id);
  }

  // 4. 字段修正（topic / impact）
  for (const [id, topic] of Object.entries(config.topics || {})) {
    const ev = byId.get(id);
    if (!ev) { errors.push(`topics 引用不存在的 id: ${id}`); continue; }
    if (!validTopic.has(topic)) { errors.push(`topics 非法枚举: ${id} → ${topic}`); continue; }
    ev.topic = topic;
  }
  for (const [id, impact] of Object.entries(config.impacts || {})) {
    const ev = byId.get(id);
    if (!ev) { errors.push(`impacts 引用不存在的 id: ${id}`); continue; }
    if (!validImpact.has(impact)) { errors.push(`impacts 非法枚举: ${id} → ${impact}`); continue; }
    ev.impact = impact;
  }

  // 5. 文本覆盖
  for (const [id, s] of Object.entries(config.summaries || {})) {
    const ev = byId.get(id);
    if (!ev) { errors.push(`summaries 引用不存在的 id: ${id}`); continue; }
    ev.summary = s;
  }
  for (const [id, s] of Object.entries(config.whyItMatters || {})) {
    const ev = byId.get(id);
    if (!ev) { errors.push(`whyItMatters 引用不存在的 id: ${id}`); continue; }
    ev.whyItMatters = s;
  }

  // 6. 今日观察覆盖
  if (Array.isArray(config.observations) && config.observations.length) {
    featured.observations = config.observations.slice(0, 5);
  }

  // 7. 事件合并：保留第一个为主，其余并入 relatedSources
  for (const group of ensure(config.mergeGroups)) {
    if (!Array.isArray(group) || group.length < 2) { warnings.push('mergeGroups 条目需 ≥2 个 id'); continue; }
    const ids = group.filter(id => byId.has(id));
    const missing = group.filter(id => !byId.has(id));
    for (const m of missing) errors.push(`mergeGroups 引用不存在的 id: ${m}`);
    if (ids.length < 2) continue;
    const [main, ...rest] = ids;
    const mainEv = byId.get(main);
    for (const r of rest) {
      const rEv = byId.get(r);
      const seen = new Set(mainEv.relatedSources.map(s => s.url));
      if (!seen.has(rEv.url)) {
        mainEv.relatedSources.push({ name: rEv.source.name, url: rEv.url });
      }
      daily.items = daily.items.filter(e => e.id !== r);
      byId.delete(r);
      featured.featuredEventIds = featured.featuredEventIds.filter(x => x !== r);
    }
  }

  return { errors, warnings };
}
