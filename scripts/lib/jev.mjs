#!/usr/bin/env node
/**
 * Jev 概率决策模型接入（TypeSafe AI 直连 API）。
 *
 * 职责一（复审捞回）：关键词硬过滤（filter.mjs）被拒的条目交 Jev 复判
 * 「是否真的无关」，高置信相关的捞回，降低关键词误杀。
 * 职责二（主题仲裁）：关键词主题提取（extract.mjs extractTopics）给出
 * 空主题或兜底档 other-energy 时，交 Jev Choice 归入具体主题。
 *
 * 配置：
 *   TYPESAFE_API_KEY    TypeSafe API 密钥（apikey_ 前缀；未配置则整体跳过，行为同旧版）
 *   JEV_REVIEW=off      显式关闭 Jev 全部介入
 *   JEV_RESCUE_THRESHOLD  捞回阈值，relevant 概率 ≥ 该值才捞回（默认 0.65，校准见 scripts/jev-calibrate.mjs）
 *
 * 传输（2026-09-21 由 Vercel AI Gateway 免费档切换为直连）：
 *   - 免费档网关对该模型限流极紧（并发 3 连发约 4 条即封、封锁数分钟），
 *     只能串行 + 15s 间隔 + 8min 预算，112 条校准要 30~45 分钟；
 *   - 直连实测：单条 1~2s，4 并发连发无 429（2026-09-21），故改为小并发池；
 *   - 仍保留 429/529 退避与总预算：Jev 是增益，不能阻塞构建。
 *
 * 容错：单条失败/超时/限流放弃 → 该条维持原判定（被拒维持被拒，
 * 无主题维持 other-energy）。
 *
 * 用法：
 *   import { jevConfigured, reviewRejected, shouldRescue, reviewTopics } from './jev.mjs';
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const CONCURRENCY = 4;              // 小并发池：直连实测 4 并发无 429
const RATE_LIMIT_WAIT_MS = 20_000;  // 429/529 后退避等待（按次翻倍）
const MAX_RATE_LIMIT_RETRIES = 2;   // 单条最多退避重试次数
const BUDGET_MS = 8 * 60_000;      // 整批复审总预算：超时放弃剩余条目（CI 保护）
const TIMEOUT_MS = 20_000;         // 单条超时；超时视为「无 verdict」

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Jev 复审是否启用（有 key 且未被显式关闭）。 */
export function jevConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY) && process.env.JEV_REVIEW !== 'off';
}

/** 捞回阈值（可通过 JEV_RESCUE_THRESHOLD 覆盖）。 */
export function rescueThreshold() {
  const v = Number(process.env.JEV_RESCUE_THRESHOLD);
  // 0.65：2026-09-21 直连 API 校准（112 条标注，samples/annotations/jev-calibration.json）
  // 精确率 0.96 / 召回率 0.65——0.8 时精确率 1.00 但漏掉固态电池/数据中心供电等
  // 硬货；0.6 以下灰区真假各半。下游 importance 评分会再筛软误报。
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.65;
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

async function callJev(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`jev api ${res.status}: ${body.slice(0, 200)}`);
      e.statusCode = res.status;
      throw e;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const isRateLimit = (e) => e?.statusCode === 429 || e?.statusCode === 529 || /rate.?limit/i.test(String(e?.message || e));

/**
 * 单条判定：relevant 布尔 + 主题 Choice，一次请求并行回答。
 * 出错时抛出（含限流/超时错误），由调用方决定退避/放弃。
 */
export async function reviewOne(item, enums) {
  const state = {
    title: item.translatedTitle || item.title || '',
    summary: String(item.summary || '').slice(0, 1200),
    source: item.source || '',
  };
  if (!state.title && !state.summary) return null;

  const result = await callJev({
    model: MODEL,
    state,
    questions: {
      relevant: {
        type: 'noul',
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
  if (!result?.answers?.relevant) return null;

  const rel = result.answers.relevant;
  const topicAns = result.answers.topic;
  const p = rel.noul;
  if (typeof p !== 'number') return null;
  return {
    relevant: p >= 0.5,
    probability: p,
    topic: topicAns?.choice && enums.topics?.some(t => t.id === topicAns.choice)
      ? topicAns.choice
      : null,
  };
}

/**
 * 通用批量执行：小并发池 + 限流退避 + 总预算。
 * task 抛错（限流除外）该条放弃保持 null；返回与 items 等长的结果数组。
 */
async function runPool(items, task, opts = {}) {
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const what = opts.label || 'Jev';
  const results = new Array(items.length).fill(null);
  const startedAt = Date.now();
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length || Date.now() - startedAt > budgetMs) return;
      for (let attempt = 0; ; attempt++) {
        try {
          results[i] = await task(items[i]);
          break;
        } catch (e) {
          if (isRateLimit(e) && attempt < MAX_RATE_LIMIT_RETRIES) {
            const wait = RATE_LIMIT_WAIT_MS * (attempt + 1);
            console.warn(`${what}: 第 ${i + 1} 条触发限流，退避 ${wait / 1000}s 重试（${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}）`);
            await sleep(wait);
            continue;
          }
          break; // 超时/其他错误：该条放弃
        }
      }
    }
  }

  if (!items.length) return results;
  if (Date.now() - startedAt > budgetMs) {
    console.warn(`${what}: 总预算 ${budgetMs / 60000}min 已耗尽，全部 ${items.length} 条跳过`);
  } else {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    const skipped = items.length - Math.min(next, items.length);
    if (skipped > 0) {
      console.warn(`${what}: 预算耗尽，剩余 ${skipped} 条跳过`);
    }
  }
  return results;
}

/**
 * 批量复判被拒条目（小并发池 + 限流退避 + 总预算）。
 * 返回与 items 等长的 verdict 数组（失败/放弃位为 null）。
 * @param {Array<object>} items 关键词过滤被拒的原始条目
 * @param {object} enums data/enums.json（提供主题枚举）
 */
export async function reviewRejected(items, enums, opts = {}) {
  return runPool(items, (item) => reviewOne(item, enums), { ...opts, label: 'Jev 复审' });
}

/**
 * 是否需要主题仲裁：Jev 已判过主题（捞回条目）不重复；关键词
 * 给出具体主题（非空且非兜底档 other-energy）时无需仲裁。
 * @param {{topics: string[]}} ex extractItem 的提取结果
 * @param {object} item 原始条目（看 _jev 标记）
 */
export function needsTopicArbitration(ex, item) {
  if (item?._jev?.topic) return false;
  const first = ex?.topics?.[0];
  return !first || first === 'other-energy';
}

/**
 * 单条主题仲裁：Choice 归入最贴切主题，返回主题 id（校验过枚举）或 null。
 * other-energy 留在 criteria 里：Jev 也认为无具体主题时可显式归入兜底档。
 */
export async function reviewTopic(item, enums) {
  const state = {
    title: item.translatedTitle || item.title || '',
    summary: String(item.summary || '').slice(0, 1200),
    source: item.source || '',
  };
  if (!state.title && !state.summary) return null;

  const result = await callJev({
    model: MODEL,
    state,
    questions: {
      topic: {
        type: 'choice',
        instructions:
          '把这条内容归入最贴切的一个主题。优先选择具体主题（按主题说明判断主体内容）；' +
          '仅当确实无法归入任何具体主题时才选 other-energy。',
        criteria: topicCriteria(enums),
      },
    },
  });
  const choice = result?.answers?.topic?.choice;
  return enums.topics?.some(t => t.id === choice) ? choice : null;
}

/**
 * 批量主题仲裁。返回与 items 等长的主题 id 数组（失败/放弃位为 null）。
 * @param {Array<object>} items 需要仲裁的条目
 * @param {object} enums data/enums.json（提供主题枚举）
 */
export async function reviewTopics(items, enums, opts = {}) {
  return runPool(items, (item) => reviewTopic(item, enums), { ...opts, label: 'Jev 主题仲裁' });
}

/**
 * 单对判定：两条内容是否报道同一个具体事件。
 * @returns {number|null} noul 概率（1=同一事件），失败/无有效回答为 null
 */
export async function reviewPair(a, b) {
  const brief = (x) => ({
    title: x.title || '',
    originalTitle: x.originalTitle || '',
    summary: String(x.summary || '').slice(0, 600),
    source: x.source || '',
    publishedAt: x.publishedAt || null,
  });
  const state = { first: brief(a), second: brief(b) };

  const result = await callJev({
    model: MODEL,
    state,
    questions: {
      same: {
        type: 'noul',
        instructions:
          'first 和 second 是否报道同一个具体事件（同一公告/同一项目/同一笔交易/' +
          '同一事故等）？同主题但主体不同（如两家公司各自独立的储能项目、' +
          '同系列的不同型号发布）为 false。originalTitle 是标题的英文原文，' +
          '与 title（中文译名）指同一篇报道。',
        criteria: {
          true: '两条报道的核心事实指向同一事件，只是措辞/语言/详略不同',
          false: '两条是不同事件，或分别报道同类事件的不同主体',
        },
      },
    },
  });
  const n = result?.answers?.same?.noul;
  return typeof n === 'number' ? n : null;
}

/**
 * 批量同事件判定（灰区配对语义合并仲裁）。
 * @param {Array<[object, object]>} pairs 条目对
 * @returns {Array<number|null>} 每对的 noul 概率（失败/放弃位为 null）
 */
export async function reviewPairs(pairs, opts = {}) {
  return runPool(pairs, ([a, b]) => reviewPair(a, b), { ...opts, label: 'Jev 语义合并' });
}

// CLI 自检：node scripts/lib/jev.mjs "测试标题"（需 TYPESAFE_API_KEY）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!jevConfigured()) {
    console.error('未配置 TYPESAFE_API_KEY');
    process.exit(1);
  }
  const enums = JSON.parse(await fs.readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/enums.json'), 'utf8'));
  const title = process.argv[2] || 'NVIDIA unveils 800 VDC power architecture for AI data centers';
  try {
    const v = await reviewOne({ title, summary: '', source: 'manual' }, enums);
    console.log(JSON.stringify(v, null, 2));
  } catch (e) {
    console.error('失败:', e?.message || e);
    process.exit(1);
  }
}
