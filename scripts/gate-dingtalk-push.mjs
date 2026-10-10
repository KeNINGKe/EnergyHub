#!/usr/bin/env node
/**
 * 钉钉推送防重闸门 —— fetch-feeds 推送步骤的前置检查。
 *
 * 本 run 推送前查当天早晨窗口（北京 04:00 起）内是否已有**其他** run 成功
 * 执行过「Push daily hot list to DingTalk」——有则本 run 跳过推送。
 * 判定逻辑与守卫单源（scripts/lib/guard-logic.mjs decidePushGate）。
 *
 * 背景（2026-10-10 双推事故）：GitHub schedule 迟到 3.5h+，外部守卫 08:07
 * 补发推送成功，迟到的主调度 08:18 又推一次，两次构建相差 10 分钟内容不同。
 *
 * 用法（fetch-feeds.yml 推送步骤内）：
 *   node scripts/gate-dingtalk-push.mjs
 *
 * 环境变量：
 *   GH_TOKEN           必填（CI 里用 secrets.GITHUB_TOKEN）
 *   GITHUB_REPOSITORY  自动注入（owner/repo）
 *   GITHUB_RUN_ID      自动注入（本 run id，排除自己）
 *   PUSH_GATE_BYPASS   'true' 时直接放行（手动 dispatch 强制推送测试用）
 *
 * 退出码：0 = 无人推过，可以推送；3 = 已有其他 run 推过，跳过；
 *         1 = API 失败。调用方约定：3 跳过；0 与 1 都按「推送」处理——
 *         查询失败时宁可重复推送，不可缺报。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 判定逻辑与守卫（guard-daily-report / worker/guard）单源复用
import { FETCH_WORKFLOW_FILE, morningWindowStartUtc, pushStepSucceeded, decidePushGate } from './lib/guard-logic.mjs';

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

  if (process.env.PUSH_GATE_BYPASS === 'true') {
    console.log('PUSH_GATE_BYPASS=true，跳过防重检查直接推送。');
    process.exit(0);
  }

  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const selfRunId = Number(process.env.GITHUB_RUN_ID);
  if (!token || !repo || !Number.isFinite(selfRunId) || selfRunId <= 0) {
    console.error('缺少 GH_TOKEN / GITHUB_REPOSITORY / GITHUB_RUN_ID，闸门无法判定。');
    process.exit(1);
  }

  const since = morningWindowStartUtc().toISOString();
  const listUrl = `https://api.github.com/repos/${repo}/actions/workflows/${FETCH_WORKFLOW_FILE}/runs?per_page=30&created=>=${since}`;
  const listRes = await api(listUrl, token);
  if (!listRes.ok) {
    console.error(`查询 workflow runs 失败：HTTP ${listRes.status}（按可推送处理，宁可重复不可缺报）`);
    process.exit(1);
  }
  const { workflow_runs: runs } = await listRes.json();

  const hasPushed = async (run) => {
    const jobsRes = await api(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`, token);
    if (!jobsRes.ok) return false;
    const { jobs } = await jobsRes.json();
    return jobs.some(pushStepSucceeded);
  };

  const action = await decidePushGate(runs, hasPushed, selfRunId);
  if (action === 'skip') {
    console.log('今日日报已由其他 run 推送，本 run 跳过（推送防重闸门）。');
    process.exit(3);
  }
  console.log(`早晨窗口内无其他 run 推送成功（共 ${runs.length} 个 run），允许推送。`);
}

await main();
