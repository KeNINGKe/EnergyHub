#!/usr/bin/env node
/**
 * EnergyHub 本地管理后台入口。
 *
 * - 只绑定 127.0.0.1（后台可改写仓库文件，勿暴露到局域网）。
 * - 启动：npm run admin（= node scripts/admin/server.mjs）
 *   参数：--port 4181 换端口；--open 自动打开浏览器；环境变量 ADMIN_PORT 同效。
 * - API 统一前缀 /api/*；其余路径服务 admin/ 静态文件。
 * - 防 drive-by CSRF：非 GET 必须带 X-Admin-Request 头且 Origin 合法（见下）。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { createRouter, readBody, jsonFail } from './router.mjs';
import { createStaticHandler } from './lib/static.mjs';

import * as statusApi from './api/status.mjs';
import * as contentApi from './api/content.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = path.resolve(__dirname, '../../admin');
const CSRF_HEADER = 'x-admin-request';
const CSRF_VALUE = 'energyhub';

/* ===== 参数解析 ===== */

function parseArgs(argv) {
  const opts = { port: null, open: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      opts.port = parseInt(argv[++i], 10);
    } else if (a.startsWith('--port=')) {
      opts.port = parseInt(a.slice(7), 10);
    } else if (a === '--open') {
      opts.open = true;
    }
  }
  const port = Number.isFinite(opts.port) && opts.port > 0
    ? opts.port
    : (parseInt(process.env.ADMIN_PORT, 10) || 4180);
  return { port, open: opts.open };
}

/* ===== 组装路由 ===== */

function buildRouter() {
  const router = createRouter();
  statusApi.register(router);
  contentApi.register(router);
  // 后续阶段在此追加：sources / config / publish
  return router;
}

/* ===== 主程序 ===== */

const { port: PORT, open: AUTO_OPEN } = parseArgs(process.argv);
const router = buildRouter();
const serveStatic = createStaticHandler(ADMIN_DIR);
const allowedOrigins = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;
  const ctxBase = { req, res, port: PORT };

  try {
    if (pathname.startsWith('/api/') || pathname === '/api') {
      // 本地 CSRF 加固：自定义头强制 CORS 预检（drive-by 页面发不过去）+ Origin 白名单
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if ((origin && !allowedOrigins.has(origin)) || req.headers[CSRF_HEADER] !== CSRF_VALUE) {
          return jsonFail(ctxBase, 403, { error: '缺少本地后台凭证头或 Origin 非法' });
        }
      }

      const matched = router.match(req.method, pathname);
      if (!matched) {
        return jsonFail(ctxBase, 404, { error: `接口不存在: ${req.method} ${pathname}` });
      }

      const body = await readBody(req).catch((e) => {
        e.statusCode = e.statusCode || 400;
        throw e;
      });

      await matched.handler({
        ...ctxBase,
        params: matched.params,
        query: url.searchParams,
        body
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const out = await serveStatic(req.url);
    res.writeHead(out.status, { 'Content-Type': out.type });
    res.end(out.body);
  } catch (e) {
    const status = e.statusCode || 500;
    if (!res.headersSent) {
      jsonFail(ctxBase, status, { error: e.message });
    } else {
      res.end();
    }
    if (status >= 500) console.error(`[admin] ${req.method} ${pathname} failed:`, e.message);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[admin] port ${PORT} in use. Try: npm run admin -- --port 4181`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`EnergyHub admin running at ${url}  (Ctrl+C to stop)`);
  console.log('提示：若控制台中文乱码，可先执行 chcp 65001');
  if (AUTO_OPEN) openBrowser(url);
});

function openBrowser(url) {
  const plat = process.platform;
  if (plat === 'win32') {
    // start 的第一个引号参数是窗口标题，必须给空占位
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else if (plat === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
