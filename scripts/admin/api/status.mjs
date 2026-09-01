/**
 * GET /api/status — 仓库与数据状态快照。
 *
 * 返回：分支、未提交文件、领先/落后（fetch 失败时降级 unknown）、gh 登录态、
 * 当前数据日期与 overrides 文件存在性。UI 顶部状态条与发布页共用。
 */
import { git, ghAuthed } from '../lib/git.mjs';
import { readJson, exists } from '../lib/jsonfile.mjs';
import { PATHS } from '../lib/paths.mjs';
import { jsonOk } from '../router.mjs';

export function register(router) {
  router.add('GET', '/api/status', async (ctx) => {
    const [branchRes, statusRes] = await Promise.all([
      git('rev-parse', '--abbrev-ref', 'HEAD'),
      git('status', '--porcelain=v1')
    ]);

    if (branchRes.code !== 0) {
      throw Object.assign(new Error(`git rev-parse 失败: ${branchRes.stderr}`), { statusCode: 500 });
    }

    // 未提交文件（porcelain: XY path）
    const dirtyFiles = statusRes.stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .map((l) => ({ code: l.slice(0, 2).trim() || '?', path: l.slice(3) }));

    // 领先/落后：fetch 尽力而为，失败降级 unknown
    let aheadCount = null;
    let behindCount = null;
    await git('fetch', 'origin', 'main', '--quiet', { timeout: 20000 });
    const count = await git('rev-list', '--left-right', '--count', 'origin/main...HEAD');
    if (count.code === 0) {
      const [left, right] = count.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
      behindCount = Number.isFinite(left) ? left : null;
      aheadCount = Number.isFinite(right) ? right : null;
    }

    // 数据日期（只读 daily-v2，缺失回退 V1）
    let dataDate = null;
    let generatedAt = null;
    const dailyV2 = await readJson(PATHS.dailyV2);
    const daily = dailyV2 || (await readJson(PATHS.dailyV1));
    if (daily) {
      dataDate = daily.date || null;
      generatedAt = daily.generatedAt || null;
    }

    const [ghOk, overridesExists] = await Promise.all([
      ghAuthed(),
      exists(PATHS.editorialOverrides)
    ]);

    jsonOk(ctx, {
      branch: branchRes.stdout.trim(),
      dirtyFiles,
      dirtyCount: dirtyFiles.length,
      aheadCount,
      behindCount,
      ghAuthed: ghOk,
      dataDate,
      generatedAt,
      overridesExists
    });
  });
}
