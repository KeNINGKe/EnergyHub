/**
 * admin/ 静态文件服务。
 *
 * 安全：path.resolve 后必须仍落在 adminDir 内，否则 403（路径穿越防护）。
 * 仅服务白名单扩展名；找不到时回落 index.html（hash 路由其实用不到，但保底）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/**
 * @param {string} adminDir admin 目录绝对路径
 * @returns {(urlPath: string) => Promise<{status:number, body:Buffer|string, type:string}>}
 */
export function createStaticHandler(adminDir) {
  const root = path.resolve(adminDir);

  return async function serve(urlPath) {
    let rel = decodeURIComponent(urlPath.split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';

    const target = path.resolve(root, '.' + rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      return { status: 403, body: 'Forbidden', type: 'text/plain; charset=utf-8' };
    }

    try {
      const buf = await fs.readFile(target);
      const ext = path.extname(target).toLowerCase();
      return { status: 200, body: buf, type: MIME[ext] || 'application/octet-stream' };
    } catch {
      return { status: 404, body: 'Not Found', type: 'text/plain; charset=utf-8' };
    }
  };
}
