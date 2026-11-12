import { canonicalizeOrigins } from './util.js';

const MAX_ADDED = 150;
const MAX_REMOVED = 150;
const MAX_CHANGED = 250;

/**
 * Element-level diff. Matches nodes by their rendered CSS path, compares text and
 * selected attributes, then filters out nodes that merely moved because a sibling
 * was added or removed.
 */
export function diffMarkup(local, staging, options = {}) {
  const normalizeOrigins = options.normalizeOrigins !== false;
  const compareAttributes = options.compareAttributes !== false;

  const localIndex = buildIndex(local.elements, normalizeOrigins ? local.finalUrl : null);
  const stagingIndex = buildIndex(staging.elements, normalizeOrigins ? staging.finalUrl : null);

  const stagedText = new Set();
  const stagedSignatures = new Set();
  for (const entry of stagingIndex.list) {
    if (entry.text.length >= 3) stagedText.add(`${entry.tag}|${entry.text}`);
    stagedSignatures.add(signatureOf(entry));
  }

  const localText = new Set();
  const localSignatures = new Set();
  for (const entry of localIndex.list) {
    if (entry.text.length >= 3) localText.add(`${entry.tag}|${entry.text}`);
    localSignatures.add(signatureOf(entry));
  }

  const added = [];
  const removed = [];
  const changed = [];
  let moved = 0;
  let compared = 0;

  for (const entry of localIndex.list) {
    const other = stagingIndex.map.get(entry.key);
    if (!other) {
      const key = `${entry.tag}|${entry.text}`;
      if (entry.text.length >= 3 && stagedText.has(key)) {
        moved += 1;
        continue;
      }
      if (entry.text.length < 3 && stagedSignatures.has(signatureOf(entry))) {
        moved += 1;
        continue;
      }
      added.push(toListItem(entry));
      continue;
    }

    compared += 1;
    if (other.tag !== entry.tag) {
      removed.push(toListItem(other));
      added.push(toListItem(entry));
      continue;
    }

    const attrChanges = compareAttributes ? diffAttributes(other.attrs, entry.attrs) : [];
    const textChanged = other.text !== entry.text;
    if (textChanged || attrChanges.length > 0) {
      changed.push({
        path: entry.path,
        tag: entry.tag,
        text: textChanged ? { from: other.text, to: entry.text } : null,
        attrs: attrChanges,
      });
    }
  }

  for (const entry of stagingIndex.list) {
    if (localIndex.map.has(entry.key)) continue;
    const key = `${entry.tag}|${entry.text}`;
    if (entry.text.length >= 3 && localText.has(key)) {
      moved += 1;
      continue;
    }
    if (entry.text.length < 3 && localSignatures.has(signatureOf(entry))) {
      moved += 1;
      continue;
    }
    removed.push(toListItem(entry));
  }

  return {
    stats: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      moved,
      compared,
      localElements: local.elements.length,
      stagingElements: staging.elements.length,
    },
    added: added.slice(0, MAX_ADDED),
    removed: removed.slice(0, MAX_REMOVED),
    changed: changed.slice(0, MAX_CHANGED),
    truncated: {
      added: added.length > MAX_ADDED,
      removed: removed.length > MAX_REMOVED,
      changed: changed.length > MAX_CHANGED,
    },
  };
}

function buildIndex(elements, sideUrl) {
  const counts = new Map();
  const list = [];
  const map = new Map();
  for (const element of elements) {
    const path = sideUrl ? canonicalizeOrigins(element.path, sideUrl) : element.path;
    const occurrence = (counts.get(path) || 0) + 1;
    counts.set(path, occurrence);
    const key = occurrence === 1 ? path : `${path}#${occurrence}`;
    const text = sideUrl ? canonicalizeOrigins(element.text, sideUrl) : element.text;
    const attrs = {};
    for (const [name, value] of Object.entries(element.attrs || {})) {
      attrs[name] = sideUrl ? canonicalizeOrigins(value, sideUrl) : value;
    }
    const entry = {
      key,
      path,
      tag: element.tag,
      text: String(text || '').replace(/\s+/g, ' ').trim(),
      attrs,
    };
    list.push(entry);
    map.set(key, entry);
  }
  return { list, map };
}

function diffAttributes(stagingAttrs, localAttrs) {
  const names = new Set([...Object.keys(stagingAttrs), ...Object.keys(localAttrs)]);
  const changes = [];
  for (const name of names) {
    const from = stagingAttrs[name] ?? '';
    const to = localAttrs[name] ?? '';
    if (from !== to) {
      changes.push({ name, from: from.slice(0, 400), to: to.slice(0, 400) });
    }
  }
  return changes;
}

function signatureOf(entry) {
  const attrs = entry.attrs || {};
  return `${entry.tag}|${attrs.href || ''}|${attrs.src || ''}|${attrs.alt || ''}|${attrs.value || ''}`;
}

function toListItem(entry) {
  return {
    path: entry.path,
    tag: entry.tag,
    text: entry.text,
    attrs: entry.attrs,
  };
}
