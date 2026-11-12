import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../core/constants.js';

const ASSET_DIR = new URL('../assets/', import.meta.url);
const ASSETS = {
  'index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  'app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  'app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  'icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
};

const ASSET_CACHE = new Map();

/** Only loopback callers may use the management surface. */
function isLoopback(address) {
  if (typeof address !== 'string') return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('127.');
}

/** Reject DNS-rebinding Host values; the GUI is a loopback-only surface. */
function hostAllowed(req) {
  const raw = String(req.headers.host ?? '').toLowerCase();
  if (raw.length === 0) return false;
  let hostname;
  try {
    hostname = new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

/** Reject cross-origin browser writes; same-origin iframe requests pass. */
function originAllowed(req) {
  if (!hostAllowed(req)) return false;
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET' || req.method === 'HEAD' || isLoopback(req.socket?.remoteAddress);
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    const originHost = parsed.hostname.toLowerCase();
    const loopbackOrigin = originHost === '127.0.0.1' || originHost === 'localhost' || originHost === '::1' || originHost === '[::1]';
    return loopbackOrigin && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  );
}

function sendJson(res, status, value) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function sendText(res, status, value, contentType = 'text/plain; charset=utf-8') {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.end(value);
}

function errorStatus(error) {
  const code = error?.code;
  if (code === 'UNAUTHORIZED' || code === 'VAULT_UNLOCK_FAILED') return 401;
  if (code === 'VAULT_LOCKED' || code === 'AUDIT_INTEGRITY') return 423;
  if (code === 'DENIED') return 403;
  if (code === 'WORKSPACE_NOT_FOUND' || code === 'DOC_NOT_FOUND' || code === 'VAULT_NOT_FOUND') return 404;
  if (code === 'UNAUTHORIZED_SESSION_WORKSPACE' || code === 'SESSION_DISABLED' || code === 'NO_SESSION_WORKSPACES') return 403;
  if (code === 'INVALID_SESSION_ID' || code === 'SESSION_REQUIRED') return 400;
  if (code === 'LIMIT_EXCEEDED' || code === 'EMPTY_IMPORT') return 413;
  if (code === 'RATE_LIMITED' || code === 'UNLOCK_RATE_LIMITED') return 429;
  if (code === 'VAULT_EXISTS') return 409;
  return 400;
}

function publicError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'BAD_REQUEST';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 500) : '请求失败';
  return { error: { code, message } };
}

async function readJsonBody(req, maxBytes = LIMITS.bodyBytes) {
  if (req.method !== 'POST') return {};
  const type = String(req.headers['content-type'] ?? '');
  if (!type.toLowerCase().startsWith('application/json')) {
    const error = new Error('Content-Type 必须是 application/json');
    error.code = 'BAD_CONTENT_TYPE';
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`请求体超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
      error.code = 'LIMIT_EXCEEDED';
      throw error;
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad shape');
    return value;
  } catch {
    const error = new Error('请求体不是有效 JSON 对象');
    error.code = 'BAD_JSON';
    throw error;
  }
}

function bearerToken(req) {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length >= 20 ? token : null;
}

function parseWorkspaceIds(url) {
  const raw = url.searchParams.get('workspaceIds');
  if (!raw) return [];
  return raw.split(',').map((value) => value.trim()).filter(Boolean).slice(0, 64);
}

function requireToken(req, service, { touch = true } = {}) {
  const token = bearerToken(req);
  if (!token || !service.validateToken(token, { touch })) {
    const error = new Error('管理会话无效或已过期，请重新解锁');
    error.code = 'UNAUTHORIZED';
    throw error;
  }
}

async function loadAsset(name) {
  if (ASSET_CACHE.has(name)) return ASSET_CACHE.get(name);
  const entry = ASSETS[name];
  if (!entry) return null;
  const path = fileURLToPath(new URL(entry.file, ASSET_DIR));
  const buffer = await readFile(path);
  const value = { ...entry, buffer };
  ASSET_CACHE.set(name, value);
  return value;
}

async function serveAsset(res, name) {
  const asset = await loadAsset(name);
  if (!asset) {
    sendText(res, 404, 'Not found');
    return;
  }
  securityHeaders(res);
  res.statusCode = 200;
  res.setHeader('Content-Type', asset.type);
  res.end(asset.buffer);
}

/**
 * Create the prefix handler registered with ctx.webServer. The management
 * page is public HTML/CSS/JS but contains no data. Every data-bearing API
 * requires both a loopback socket and an in-memory bearer token issued by
 * setup/unlock.
 */
export function createRoutes({ service, version = '0.1.0' }) {
  return async function handleSecureMemoryRoute(req, res) {
    try {
      const remote = req.socket?.remoteAddress;
      if (!isLoopback(remote)) {
        sendText(res, 403, 'This management surface is available only from loopback.');
        return;
      }
      if (!originAllowed(req)) {
        sendText(res, 403, 'Cross-origin request rejected.');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (req.method === 'GET' && (path === '/secure-memory' || path === '/secure-memory/')) {
        await serveAsset(res, 'index.html');
        return;
      }
      if (req.method === 'GET' && path === '/secure-memory/app.js') { await serveAsset(res, 'app.js'); return; }
      if (req.method === 'GET' && path === '/secure-memory/app.css') { await serveAsset(res, 'app.css'); return; }
      if (req.method === 'GET' && path === '/secure-memory/icon.svg') { await serveAsset(res, 'icon.svg'); return; }

      if (req.method === 'GET' && path === '/secure-memory/api/bootstrap') {
        sendJson(res, 200, {
          plugin: 'dsh-secure-memory',
          version,
          initialized: service.store.initialized,
          locked: !service.store.unlocked,
          setupAllowed: !service.store.initialized,
          auth: 'bearer',
          officialCloudAvailable: false,
        });
        return;
      }

      if (req.method === 'POST' && path === '/secure-memory/api/setup') {
        const body = await readJsonBody(req, 16 * 1024);
        const result = await service.setup(body.passphrase);
        sendJson(res, 200, {
          ok: true,
          token: result.token,
          initialized: true,
          unlocked: true,
          auditIntact: result.auditIntact,
        });
        return;
      }

      if (req.method === 'POST' && path === '/secure-memory/api/unlock') {
        const body = await readJsonBody(req, 16 * 1024);
        const result = await service.unlock(body.passphrase);
        sendJson(res, 200, {
          ok: true,
          token: result.token,
          initialized: true,
          unlocked: true,
          auditIntact: result.auditIntact,
          auditReason: result.auditReason,
        });
        return;
      }

      // Everything below is a protected read or management action.
      // A 3s status poll is a read-only heartbeat; it must not extend the
      // vault/token idle lifetime, otherwise an open bar would disable idle
      // lock. User actions still touch the token.
      const statusPoll = req.method === 'GET' && /^\/secure-memory\/api\/session\/[^/]+\/status$/.test(path);
      requireToken(req, service, { touch: !statusPoll });
      const method = req.method;
      const workspaceMatch = path.match(/^\/secure-memory\/api\/workspaces\/([^/]+)\/(authorize|sync|revoke|pause|default)$/);
      const memoryMatch = path.match(/^\/secure-memory\/api\/memory\/([^/]+)\/mark$/);
      const sessionMatch = path.match(/^\/secure-memory\/api\/sessions\/([^/]+)\/exclude$/);
      const sourceMatch = path.match(/^\/secure-memory\/api\/sources\/exclude$/);
      const composerSessionMatch = path.match(/^\/secure-memory\/api\/session\/([^/]+)\/(status|scope|sync)$/);

      if (method === 'GET' && path === '/secure-memory/api/state') {
        sendJson(res, 200, await service.state());
        return;
      }
      if (method === 'POST' && path === '/secure-memory/api/lock') {
        await service.lock({ actor: 'user-ui', reason: 'user' });
        sendJson(res, 200, { ok: true, locked: true });
        return;
      }
      if (method === 'POST' && workspaceMatch) {
        const workspaceId = decodeURIComponent(workspaceMatch[1]);
        const action = workspaceMatch[2];
        const body = await readJsonBody(req);
        if (action === 'authorize') {
          const result = await service.authorize({
            workspaceId,
            mode: body.mode,
            ttlMs: body.ttlMs,
            defaultRetrieval: body.defaultRetrieval !== false,
            sync: body.sync === true,
          });
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        if (action === 'sync') {
          sendJson(res, 200, { ok: true, ...(await service.syncWorkspace(workspaceId, { actor: 'user-ui' })) });
          return;
        }
        if (action === 'revoke') {
          sendJson(res, 200, { ok: true, ...(await service.revoke(workspaceId)) });
          return;
        }
        if (action === 'pause') {
          sendJson(res, 200, { ok: true, grant: await service.pause(workspaceId, body.paused !== false) });
          return;
        }
        if (action === 'default') {
          sendJson(res, 200, { ok: true, grant: await service.setDefaultRetrieval(workspaceId, body.enabled !== false) });
          return;
        }
      }
      if (method === 'POST' && path === '/secure-memory/api/import') {
        const body = await readJsonBody(req, LIMITS.bodyBytes);
        const result = await service.importMemory({
          filename: body.filename,
          content: body.content,
          title: body.title,
          mode: body.mode,
          ttlMs: body.ttlMs,
        });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (method === 'POST' && path === '/secure-memory/api/search') {
        const body = await readJsonBody(req, 64 * 1024);
        sendJson(res, 200, await service.search({
          query: body.query,
          workspaceIds: Array.isArray(body.workspaceIds) ? body.workspaceIds : [],
          includeNonDefault: true,
          mode: body.mode,
          filters: body.filters && typeof body.filters === 'object' ? body.filters : {},
          limit: body.limit,
          actor: 'user-ui',
        }));
        return;
      }
      if (method === 'POST' && path === '/secure-memory/api/context') {
        const body = await readJsonBody(req, 64 * 1024);
        sendJson(res, 200, await service.context({
          query: body.query,
          workspaceIds: Array.isArray(body.workspaceIds) ? body.workspaceIds : [],
          includeNonDefault: true,
          mode: body.mode,
          filters: body.filters && typeof body.filters === 'object' ? body.filters : {},
          actor: 'user-ui',
        }));
        return;
      }
      if (method === 'GET' && path === '/secure-memory/api/graph') {
        sendJson(res, 200, await service.graph({ workspaceIds: parseWorkspaceIds(url) }));
        return;
      }
      if (method === 'GET' && path === '/secure-memory/api/timeline') {
        const limit = Number(url.searchParams.get('limit') ?? 200);
        sendJson(res, 200, await service.timeline({ workspaceIds: parseWorkspaceIds(url), limit }));
        return;
      }
      if (method === 'GET' && path === '/secure-memory/api/audit') {
        const limit = Number(url.searchParams.get('limit') ?? 200);
        sendJson(res, 200, await service.auditList(limit));
        return;
      }
      if (method === 'POST' && path === '/secure-memory/api/security/revoke-all') {
        sendJson(res, 200, { ok: true, ...(await service.revokeAll()) });
        return;
      }
      if (method === 'POST' && path === '/secure-memory/api/security/delete-all') {
        const body = await readJsonBody(req, 16 * 1024);
        if (body.confirm !== 'DELETE') {
          const error = new Error('删除全部数据需要确认短语 DELETE');
          error.code = 'BAD_REQUEST';
          throw error;
        }
        sendJson(res, 200, { ok: true, ...(await service.deleteAll()) });
        return;
      }
      if (method === 'POST' && path === '/secure-memory/api/security/repair-audit') {
        sendJson(res, 200, { ok: true, ...(await service.repairAudit()) });
        return;
      }
      if (method === 'POST' && path === '/secure-memory/api/security/blocked-terms') {
        const body = await readJsonBody(req, 64 * 1024);
        sendJson(res, 200, { ok: true, ...(await service.setBlockedTerms(body.terms)) });
        return;
      }
      if (method === 'GET' && path === '/secure-memory/api/conflicts') {
        sendJson(res, 200, {
          conflicts: service.conflicts ?? [],
          toolNames: service.toolNames ?? null,
          limitations: [
            'DSH Client slots 官方服务只提供 register/inject；无法可靠枚举其他插件占用的 slot、命令、快捷键或事件监听器。',
            '本插件不注册 DSH 命令或快捷键；UI 使用唯一 cwm- 命名空间。',
          ],
        });
        return;
      }
      if (composerSessionMatch) {
        const sessionId = decodeURIComponent(composerSessionMatch[1]);
        const action = composerSessionMatch[2];
        if (method === 'GET' && action === 'status') {
          sendJson(res, 200, await service.sessionStatus(sessionId));
          return;
        }
        if (method === 'POST' && action === 'scope') {
          const body = await readJsonBody(req, 64 * 1024);
          sendJson(res, 200, {
            ok: true,
            ...(await service.setSessionScope(sessionId, {
              enabled: body.enabled === true,
              workspaceIds: Array.isArray(body.workspaceIds) ? body.workspaceIds : [],
              selections: body.selections,
              tokenBudget: body.tokenBudget,
            })),
          });
          return;
        }
        if (method === 'POST' && action === 'sync') {
          sendJson(res, 200, { ok: true, ...(await service.syncSession(sessionId)) });
          return;
        }
      }
      if (method === 'POST' && path === '/secure-memory/api/settings') {
        const body = await readJsonBody(req, 32 * 1024);
        sendJson(res, 200, { ok: true, settings: await service.updateSettings(body) });
        return;
      }
      if (method === 'POST' && memoryMatch) {
        const docId = decodeURIComponent(memoryMatch[1]);
        const body = await readJsonBody(req, 32 * 1024);
        sendJson(res, 200, { ok: true, ...(await service.markDocument(docId, {
          category: body.category,
          status: body.status,
          excluded: body.excluded,
          reason: body.reason,
        })) });
        return;
      }
      if (method === 'POST' && sessionMatch) {
        const sourceSessionId = decodeURIComponent(sessionMatch[1]);
        const body = await readJsonBody(req, 32 * 1024);
        sendJson(res, 200, { ok: true, ...(await service.setSessionExcluded(sourceSessionId, body.excluded !== false, body.reason)) });
        return;
      }
      if (method === 'POST' && sourceMatch) {
        const body = await readJsonBody(req, 32 * 1024);
        sendJson(res, 200, { ok: true, ...(await service.setSourceExcluded(body.sourceName, body.excluded !== false, body.reason)) });
        return;
      }

      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (error) {
      const status = errorStatus(error);
      if (status >= 500) {
        // Never log bodies, queries, passphrases, or tokens.
        console.error(`[dsh-secure-memory] request failed: ${error?.code ?? error?.name ?? 'Error'}`);
      }
      sendJson(res, status, publicError(error));
    }
  };
}
