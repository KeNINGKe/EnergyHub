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

/**
 * 推送防重闸门（2026-10-10 双推事故）：本 run 推送前检查早晨窗口内是否已有
 * **其他** run 成功执行过推送步骤——有则本 run 跳过，保证「每天只推一次」。
 *
 * 事故还原：GitHub schedule 又被延迟（08:17 才跑），外部守卫 08:07 判定漏推
 * 并 dispatch 补发（08:10 已推送）；迟到的主调度重建后 08:18 又推了一次，
 * 两次构建相差 10 分钟导致内容不一致。守卫与迟到 run 各自行为都正确，
 * 缺的是推送侧的幂等保护。
 *
 * 残余窗口：两个 run 的推送步骤在几秒内先后执行时仍可能双推（查询都在对方
 * 完成前发生）——守卫 08:07 与 cron 最早 08:00 后到达，间隔通常在分钟级，
 * 可接受。
 *
 * @param {Array<{id:number, status:string}>} runs 早晨窗口内的 fetch-feeds runs
 * @param {(run) => Promise<boolean>} hasPushed 查询单个 run 是否包含成功的推送步骤
 * @param {number} selfRunId 本 run 的 id（排除自己）
 * @returns {Promise<'push'|'skip'>}
 */
export async function decidePushGate(runs, hasPushed, selfRunId) {
  const others = runs.filter(r => r.id !== selfRunId && r.status === 'completed');
  for (const run of others) {
    if (await hasPushed(run)) return 'skip';
  }
  return 'push';
}
