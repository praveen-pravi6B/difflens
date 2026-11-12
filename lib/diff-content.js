import { diffLines, diffWordsWithSpace } from 'diff';

const HUNK_CONTEXT = 4;
const MAX_ROWS_IN_PAYLOAD = 4500;
const MAX_SEGMENTS_PER_LINE = 220;

/**
 * Line-level content diff. The staging page is the base, local is the target,
 * so additions are "new in local" and removals are "missing from local".
 */
export function diffContent(localText, stagingText, options = {}) {
  const oldText = stagingText ?? '';
  const newText = localText ?? '';
  const parts = diffLines(oldText, newText, { ignoreWhitespace: options.ignoreWhitespace !== false });

  const rawRows = [];
  for (const part of parts) {
    const lines = splitLines(part.value);
    const kind = part.added ? 'add' : part.removed ? 'del' : 'same';
    for (const text of lines) rawRows.push({ kind, text });
  }

  const rows = [];
  let index = 0;
  while (index < rawRows.length) {
    if (rawRows[index].kind === 'same') {
      rows.push({ kind: 'same', oldText: rawRows[index].text, newText: rawRows[index].text });
      index += 1;
      continue;
    }
    const dels = [];
    const adds = [];
    while (index < rawRows.length && rawRows[index].kind !== 'same') {
      if (rawRows[index].kind === 'del') dels.push(rawRows[index].text);
      else adds.push(rawRows[index].text);
      index += 1;
    }
    const pairs = Math.min(dels.length, adds.length);
    for (let i = 0; i < pairs; i += 1) {
      const segments = wordSegments(dels[i], adds[i]);
      rows.push({
        kind: 'mod',
        oldText: dels[i],
        newText: adds[i],
        oldSegments: segments.oldSegments,
        newSegments: segments.newSegments,
      });
    }
    for (let i = pairs; i < dels.length; i += 1) rows.push({ kind: 'del', oldText: dels[i] });
    for (let i = pairs; i < adds.length; i += 1) rows.push({ kind: 'add', newText: adds[i] });
  }

  let oldLine = 1;
  let newLine = 1;
  const oldBefore = new Array(rows.length + 1).fill(0);
  const newBefore = new Array(rows.length + 1).fill(0);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    oldBefore[i] = oldLine - 1;
    newBefore[i] = newLine - 1;
    if (row.kind === 'same') {
      row.oldLine = oldLine++;
      row.newLine = newLine++;
    } else if (row.kind === 'del') {
      row.oldLine = oldLine++;
      row.newLine = null;
    } else if (row.kind === 'add') {
      row.oldLine = null;
      row.newLine = newLine++;
    } else {
      row.oldLine = oldLine++;
      row.newLine = newLine++;
    }
  }
  oldBefore[rows.length] = oldLine - 1;
  newBefore[rows.length] = newLine - 1;

  const totalOldLines = oldLine - 1;
  const totalNewLines = newLine - 1;
  const stats = {
    added: rows.filter((row) => row.kind === 'add').length,
    removed: rows.filter((row) => row.kind === 'del').length,
    changed: rows.filter((row) => row.kind === 'mod').length,
    unchanged: rows.filter((row) => row.kind === 'same').length,
    totalOldLines,
    totalNewLines,
    similarity:
      Math.round(
        (statsSafeUnchanged(rows) / Math.max(totalOldLines, totalNewLines, 1)) * 1000,
      ) / 10,
  };
  stats.identical = stats.added + stats.removed + stats.changed === 0;

  const hunks = buildHunks(rows, oldBefore, newBefore);
  let keptRows = 0;
  const trimmedHunks = [];
  for (const hunk of hunks) {
    if (keptRows >= MAX_ROWS_IN_PAYLOAD) break;
    const remaining = MAX_ROWS_IN_PAYLOAD - keptRows;
    if (hunk.rows.length > remaining) {
      trimmedHunks.push({
        ...hunk,
        rows: hunk.rows.slice(0, remaining),
        truncated: true,
      });
      keptRows += remaining;
      break;
    }
    trimmedHunks.push(hunk);
    keptRows += hunk.rows.length;
  }

  return {
    stats,
    hunks: trimmedHunks,
    truncated: keptRows < rows.length,
    rowsRendered: keptRows,
  };
}

function statsSafeUnchanged(rows) {
  let unchanged = 0;
  for (const row of rows) if (row.kind === 'same') unchanged += 1;
  return unchanged;
}

function buildHunks(rows, oldBefore, newBefore) {
  const changedIndexes = [];
  for (let i = 0; i < rows.length; i += 1) if (rows[i].kind !== 'same') changedIndexes.push(i);
  if (changedIndexes.length === 0) return [];

  const ranges = [];
  for (const changed of changedIndexes) {
    const start = Math.max(0, changed - HUNK_CONTEXT);
    const end = Math.min(rows.length - 1, changed + HUNK_CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  return ranges.map((range) => {
    const hunkRows = rows.slice(range.start, range.end + 1);
    return {
      oldStart: oldBefore[range.start] + 1,
      newStart: newBefore[range.start] + 1,
      oldEnd: oldBefore[range.end + 1],
      newEnd: newBefore[range.end + 1],
      changes: hunkRows.filter((row) => row.kind !== 'same').length,
      rows: hunkRows,
    };
  });
}

function splitLines(value) {
  const lines = String(value).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? lines : [''];
}

function wordSegments(oldText, newText) {
  if (oldText.length > 6000 || newText.length > 6000) {
    return {
      oldSegments: [{ t: oldText, k: 'del' }],
      newSegments: [{ t: newText, k: 'add' }],
    };
  }
  const parts = diffWordsWithSpace(oldText, newText);
  const oldSegments = [];
  const newSegments = [];
  for (const part of parts) {
    if (part.added) newSegments.push({ t: part.value, k: 'add' });
    else if (part.removed) oldSegments.push({ t: part.value, k: 'del' });
    else {
      oldSegments.push({ t: part.value, k: 'same' });
      newSegments.push({ t: part.value, k: 'same' });
    }
  }
  return {
    oldSegments: mergeSegments(oldSegments),
    newSegments: mergeSegments(newSegments),
  };
}

function mergeSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.k === segment.k) last.t += segment.t;
    else merged.push({ ...segment });
  }
  if (merged.length > MAX_SEGMENTS_PER_LINE) {
    const keep = merged.slice(0, MAX_SEGMENTS_PER_LINE - 1);
    keep.push({ t: merged.slice(MAX_SEGMENTS_PER_LINE - 1).map((s) => s.t).join(''), k: 'same' });
    return keep;
  }
  return merged;
}
