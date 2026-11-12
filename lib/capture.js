import { VIEWPORT } from './browser.js';
import { sleep, shortError, truncate } from './util.js';

const MAX_SCREENSHOT_HEIGHT = 16000;
const MAX_TEXT_CHARS = 400_000;
const MAX_ELEMENTS = 2500;

const ATTR_NAMES = [
  'href',
  'src',
  'alt',
  'title',
  'aria-label',
  'aria-expanded',
  'aria-checked',
  'aria-selected',
  'aria-current',
  'placeholder',
  'value',
  'type',
  'role',
  'action',
  'method',
  'name',
  'for',
  'target',
  'rel',
  'download',
];

const MEDIA_TAGS = ['img', 'input', 'textarea', 'select', 'button', 'video', 'audio', 'iframe', 'canvas'];

export class CaptureError extends Error {
  constructor(message, side, details = {}) {
    super(message);
    this.name = 'CaptureError';
    this.side = side;
    this.details = details;
    this.status = 422;
  }
}

/**
 * Load one URL in an isolated Chromium context and capture:
 * metadata, visible text, element snapshots, diagnostics and a screenshot.
 */
export async function captureSide(engine, side, config) {
  const browser = await engine.ensure();
  const started = Date.now();
  const warnings = [];

  const context = await browser.newContext({
    viewport: VIEWPORT,
    screen: VIEWPORT,
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
    serviceWorkers: 'block',
    userAgent: config.standardUserAgent === false ? undefined : engine.userAgent,
    extraHTTPHeaders: config.headers || {},
    httpCredentials: config.auth || undefined,
  });

  if (config.cookies?.length) {
    const cookies = config.cookies.map((cookie) => {
      const out = { name: cookie.name, value: cookie.value };
      if (cookie.url) out.url = cookie.url;
      if (cookie.domain) out.domain = cookie.domain;
      if (cookie.path) out.path = cookie.path;
      if (cookie.expires !== undefined) out.expires = Number(cookie.expires);
      if (cookie.httpOnly !== undefined) out.httpOnly = Boolean(cookie.httpOnly);
      if (cookie.secure !== undefined) out.secure = Boolean(cookie.secure);
      if (cookie.sameSite) out.sameSite = cookie.sameSite;
      if (!out.url && !out.domain) out.url = config.url;
      return out;
    });
    try {
      await context.addCookies(cookies);
    } catch (error) {
      warnings.push(`Could not apply cookies: ${shortError(error)}`);
    }
  }

  const page = await context.newPage();
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  const failedRequests = [];
  const httpErrors = [];
  let requestCount = 0;

  page.on('console', (message) => {
    const type = message.type();
    if (type === 'error' && consoleErrors.length < 30) {
      consoleErrors.push(truncate(message.text(), 400));
    } else if (type === 'warning' && consoleWarnings.length < 20) {
      consoleWarnings.push(truncate(message.text(), 400));
    }
  });
  page.on('pageerror', (error) => {
    if (pageErrors.length < 20) pageErrors.push(truncate(shortError(error), 400));
  });
  page.on('requestfailed', (request) => {
    requestCount += 1;
    const url = request.url();
    if (url.startsWith('data:') || url.includes('favicon.ico')) return;
    if (failedRequests.length >= 30) return;
    failedRequests.push({
      url: truncate(url, 500),
      method: request.method(),
      error: truncate(request.failure()?.errorText || 'request failed', 200),
    });
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = response.url();
    if (status < 400) return;
    if (url.startsWith('data:') || url.includes('favicon.ico')) return;
    if (httpErrors.length >= 30) return;
    httpErrors.push({ url: truncate(url, 500), status });
  });

  let navError = null;
  let response = null;
  const navStart = Date.now();
  try {
    response = await page.goto(config.url, {
      waitUntil: 'domcontentloaded',
      timeout: config.navTimeoutMs || 45_000,
    });
  } catch (error) {
    navError = shortError(error);
  }
  const navMs = Date.now() - navStart;

  if (navError) {
    const pageUrl = page.url();
    const blank = pageUrl === 'about:blank' || pageUrl === '';
    if (blank) {
      await closeQuietly(page, context);
      throw new CaptureError(`Could not load ${config.url} — ${navError}`, side, {
        navError,
        url: config.url,
      });
    }
    warnings.push(`Navigation reported: ${navError}`);
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: 6000 });
  } catch {
    /* networkidle is best-effort */
  }

  await sleep(Math.max(250, config.settleMs ?? 1500));

  // Freeze animation and hide ignored regions for both text extraction and the screenshot.
  const ignoreCss = (config.ignoreSelectors || [])
    .map((selector) => `${selector}{display:none !important;}`)
    .join('\n');
  const freezeCss = `
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
    }
    html { scroll-behavior: auto !important; }
  `;
  await page.addStyleTag({ content: `${freezeCss}\n${ignoreCss}` }).catch(() => {});

  if (config.scrollPage !== false) {
    await page
      .evaluate(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const height = () =>
          Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0);
        const step = Math.max(400, Math.floor(innerHeight * 0.75));
        let y = 0;
        let guard = 0;
        while (y < height() && guard < 30) {
          scrollTo(0, y);
          await wait(30);
          y += step;
          guard += 1;
        }
        scrollTo(0, 0);
        await wait(80);
      })
      .catch(() => {});
  }

  await page
    .evaluate(async () => {
      const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        if (document.fonts?.ready) await Promise.race([document.fonts.ready, timeout(1500)]);
      } catch {
        /* ignore */
      }
      const pending = [...document.images].filter((img) => !img.complete);
      await Promise.race([
        Promise.all(
          pending.map(
            (img) =>
              new Promise((resolve) => {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
              }),
          ),
        ),
        timeout(3000),
      ]);
    })
    .catch(() => {});

  let data;
  try {
    data = await page.evaluate(extractPageData, {
      ignoreSelectors: config.ignoreSelectors || [],
      maxElements: MAX_ELEMENTS,
      attrNames: ATTR_NAMES,
      mediaTags: MEDIA_TAGS,
    });
  } catch (error) {
    await closeQuietly(page, context);
    throw new CaptureError(`Could not read the page DOM — ${shortError(error)}`, side, { navError });
  }

  const textTruncated = data.text.length > MAX_TEXT_CHARS;
  const text = textTruncated ? data.text.slice(0, MAX_TEXT_CHARS) : data.text;
  if (textTruncated) warnings.push(`Visible text was truncated to ${MAX_TEXT_CHARS.toLocaleString()} characters.`);
  if (data.elementsTruncated) warnings.push(`Element scan stopped at ${MAX_ELEMENTS.toLocaleString()} nodes.`);

  const dimensions = await page
    .evaluate(() => ({
      width: window.innerWidth,
      height: Math.max(
        document.documentElement.scrollHeight || 0,
        document.body?.scrollHeight || 0,
        window.innerHeight,
      ),
    }))
    .catch(() => ({ width: VIEWPORT.width, height: VIEWPORT.height }));

  let screenshot = null;
  let screenshotMeta = null;
  const shotStart = Date.now();
  try {
    const wantFullPage = config.fullPage !== false;
    const canFullPage = wantFullPage && dimensions.height <= MAX_SCREENSHOT_HEIGHT;
    const captureHeight = canFullPage
      ? dimensions.height
      : Math.min(dimensions.height, wantFullPage ? MAX_SCREENSHOT_HEIGHT : VIEWPORT.height);
    const buffer = await page.screenshot({
      fullPage: canFullPage,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      ...(canFullPage
        ? {}
        : {
            clip: {
              x: 0,
              y: 0,
              width: VIEWPORT.width,
              height: Math.max(1, captureHeight),
            },
          }),
    });
    screenshot = buffer;
    screenshotMeta = {
      mode: canFullPage ? 'full-page' : wantFullPage ? 'full-page-capped' : 'viewport',
      height: Math.max(1, captureHeight),
      truncated: wantFullPage && dimensions.height > MAX_SCREENSHOT_HEIGHT,
    };
    if (dimensions.height > MAX_SCREENSHOT_HEIGHT) {
      warnings.push(
        `Page is ${dimensions.height}px tall; the screenshot was capped at ${MAX_SCREENSHOT_HEIGHT}px.`,
      );
    }
  } catch (error) {
    warnings.push(`Screenshot failed: ${shortError(error)}`);
  }
  const shotMs = Date.now() - shotStart;

  const httpStatus = response?.status() ?? null;
  if (httpStatus !== null && httpStatus >= 400) {
    warnings.push(`The page returned HTTP ${httpStatus}.`);
  }
  if (data.textLength === 0) {
    warnings.push('No visible text was found. The page may render entirely in canvas/WebGL or require client-side data.');
  }

  await closeQuietly(page, context);

  const meta = data.meta || {};
  return {
    side,
    requestedUrl: config.url,
    finalUrl: data.url || config.url,
    title: meta.title || '',
    description: meta.description || '',
    ogTitle: meta.ogTitle || '',
    canonical: meta.canonical || '',
    lang: meta.lang || '',
    httpStatus,
    text,
    textLength: data.textLength,
    elements: data.elements,
    elementsTruncated: data.elementsTruncated,
    counts: data.counts,
    viewport: data.viewport,
    documentHeight: data.documentHeight,
    documentWidth: data.documentWidth,
    screenshot,
    screenshotMeta,
    diagnostics: {
      navError,
      consoleErrors,
      consoleWarnings,
      pageErrors,
      failedRequests,
      httpErrors,
      requestCount,
    },
    warnings,
    timings: {
      navMs,
      shotMs,
      totalMs: Date.now() - started,
    },
  };
}

async function closeQuietly(page, context) {
  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
}

/**
 * Runs inside the page. Keep it self-contained: Playwright serialises this function.
 */
function extractPageData(args) {
  const { ignoreSelectors = [], maxElements = 2500, attrNames = [], mediaTags = [] } = args;
  const skipTags = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'PATH',
    'HEAD',
    'META',
    'LINK',
    'TITLE',
    'BR',
    'HR',
    'SOURCE',
    'TRACK',
    'MAP',
    'AREA',
  ]);
  const media = new Set(mediaTags.map((tag) => tag.toUpperCase()));
  const normalize = (value) =>
    String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\n\r]+/g, ' ')
      .trim();

  const ignored = new Set();
  for (const selector of ignoreSelectors) {
    try {
      document.querySelectorAll(selector).forEach((element) => ignored.add(element));
    } catch {
      /* invalid selector: ignore it */
    }
  }
  const isIgnored = (element) => {
    for (let node = element; node; node = node.parentElement) {
      if (ignored.has(node)) return true;
    }
    return false;
  };

  const isVisible = (element) => {
    if (!element.isConnected) return false;
    if (element.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    if (Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const pathOf = (element) => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 7) {
      let part = node.tagName.toLowerCase();
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${node.id}`);
        return parts.join(' > ');
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ') || 'body';
  };

  const readAttributes = (element) => {
    const attrs = {};
    for (const name of attrNames) {
      const value = element.getAttribute(name);
      if (value !== null && value !== '') attrs[name] = value.slice(0, 600);
    }
    return attrs;
  };

  const elements = [];
  let elementsTruncated = false;
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (const element of all) {
    if (elements.length >= maxElements) {
      elementsTruncated = true;
      break;
    }
    if (skipTags.has(element.tagName)) continue;
    if (element.closest('svg')) continue;
    if (isIgnored(element)) continue;
    if (!isVisible(element)) continue;
    let ownText = '';
    for (const child of element.childNodes) {
      if (child.nodeType === 3) ownText += `${child.nodeValue} `;
    }
    ownText = normalize(ownText);
    const attrs = readAttributes(element);
    const interesting = ownText.length > 0 || media.has(element.tagName) || Object.keys(attrs).length > 0;
    if (!interesting) continue;
    elements.push({
      path: pathOf(element),
      tag: element.tagName.toLowerCase(),
      text: ownText.slice(0, 400),
      attrs,
    });
  }

  const meta = {};
  const title = document.querySelector('title')?.textContent?.trim() || '';
  const description =
    document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
  const ogTitle =
    document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || '';
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
  meta.title = title;
  meta.description = description;
  meta.ogTitle = ogTitle;
  meta.canonical = canonical;
  meta.lang = document.documentElement.lang || '';

  let text = '';
  try {
    text = document.body?.innerText || '';
  } catch {
    text = document.body?.textContent || '';
  }
  if (!text.trim()) text = document.body?.textContent || '';

  const count = (selector) => document.querySelectorAll(selector).length;
  const counts = {
    links: count('a[href]'),
    buttons: count('button, [role="button"]'),
    images: count('img'),
    forms: count('form'),
    inputs: count('input, select, textarea'),
    headings: count('h1, h2, h3, h4, h5, h6'),
  };

  return {
    url: location.href,
    meta,
    text,
    textLength: text.length,
    elements,
    elementsTruncated,
    counts,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    documentHeight: Math.max(
      document.documentElement.scrollHeight || 0,
      document.body?.scrollHeight || 0,
    ),
    documentWidth: Math.max(
      document.documentElement.scrollWidth || 0,
      document.body?.scrollWidth || 0,
    ),
  };
}
