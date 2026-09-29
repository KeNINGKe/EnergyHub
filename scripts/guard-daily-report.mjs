#!/usr/bin/env node
/**
 * 日报推送守卫 —— 每天 08:13/08:33（北京）检查当天钉钉日报是否已发出，
 * 未发出且没有在跑的构建时，自动 dispatch fetch-feeds 补发。
 *
 * 背景（2026-09-29 事故）：GitHub 免费 runner 的 schedule 在整点高峰会被
 * 延迟数小时甚至丢弃，且并发 run 会在 git push 处互相冲突，两者都导致
 * 「构建没跑到钉钉推送一步」。光修 cron 避峰不够，需要事后兜底。
 *
 * 判定逻辑：
 *   1. 查当天早晨窗口（北京 04:00 起）fetch-feeds 的 run；
 *   2. 任一 run 的「Push daily hot list to DingTalk」步骤成功 → 已推送，收工；
 *      （注意不能只看 run 成功：午间构建成功但不含推送步骤）
 *   3. 有 run 还在跑 → 跳过本轮等它（08:33 第二轮兜住其失败）；
 *   4. 否则 dispatch fetch-feeds.yml 补发（dispatch 模式不等待、必推钉钉）。
 *
 * 用法：
 *   node scripts/guard-daily-report.mjs
 *
 * 环境变量：
 *   GH_TOKEN           必填（CI 里用 secrets.GITHUB_TOKEN）
 *   GITHUB_REPOSITORY  自动注入（owner/repo）
 *
 * 退出码：0 = 已推送 / 跳过 / 补发成功；1 = API 或 dispatch 失败
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BEIJING_OFFSET_MIN = 8 * 60; // UTC+8，无夏令时
const PUSH_STEP_NAME = 'Push daily hot list to DingTalk';
const FETCH_WORKFLOW_FILE = 'fetch-feeds.yml';

/**
 * 当天早晨窗口的起点：北京时间今天 04:00（= 通常情况下的前一天 UTC 20:00）。
 * 早晨定时构建（UTC 20:37）及迟到的 run 都落在这个窗口内；更早的窗口会
 * 把前一天白天的手动测试 dispatch 误算成"今天已推送"。
 */
export function morningWindowStartUtc(now = new Date()) {
  const bj = new Date(now.getTime() + BEIJING_OFFSET_MIN * 60 * 1000);
  // 北京今天 04:00 = Date.UTC(北京年,月,日, -4)（负小时自动退到前一天 20:00 UTC）
  return new Date(Date.UTC(
    bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), -4,
  ));
}

/** 某个 job 里钉钉推送步骤是否成功执行（skipped/absent 均不算）。 */
export function pushStepSucceeded(job) {
  return Boolean(
    job && Array.isArray(job.steps)
    && job.steps.some(s => s.name === PUSH_STEP_NAME && s.conclusion === 'success'),
  );
}

/**
 * 由 run 列表决定守卫动作。
 * @param {Array<{status: string}>} runs 早晨窗口内的 fetch-feeds runs
 * @param {(run) => Promise<boolean>} hasPushed 查询单个 run 是否包含成功的推送步骤
 * @returns {Promise<'ok'|'wait'|'dispatch'>}
 */
export async function decideGuardAction(runs, hasPushed) {
  const finished = runs.filter(r => r.status === 'completed');
  for (const run of finished) {
    if (await hasPushed(run)) return 'ok';
  }
  const running = runs.filter(r => r.status === 'in_progress' || r.status === 'queued');
  if (running.length > 0) return 'wait';
  return 'dispatch';
}

async function api(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  return res;
}

async function main() {
  const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  if (!isMain) return; // 被 import 复用纯函数时不执行 CLI

  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.error('缺少 GH_TOKEN 或 GITHUB_REPOSITORY，无法查询/补发。');
    process.exit(1);
  }

  const since = morningWindowStartUtc().toISOString();
  const listUrl = `https://api.github.com/repos/${repo}/actions/workflows/${FETCH_WORKFLOW_FILE}/runs?per_page=20&created=>=${since}`;
  const listRes = await api(listUrl, token);
  if (!listRes.ok) {
    console.error(`查询 workflow runs 失败：HTTP ${listRes.status}`);
    process.exit(1);
  }
  const { workflow_runs: runs } = await listRes.json();
  console.log(`早晨窗口（北京 04:00 起）fetch-feeds runs：${runs.length} 个`);

  const hasPushed = async (run) => {
    const jobsRes = await api(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`, token);
    if (!jobsRes.ok) return false;
    const { jobs } = await jobsRes.json();
    return jobs.some(pushStepSucceeded);
  };

  const action = await decideGuardAction(runs, hasPushed);
  if (action === 'ok') {
    console.log('今日钉钉日报已推送，无需处理。');
    return;
  }
  if (action === 'wait') {
    console.log('有 fetch-feeds run 仍在跑，本轮跳过（08:33 第二轮会再查）。');
    return;
  }

  console.log('今日日报尚未推送且无在跑构建，dispatch fetch-feeds 补发……');
  const dispatchRes = await api(
    `https://api.github.com/repos/${repo}/actions/workflows/${FETCH_WORKFLOW_FILE}/dispatches`,
    token,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main' }) },
  );
  if (dispatchRes.status !== 204) {
    console.error(`dispatch 失败：HTTP ${dispatchRes.status}`);
    process.exit(1);
  }
  console.log('已触发补发（约 5 分钟后推送）。');
}

await main();
