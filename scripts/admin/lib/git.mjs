/**
 * git / gh 命令包装。
 *
 * 一律 execFile(cmd, argsArray)（shell:false），规避 Windows 引号与注入问题；
 * 永不拼接 shell 字符串。返回 { code, stdout, stderr }，不抛异常（失败是常规路径）。
 */
import { execFile } from 'node:child_process';

const MAX_BUFFER = 10 * 1024 * 1024;

/** 执行一个命令，永不 reject。opts 透传 execFile（timeout 等）。 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', maxBuffer: MAX_BUFFER, windowsHide: true, ...opts },
      (err, stdout, stderr) => {
        const code = err
          ? (Number.isFinite(err.code) ? err.code : (err.code ?? 1))
          : 0;
        resolve({ code, stdout: stdout || '', stderr: stderr || '' });
      }
    );
  });
}

export const git = (...args) => run('git', args);
export const gh = (...args) => run('gh', args);

let ghAuthedCache = { value: null, at: 0 };
const GH_CACHE_MS = 5 * 60 * 1000;

/** 探测 gh CLI 是否已认证（结果缓存 5 分钟）。 */
export async function ghAuthed() {
  const now = Date.now();
  if (ghAuthedCache.value !== null && now - ghAuthedCache.at < GH_CACHE_MS) {
    return ghAuthedCache.value;
  }
  const r = await gh('auth', 'status');
  const ok = r.code === 0;
  ghAuthedCache = { value: ok, at: now };
  return ok;
}

/**
 * dispatch 一个 workflow。按可用性依次尝试：gh CLI → REST API（token）→ manual。
 * @param {string} repo 形如 "KeNINGKe/EnergyHub"
 * @param {string} workflow 形如 "fetch-feeds.yml"
 * @param {{ref?: string}} [opts]
 * @returns {Promise<{mode:'gh'|'api'|'manual', ok:boolean, detail?:string}>}
 */
export async function dispatchWorkflow(repo, workflow, opts = {}) {
  const ref = opts.ref || 'main';

  if (await ghAuthed()) {
    const r = await gh('workflow', 'run', workflow, '--repo', repo, '--ref', ref);
    if (r.code === 0) return { mode: 'gh', ok: true };
    // gh 已登录但本次调用失败（权限等）——继续尝试 token 路径，最终落到 manual
  }

  const token = process.env.ADMIN_GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (token) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          body: JSON.stringify({ ref })
        }
      );
      if (res.status === 204) return { mode: 'api', ok: true };
      return { mode: 'manual', ok: false, detail: `GitHub API 返回 HTTP ${res.status}` };
    } catch (e) {
      return { mode: 'manual', ok: false, detail: `GitHub API 调用失败: ${e.message}` };
    }
  }

  return { mode: 'manual', ok: false, detail: '本机 gh 未登录且未设置 ADMIN_GITHUB_TOKEN/GH_TOKEN' };
}
