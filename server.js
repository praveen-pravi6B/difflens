import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { BrowserEngine, VIEWPORT } from './lib/browser.js';
import { compareUrls } from './lib/compare.js';
import { LiveSession } from './lib/live-session.js';
import { buildReportHtml } from './lib/report.js';
import {
  APP_VERSION,
  ARTIFACT_DIR,
  DEMO_DIR,
  PUBLIC_DIR,
  ValidationError,
  clampInt,
  makeId,
  normalizeBasicAuth,
  normalizeCookies,
  normalizeHeaders,
  normalizeUrl,
  parseIgnoreSelectors,
  splitUrlCredentials,
} from './lib/util.js';

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_JOBS = 25;
const MAX_LIVE_SESSIONS = 2;
const KEEP_ARTIFACT_DIRS = 40;

const app = express();
const engine = new BrowserEngine();
const jobs = new Map();
const liveSessions = new Map();
let running = false;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: { name: 'DiffLens', version: APP_VERSION },
    engine: {
      name: 'Chromium',
      installed: engine.isInstalled(),
      version: engine.version,
      viewport: VIEWPORT,
    },
    busy: running,
    jobs: jobs.size,
    liveSessions: liveSessions.size,
  });
});

app.get('/api/demo-targets', (req, res) => {
  let host = req.get('host') || `127.0.0.1:${PORT}`;
  if (host.startsWith('0.0.0.0')) host = host.replace('0.0.0.0', '127.0.0.1');
  const base = `${req.protocol}://${host}`;
  res.json({
    local: `${base}/demo/local.html`,
    staging: `${base}/demo/staging.html`,
  });
});

app.post('/api/compare', async (req, res, next) => {
  if (running) {
    return next(new HttpError(429, 'A comparison is already running. Give it a moment and try again.'));
  }
  let payload;
  try {
    payload = buildPayload(req.body || {});
  } catch (error) {
    return next(error);
  }

  running = true;
  const started = Date.now();
  try {
    const result = await compareUrls(engine, payload);
    remember(result);
    console.log(
      `[compare] ${payload.localUrl} ↔ ${payload.stagingUrl} — ` +
        `${result.summary.totalChanges} content/markup changes, ` +
        `${result.visual.available ? (result.visual.ratio * 100).toFixed(2) + '% pixels' : 'no pixel diff'} ` +
        `in ${Date.now() - started}ms`,
    );
    res.json(result);
  } catch (error) {
    next(error);
  } finally {
    running = false;
  }
});

app.get('/api/result/:id', (req, res, next) => {
  const result = loadResult(req.params.id);
  if (!result) return next(new HttpError(404, 'That comparison result no longer exists.'));
  if (req.query.download === '1') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="difflens-${result.id}.json"`);
  }
  res.json(result);
});

app.get('/api/report/:id', (req, res, next) => {
  const result = loadResult(req.params.id);
  if (!result) return next(new HttpError(404, 'That comparison result no longer exists.'));
  let html;
  try {
    html = buildReportHtml(result);
  } catch (error) {
    return next(error);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="difflens-report-${result.id}.html"`);
  res.send(html);
});

app.post('/api/session', async (req, res, next) => {
  if (liveSessions.size >= MAX_LIVE_SESSIONS) {
    return next(
      new HttpError(
        429,
        `Up to ${MAX_LIVE_SESSIONS} live sessions can run at once. End one before starting another.`,
      ),
    );
  }
  let config;
  try {
    config = buildLiveConfig(req.body || {});
  } catch (error) {
    return next(error);
  }

  const session = new LiveSession(engine, config, {
    onEnd: (id) => liveSessions.delete(id),
  });

  try {
    await session.start();
    liveSessions.set(session.id, session);
    console.log(`[live] started ${session.id} (${liveSessions.size} active)`);
    res.json({
      id: session.id,
      wsPath: `/ws/session/${session.id}`,
      viewport: VIEWPORT,
      engine: { name: 'Chromium', version: engine.version },
      urls: {
        local: config.sides.local.url,
        staging: config.sides.staging.url,
      },
    });
  } catch (error) {
    await session.end('failed');
    next(error);
  }
});

app.get('/api/session/:id', (req, res, next) => {
  const session = liveSessions.get(req.params.id);
  if (!session) return next(new HttpError(404, 'That live session has ended.'));
  res.json({
    id: session.id,
    startedAt: session.startedAt,
    viewport: VIEWPORT,
    urls: {
      local: session.config.sides.local.url,
      staging: session.config.sides.staging.url,
    },
    actions: session.actions,
  });
});

app.delete('/api/session/:id', async (req, res, next) => {
  const session = liveSessions.get(req.params.id);
  if (!session) return next(new HttpError(404, 'That live session has ended.'));
  await session.end('requested');
  liveSessions.delete(session.id);
  res.json({ ok: true });
});

app.use('/artifacts', express.static(ARTIFACT_DIR, {
  index: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));
app.use('/demo', express.static(DEMO_DIR, { extensions: ['html'] }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Unknown API endpoint.' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status) || 500;
  if (status >= 500 && status !== 503) console.error('[error]', error);
  const details =
    error.details || error.sides
      ? { ...(error.details || {}), ...(error.sides ? { sides: error.sides } : {}) }
      : null;
  res.status(status).json({
    error: error.name || 'Error',
    message: error.message || 'Something went wrong.',
    ...(error.field ? { field: error.field } : {}),
    ...(details ? { details } : {}),
  });
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = status === 429 ? 'busy' : 'error';
  }
}

function buildPayload(body) {
  const local = splitUrlCredentials(normalizeUrl(body.localUrl));
  const staging = splitUrlCredentials(normalizeUrl(body.stagingUrl));
  const ignoreSelectors = parseIgnoreSelectors(body.ignoreSelectors).slice(0, 50);
  const pixelThreshold = Number(body.pixelThreshold);

  const options = {
    localHeaders: normalizeHeaders(body.localHeaders, 'Local headers'),
    stagingHeaders: normalizeHeaders(body.stagingHeaders, 'Staging headers'),
    localCookies: normalizeCookies(body.localCookies, 'Local cookies'),
    stagingCookies: normalizeCookies(body.stagingCookies, 'Staging cookies'),
    localAuth: normalizeBasicAuth(body.localAuth, 'Local basic auth') || local.credentials,
    stagingAuth: normalizeBasicAuth(body.stagingAuth, 'Staging basic auth') || staging.credentials,
    ignoreSelectors,
    settleMs: clampInt(body.settleMs, { min: 250, max: 15_000, fallback: 1500 }),
    pixelThreshold: Number.isFinite(pixelThreshold)
      ? Math.min(1, Math.max(0.01, pixelThreshold))
      : 0.12,
    fullPage: body.fullPage !== false,
    ignoreWhitespace: body.ignoreWhitespace !== false,
    compareAttributes: body.compareAttributes !== false,
    normalizeOrigins: body.normalizeOrigins !== false,
    standardUserAgent: body.standardUserAgent !== false,
    scrollPage: body.scrollPage !== false,
    viewport: VIEWPORT,
    navTimeoutMs: 45_000,
  };

  return { localUrl: local.url, stagingUrl: staging.url, options };
}

function buildLiveConfig(body) {
  const local = splitUrlCredentials(normalizeUrl(body.localUrl));
  const staging = splitUrlCredentials(normalizeUrl(body.stagingUrl));

  return {
    id: makeId(),
    standardUserAgent: body.standardUserAgent !== false,
    sides: {
      local: {
        url: local.url,
        headers: normalizeHeaders(body.localHeaders, 'Local headers'),
        cookies: normalizeCookies(body.localCookies, 'Local cookies'),
        auth: normalizeBasicAuth(body.localAuth, 'Local basic auth') || local.credentials,
        standardUserAgent: body.standardUserAgent !== false,
      },
      staging: {
        url: staging.url,
        headers: normalizeHeaders(body.stagingHeaders, 'Staging headers'),
        cookies: normalizeCookies(body.stagingCookies, 'Staging cookies'),
        auth: normalizeBasicAuth(body.stagingAuth, 'Staging basic auth') || staging.credentials,
        standardUserAgent: body.standardUserAgent !== false,
      },
    },
  };
}

function remember(result) {
  jobs.set(result.id, result);
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    jobs.delete(oldest);
  }
}

function loadResult(id) {
  if (!/^[a-z0-9-]{8,80}$/i.test(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  const file = path.join(ARTIFACT_DIR, id, 'result.json');
  if (!fs.existsSync(file)) return null;
  try {
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    remember(result);
    return result;
  } catch {
    return null;
  }
}

function cleanupArtifacts() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const entries = fs
    .readdirSync(ARTIFACT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(ARTIFACT_DIR, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const entry of entries.slice(KEEP_ARTIFACT_DIRS)) {
    fs.rmSync(entry.full, { recursive: true, force: true });
  }
}

cleanupArtifacts();

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    socket.destroy();
    return;
  }

  const match = url.pathname.match(/^\/ws\/session\/([a-z0-9-]+)$/i);
  const session = match ? liveSessions.get(match[1]) : null;
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, session);
  });
});

wss.on('connection', (ws, session) => {
  session.attach(ws);
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('');
  console.log(`  DiffLens ${APP_VERSION}`);
  console.log(`  → http://${shownHost}:${PORT}`);
  console.log(`  Chromium: ${engine.isInstalled() ? 'installed' : 'MISSING — run npm run setup:browser'} · viewport ${VIEWPORT.width}×${VIEWPORT.height}`);
  console.log('');
});

server.requestTimeout = 180_000;
server.headersTimeout = 185_000;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start with: PORT=4174 npm start`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down…`);
  server.close();
  wss.close();
  await Promise.all([...liveSessions.values()].map((session) => session.end('shutdown')));
  liveSessions.clear();
  await engine.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
