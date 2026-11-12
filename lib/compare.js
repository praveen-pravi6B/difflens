import fs from 'node:fs';
import path from 'node:path';
import { captureSide, CaptureError } from './capture.js';
import { diffContent } from './diff-content.js';
import { diffMarkup } from './diff-markup.js';
import { diffScreenshots } from './diff-visual.js';
import { ARTIFACT_DIR, canonicalizeOrigins, makeId, normalizeText } from './util.js';

export class CompareError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CompareError';
    this.details = details;
    this.status = 422;
  }
}

/**
 * Capture both sides, run all three diff layers, persist screenshots and return
 * a JSON-safe result. The staging page is the baseline; local is the candidate.
 */
export async function compareUrls(engine, { localUrl, stagingUrl, options }) {
  const started = Date.now();
  const id = makeId();

  const [localResult, stagingResult] = await Promise.allSettled([
    captureSide(engine, 'local', {
      url: localUrl,
      headers: options.localHeaders,
      cookies: options.localCookies,
      auth: options.localAuth,
      ignoreSelectors: options.ignoreSelectors,
      settleMs: options.settleMs,
      fullPage: options.fullPage,
      standardUserAgent: options.standardUserAgent,
      scrollPage: options.scrollPage,
      navTimeoutMs: options.navTimeoutMs,
    }),
    captureSide(engine, 'staging', {
      url: stagingUrl,
      headers: options.stagingHeaders,
      cookies: options.stagingCookies,
      auth: options.stagingAuth,
      ignoreSelectors: options.ignoreSelectors,
      settleMs: options.settleMs,
      fullPage: options.fullPage,
      standardUserAgent: options.standardUserAgent,
      scrollPage: options.scrollPage,
      navTimeoutMs: options.navTimeoutMs,
    }),
  ]);

  if (localResult.status === 'rejected' || stagingResult.status === 'rejected') {
    const sides = {};
    if (localResult.status === 'rejected') {
      const error = localResult.reason;
      sides.local = {
        ok: false,
        message:
          error instanceof CaptureError
            ? error.message
            : `Could not capture the local page: ${error?.message || error}`,
        details: error?.details || {},
      };
    } else {
      sides.local = { ok: true, title: localResult.value.title, finalUrl: localResult.value.finalUrl };
    }
    if (stagingResult.status === 'rejected') {
      const error = stagingResult.reason;
      sides.staging = {
        ok: false,
        message:
          error instanceof CaptureError
            ? error.message
            : `Could not capture the staging page: ${error?.message || error}`,
        details: error?.details || {},
      };
    } else {
      sides.staging = {
        ok: true,
        title: stagingResult.value.title,
        finalUrl: stagingResult.value.finalUrl,
      };
    }
    throw new CompareError('One of the pages could not be loaded.', { sides });
  }

  const local = localResult.value;
  const staging = stagingResult.value;

  const localText = options.normalizeOrigins
    ? canonicalizeOrigins(normalizeText(local.text), local.finalUrl)
    : normalizeText(local.text);
  const stagingText = options.normalizeOrigins
    ? canonicalizeOrigins(normalizeText(staging.text), staging.finalUrl)
    : normalizeText(staging.text);

  const content = diffContent(localText, stagingText, {
    ignoreWhitespace: options.ignoreWhitespace,
  });
  const markup = diffMarkup(local, staging, {
    normalizeOrigins: options.normalizeOrigins,
    compareAttributes: options.compareAttributes,
  });

  const artifactDir = path.join(ARTIFACT_DIR, id);
  fs.mkdirSync(artifactDir, { recursive: true });

  let localShotName = null;
  let stagingShotName = null;
  if (local.screenshot) {
    fs.writeFileSync(path.join(artifactDir, 'local.png'), local.screenshot);
    localShotName = 'local.png';
  }
  if (staging.screenshot) {
    fs.writeFileSync(path.join(artifactDir, 'staging.png'), staging.screenshot);
    stagingShotName = 'staging.png';
  }

  let visual;
  try {
    visual = diffScreenshots(local.screenshot, staging.screenshot, {
      threshold: options.pixelThreshold,
      outputPath: path.join(artifactDir, 'diff.png'),
    });
  } catch (error) {
    visual = {
      available: false,
      reason: error.message,
      warning: `Pixel comparison failed: ${error.message}`,
    };
  }
  if (visual.available) visual.diffUrl = `/artifacts/${id}/diff.png`;

  const totalMarkupChanges = markup.stats.added + markup.stats.removed + markup.stats.changed;
  const totalContentChanges = content.stats.added + content.stats.removed + content.stats.changed;
  const pixelIdentical = visual.available ? visual.mismatchPixels === 0 : null;
  const identical =
    totalMarkupChanges === 0 &&
    totalContentChanges === 0 &&
    (pixelIdentical === null || pixelIdentical);

  const warnings = unique([
    ...local.warnings,
    ...staging.warnings,
    ...(visual.warning ? [visual.warning] : []),
  ]);

  const result = {
    id,
    createdAt: new Date().toISOString(),
    engine: {
      name: 'Chromium',
      version: engine.version,
      viewport: options.viewport,
      screenshotMode: options.fullPage ? 'full-page' : 'viewport',
    },
    options: {
      settleMs: options.settleMs,
      fullPage: options.fullPage,
      ignoreWhitespace: options.ignoreWhitespace,
      compareAttributes: options.compareAttributes,
      normalizeOrigins: options.normalizeOrigins,
      standardUserAgent: options.standardUserAgent,
      scrollPage: options.scrollPage,
      pixelThreshold: options.pixelThreshold,
      ignoreSelectors: options.ignoreSelectors,
      auth: {
        local: Boolean(options.localAuth),
        staging: Boolean(options.stagingAuth),
      },
    },
    urls: { local: localUrl, staging: stagingUrl },
    local: summarizeSide(local, 'local', id, localShotName),
    staging: summarizeSide(staging, 'staging', id, stagingShotName),
    content,
    markup,
    visual,
    summary: {
      identical,
      pixelIdentical,
      visualRatio: visual.available ? visual.ratio : null,
      contentChanges: totalContentChanges,
      markupChanges: totalMarkupChanges,
      totalChanges: totalContentChanges + totalMarkupChanges,
      similarity: content.stats.similarity,
    },
    warnings,
    timings: {
      startedAt: new Date(started).toISOString(),
      totalMs: Date.now() - started,
    },
  };

  result.local.textChars = localText.length;
  result.staging.textChars = stagingText.length;
  // Keep the canonical text for report exports without bloating the API response.
  fs.writeFileSync(path.join(artifactDir, 'local.txt'), localText);
  fs.writeFileSync(path.join(artifactDir, 'staging.txt'), stagingText);
  fs.writeFileSync(path.join(artifactDir, 'result.json'), JSON.stringify(result, null, 2));

  return result;
}

function summarizeSide(side, name, id, shotName) {
  return {
    side: name,
    requestedUrl: side.requestedUrl,
    finalUrl: side.finalUrl,
    title: side.title,
    description: side.description,
    lang: side.lang,
    httpStatus: side.httpStatus,
    viewport: side.viewport,
    documentHeight: side.documentHeight,
    documentWidth: side.documentWidth,
    textChars: side.text.length,
    elements: side.elements.length,
    elementsTruncated: side.elementsTruncated,
    counts: side.counts,
    diagnostics: side.diagnostics,
    warnings: side.warnings,
    timings: side.timings,
    screenshot: shotName
      ? {
          url: `/artifacts/${id}/${shotName}`,
          mode: side.screenshotMeta?.mode || 'full-page',
          height: side.screenshotMeta?.height || null,
          truncated: Boolean(side.screenshotMeta?.truncated),
        }
      : null,
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
