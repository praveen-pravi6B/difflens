import fs from 'node:fs';
import { chromium } from 'playwright-core';

/** The comparison viewport. One fixed, standard screen: 1920×1080 (Full HD). */
export const VIEWPORT = Object.freeze({ width: 1920, height: 1080 });

const LAUNCH_ARGS = [
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-dev-shm-usage',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

export class BrowserUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserUnavailableError';
    this.status = 503;
  }
}

export class BrowserEngine {
  constructor() {
    this.browser = null;
    this.launching = null;
    this.version = null;
    this.userAgent = null;
  }

  executablePath() {
    try {
      return chromium.executablePath();
    } catch {
      return null;
    }
  }

  isInstalled() {
    const exe = this.executablePath();
    return Boolean(exe && fs.existsSync(exe));
  }

  async ensure() {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = this.#launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  async #launch() {
    if (!this.isInstalled()) {
      throw new BrowserUnavailableError(
        'Chromium is not installed for Playwright. Run "npm run setup:browser" once, then restart DiffLens.',
      );
    }
    const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    this.browser = browser;
    this.version = browser.version();
    const major = this.version.split('.')[0];
    this.userAgent =
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    browser.on('disconnected', () => {
      if (this.browser === browser) this.browser = null;
    });
    return browser;
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.version = null;
    if (browser) await browser.close().catch(() => {});
  }
}
