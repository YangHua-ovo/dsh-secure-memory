import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Yield a fresh UUID. */
export function uuid() {
  return randomUUID();
}

/** Current time as an ISO-8601 string. */
export function nowIso(date = new Date()) {
  return date.toISOString();
}

/** Parse an ISO date and return a finite epoch milliseconds value, or null. */
export function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

/** SHA-256 hex digest. */
export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Short, non-reversible digest for display and audit. */
export function shortHash(value, length = 12) {
  return sha256(value).slice(0, length);
}

/** Clamp a number to an inclusive range. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Count Unicode code points rather than UTF-16 units. */
export function charLength(value) {
  return Array.from(String(value)).length;
}

/** Truncate by Unicode code points, appending an explicit marker. */
export function truncateChars(value, limit) {
  const chars = Array.from(String(value ?? ''));
  if (chars.length <= limit) return { text: chars.join(''), truncated: false };
  return { text: chars.slice(0, Math.max(0, limit)).join('') + '\n[truncated]', truncated: true };
}

/** Normalize a string for storage and matching without destroying meaning. */
export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** A compact one-line title derived from text. */
export function makeTitle(text, fallback = '未命名记忆') {
  const first = normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return fallback;
  const chars = Array.from(first);
  return chars.length > 72 ? chars.slice(0, 72).join('') + '…' : first;
}

/** Stable JSON stringify with sorted object keys, used for authentication data. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

/** Return a safe slug for a profile directory segment. */
export function safeProfileName(value) {
  const raw = String(value ?? 'default');
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'default';
}

/** Atomic UTF-8 file write. The temp file lives beside the target. */
export async function atomicWriteFile(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let handle;
  try {
    handle = await open(tmp, 'w', mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, path);
    // Best-effort directory fsync for rename durability.
    try {
      const dir = await open(dirname(path), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } catch {
      // Directory fsync is not available on every platform; the file itself is synced.
    }
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

/** Remove a file if it exists, never following a directory. */
export async function removeFile(path) {
  await rm(path, { force: true });
}

/** Decode base64 into a Buffer, rejecting malformed strings. */
export function fromBase64(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.length === 0) throw new Error(`invalid ${field}`);
  return buf;
}
