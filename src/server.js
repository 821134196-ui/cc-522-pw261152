import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Service, httpError } from './service.js';
import { PRESETS, BUNDLES } from './spec.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const DB_PATH = process.env.FCX_DB || join(ROOT, 'data', 'fcx.db');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createApp({ dbPath = DB_PATH } = {}) {
  const store = new Store(dbPath);
  const service = new Service(store);
  service.ensureInitialized();

  const routes = [
    ['GET', /^\/api\/state$/, () => service.state()],
    ['GET', /^\/api\/diffs$/, (_, url) => {
      const items = service.compareAll();
      const feature = url.searchParams.get('feature');
      const cause = url.searchParams.get('cause');
      const release = url.searchParams.get('release');
      const severity = url.searchParams.get('severity');
      let filtered = items;
      if (feature) filtered = filtered.filter((i) => i.feature_key === feature);
      if (cause) filtered = filtered.filter((i) => i.causes.includes(cause));
      if (severity) filtered = filtered.filter((i) => i.severity === severity);
      if (release === 'canary') filtered = filtered.filter((i) => i.cohort?.inCanary);
      if (release === 'outside') filtered = filtered.filter((i) => !i.cohort?.inCanary);
      return {
        items: filtered,
        total: items.length,
        filtered: filtered.length,
        features: service.diffSummary().features,
      };
    }],
    ['GET', /^\/api\/sample\/([^/]+)\/([^/]+)$/, (m) => service.sample(m[1], m[2])],
    ['GET', /^\/api\/quality$/, () => service.quality()],
    ['GET', /^\/api\/releases$/, () => ({
      releases: service.releases(),
      current: service.currentRelease(),
      cohort: [...service.cohortMap().entries()]
        .filter(([, v]) => v.inCanary)
        .map(([k, v]) => ({ entity_key: k, bucket: v.bucket, version: v.version })),
      bundles: BUNDLES,
      validation: store.latestSnapshot('validation')?.summary ?? null,
    })],
    ['POST', /^\/api\/releases$/, (_, __, body) => service.createRelease(body)],
    ['POST', /^\/api\/releases\/(\d+)\/ramp$/, (m, __, body) => service.rampRelease(Number(m[1]), body.percent)],
    ['POST', /^\/api\/releases\/(\d+)\/validate$/, (m) => service.validateRelease(Number(m[1]))],
    ['POST', /^\/api\/releases\/(\d+)\/rollback$/, (m, __, body) => service.rollbackRelease(Number(m[1]), body)],
    ['GET', /^\/api\/repairs$/, () => ({ repairs: service.repairs(), presets: PRESETS, jobs: service.jobs() })],
    ['POST', /^\/api\/repairs\/plan$/, (_, __, body) => service.planRepair(body)],
    ['POST', /^\/api\/repairs$/, (_, __, body) => service.applyRepair(body)],
    ['POST', /^\/api\/validate$/, () => service.validateNow({ label: 'manual' })],
    ['POST', /^\/api\/reset$/, () => {
      service.reset();
      return service.state();
    }],
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      await serveStatic(req, res, url);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: err.message });
    }
  });

  async function handleApi(req, res, url) {
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      const body = method === 'POST' ? await readBody(req) : {};
      const result = await handler(match, url, body);
      sendJson(res, 200, result);
      return;
    }
    throw httpError(404, `no route for ${req.method} ${url.pathname}`);
  }

  async function serveStatic(req, res, url) {
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = normalize(join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR)) throw httpError(403, 'forbidden');
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      // SPA fallback
      data = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(data);
      return;
    }
    const type = MIME[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  }

  return { server, store, service };
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(httpError(413, 'payload too large'));
    });
    req.on('end', () => {
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        reject(httpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  const { server, store } = createApp();
  server.listen(port, () => {
    console.log(`feature-consistency-console listening on http://localhost:${port} (db: ${store.db.location?.() ?? 'file'})`);
  });
  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
