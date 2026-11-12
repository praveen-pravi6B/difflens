import fs from 'node:fs';
import pixelmatch from 'pixelmatch';
import pngjs from 'pngjs';

const { PNG } = pngjs;

const MAX_COMPARE_HEIGHT = 12_000;
const BLANK_RATIO = 0.001; // 0.1% of pixels carry ink

/**
 * Pixel diff at the captured resolution. The local screenshot is faded into the
 * background, then changed pixels are painted over it in hot pink.
 */
export function diffScreenshots(localBuffer, stagingBuffer, options = {}) {
  if (!localBuffer || !stagingBuffer) {
    return {
      available: false,
      reason: 'One or both screenshots could not be captured.',
      warning: 'Pixel comparison is unavailable because a screenshot is missing.',
    };
  }

  let localPng;
  let stagingPng;
  try {
    localPng = PNG.sync.read(localBuffer);
    stagingPng = PNG.sync.read(stagingBuffer);
  } catch (error) {
    return {
      available: false,
      reason: error.message,
      warning: `Could not decode a screenshot: ${error.message}`,
    };
  }

  const truncated = localPng.height > MAX_COMPARE_HEIGHT || stagingPng.height > MAX_COMPARE_HEIGHT;
  const width = Math.max(localPng.width, stagingPng.width);
  const height = Math.min(Math.max(localPng.height, stagingPng.height), MAX_COMPARE_HEIGHT);
  if (width < 1 || height < 1) {
    return {
      available: false,
      reason: 'Empty screenshot',
      warning: 'A screenshot came back empty.',
    };
  }

  const canvasLocal = whiteCanvas(width, height);
  const canvasStaging = whiteCanvas(width, height);
  copyInto(localPng, canvasLocal, width, height);
  copyInto(stagingPng, canvasStaging, width, height);

  const localInk = inkRatio(canvasLocal);
  const stagingInk = inkRatio(canvasStaging);

  const output = whiteCanvas(width, height);
  fadeTowardWhite(canvasLocal, output, 0.78);
  const baseData = Buffer.from(output.data);

  const mismatchPixels = pixelmatch(canvasLocal.data, canvasStaging.data, output.data, width, height, {
    threshold: options.threshold ?? 0.12,
    includeAA: false,
    alpha: 0,
    diffColor: [255, 42, 109],
    aaColor: [250, 204, 21],
    diffMask: false,
  });

  const { bbox, regions } = findRegions(output.data, baseData, width, height);
  if (options.outputPath) {
    fs.writeFileSync(options.outputPath, PNG.sync.write(output));
  }

  const warnings = [];
  if (localInk < BLANK_RATIO) warnings.push('The local screenshot is almost blank — the page may block headless browsers or render in canvas/WebGL.');
  if (stagingInk < BLANK_RATIO) warnings.push('The staging screenshot is almost blank — the page may block headless browsers or render in canvas/WebGL.');
  if (truncated) {
    warnings.push(`Visual comparison was capped at ${MAX_COMPARE_HEIGHT}px of page height.`);
  }

  return {
    available: true,
    width,
    height,
    mismatchPixels,
    totalPixels: width * height,
    ratio: width * height > 0 ? mismatchPixels / (width * height) : 0,
    bbox,
    regions,
    local: {
      width: localPng.width,
      height: localPng.height,
      inkRatio: localInk,
      blank: localInk < BLANK_RATIO,
    },
    staging: {
      width: stagingPng.width,
      height: stagingPng.height,
      inkRatio: stagingInk,
      blank: stagingInk < BLANK_RATIO,
    },
    truncated,
    warning: warnings.length ? warnings.join(' ') : null,
  };
}

function whiteCanvas(width, height) {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return png;
}

function copyInto(source, target, width, height) {
  const copyWidth = Math.min(source.width, width);
  const copyHeight = Math.min(source.height, height);
  PNG.bitblt(source, target, 0, 0, copyWidth, copyHeight, 0, 0);
}

/** Blend toward white so unchanged areas recede and pink diff pixels stand out. */
function fadeTowardWhite(source, target, keep) {
  const src = source.data;
  const dst = target.data;
  for (let i = 0; i < src.length; i += 4) {
    dst[i] = Math.round(255 - (255 - src[i]) * keep);
    dst[i + 1] = Math.round(255 - (255 - src[i + 1]) * keep);
    dst[i + 2] = Math.round(255 - (255 - src[i + 2]) * keep);
    dst[i + 3] = 255;
  }
}

function inkRatio(png) {
  let ink = 0;
  const total = png.width * png.height;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] < 247 || png.data[i + 1] < 247 || png.data[i + 2] < 247) ink += 1;
  }
  return total > 0 ? ink / total : 0;
}

function findRegions(diffData, baseData, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const rowCounts = new Uint32Array(height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const i = rowOffset + x * 4;
      if (
        Math.abs(diffData[i] - baseData[i]) > 2 ||
        Math.abs(diffData[i + 1] - baseData[i + 1]) > 2 ||
        Math.abs(diffData[i + 2] - baseData[i + 2]) > 2
      ) {
        rowCounts[y] += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxY === -1) return { bbox: null, regions: [] };

  const regions = [];
  let current = null;
  for (let y = 0; y < height; y += 1) {
    if (rowCounts[y] > 0) {
      if (!current) current = { y, height: 1, pixels: rowCounts[y] };
      else {
        current.height += 1;
        current.pixels += rowCounts[y];
      }
    } else if (current) {
      if (current.height >= 2) regions.push(current);
      current = null;
    }
  }
  if (current && current.height >= 2) regions.push(current);

  regions.sort((a, b) => b.pixels - a.pixels);
  return {
    bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    regions: regions.slice(0, 24).sort((a, b) => a.y - b.y),
  };
}
