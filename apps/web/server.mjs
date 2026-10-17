#!/usr/bin/env node
/*
 * Production server for the OpenCreator web build.
 *
 * Why this exists: the Vite dev server must never be exposed to a network — it
 * serves source files and dev-only endpoints and has a large attack surface.
 * This server only:
 *   1. serves the built SPA from `apps/web/dist` (with an index.html fallback),
 *   2. answers `/.opencreator/runtime-config` with the same-origin runtime base,
 *   3. proxies `/.opencreator/runtime/*` to the local daemon, injecting the
 *      per-launch Bearer token server-side (the browser never sees the token).
 *
 * The daemon is either spawned here (default) or reached through
 * OPENCREATOR_RUNTIME_ADDRESS + OPENCREATOR_RUNTIME_TOKEN.
 *
 * Security notes:
 *   - Binds 127.0.0.1 by default; put frp/nginx in front.
 *   - The runtime proxy grants full daemon access, so set
 *     OPENCREATOR_WEB_BASIC_AUTH="user:password" (or an nginx auth_basic gate)
 *     before exposing this publicly.
 *   - Only files inside `dist` are served; there is no source/arbitrary serving.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = fileURLToPath(new URL('.', import.meta.url));
const HOST = process.env.OPENCREATOR_WEB_HOST ?? '127.0.0.1';
const PORT = Number(process.env.OPENCREATOR_WEB_PORT ?? 3002);
const DIST = resolve(process.env.OPENCREATOR_WEB_DIST ?? join(WEB_DIR, 'dist'));
const RUNTIME_PREFIX = '/.opencreator/runtime';
const RUNTIME_CONFIG_PATH = '/.opencreator/runtime-config';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const BASIC_AUTH = process.env.OPENCREATOR_WEB_BASIC_AUTH ?? '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8'
};

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`[web-server] Web build not found at ${DIST}. Run "pnpm --filter @opencreator/web build" first.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Runtime (daemon) discovery
// ---------------------------------------------------------------------------

let runtimeConfig; // { origin, token }
let runtimePromise;
let runtimeChild;

function startRuntime() {
  if (runtimePromise !== undefined) return runtimePromise;
  runtimePromise = new Promise((resolvePromise, reject) => {
    const providedAddress = process.env.OPENCREATOR_RUNTIME_ADDRESS;
    const providedToken = process.env.OPENCREATOR_RUNTIME_TOKEN;
    if (providedAddress && providedToken) {
      resolvePromise({ origin: normaliseOrigin(providedAddress), token: providedToken });
      return;
    }

    const daemonDir = resolve(WEB_DIR, '../daemon');
    const entry = process.env.OPENCREATOR_DAEMON_ENTRY;
    const useTsx = entry === undefined;
    const args = useTsx
      ? ['--import', 'tsx', 'src/main.ts']
      : [entry];
    runtimeChild = spawn(process.execPath, args, {
      cwd: daemonDir,
      env: {
        ...process.env,
        OPENCREATOR_MANAGED_PARENT_PID: String(process.pid)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Runtime did not report its address within 30s. ${stderr.slice(-500)}`));
    }, 30_000);
    runtimeChild.stdout.on('data', chunk => {
      stdout += String(chunk);
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed.address === 'string' && typeof parsed.token === 'string') {
            clearTimeout(timeout);
            resolvePromise({ origin: normaliseOrigin(parsed.address), token: parsed.token });
            return;
          }
        } catch {
          // keep buffering
        }
      }
    });
    runtimeChild.stderr.on('data', chunk => { stderr += String(chunk); });
    runtimeChild.once('exit', code => {
      clearTimeout(timeout);
      runtimeChild = undefined;
      runtimePromise = undefined;
      runtimeConfig = undefined;
      if (runtimeConfig === undefined) {
        reject(new Error(`Runtime exited with code ${code}. ${stderr.slice(-500)}`));
      }
    });
  });
  return runtimePromise;
}

function normaliseOrigin(address) {
  const url = new URL(/^https?:\/\//.test(address) ? address : `http://${address}`);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('Runtime must be a loopback HTTP origin');
  }
  return url.origin;
}

async function getRuntime() {
  runtimeConfig ??= await startRuntime();
  return runtimeConfig;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  try {
    if (BASIC_AUTH.length > 0 && !authorised(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OpenCreator"' });
      res.end('Authentication required');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === RUNTIME_CONFIG_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ baseUrl: RUNTIME_PREFIX }));
      return;
    }

    if (pathname === RUNTIME_PREFIX || pathname.startsWith(`${RUNTIME_PREFIX}/`)) {
      await proxyRuntime(req, res, pathname, url.search);
      return;
    }

    serveStatic(req, res, pathname);
  } catch (error) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'WEB_SERVER_FAILED', message: error instanceof Error ? error.message : String(error) } }));
  }
});

function authorised(req) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  try {
    return Buffer.from(header.slice(6), 'base64').toString('utf8') === BASIC_AUTH;
  } catch {
    return false;
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = resolve(DIST, relativePath);
  const inside = relative(DIST, filePath);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const target = existsSync(filePath) && statSync(filePath).isFile()
    ? filePath
    : join(DIST, 'index.html');
  const stat = statSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Cache-Control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

async function proxyRuntime(req, res, pathname, search) {
  const runtime = await getRuntime();
  const runtimePath = pathname.slice(RUNTIME_PREFIX.length) || '/';
  if (runtimePath.startsWith('//') || runtimePath.includes('\\') || /[\u0000-\u001f\u007f]/.test(runtimePath)) {
    res.writeHead(400).end('Bad Request');
    return;
  }
  const target = new URL(`${runtimePath}${search}`, `${runtime.origin}/`);
  if (target.origin !== runtime.origin) {
    res.writeHead(400).end('Bad Request');
    return;
  }

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['content-length'];
  delete headers.authorization;
  headers.authorization = `Bearer ${runtime.token}`;

  let sent = 0;
  const upstream = httpRequest(
    target,
    { method: req.method, headers },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Runtime proxy error');
  });
  req.on('data', chunk => {
    sent += chunk.length;
    if (sent > MAX_BODY_BYTES) {
      upstream.destroy();
      res.writeHead(413).end('Payload Too Large');
    }
  });
  req.pipe(upstream);
}

server.listen(PORT, HOST, () => {
  console.log(`[web-server] OpenCreator web on http://${HOST}:${PORT} (dist: ${DIST})`);
  if (BASIC_AUTH.length === 0) {
    console.warn('[web-server] OPENCREATOR_WEB_BASIC_AUTH is not set — do not expose this port publicly without an auth gate.');
  }
});

function shutdown() {
  if (runtimeChild !== undefined) runtimeChild.kill();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
