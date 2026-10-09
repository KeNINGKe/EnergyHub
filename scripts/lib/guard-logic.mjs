/**
 * 日报守卫判定逻辑 —— 纯函数，无副作用、无 Node 专属 API。
 *
 * 两处复用，逻辑必须单源：
 *   - scripts/guard-daily-report.mjs   GitHub Actions 内置守卫（cron 08:13/08:33）
 *   - worker/guard.mjs                 Cloudflare Workers Cron 外部守卫（兜底
 *                                      GitHub schedule 被整体丢弃的情况，
 *                                      2026-10-09 事故：cron 与内置守卫双双
 *                                      被 GitHub 静默丢弃，两道防线同源失效）
 */

const BEIJING_OFFSET_MIN = 8 * 60; // UTC+8，无夏令时
export const PUSH_STEP_NAME = 'Push daily hot list to DingTalk';
export const FETCH_WORKFLOW_FILE = 'fetch-feeds.yml';

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
