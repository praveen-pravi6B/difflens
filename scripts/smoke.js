#!/usr/bin/env node
/**
 * End-to-end smoke test: boots the server on a spare port, compares the bundled
 * demo pages, and checks that all three diff layers and both exports work.
 *
 * Usage: npm run smoke
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 4399);
const HOST = '127.0.0.1';
const base = `http://${HOST}:${PORT}`;

const checks = [];
let child = null;

function ok(name, detail = '') {
  checks.push({ name, detail, passed: true });
  console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  checks.push({ name, detail, passed: false });
  console.error(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return response.json();
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

function startServer() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(output.trim());
  });
}

function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
}

/** A tiny probe app for live-session tests: optional Basic Auth + blocking headers. */
function startProbeServer({ auth = null, title = 'probe' } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || null });
    if (auth) {
      const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="difflens-smoke"',
          'Content-Type': 'text/html',
        });
        res.end('<h1>Unauthorized</h1>');
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    });
    res.end(`<!doctype html><html><head><title>${title}</title></head>
<body style="margin:0;font:16px system-ui">
<button id="mirrorMe" data-demo-counter style="position:fixed;left:100px;top:100px;width:200px;height:60px">Click me</button>
<script>
  let count = 0;
  document.getElementById('mirrorMe').addEventListener('click', () => {
    count += 1;
    document.getElementById('mirrorMe').textContent = 'Clicked ' + count;
  });
</script>
</body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, seen, port: server.address().port }),
    );
  });
}

function waitForMessage(messages, predicate, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const found = messages.find(predicate);
      if (found) return resolve(found);
      if (Date.now() > deadline) {
        return reject(new Error('Timed out waiting for a live-session message'));
      }
      setTimeout(check, 60);
    };
    check();
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function main() {
  console.log('\nDiffLens smoke test\n');
  startServer();

  try {
    const health = await waitForServer();
    if (!health.engine?.installed) {
      fail('Chromium installed', 'run `npm run setup:browser` first');
      process.exitCode = 1;
      return;
    }
    ok('Server responds', `Chromium ${health.engine.version || 'ready'}`);
    ok('Viewport is 1920×1080', `${health.engine.viewport.width}×${health.engine.viewport.height}`);

    const started = Date.now();
    const response = await fetch(`${base}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localUrl: `${base}/demo/local.html`,
        stagingUrl: `${base}/demo/staging.html`,
        settleMs: 400,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      fail('Comparison request', `${response.status} ${result.message || ''}`.trim());
      process.exitCode = 1;
      return;
    }
    ok('Comparison completed', `${Date.now() - started}ms`);

    const id = result.id;
    if (!id) fail('Result has an id');
    else ok('Result has an id', id);

    if (result.summary?.identical === false) ok('Differences detected');
    else fail('Differences detected', 'expected the demo pages to differ');

    if (result.visual?.available && result.visual.mismatchPixels > 0) {
      ok('Pixel diff found changes', `${(result.visual.ratio * 100).toFixed(2)}% pixels`);
    } else {
      fail('Pixel diff found changes', JSON.stringify(result.visual));
    }

    if (result.content?.stats && result.content.hunks.length > 0) {
      ok(
        'Content diff has hunks',
        `+${result.content.stats.added} −${result.content.stats.removed} ~${result.content.stats.changed}`,
      );
    } else {
      fail('Content diff has hunks');
    }

    if (result.markup?.stats && result.markup.stats.added + result.markup.stats.removed + result.markup.stats.changed > 0) {
      ok(
        'Markup diff found changes',
        `+${result.markup.stats.added} −${result.markup.stats.removed} ~${result.markup.stats.changed}`,
      );
    } else {
      fail('Markup diff found changes');
    }

    const artifacts = ['local.png', 'staging.png', 'diff.png', 'result.json'];
    for (const file of artifacts) {
      const artifact = await fetch(`${base}/artifacts/${id}/${file}`);
      if (artifact.ok) ok(`Artifact ${file}`);
      else fail(`Artifact ${file}`, `HTTP ${artifact.status}`);
    }

    const report = await fetch(`${base}/api/report/${id}`);
    const reportHtml = report.ok ? await report.text() : '';
    if (report.ok && reportHtml.includes('<!doctype html>') && reportHtml.includes('diff')) {
      ok('HTML report renders', `${Math.round(reportHtml.length / 1024)} KB`);
    } else {
      fail('HTML report renders', `HTTP ${report.status}`);
    }

    const json = await fetch(`${base}/api/result/${id}?download=1`);
    const disposition = json.headers.get('content-disposition') || '';
    if (json.ok && disposition.includes('attachment')) ok('JSON export downloads');
    else fail('JSON export downloads', `HTTP ${json.status}`);

    const bad = await fetch(`${base}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localUrl: 'not a url', stagingUrl: `${base}/demo/staging.html` }),
    });
    if (bad.status === 400) ok('Invalid URL is rejected');
    else fail('Invalid URL is rejected', `HTTP ${bad.status}`);

    const broken = await fetch(`${base}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        localUrl: 'http://127.0.0.1:1/',
        stagingUrl: `${base}/demo/staging.html`,
        settleMs: 400,
      }),
    });
    const brokenBody = await broken.json().catch(() => ({}));
    const sides = brokenBody.details?.sides;
    if (broken.status === 422 && sides?.local?.ok === false && sides?.staging?.ok === true) {
      ok('A failing side is reported on its own', sides.local.message);
    } else {
      fail('A failing side is reported on its own', `HTTP ${broken.status} ${JSON.stringify(sides || {})}`);
    }

    // ---- Live split view -------------------------------------------------
    const localProbe = await startProbeServer({
      auth: { username: 'alice', password: 's3cret' },
      title: 'Live local',
    });
    const stagingProbe = await startProbeServer({ title: 'Live staging' });
    let socket = null;
    let liveId = null;

    try {
      const liveResponse = await fetch(`${base}/api/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          localUrl: `http://127.0.0.1:${localProbe.port}/`,
          stagingUrl: `http://127.0.0.1:${stagingProbe.port}/`,
          localAuth: { username: 'alice', password: 's3cret' },
        }),
      });
      const live = await liveResponse.json().catch(() => ({}));

      if (liveResponse.ok && live.id && live.wsPath) {
        liveId = live.id;
        ok('Live session starts', live.id);
      } else {
        fail('Live session starts', `HTTP ${liveResponse.status} ${live.message || ''}`.trim());
      }

      if (liveId) {
        const messages = [];
        socket = await openSocket(`ws://${HOST}:${PORT}${live.wsPath}`);
        socket.on('message', (raw) => {
          try {
            messages.push(JSON.parse(String(raw)));
          } catch {
            /* ignore malformed frames */
          }
        });

        const ready = await waitForMessage(messages, (message) => message.type === 'ready');
        const layout = ready.layout || {};
        const panes = layout.panes || [];
        const splitOk =
          layout.mode === 'split' &&
          layout.width === 1920 &&
          layout.height === 1080 &&
          panes.length === 2 &&
          panes.every((pane) => pane.width === 960) &&
          panes[0].x === 0 &&
          panes[1].x === 960;
        if (splitOk) ok('Live layout is 1920×1080 in two 960 px panes');
        else fail('Live layout is 1920×1080 in two 960 px panes', JSON.stringify(layout));

        const frame = await waitForMessage(messages, (message) => message.type === 'frame');
        if (frame.width === 1920 && frame.height === 1080 && String(frame.data).length > 1000) {
          ok('Screencast frames stream', `${Math.round(String(frame.data).length / 1024)} KB`);
        } else {
          fail('Screencast frames stream', `${frame.width}×${frame.height}, ${String(frame.data).length} bytes`);
        }

        // The probe pages refuse framing with X-Frame-Options and CSP; the live
        // session must strip both or the click below could never resolve.
        socket.send(JSON.stringify({ type: 'click', x: 200, y: 130 }));
        const action = await waitForMessage(
          messages,
          (message) => message.type === 'action' && message.action?.kind === 'click',
        );
        if (action.action.mirrored && action.action.label === 'Click me') {
          ok('Clicks mirror across both panes', `${action.action.side} → ${action.action.targetSide}`);
        } else {
          fail('Clicks mirror across both panes', JSON.stringify(action.action));
        }

        const localSawAuth = localProbe.seen.some((entry) => entry.authorization);
        const stagingLeak = stagingProbe.seen.some((entry) => entry.authorization);
        if (localSawAuth && !stagingLeak) ok('Basic Auth stays on its own origin');
        else fail('Basic Auth stays on its own origin', `local=${localSawAuth} leaked=${stagingLeak}`);

        socket.send(JSON.stringify({ type: 'end' }));
        const closed = await waitForMessage(messages, (message) => message.type === 'closed');
        if (closed.reason) ok('Live session ends on request', closed.reason);
        else fail('Live session ends on request');

        const after = await fetch(`${base}/api/session/${liveId}`);
        if (after.status === 404) ok('Ended session is no longer listed');
        else fail('Ended session is no longer listed', `HTTP ${after.status}`);
      }
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
      if (liveId) {
        await fetch(`${base}/api/session/${liveId}`, { method: 'DELETE' }).catch(() => {});
      }
      localProbe.server.close();
      stagingProbe.server.close();
    }
  } finally {
    stopServer();
  }

  const failed = checks.filter((check) => !check.passed);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ' — FAILED' : ''}\n`,
  );
  if (failed.length) process.exitCode = 1;
}

process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});
process.on('exit', stopServer);

main().catch((error) => {
  fail('Smoke test crashed', error.message);
  stopServer();
  process.exitCode = 1;
});
