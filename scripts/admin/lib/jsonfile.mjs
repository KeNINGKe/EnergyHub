/**
 * 后台 JSON 文件原子读写。
 *
 * 约定（与构建端 atomicWrite 一致）：
 * - 读：文件缺失返回 null；JSON 解析失败抛出带路径的错误。
 * - 写：同目录 tmp 文件（名字带 randomUUID 防多实例碰撞）+ fs.rename 原子替换；
 *   可选 .bak 备份上一版。固定 JSON.stringify(x, null, 2) + '\n'，避免 diff 噪音。
 *
 * 红线：调用方必须先校验再写（schema.mjs / validators.mjs），本模块不做语义校验。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 读 JSON；不存在返回 null。 */
export async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    const err = new Error(`JSON 解析失败: ${filePath} — ${e.message}`);
    err.cause = e;
    throw err;
  }
}

/**
 * 原子写 JSON。
 * @param {string} filePath 目标路径
 * @param {*} data 可序列化数据
 * @param {{bak?: boolean}} [opts] bak=true 时把旧版本复制为 <name>.json.bak
 */
export async function writeJson(filePath, data, opts = {}) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  if (opts.bak) {
    try {
      await fs.copyFile(filePath, filePath + '.bak');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const text = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** 文件是否存在。 */
export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
