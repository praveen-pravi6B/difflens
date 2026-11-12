#!/usr/bin/env node
/**
 * Install the Chromium build that DiffLens uses for rendering.
 *
 * DiffLens depends on `playwright-core`, which does not download a browser on
 * install. Run this once after `npm install`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', 'playwright-core', 'cli.js');

function executable() {
  try {
    return chromium.executablePath();
  } catch {
    return null;
  }
}

const before = executable();
if (before && fs.existsSync(before)) {
  console.log(`Chromium is already installed:\n  ${before}`);
  process.exit(0);
}

console.log('Downloading Chromium for DiffLens (one-time, ~140 MB)…');
const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  stdio: 'inherit',
  env: process.env,
});

if (result.status !== 0) {
  console.error('\nChromium download failed. Try again with a stable network, or install it manually:');
  console.error(`  node ${path.relative(process.cwd(), cli)} install chromium`);
  process.exit(result.status || 1);
}

const after = executable();
if (!after || !fs.existsSync(after)) {
  console.error('\nChromium reported success but no executable was found.');
  process.exit(1);
}

console.log(`\nDone. Chromium is ready:\n  ${after}`);
