import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DEMO_DIR = path.join(ROOT, 'demo');
export const ARTIFACT_DIR = path.join(ROOT, '.artifacts');

export const APP_VERSION = '1.0.0';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ValidationError('Both URLs are required.');
  }
  let raw = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`"${input}" is not a valid URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ValidationError('Only http:// and https:// URLs can be compared.');
  }
  return url.toString();
}

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.status = 400;
  }
}

export function parseJsonField(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new ValidationError(`${field} must be valid JSON.`, field);
  }
}

export function normalizeHeaders(value, field) {
  const parsed = parseJsonField(value, {}, field);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError(`${field} must be a JSON object of header names to values.`, field);
  }
  const headers = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (val === null || val === undefined) continue;
    headers[String(key)] = String(val);
  }
  return headers;
}

export function normalizeCookies(value, field) {
  const parsed = parseJsonField(value, [], field);
  if (!Array.isArray(parsed)) {
    throw new ValidationError(`${field} must be a JSON array of cookies.`, field);
  }
  return parsed
    .filter((cookie) => cookie && typeof cookie === 'object' && cookie.name && cookie.value !== undefined)
    .map((cookie) => {
      const out = { name: String(cookie.name), value: String(cookie.value) };
      for (const key of ['domain', 'path', 'url', 'expires', 'httpOnly', 'secure', 'sameSite']) {
        if (cookie[key] !== undefined) out[key] = cookie[key];
      }
      return out;
    });
}

/**
 * Normalise HTTP Basic credentials. Returns null when neither field is set.
 * Credentials are never persisted in results or artifacts.
 */
export function normalizeBasicAuth(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object with username and password.`, field);
  }
  const username = String(value.username ?? '').trim();
  const password = String(value.password ?? '');
  if (!username && !password) return null;
  if (!username) {
    throw new ValidationError(`${field} needs a username.`, field);
  }
  return { username, password };
}

/** Pull credentials out of a URL, since browsers refuse URLs with embedded auth. */
export function splitUrlCredentials(url) {
  const parsed = new URL(url);
  if (!parsed.username && !parsed.password) return { url, credentials: null };
  const credentials = {
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
  parsed.username = '';
  parsed.password = '';
  return { url: parsed.toString(), credentials };
}

export function makeId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}

export function parseIgnoreSelectors(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value !== 'string') return [];
  return value
    .split(/[,\n]/)
    .map((selector) => selector.trim())
    .filter(Boolean);
}

export function clampInt(value, { min, max, fallback }) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Replace a side's own origin/host with a stable token so local vs staging links compare equal. */
export function canonicalizeOrigins(value, url) {
  let text = String(value ?? '');
  const origin = originOf(url);
  const host = hostOf(url);
  if (origin) {
    text = text.split(origin).join('{{ORIGIN}}');
    text = text.split(origin.replace(/^https?:/, '')).join('{{ORIGIN}}');
  }
  if (host) text = text.split(host).join('{{HOST}}');
  return text;
}

export function shortError(error) {
  const message = error?.message || String(error);
  return message.split('\n')[0].slice(0, 500);
}
