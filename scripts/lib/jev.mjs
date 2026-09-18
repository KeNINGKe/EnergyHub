#!/usr/bin/env node
/**
 * Jev 概率决策模型复审（TypeSafe AI / Vercel AI Gateway）。
 *
 * 作用：关键词硬过滤（filter.mjs）被拒的条目交 Jev 复判「是否真的无关」，
 * 高置信相关的捞回管线，降低关键词误杀；关键词快速通道保持不变。
 *
 * 配置：
 *   AI_GATEWAY_API_KEY  Vercel AI Gateway 密钥（未配置则整体跳过，行为同旧版）
 *   JEV_REVIEW=off      显式关闭复审
 *   JEV_RESCUE_THRESHOLD  捞回阈值，relevant 概率 ≥ 该值才捞回（默认 0.8）
 *
 * 容错：单条调用失败/超时返回 null verdict，条目维持被拒——复审是增益，
 * 不能阻塞构建。AI SDK 的 evaluate 仅在 AI SDK 7+ 提供，无 OpenAI 兼容端点。
 *
 * 用法：
 *   import { jevConfigured, reviewRejected, shouldRescue } from './jev.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { experimental_evaluate as evaluate } from 'ai';

const MODEL = 'typesafe-ai/jev';
const CONCURRENCY = 3;          // 并发上限，避免触发 Gateway 限流
const TIMEOUT_MS = 20_000;      // 单条超时；超时视为「无 verdict」

/** Jev 复审是否启用（有 key 且未被显式关闭）。 */
export function jevConfigured() {
  return Boolean(process.env.AI_GATEWAY_API_KEY) && process.env.JEV_REVIEW !== 'off';
}

/** 捞回阈值（可通过 JEV_RESCUE_THRESHOLD 覆盖）。 */
export function rescueThreshold() {
  const v = Number(process.env.JEV_RESCUE_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.8;
}

/** verdict 是否达到捞回标准。 */
export function shouldRescue(verdict, threshold = rescueThreshold()) {
  return Boolean(verdict && verdict.relevant && verdict.probability >= threshold);
}

/** 由 enums.json 构建主题 Choice 的 criteria（id → 中文说明）。 */
export function topicCriteria(enums) {
  const out = {};
  for (const t of enums?.topics || []) {
    out[t.id] = t.label || t.id;
  }
  return out;
}

/** 单条判定：relevant 布尔 + 主题 Choice，一次请求并行回答。 */
export async function reviewOne(item, enums) {
  const state = {
    title: item.translatedTitle || item.title || '',
    summary: String(item.summary || '').slice(0, 1200),
    source: item.source || '',
  };
  if (!state.title && !state.summary) return null;

  const op = evaluate({
    model: MODEL,
    state,
    questions: {
      relevant: {
        type: 'boolean',
        instructions:
          '这是否是一条值得收录进能源/电力行业信息站的新闻？' +
          '覆盖：储能、PCS/逆变器、固态变压器(SST)、AIDC数据中心供电与配电、' +
          '电网/输配电、光伏风电、核电SMR、燃气备用电源、温控散热、' +
          '绿电PPA、电力市场与政策、芯片与算力供给。' +
          '纯招聘/广告/股市行情/与能源无关的科技新闻为 false。',
        criteria: {
          true: '主题或主体与上述能源/电力领域明确相关',
          false: '与能源/电力领域无实质关联，或仅为泛科技/财经内容',
        },
      },
      topic: {
        type: 'choice',
        instructions: '把这条内容归入最贴切的一个主题。',
        criteria: topicCriteria(enums),
      },
    },
  });
  // 注：不带 providerOptions.gateway.zeroDataRetention —— 该项要求 Vercel
  // Pro/Enterprise 套餐，Hobby 下整个请求会被拒（2026-09-18 实测）。

  // evaluate 未文档化超时参数，用 Promise.race 兜底，避免单条挂死整个构建
  const result = await Promise.race([
    op,
    new Promise((_, rej) => setTimeout(() => rej(new Error('jev timeout')), TIMEOUT_MS)),
  ]).catch(() => null);
  if (!result?.answers?.relevant) return null;

  const rel = result.answers.relevant;
  const topicAns = result.answers.topic;
  return {
    relevant: rel.probability >= 0.5,
    probability: rel.probability,
    topic: topicAns?.choice && enums.topics?.some(t => t.id === topicAns.choice)
      ? topicAns.choice
      : null,
  };
}

/**
 * 批量复判被拒条目。返回与 items 等长的 verdict 数组（失败位为 null）。
 * @param {Array<object>} items 关键词过滤被拒的原始条目
 * @param {object} enums data/enums.json（提供主题枚举）
 */
export async function reviewRejected(items, enums) {
  const verdicts = new Array(items.length).fill(null);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      verdicts[i] = await reviewOne(items[i], enums);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker())
  );
  return verdicts;
}

// CLI 自检：node scripts/lib/jev.mjs "测试标题"（需 AI_GATEWAY_API_KEY）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!jevConfigured()) {
    console.error('未配置 AI_GATEWAY_API_KEY');
    process.exit(1);
  }
  const enums = JSON.parse(await fs.readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/enums.json'), 'utf8'));
  const title = process.argv[2] || 'NVIDIA unveils 800 VDC power architecture for AI data centers';
  const v = await reviewOne({ title, summary: '', source: 'manual' }, enums);
  console.log(JSON.stringify(v, null, 2));
}
