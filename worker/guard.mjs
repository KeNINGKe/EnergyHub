/**
 * EnergyHub 日报外部守卫 —— Cloudflare Workers Cron 兜底。
 *
 * 为什么需要它（2026-10-09 事故）：GitHub Actions 的 schedule 会静默丢弃
 * （当天 20:37 UTC 的 fetch-feeds 与 00:13 的内置守卫 report-guard.yml
 * 双双没触发，状态页"一切正常"）。内置守卫与主工作流同在 GitHub 调度上，
 * 等于单点。本 worker 部署在 Cloudflare 上，cron 与 GitHub 完全独立，
 * 是第三道防线。
 *
 * 两轮 cron（UTC，= 北京时间）：
 *   00:07（08:07）—— 早于内置守卫 08:13，"调度被整体丢弃"当天能更早补发；
 *   00:41（08:41）—— 兜住内置守卫 08:13/08:33 两轮都没跑 / 没起作用的情况。
 *
 * 判定逻辑与 scripts/guard-daily-report.mjs 单源（scripts/lib/guard-logic.mjs）：
 * 查当天早晨窗口内 fetch-feeds 各 run 的「Push daily hot list to DingTalk」
 * 步骤是否成功；未推且无在跑构建 → dispatch fetch-feeds 补发（dispatch 模式
 * 不等待 08:00、必推钉钉）。
 *
 * 触发补发或自身出错时，向钉钉群发一条运维告警（best-effort，不阻塞补发）。
 * 由 deploy.yml 在 CI 里从仓库 secrets 同步：GH_PAT / DINGTALK_WEBHOOK /
 * DINGTALK_WEBHOOK_SECRET（见 deploy.yml 的「Sync guard worker secrets」步骤）。
 *
 * 本地验证（无需 Cloudflare 登录）：
 *   npx wrangler dev -c wrangler-guard.jsonc --test-scheduled
 *   curl "http://localhost:8787/__scheduled?cron=7+0+*+*+*"
 * （secrets 放 .dev.vars，已 gitignore）
 */
import {
  FETCH_WORKFLOW_FILE,
  morningWindowStartUtc,
  pushStepSucceeded,
  decideGuardAction,
} from '../scripts/lib/guard-logic.mjs';

async function gh(url, token, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'energyhub-guard-worker', // GitHub API 要求显式 UA
      ...(init.headers || {}),
    },
  });
}

/**
 * 检查当天日报并按需补发。
 * @returns {Promise<'ok'|'wait'|'dispatched'>}
 */
async function checkAndRescue(env, log) {
  const repo = env.GH_REPO;
  const since = morningWindowStartUtc().toISOString();
  const listRes = await gh(
    `https://api.github.com/repos/${repo}/actions/workflows/${FETCH_WORKFLOW_FILE}/runs?per_page=20&created=>=${since}`,
    env.GH_PAT,
  );
  if (!listRes.ok) throw new Error(`查询 workflow runs 失败：HTTP ${listRes.status}`);
  const { workflow_runs: runs } = await listRes.json();
  log(`早晨窗口（北京 04:00 起）fetch-feeds runs：${runs.length} 个`);

  const hasPushed = async (run) => {
    const jobsRes = await gh(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs`, env.GH_PAT);
    if (!jobsRes.ok) return false;
    const { jobs } = await jobsRes.json();
    return jobs.some(pushStepSucceeded);
  };

  const action = await decideGuardAction(runs, hasPushed);
  if (action === 'ok') {
    log('今日钉钉日报已推送，无需处理。');
    return 'ok';
  }
  if (action === 'wait') {
    log('有 fetch-feeds run 仍在跑，本轮跳过（下一轮 cron 再查）。');
    return 'wait';
  }

  log('今日日报尚未推送且无在跑构建，dispatch fetch-feeds 补发……');
  const dispatchRes = await gh(
    `https://api.github.com/repos/${repo}/actions/workflows/${FETCH_WORKFLOW_FILE}/dispatches`,
    env.GH_PAT,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main' }) },
  );
  if (dispatchRes.status !== 204) throw new Error(`dispatch 失败：HTTP ${dispatchRes.status}`);
  log('已触发补发（约 5 分钟后推送）。');
  return 'dispatched';
}

/** Web Crypto 版钉钉加签（worker 里没有 node:crypto）。 */
async function dingtalkSign(secret, timestamp) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}\n${secret}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

/** 运维告警（best-effort）：未配 webhook 或发送失败都不抛错。 */
async function alert(env, text) {
  try {
    if (!env.DINGTALK_WEBHOOK) return;
    const url = new URL(env.DINGTALK_WEBHOOK);
    if (env.DINGTALK_WEBHOOK_SECRET) {
      const ts = Date.now();
      url.searchParams.set('timestamp', String(ts)); // set 自带百分号编码
      url.searchParams.set('sign', await dingtalkSign(env.DINGTALK_WEBHOOK_SECRET, ts));
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    });
    if (!res.ok) console.error(`告警发送失败：HTTP ${res.status}`);
  } catch (e) {
    console.error(`告警发送异常：${e.message}`);
  }
}

export default {
  async scheduled(event, env) {
    const bjTime = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    try {
      const result = await checkAndRescue(env, m => console.log(m));
      if (result === 'dispatched') {
        await alert(env, `⚠️ EnergyHub 外部守卫（Workers Cron）于北京 ${bjTime} 触发补发：未检出今日钉钉推送，已 dispatch fetch-feeds。`);
      }
    } catch (e) {
      console.error(e.message);
      await alert(env, `🚨 EnergyHub 外部守卫（Workers Cron）于北京 ${bjTime} 出错：${e.message}。请人工检查日报。`);
    }
  },
};
