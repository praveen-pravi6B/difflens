import { VIEWPORT } from './browser.js';
import { shortError, truncate } from './util.js';

const IDLE_MS = 5 * 60 * 1000;
const NO_CLIENT_MS = 20 * 1000;
const MAX_SOCKET_BUFFER = 4 * 1024 * 1024;
const MAX_ACTION_LOG = 12;
const SIDES = ['local', 'staging'];
const HALF = Math.floor(VIEWPORT.width / 2);
const PANE = {
  local: { x: 0, width: HALF },
  staging: { x: HALF, width: VIEWPORT.width - HALF },
};
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads';

/**
 * One Chromium tab containing both pages side by side in sandboxed iframes.
 * A single screencast is streamed to the UI; clicks and wheel events are
 * resolved to the element under the pointer and mirrored in the other iframe.
 *
 * Framing headers are stripped per document request so pages that send
 * X-Frame-Options / frame-ancestors can still be embedded. Basic auth,
 * headers and cookies are applied per side, by origin, so credentials never
 * cross over to the other app.
 */
export class LiveSession {
  constructor(engine, config, { onEnd } = {}) {
    this.engine = engine;
    this.config = config;
    this.id = config.id;
    this.onEnd = onEnd;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.frames = {};
    this.net = {};
    this.sideByOrigin = new Map();
    this.cdp = null;
    this.lastFrame = null;
    this.sockets = new Set();
    this.ended = false;
    this.idleTimer = null;
    this.disconnectTimer = null;
    this.actions = [];
    this.documentFailures = [];
    this.startedAt = new Date().toISOString();
  }

  async start() {
    this.browser = await this.engine.ensure();
    try {
      await this.#openSplitView();
      await this.#startScreencast();
      this.touch();
      return this;
    } catch (error) {
      const parts = {};
      for (const side of SIDES) {
        parts[side] =
          this.frames[side] && error.side === side
            ? { ok: false, message: error.message }
            : this.frames[side]
              ? { ok: true }
              : { ok: false, message: error.side === side ? error.message : 'Did not load' };
      }
      const wrapped = new Error(error.message || 'Could not start the live session.');
      wrapped.status = error.status || 422;
      wrapped.sides = error.sides || parts;
      await this.end('failed');
      throw wrapped;
    }
  }

  #buildNet() {
    for (const side of SIDES) {
      const config = this.config.sides[side];
      let origin;
      try {
        origin = new URL(config.url).origin;
      } catch {
        origin = null;
      }
      const net = {
        side,
        origin,
        headers: config.headers || {},
        authorization: config.auth
          ? `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')}`
          : null,
      };
      this.net[side] = net;
      if (origin) this.sideByOrigin.set(origin, net);
    }
  }

  async #openSplitView() {
    this.#buildNet();

    const context = await this.browser.newContext({
      viewport: VIEWPORT,
      screen: VIEWPORT,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      colorScheme: 'light',
      reducedMotion: 'reduce',
      locale: 'en-US',
      serviceWorkers: 'block',
      userAgent: this.config.standardUserAgent === false ? undefined : this.engine.userAgent,
    });
    this.context = context;

    for (const side of SIDES) {
      const cookies = this.config.sides[side].cookies;
      if (cookies?.length) await context.addCookies(cookies).catch(() => {});
    }

    await context.route('**/*', (route) => this.#route(route));

    const page = await context.newPage();
    this.page = page;

    page.on('dialog', async (dialog) => {
      this.system(`auto-accepted a ${dialog.type()} dialog`);
      await dialog.accept().catch(() => {});
    });
    page.on('crash', () => this.system('the split-view page crashed'));

    page.on('requestfailed', (request) => {
      const failure = request.failure();
      if (!failure) return;
      this.documentFailures.push({ url: request.url(), error: failure.errorText });
    });

    const shell = shellHtml(
      Object.fromEntries(SIDES.map((side) => [side, this.config.sides[side].url])),
    );

    try {
      await page.setContent(shell, { waitUntil: 'load', timeout: 45_000 });
    } catch (error) {
      const wrapped = new Error(`Could not open the split view — ${shortError(error)}`);
      wrapped.status = 422;
      throw wrapped;
    }

    const loaded = await Promise.allSettled(SIDES.map((side) => this.#loadSide(side)));
    const failed = loaded.filter((entry) => entry.status === 'rejected');
    if (failed.length) {
      const sides = {};
      SIDES.forEach((side, index) => {
        sides[side] =
          loaded[index].status === 'fulfilled'
            ? { ok: true }
            : { ok: false, message: loaded[index].reason.message };
      });
      const error = new Error(failed[0].reason.message);
      error.status = 422;
      error.sides = sides;
      throw error;
    }

    // Frame navigation events live on the page, not on individual Frame objects.
    page.on('framenavigated', (navigated) => {
      const side = SIDES.find((name) => this.frames[name] === navigated);
      if (!side) return;
      const url = navigated.url();
      if (!/^https?:/i.test(url)) return;
      this.broadcast({ type: 'navigated', side, url });
      this.touch();
    });
  }

  async #loadSide(side) {
    const config = this.config.sides[side];
    const element = await this.page.$(`iframe[name="${side}"]`);
    if (!element) {
      const error = new Error(`The ${side} pane could not be created.`);
      error.side = side;
      throw error;
    }
    const frame = await element.contentFrame();
    if (!frame) {
      const error = new Error(`The ${side} pane did not attach a frame.`);
      error.side = side;
      throw error;
    }
    this.frames[side] = frame;

    try {
      await frame.waitForLoadState('domcontentloaded', { timeout: 30_000 });
      await frame.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
    } catch (error) {
      const wrapped = new Error(`Could not load the ${side} page — ${shortError(error)}`);
      wrapped.side = side;
      throw wrapped;
    }

    if (frame.url() === 'about:blank') {
      const wrapped = new Error(`The ${side} page did not load.`);
      wrapped.side = side;
      throw wrapped;
    }

    const blocked = this.documentFailures.find(
      (failure) =>
        failure.url === config.url ||
        failure.url.startsWith(config.url.split(/[?#]/)[0]),
    );
    if (blocked) {
      const wrapped = new Error(`Could not load the ${side} page — ${blocked.error}`);
      wrapped.side = side;
      throw wrapped;
    }

    await frame
      .evaluate(async () => {
        const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        try {
          if (document.fonts?.ready) await Promise.race([document.fonts.ready, timeout(1200)]);
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
    await frame.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  }

  async #route(route) {
    const request = route.request();
    const rawUrl = request.url();
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return route.continue().catch(() => {});
    }

    const net = this.sideByOrigin.get(url.origin);
    const isDocument = request.resourceType() === 'document';
    const headers = { ...request.headers() };
    let changed = false;

    if (net) {
      for (const [name, value] of Object.entries(net.headers)) {
        if (headers[name.toLowerCase()] === undefined) {
          headers[name.toLowerCase()] = value;
          changed = true;
        }
      }
      if (net.authorization && !headers.authorization) {
        headers.authorization = net.authorization;
        changed = true;
      }
    }

    if (!isDocument) {
      if (!net) return route.continue().catch(() => {});
      return (changed ? route.continue({ headers }) : route.continue()).catch(() => {});
    }

    let response;
    try {
      response = await route.fetch(changed ? { headers, maxRedirects: 0 } : { maxRedirects: 0 });
    } catch {
      return route.continue().catch(() => {});
    }

    if (net && (response.status() === 401 || response.status() === 407)) {
      this.#authNeeded(net.side, response.status());
    }

    const responseHeaders = { ...response.headers() };
    delete responseHeaders['x-frame-options'];
    delete responseHeaders['content-security-policy'];
    delete responseHeaders['content-security-policy-report-only'];

    await route.fulfill({ response, headers: responseHeaders }).catch(async () => {
      await route.continue().catch(() => {});
    });
  }

  #authNeeded(side, status) {
    if (this.authNoticed?.[side]) return;
    this.authNoticed ||= {};
    this.authNoticed[side] = true;
    const message = this.net[side]?.authorization
      ? `${side}: the server rejected the Basic Auth credentials (HTTP ${status}).`
      : `${side}: page returned HTTP ${status} — Basic Auth may be required. Add credentials in Options.`;
    this.system(message);
    this.broadcast({ type: 'auth', side, status, hasCredentials: Boolean(this.net[side]?.authorization) });
  }

  async #startScreencast() {
    const cdp = await this.context.newCDPSession(this.page);
    this.cdp = cdp;

    cdp.on('Page.screencastFrame', (event) => {
      if (this.ended) return;
      const meta = event.metadata || {};
      const frame = {
        data: event.data,
        width: meta.deviceWidth || VIEWPORT.width,
        height: meta.deviceHeight || VIEWPORT.height,
        pageWidth: VIEWPORT.width,
        pageHeight: VIEWPORT.height,
      };
      this.lastFrame = frame;
      this.broadcast({ type: 'frame', ...frame }, true);
      cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 65,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    });

    const shot = await this.page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => null);
    if (shot) {
      this.lastFrame = {
        data: shot.toString('base64'),
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        pageWidth: VIEWPORT.width,
        pageHeight: VIEWPORT.height,
      };
    }
  }

  attach(ws) {
    if (this.ended) {
      ws.close(1000, 'session ended');
      return;
    }
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
    this.sockets.add(ws);
    this.touch();

    ws.on('message', (raw) => {
      this.#handleMessage(ws, raw).catch((error) => {
        this.send(ws, { type: 'error', message: shortError(error) });
      });
    });
    ws.on('close', () => {
      this.sockets.delete(ws);
      if (this.sockets.size === 0 && !this.ended) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => this.end('disconnected'), NO_CLIENT_MS);
        this.disconnectTimer.unref?.();
      }
    });
    ws.on('error', () => {});

    this.send(ws, {
      type: 'ready',
      id: this.id,
      layout: {
        mode: 'split',
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        panes: SIDES.map((side) => ({ side, ...PANE[side] })),
      },
      urls: {
        local: this.config.sides.local.url,
        staging: this.config.sides.staging.url,
      },
      engine: { name: 'Chromium', version: this.engine.version },
      startedAt: this.startedAt,
      actions: this.actions,
    });

    if (this.lastFrame) this.send(ws, { type: 'frame', ...this.lastFrame });
  }

  async #handleMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === 'click') {
      await this.click(Number(message.x), Number(message.y));
    } else if (message.type === 'wheel') {
      await this.wheel(
        Number(message.x),
        Number(message.y),
        Number(message.deltaY),
        Number(message.deltaX || 0),
      );
    } else if (message.type === 'reload') {
      await this.reload();
    } else if (message.type === 'end') {
      await this.end('requested');
    } else if (message.type === 'ping') {
      this.send(ws, { type: 'pong' });
    }
  }

  async click(x, y) {
    this.touch();
    if (this.ended || !this.page) return;
    const point = clampPoint(x, y);
    const hit = await this.#frameAt(point).catch(() => null);
    if (!hit) {
      this.#action({ kind: 'click', label: 'outside the split view', mirrored: false, error: 'No page under that point' });
      return;
    }

    const source = this.frames[hit.side];
    const targetSide = other(hit.side);
    const target = this.frames[targetSide];
    if (!source || !target) return;

    let descriptor = null;
    try {
      descriptor = await source.evaluate(describePoint, { x: hit.x, y: hit.y });
    } catch {
      descriptor = null;
    }

    try {
      await this.#alignScroll(source, target);
    } catch {
      /* scrolling is best effort */
    }

    // Immediate feedback in the pane that was clicked.
    try {
      await this.page.mouse.click(point.x, point.y);
    } catch (error) {
      this.#action({
        kind: 'click',
        side: hit.side,
        targetSide,
        label: descriptor ? elementLabel(descriptor) : 'element',
        mirrored: false,
        error: `Click failed — ${shortError(error)}`,
      });
      return;
    }

    if (!descriptor) {
      this.#action({
        kind: 'click',
        side: hit.side,
        targetSide,
        label: 'empty area',
        mirrored: false,
        error: 'No element at that point',
      });
      return;
    }

    let match = null;
    let error = null;
    try {
      match = await clickDescriptor(target, descriptor);
      if (!match) error = 'The same element was not found on the other page';
    } catch (clickError) {
      error = shortError(clickError);
    }

    if (descriptor.targetBlank && !error) {
      error = 'This link opens a new tab — new tabs are not mirrored in the split view';
    }

    // Playwright locator boxes are relative to the main frame viewport, while
    // the source descriptor came from getBoundingClientRect inside the iframe.
    const targetBbox = match?.bbox ? frameRect(match.bbox, targetSide) : null;

    this.#action({
      kind: 'click',
      side: hit.side,
      targetSide,
      label: elementLabel(descriptor),
      tag: descriptor.tag,
      role: descriptor.role,
      selector: match?.selector || descriptor.path,
      matchedBy: match?.by || null,
      mirrored: Boolean(match),
      error,
      bbox: descriptor.rect,
      targetBbox,
      bboxPage: pageRect(descriptor.rect, hit.side),
      targetBboxPage: match?.bbox || null,
    });
  }

  async wheel(x, y, deltaY, deltaX = 0) {
    this.touch();
    if (this.ended || !this.page) return;
    const dy = Math.max(-2400, Math.min(2400, Math.round(deltaY) || 0));
    const dx = Math.max(-2400, Math.min(2400, Math.round(deltaX) || 0));
    if (!dy && !dx) return;

    const point = clampPoint(x, y);
    const hit = await this.#frameAt(point).catch(() => null);
    if (!hit) return;
    const targetSide = other(hit.side);
    const mirrored = { x: PANE[targetSide].x + hit.x, y: hit.y };

    await this.page.mouse.move(point.x, point.y).catch(() => {});
    await this.page.mouse.wheel(dx, dy).catch(() => {});
    await this.page.mouse.move(mirrored.x, mirrored.y).catch(() => {});
    await this.page.mouse.wheel(dx, dy).catch(() => {});
  }

  async reload() {
    if (this.ended) return;
    await Promise.all(
      SIDES.map((side) =>
        this.frames[side]?.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
      ),
    );
    this.system('Reloaded both pages');
    this.touch();
  }

  async #frameAt({ x, y }) {
    const hit = await this.page.evaluate(({ px, py }) => {
      const element = document.elementFromPoint(px, py);
      const frame = element?.closest?.('iframe') || (element?.tagName === 'IFRAME' ? element : null);
      if (!frame) return null;
      const side = frame.getAttribute('name');
      if (side !== 'local' && side !== 'staging') return null;
      const rect = frame.getBoundingClientRect();
      return {
        side,
        x: Math.min(rect.width - 1, Math.max(0, px - rect.left)),
        y: Math.min(rect.height - 1, Math.max(0, py - rect.top)),
      };
    }, { px: x, py: y });
    return hit;
  }

  async #alignScroll(source, target) {
    const info = await source.evaluate(() => {
      const scrolling = document.scrollingElement || document.documentElement;
      const max = Math.max(0, scrolling.scrollHeight - window.innerHeight);
      return { top: scrolling.scrollTop, max };
    });
    const ratio = info.max > 0 ? info.top / info.max : 0;
    await target.evaluate((value) => {
      const scrolling = document.scrollingElement || document.documentElement;
      const max = Math.max(0, scrolling.scrollHeight - window.innerHeight);
      scrolling.scrollTop = Math.round(value * max);
    }, ratio);
  }

  #action(action) {
    const entry = {
      at: new Date().toISOString(),
      ...action,
      label: truncate(action.label || 'element', 90),
    };
    this.actions.unshift(entry);
    if (this.actions.length > MAX_ACTION_LOG) this.actions.pop();
    this.broadcast({ type: 'action', action: entry });
  }

  system(message) {
    this.broadcast({ type: 'system', message: truncate(message, 240), at: new Date().toISOString() });
  }

  touch() {
    if (this.ended) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.end('idle'), IDLE_MS);
    this.idleTimer.unref?.();
  }

  broadcast(payload, dropIfBusy = false) {
    const text = JSON.stringify(payload);
    for (const ws of this.sockets) {
      if (ws.readyState !== 1) continue;
      if (dropIfBusy && ws.bufferedAmount > MAX_SOCKET_BUFFER) continue;
      try {
        ws.send(text);
      } catch {
        /* socket is closing */
      }
    }
  }

  send(ws, payload) {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  async end(reason = 'ended') {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.disconnectTimer);

    this.broadcast({ type: 'closed', reason });
    for (const ws of this.sockets) {
      try {
        ws.close(1000, 'session ended');
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();

    if (this.cdp) {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      this.cdp = null;
    }
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
    this.frames = {};

    this.onEnd?.(this.id);
  }
}

function shellHtml(urls) {
  const escape = (value) =>
    String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const panes = SIDES.map(
    (side) =>
      `<iframe name="${side}" title="${side}" src="${escape(urls[side])}" sandbox="${SANDBOX}" allow="clipboard-read; clipboard-write" scrolling="yes"></iframe>`,
  ).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DiffLens live split view</title>
<style>
  html, body { margin: 0; padding: 0; width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; overflow: hidden; background: #0a0e17; }
  .split { display: flex; width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; }
  iframe { display: block; border: 0; padding: 0; margin: 0; background: #fff; width: ${PANE.local.width}px; height: ${VIEWPORT.height}px; }
  iframe[name="staging"] { width: ${PANE.staging.width}px; }
</style>
</head>
<body><div class="split">${panes}</div></body>
</html>`;
}

function other(side) {
  return side === 'local' ? 'staging' : 'local';
}

function clampPoint(x, y) {
  return {
    x: Math.min(VIEWPORT.width - 1, Math.max(0, Math.round(Number.isFinite(x) ? x : 0))),
    y: Math.min(VIEWPORT.height - 1, Math.max(0, Math.round(Number.isFinite(y) ? y : 0))),
  };
}

function pageRect(rect, side) {
  if (!rect) return null;
  return {
    x: rect.x + PANE[side].x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function frameRect(rect, side) {
  if (!rect) return null;
  return {
    x: rect.x - PANE[side].x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function elementLabel(descriptor) {
  return (
    descriptor.ariaLabel ||
    descriptor.text ||
    descriptor.id ||
    descriptor.name ||
    descriptor.path ||
    descriptor.tag ||
    'element'
  );
}

/**
 * Runs inside an iframe. Finds the visible element under the point (climbing
 * to the nearest interactive ancestor) and returns selectors to find it again.
 */
function describePoint({ x, y }) {
  const isVisible = (element) => {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const nodes = document.elementsFromPoint(x, y);
  let element =
    nodes.find(
      (node) =>
        node.nodeType === 1 &&
        node.tagName !== 'HTML' &&
        node.tagName !== 'BODY' &&
        isVisible(node),
    ) || null;

  if (!element) return null;

  const interactive = element.closest(
    'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="tab"],[onclick],[data-demo-counter]',
  );
  if (interactive && isVisible(interactive)) element = interactive;

  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const attr = (name) => element.getAttribute(name) || '';
  const tag = element.tagName.toLowerCase();
  const cssString = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cssIdent = (value) =>
    window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');

  const pathOf = (node) => {
    const parts = [];
    let current = node;
    while (current && current.nodeType === 1 && current !== document.body && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      if (current.id && /^[A-Za-z][\w-]*$/.test(current.id)) {
        parts.unshift(`#${cssIdent(current.id)}`);
        return parts.join(' > ');
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ') || tag;
  };

  const candidates = [];
  for (const name of ['data-testid', 'data-test', 'data-cy', 'data-test-id']) {
    const value = attr(name);
    if (value) candidates.push(`[${name}="${cssString(value)}"]`);
  }
  if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) {
    candidates.push(`#${cssIdent(element.id)}`);
  }
  if (attr('aria-label')) {
    candidates.push(`[aria-label="${cssString(attr('aria-label'))}"]`);
  }
  if (attr('name')) {
    candidates.push(`${tag}[name="${cssString(attr('name'))}"]`);
  }
  if (tag === 'a' && attr('href') && !attr('href').startsWith('#')) {
    candidates.push(`a[href="${cssString(attr('href'))}"]`);
  }

  const text = normalize(
    attr('aria-label') || element.innerText || element.textContent || element.value || '',
  ).slice(0, 140);
  const rect = element.getBoundingClientRect();

  return {
    tag,
    id: element.id || '',
    name: attr('name'),
    role: attr('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : ''),
    ariaLabel: attr('aria-label'),
    text,
    targetBlank: attr('target') === '_blank',
    path: pathOf(element),
    candidates: [...new Set(candidates)],
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
}

async function clickDescriptor(frame, descriptor) {
  for (const selector of descriptor.candidates || []) {
    let locator;
    try {
      locator = frame.locator(selector);
    } catch {
      continue;
    }
    if ((await locator.count().catch(() => 0)) !== 1) continue;
    const box = await locator.boundingBox().catch(() => null);
    if (!box) continue;
    await locator.click({ timeout: 2500 });
    return { selector, by: 'css', bbox: box };
  }

  const text = String(descriptor.text || '').trim();
  if (text) {
    const roles = [];
    if (descriptor.role === 'link') roles.push('link');
    if (descriptor.role === 'button' || descriptor.tag === 'button') roles.push('button');
    for (const role of roles) {
      const locator = frame.getByRole(role, { name: text, exact: true });
      if ((await locator.count().catch(() => 0)) !== 1) continue;
      const box = await locator.boundingBox().catch(() => null);
      if (!box) continue;
      await locator.click({ timeout: 2500 });
      return { selector: `role=${role}[name=${JSON.stringify(text)}]`, by: 'role+name', bbox: box };
    }

    const byText = frame.getByText(text, { exact: true });
    if ((await byText.count().catch(() => 0)) === 1) {
      const box = await byText.boundingBox().catch(() => null);
      if (box) {
        await byText.click({ timeout: 2500 });
        return { selector: `text=${JSON.stringify(text)}`, by: 'text', bbox: box };
      }
    }
  }

  if (descriptor.path) {
    try {
      const locator = frame.locator(descriptor.path);
      if ((await locator.count().catch(() => 0)) >= 1) {
        const box = await locator.first().boundingBox().catch(() => null);
        await locator.first().click({ timeout: 2500 });
        return { selector: descriptor.path, by: 'css-path', bbox: box };
      }
    } catch {
      /* fall through */
    }
  }

  return null;
}
