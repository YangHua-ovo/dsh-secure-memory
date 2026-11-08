import { access, mkdir, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, DEFAULT_SETTINGS, LIMITS, STATE_FORMAT, STATE_VERSION, STATUSES } from './constants.js';
import { nowIso, parseTime, safeProfileName, sha256, uuid } from './util.js';
import { createVaultFiles, deleteVaultFiles, loadVaultFile, writeVault } from './vault.js';

/** Raised when a request touches a locked vault. */
export class VaultLockedError extends Error {
  constructor() {
    super('保险库已锁定。请先在“设置 → 跨工作区记忆”中解锁。');
    this.name = 'VaultLockedError';
    this.code = 'VAULT_LOCKED';
  }
}

/** Raised when the encrypted audit chain does not verify. */
export class AuditIntegrityError extends Error {
  constructor() {
    super('审计链校验失败，安全策略已拒绝检索。请在 Security Center 检查或重建审计链。');
    this.name = 'AuditIntegrityError';
    this.code = 'AUDIT_INTEGRITY';
  }
}

/** Raised for a bounded-resource violation. */
export class LimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LimitError';
    this.code = 'LIMIT_EXCEEDED';
  }
}

/** Resolve the per-profile vault directory. */
export function vaultPaths({ dataRoot, profile }) {
  const dir = join(dataRoot, 'secure-memory', 'profiles', safeProfileName(profile));
  return {
    dir,
    vaultPath: join(dir, 'vault.enc'),
    auditPath: join(dir, 'audit.enc'),
  };
}

/** Count characters without allocating a full array for very large strings. */
function textLength(value) {
  return Array.from(String(value ?? '')).length;
}

/** Sum document content lengths. */
function totalChars(docs) {
  let total = 0;
  for (const doc of docs) total += textLength(doc.content);
  return total;
}

/** Remove abandoned atomic-write temp files in the vault directory. */
function cleanupTempFiles(dir) {
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') && name.endsWith('.tmp')) {
        try { unlinkSync(join(dir, name)); } catch { /* best effort */ }
      }
    }
  } catch { /* directory may not exist yet */ }
}

/** Stable stored workspace id for a DSH registry workspace. */
export function dshWorkspaceId(externalId) {
  return `ws_dsh_${sha256(String(externalId)).slice(0, 24)}`;
}

/**
 * Encrypted, local, single-user memory store.
 *
 * All public mutations are serialized through one promise chain. Reads only
 * return data after the caller proves the vault is unlocked; authorization is
 * enforced by the service layer before any document is selected.
 */
export class SecureMemoryStore {
  constructor({ dataRoot, profile, autoLockMinutes = LIMITS.autoLockMinutes }) {
    const paths = vaultPaths({ dataRoot, profile });
    this.dataRoot = dataRoot;
    this.profile = profile;
    this.dir = paths.dir;
    this.vaultPath = paths.vaultPath;
    this.auditPath = paths.auditPath;
    this.autoLockMinutes = autoLockMinutes;
    this.state = null;
    this.key = null;
    this.header = null;
    this.auditLedger = null;
    this.status = 'uninitialized';
    this.initialized = false;
    this.lastError = null;
    this._queue = Promise.resolve();
    this._auditQueue = Promise.resolve();
    this._listeners = new Set();
  }

  /** Inspect the data directory without unlocking. */
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await access(this.vaultPath);
      this.initialized = true;
      this.status = 'locked';
    } catch {
      this.initialized = false;
      this.status = 'uninitialized';
    }
    return this;
  }

  /** Synchronous variant for a plugin apply() that must not be async. */
  initSync() {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      cleanupTempFiles(this.dir);
    } catch { /* the first write will report a precise failure */ }
    this.initialized = existsSync(this.vaultPath);
    this.status = this.initialized ? 'locked' : 'uninitialized';
    return this;
  }

  /** Whether the store is currently unlocked. */
  get unlocked() {
    return this.status === 'unlocked' && this.state !== null && this.key !== null;
  }

  /** Subscribe to lock/unlock/change notifications (used by the service). */
  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify() {
    for (const listener of this._listeners) {
      try { listener(); } catch { /* observers must not break storage */ }
    }
  }

  /** Throw unless unlocked and audit integrity is intact. */
  assertUnlocked({ requireAudit = true } = {}) {
    if (!this.unlocked) throw new VaultLockedError();
    if (requireAudit && this.auditLedger && !this.auditLedger.intact) throw new AuditIntegrityError();
  }

  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    // Keep the chain alive after a rejected mutation.
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  _enqueueAudit(fn) {
    const run = this._auditQueue.then(fn, fn);
    this._auditQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Create the vault on first use. */
  async setup(passphrase) {
    return this._enqueue(async () => {
      try {
        await access(this.vaultPath);
        const error = new Error('保险库已存在，不能重复创建');
        error.code = 'VAULT_EXISTS';
        throw error;
      } catch (error) {
        if (error && error.code === 'VAULT_EXISTS') {
          this.initialized = true;
          this.status = 'locked';
          throw error;
        }
        if (error && error.code !== 'ENOENT') throw error;
      }
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      let created;
      try {
        created = await createVaultFiles({
          vaultPath: this.vaultPath,
          auditPath: this.auditPath,
          passphrase,
          profile: this.profile,
        });
      } catch (error) {
        // A vault without a usable audit ledger is not a valid secure state.
        // Remove a partially created vault rather than silently downgrading.
        try { await deleteVaultFiles(this.vaultPath, this.auditPath); } catch { /* best effort */ }
        throw error;
      }
      this.key = created.key;
      this.header = created.header;
      this.state = created.state;
      this.auditLedger = created.auditLedger;
      this.status = 'unlocked';
      this.initialized = true;
      this.lastError = null;
      await this._audit({
        actor: 'user-ui',
        action: 'vault.setup',
        outcome: 'ok',
        detail: '本地加密保险库已创建。',
      });
      this._notify();
      return { initialized: true, unlocked: true, auditIntact: true };
    });
  }

  /** Unlock an existing vault. */
  async unlock(passphrase) {
    return this._enqueue(async () => {
      const loaded = await loadVaultFile({
        vaultPath: this.vaultPath,
        auditPath: this.auditPath,
        passphrase,
      });
      this.key = loaded.key;
      this.header = loaded.header;
      this.state = loaded.state;
      this.validateState(this.state);
      if (!Array.isArray(this.state.excludedSessions)) this.state.excludedSessions = [];
      if (!Array.isArray(this.state.excludedSources)) this.state.excludedSources = [];
      if (!Array.isArray(this.state.exclusions)) this.state.exclusions = [];
      if (!Array.isArray(this.state.blockedTerms)) this.state.blockedTerms = [];
      if (!this.state.sessionScopes || typeof this.state.sessionScopes !== 'object' || Array.isArray(this.state.sessionScopes)) {
        this.state.sessionScopes = {};
      }
      this.auditLedger = loaded.auditLedger;
      // Detect a crash between the state write and its audit append. A state
      // mutation always saves first and appends its audit record immediately
      // after, so the newest audit timestamp must not predate the state.
      if (this.auditLedger.intact) {
        const stateMs = parseTime(this.state.updatedAt);
        const lastAuditMs = parseTime(this.auditLedger.entries.at(-1)?.ts);
        if (stateMs !== null && (lastAuditMs === null || stateMs > lastAuditMs + 2000)) {
          this.auditLedger.intact = false;
          this.auditLedger.reason = 'state-newer-than-audit';
        }
      }
      this.status = 'unlocked';
      this.initialized = true;
      this.lastError = null;
      await this._audit({
        actor: 'user-ui',
        action: 'vault.unlock',
        outcome: loaded.auditLedger.intact ? 'ok' : 'error',
        detail: loaded.auditLedger.intact ? '保险库已解锁。' : `审计链异常：${loaded.auditLedger.reason}`,
      });
      this._notify();
      return {
        initialized: true,
        unlocked: true,
        auditIntact: loaded.auditLedger.intact,
        auditReason: loaded.auditLedger.reason,
      };
    });
  }

  /** Lock immediately: zero key material and drop decrypted state. */
  async lock({ audit = true, actor = 'user-ui' } = {}) {
    return this._enqueue(async () => {
      if (!this.unlocked) {
        this.status = this.initialized ? 'locked' : 'uninitialized';
        return { locked: true };
      }
      if (audit) {
        try {
          await this._audit({ actor, action: 'vault.lock', outcome: 'ok', detail: '保险库已锁定。' });
        } catch { /* lock must never be blocked by audit failure */ }
      }
      this.key?.fill(0);
      this.auditLedger?.dispose();
      this.key = null;
      this.state = null;
      this.header = null;
      this.auditLedger = null;
      this.status = this.initialized ? 'locked' : 'uninitialized';
      this._notify();
      return { locked: true };
    });
  }

  /** Persist the current decrypted state. */
  async save() {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      this._notify();
    });
  }

  /** Append a minimal audit record. Never pass bodies, queries, or secrets. */
  async _audit(entry) {
    if (!this.auditLedger) return null;
    if (!this.auditLedger.intact) return null;
    return this._enqueueAudit(async () => {
      if (!this.auditLedger || !this.auditLedger.intact) return null;
      return this.auditLedger.append(entry);
    });
  }

  /** Public audit-write helper for the service. */
  audit(entry) {
    return this._audit(entry);
  }

  /** List recent audit entries. */
  listAudit(limit = 200) {
    this.assertUnlocked({ requireAudit: false });
    return this.auditLedger ? this.auditLedger.list(limit) : [];
  }
  /** Audit chain health. */
  auditStatus() {
    if (!this.unlocked) return { intact: false, reason: 'locked', count: 0 };
    return {
      intact: Boolean(this.auditLedger?.intact),
      reason: this.auditLedger?.reason ?? 'missing',
      count: this.auditLedger?.entries?.length ?? 0,
    };
  }

  /** Explicit user-confirmed rebuild after tamper detection. */
  async repairAudit() {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      if (!this.auditLedger) throw new VaultLockedError();
      await this.auditLedger.resetAfterTamper();
      this._notify();
      return this.auditStatus();
    });
  }

  /**
   * Remove expired grants and their indexed documents.
   * Returns active (not paused) grants. Persists only when something changed.
   */
  async refreshGrants(now = Date.now()) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      // Do not mutate grants without a trustworthy audit chain. The UI can
      // still repair the audit and then sweep expired grants.
      if (this.auditLedger && !this.auditLedger.intact) {
        return this.state.grants.filter((grant) => !grant.paused);
      }
      const expired = [];
      const kept = [];
      for (const grant of this.state.grants) {
        const expires = parseTime(grant.expiresAt);
        if (expires !== null && expires <= now) expired.push(grant);
        else kept.push(grant);
      }
      if (expired.length > 0) {
        const expiredIds = new Set(expired.map((grant) => grant.workspaceId));
        this.state.grants = kept;
        this.state.docs = this.state.docs.filter((doc) => !expiredIds.has(doc.workspaceId));
        for (const workspaceId of expiredIds) {
          for (const [sessionId, record] of Object.entries(this.state.sessions)) {
            if (record.workspaceId === workspaceId) delete this.state.sessions[sessionId];
          }
        }
        this._pruneSessionScopes(expiredIds);
        await writeVault(this.vaultPath, this.state, this.key, this.header);
        for (const grant of expired) {
          await this._audit({
            actor: 'system',
            action: 'grant.expire',
            workspaceIds: [grant.workspaceId],
            outcome: 'ok',
            detail: '临时授权到期，索引与授权已自动删除。',
          });
        }
        this._notify();
      }
      return this.state.grants.filter((grant) => !grant.paused);
    });
  }

  /** Return grants that are active for retrieval. */
  async activeGrants() {
    this.assertUnlocked();
    return this.refreshGrants(Date.now());
  }

  /**
   * Resolve a retrieval scope. Unauthorized requested IDs are rejected, never
   * silently filtered.
   */
  async authorizeScope(requestedWorkspaceIds = [], { includeNonDefault = false } = {}) {
    this.assertUnlocked();
    const active = await this.refreshGrants(Date.now());
    const activeById = new Map(active.map((grant) => [grant.workspaceId, grant]));
    let selected;
    if (Array.isArray(requestedWorkspaceIds) && requestedWorkspaceIds.length > 0) {
      const unique = [...new Set(requestedWorkspaceIds.filter((id) => typeof id === 'string'))];
      const denied = unique.filter((id) => !activeById.has(id));
      if (denied.length > 0) {
        await this._audit({
          actor: 'system',
          action: 'security.deny',
          workspaceIds: denied,
          outcome: 'denied',
          detail: '请求包含未授权、已暂停或已过期的工作区。',
        });
        return { allowed: false, denied, granted: unique.filter((id) => activeById.has(id)), grants: active };
      }
      selected = unique;
    } else {
      selected = active
        .filter((grant) => includeNonDefault || grant.defaultRetrieval)
        .map((grant) => grant.workspaceId);
    }
    return { allowed: true, denied: [], granted: selected, grants: active };
  }

  /** Find the stored workspace record. */
  getWorkspace(workspaceId) {
    return this.state?.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  }

  /** Validate a DSH session id used as an encrypted map key. */
  _sessionKey(sessionId) {
    const id = String(sessionId ?? '');
    if (id.length === 0 || Array.from(id).length > LIMITS.sessionIdChars) {
      const error = new Error('无效的会话标识');
      error.code = 'INVALID_SESSION_ID';
      throw error;
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(id) || id === '__proto__' || id === 'constructor' || id === 'prototype') {
      const error = new Error('会话标识格式不受支持');
      error.code = 'INVALID_SESSION_ID';
      throw error;
    }
    return id;
  }

  /** Read the current session's workspace association (default: disabled, none). */
  getSessionScope(sessionId) {
    this.assertUnlocked({ requireAudit: false });
    const id = this._sessionKey(sessionId);
    const scopes = this.state.sessionScopes ?? {};
    const record = Object.prototype.hasOwnProperty.call(scopes, id) ? scopes[id] : null;
    return {
      sessionId: id,
      enabled: Boolean(record?.enabled),
      workspaceIds: Array.isArray(record?.workspaceIds)
        ? record.workspaceIds.filter((value) => typeof value === 'string').slice(0, LIMITS.sessionScopeWorkspaces)
        : [],
      updatedAt: typeof record?.updatedAt === 'string' ? record.updatedAt : null,
    };
  }

  /**
   * Set the current session's association. This never grants access: every id
   * must already have an active (unpaused, unexpired) grant.
   */
  async setSessionScope(sessionId, { enabled = false, workspaceIds = [] } = {}) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const id = this._sessionKey(sessionId);
      if (!Array.isArray(workspaceIds)) {
        const error = new Error('workspaceIds 必须是数组');
        error.code = 'INVALID_SESSION_SCOPE';
        throw error;
      }
      if (workspaceIds.length > LIMITS.sessionScopeWorkspaces) {
        const error = new Error(`本次会话关联工作区不能超过 ${LIMITS.sessionScopeWorkspaces} 个`);
        error.code = 'LIMIT_EXCEEDED';
        throw error;
      }
      if (workspaceIds.some((value) => typeof value !== 'string')) {
        const error = new Error('workspaceIds 只能包含字符串');
        error.code = 'INVALID_SESSION_SCOPE';
        throw error;
      }
      const stringIds = workspaceIds;
      const selected = [...new Set(stringIds)];
      if (selected.length !== stringIds.length) {
        const error = new Error('workspaceIds 含重复项');
        error.code = 'INVALID_SESSION_SCOPE';
        throw error;
      }
      const now = Date.now();
      const activeById = new Map();
      for (const grant of this.state.grants) {
        const expiresAt = parseTime(grant.expiresAt);
        if (grant.paused) continue;
        if (expiresAt !== null && expiresAt <= now) continue;
        activeById.set(grant.workspaceId, grant);
      }
      const unauthorized = selected.filter((workspaceId) => !activeById.has(workspaceId) || !this.getWorkspace(workspaceId));
      if (unauthorized.length > 0) {
        const error = new Error('本次会话选择包含未授权、暂停或过期的工作区；请先完成工作区授权');
        error.code = 'UNAUTHORIZED_SESSION_WORKSPACE';
        error.workspaceIds = unauthorized;
        throw error;
      }
      const scopes = this.state.sessionScopes && typeof this.state.sessionScopes === 'object' && !Array.isArray(this.state.sessionScopes)
        ? this.state.sessionScopes
        : {};
      this.state.sessionScopes = scopes;
      scopes[id] = {
        enabled: Boolean(enabled),
        workspaceIds: selected,
        updatedAt: nowIso(),
      };
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: 'session.scope',
        workspaceIds: selected,
        outcome: 'ok',
        detail: `sessionHash=${sha256(id).slice(0, 16)}; enabled=${Boolean(enabled)}; count=${selected.length}`,
      });
      this._notify();
      return this.getSessionScope(id);
    });
  }

  /** Remove deleted/expired workspaces from every session association. */
  _pruneSessionScopes(workspaceIds) {
    const remove = workspaceIds instanceof Set ? workspaceIds : new Set(workspaceIds ?? []);
    if (remove.size === 0 || !this.state?.sessionScopes) return false;
    let changed = false;
    for (const scope of Object.values(this.state.sessionScopes)) {
      if (!scope || !Array.isArray(scope.workspaceIds)) continue;
      const next = scope.workspaceIds.filter((id) => !remove.has(id));
      if (next.length !== scope.workspaceIds.length) {
        scope.workspaceIds = next;
        changed = true;
      }
    }
    return changed;
  }

  /** Add or update a DSH local workspace metadata record. */
  async upsertDshWorkspace({ externalId, title, description = '' }) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      let workspace = this.state.workspaces.find((item) => item.kind === 'dsh-local' && item.externalId === externalId);
      if (!workspace) {
        workspace = {
          id: dshWorkspaceId(externalId),
          kind: 'dsh-local',
          externalId,
          title: String(title || '未命名工作区').slice(0, 200),
          description: String(description || '').slice(0, 1000),
          createdAt: nowIso(),
          lastSyncAt: null,
          sessionCount: 0,
        };
        this.state.workspaces.push(workspace);
      } else {
        workspace.title = String(title || workspace.title).slice(0, 200);
        if (description) workspace.description = String(description).slice(0, 1000);
      }
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      this._notify();
      return workspace;
    });
  }

  /** Add a manually imported source workspace. */
  async createManualWorkspace({ title, description = '', sourceKind = 'manual-pack' }) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const workspace = {
        id: `ws_${uuid()}`,
        kind: 'manual-import',
        externalId: null,
        sourceKind,
        title: String(title || '手动导入记忆').slice(0, 200),
        description: String(description || '').slice(0, 1000),
        createdAt: nowIso(),
        lastSyncAt: nowIso(),
        sessionCount: 0,
      };
      this.state.workspaces.push(workspace);
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      this._notify();
      return workspace;
    });
  }

  /** Add a grant. Only the local management UI calls this; no Agent tool exists. */
  async grant({ workspaceId, mode = 'temporary', ttlMs = 24 * 60 * 60 * 1000, defaultRetrieval = true }) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const workspace = this.getWorkspace(workspaceId);
      if (!workspace) {
        const error = new Error('工作区不存在');
        error.code = 'WORKSPACE_NOT_FOUND';
        throw error;
      }
      const existing = this.state.grants.find((grant) => grant.workspaceId === workspaceId);
      const now = Date.now();
      const grant = {
        workspaceId,
        mode: mode === 'long-term' ? 'long-term' : 'temporary',
        expiresAt: mode === 'long-term' ? null : nowIso(new Date(now + Math.max(60_000, Number(ttlMs) || 24 * 60 * 60 * 1000))),
        paused: false,
        defaultRetrieval: Boolean(defaultRetrieval),
        grantedAt: nowIso(),
        grantedBy: 'local-user-ui',
      };
      if (existing) Object.assign(existing, grant);
      else this.state.grants.push(grant);
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: 'grant.add',
        workspaceIds: [workspaceId],
        outcome: 'ok',
        detail: `${grant.mode}${grant.expiresAt ? ` until ${grant.expiresAt}` : ''}`,
      });
      this._notify();
      return grant;
    });
  }

  /** Revoke a grant and immediately purge that workspace's indexed documents. */
  async revoke(workspaceId, { reason = 'user' } = {}) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const before = this.state.docs.length;
      this.state.grants = this.state.grants.filter((grant) => grant.workspaceId !== workspaceId);
      this.state.docs = this.state.docs.filter((doc) => doc.workspaceId !== workspaceId);
      for (const [sessionId, record] of Object.entries(this.state.sessions)) {
        if (record.workspaceId === workspaceId) delete this.state.sessions[sessionId];
      }
      this._pruneSessionScopes(new Set([workspaceId]));
      const removed = before - this.state.docs.length;
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: 'grant.revoke',
        workspaceIds: [workspaceId],
        outcome: 'ok',
        detail: `reason=${reason}; purgedDocuments=${removed}`,
      });
      this._notify();
      return { revoked: true, purgedDocuments: removed };
    });
  }

  /** Pause or resume one grant without deleting the encrypted index. */
  async setPaused(workspaceId, paused) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const grant = this.state.grants.find((item) => item.workspaceId === workspaceId);
      if (!grant) {
        const error = new Error('授权不存在');
        error.code = 'GRANT_NOT_FOUND';
        throw error;
      }
      grant.paused = Boolean(paused);
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: paused ? 'grant.pause' : 'grant.resume',
        workspaceIds: [workspaceId],
        outcome: 'ok',
      });
      this._notify();
      return grant;
    });
  }

  /** Update the default retrieval flag for one grant. */
  async setDefaultRetrieval(workspaceId, enabled) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const grant = this.state.grants.find((item) => item.workspaceId === workspaceId);
      if (!grant) {
        const error = new Error('授权不存在');
        error.code = 'GRANT_NOT_FOUND';
        throw error;
      }
      grant.defaultRetrieval = Boolean(enabled);
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: 'grant.default',
        workspaceIds: [workspaceId],
        outcome: 'ok',
        detail: enabled ? 'default retrieval enabled' : 'default retrieval disabled',
      });
      this._notify();
      return grant;
    });
  }

  /** Revoke every grant and purge all documents. */
  async revokeAll() {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const workspaceIds = [...new Set(this.state.grants.map((grant) => grant.workspaceId))];
      const removed = this.state.docs.length;
      this.state.grants = [];
      this.state.docs = [];
      this.state.sessions = {};
      this.state.sessionScopes = {};
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: 'security.revoke_all',
        workspaceIds,
        outcome: 'ok',
        detail: `purgedDocuments=${removed}`,
      });
      this._notify();
      return { revoked: workspaceIds.length, purgedDocuments: removed };
    });
  }

  /** Replace one session's documents atomically with respect to limits. */
  async replaceSessionDocs({ workspaceId, sessionId, revision, docs, conversationTitle }) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const workspace = this.getWorkspace(workspaceId);
      if (!workspace) throw new Error('工作区不存在');
      const uniqueDocs = new Map();
      for (const doc of docs) if (doc && doc.id) uniqueDocs.set(doc.id, doc);
      const incoming = [...uniqueDocs.values()].map((doc) => ({ ...doc, workspaceId }));
      const others = this.state.docs.filter((doc) => doc.sourceSessionId !== sessionId);
      const proposed = [...others, ...incoming];
      if (proposed.length > LIMITS.libraryDocs) {
        throw new LimitError(`全库文档数超过上限 ${LIMITS.libraryDocs}`);
      }
      const chars = totalChars(proposed);
      if (chars > LIMITS.libraryChars) {
        throw new LimitError(`全库文本长度超过上限 ${LIMITS.libraryChars}`);
      }
      const workspaceDocs = proposed.filter((doc) => doc.workspaceId === workspaceId);
      if (workspaceDocs.length > LIMITS.workspaceDocs) {
        throw new LimitError(`工作区文档数超过上限 ${LIMITS.workspaceDocs}`);
      }
      const workspaceChars = totalChars(workspaceDocs);
      if (workspaceChars > LIMITS.workspaceChars) {
        throw new LimitError(`工作区文本长度超过上限 ${LIMITS.workspaceChars}`);
      }
      this.state.docs = proposed;
      const existing = this.state.sessions[sessionId];
      this.state.sessions[sessionId] = {
        workspaceId,
        revision: String(revision ?? ''),
        indexedAt: nowIso(),
        documentCount: incoming.length,
        conversationTitle: String(conversationTitle ?? existing?.conversationTitle ?? '').slice(0, 200),
      };
      workspace.lastSyncAt = nowIso();
      workspace.sessionCount = new Set(
        this.state.docs
          .filter((doc) => doc.workspaceId === workspaceId && doc.sourceSessionId)
          .map((doc) => doc.sourceSessionId),
      ).size;
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      this._notify();
      return { documents: incoming.length, chars: workspaceChars };
    });
  }

  /** Remove documents for sessions that no longer exist in a workspace account. */
  async pruneWorkspaceSessions(workspaceId, activeSessionIds) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const active = new Set((activeSessionIds ?? []).map(String));
      const keep = [];
      let removedDocs = 0;
      let removedSessions = 0;
      for (const doc of this.state.docs) {
        if (doc.workspaceId === workspaceId && doc.sourceSessionId && !active.has(String(doc.sourceSessionId))) {
          removedDocs += 1;
          continue;
        }
        keep.push(doc);
      }
      for (const [sessionId, record] of Object.entries(this.state.sessions)) {
        if (record.workspaceId === workspaceId && !active.has(String(sessionId))) {
          delete this.state.sessions[sessionId];
          removedSessions += 1;
        }
      }
      if (removedDocs > 0 || removedSessions > 0) {
        this.state.docs = keep;
        await writeVault(this.vaultPath, this.state, this.key, this.header);
        await this._audit({
          actor: 'system',
          action: 'memory.prune',
          workspaceIds: [workspaceId],
          outcome: 'ok',
          detail: `removedSessions=${removedSessions}; removedDocuments=${removedDocs}`,
        });
        this._notify();
      }
      return { removedDocs, removedSessions };
    });
  }

  /** Add a manual import and its grant in one atomic mutation. */
  async importWorkspace({ title, description, docs, sourceKind, mode = 'long-term', ttlMs }) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      if (!Array.isArray(docs) || docs.length === 0) {
        const error = new Error('导入内容不包含可索引的文档');
        error.code = 'EMPTY_IMPORT';
        throw error;
      }
      const uniqueDocs = new Map();
      for (const doc of docs) {
        if (!doc || typeof doc !== 'object') continue;
        const id = `doc_${sha256(`${String(doc.content ?? '')}|${String(doc.sourceRef ?? '')}`).slice(0, 32)}`;
        uniqueDocs.set(id, { ...doc, id });
      }
      const inputDocs = [...uniqueDocs.values()];
      if (inputDocs.length === 0) {
        const error = new Error('导入内容不包含可索引的文档');
        error.code = 'EMPTY_IMPORT';
        throw error;
      }
      if (inputDocs.length > LIMITS.maxImportDocs) {
        throw new LimitError(`单次导入文档数超过上限 ${LIMITS.maxImportDocs}`);
      }
      if (this.state.docs.length + inputDocs.length > LIMITS.libraryDocs) {
        throw new LimitError(`全库文档数超过上限 ${LIMITS.libraryDocs}`);
      }
      if (totalChars(this.state.docs) + totalChars(inputDocs) > LIMITS.libraryChars) {
        throw new LimitError(`全库文本长度超过上限 ${LIMITS.libraryChars}`);
      }
      if (totalChars(inputDocs) > LIMITS.workspaceChars) {
        throw new LimitError(`导入文本长度超过工作区上限 ${LIMITS.workspaceChars}`);
      }
      const workspace = {
        id: `ws_${uuid()}`,
        kind: 'manual-import',
        externalId: null,
        sourceKind,
        title: String(title || '手动导入记忆').slice(0, 200),
        description: String(description || '').slice(0, 1000),
        createdAt: nowIso(),
        lastSyncAt: nowIso(),
        sessionCount: 0,
      };
      const withWorkspace = inputDocs.map((doc) => ({
        ...doc,
        workspaceId: workspace.id,
        id: `doc_${sha256(`${workspace.id}|${doc.sourceRef}|${doc.content}`).slice(0, 32)}`,
      }));
      this.state.workspaces.push(workspace);
      this.state.docs.push(...withWorkspace);
      const now = Date.now();
      this.state.grants.push({
        workspaceId: workspace.id,
        mode: mode === 'temporary' ? 'temporary' : 'long-term',
        expiresAt: mode === 'temporary'
          ? nowIso(new Date(now + Math.max(60_000, Number(ttlMs) || 24 * 60 * 60 * 1000)))
          : null,
        paused: false,
        defaultRetrieval: true,
        grantedAt: nowIso(),
        grantedBy: 'local-user-ui',
      });
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: 'memory.import',
        workspaceIds: [workspace.id],
        outcome: 'ok',
        detail: `sourceKind=${sourceKind}; documents=${withWorkspace.length}; manual snapshot`,
      });
      this._notify();
      return { workspace, documents: withWorkspace.length };
    });
  }

  /** Exclude or restore every memory from one source file. */
  async setSourceExcluded(sourceName, excluded, { reason = 'user' } = {}) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const name = String(sourceName ?? '').trim();
      if (name.length === 0 || name.length > 240) throw new Error('无效的来源文件标识');
      const existing = this.state.excludedSources.find((item) => item.sourceName === name);
      if (excluded) {
        if (!existing) {
          if (this.state.excludedSources.length >= LIMITS.excludedSessions) {
            throw new LimitError('排除来源文件数量超过上限');
          }
          this.state.excludedSources.push({ sourceName: name, reason: String(reason).slice(0, 120), createdAt: nowIso() });
        }
      } else {
        this.state.excludedSources = this.state.excludedSources.filter((item) => item.sourceName !== name);
      }
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: excluded ? 'memory.exclude_source' : 'memory.include_source',
        outcome: 'ok',
        detail: `sourceHash=${sha256(name).slice(0, 16)}; excluded=${Boolean(excluded)}`,
      });
      this._notify();
      return { sourceName: name, excluded: Boolean(excluded) };
    });
  }

  /** Exclude or restore every memory from one source conversation/session. */
  async setSessionExcluded(sourceSessionId, excluded, { reason = 'user' } = {}) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const id = String(sourceSessionId ?? '').trim();
      if (id.length === 0 || id.length > 200) throw new Error('无效的会话标识');
      const existing = this.state.excludedSessions.find((item) => item.sourceSessionId === id);
      if (excluded) {
        if (!existing) {
          if (this.state.excludedSessions.length >= LIMITS.excludedSessions) {
            throw new LimitError('排除会话数量超过上限');
          }
          this.state.excludedSessions.push({ sourceSessionId: id, reason: String(reason).slice(0, 120), createdAt: nowIso() });
        }
      } else {
        this.state.excludedSessions = this.state.excludedSessions.filter((item) => item.sourceSessionId !== id);
      }
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: excluded ? 'memory.exclude_session' : 'memory.include_session',
        outcome: 'ok',
        detail: `sessionHash=${sha256(id).slice(0, 16)}; excluded=${Boolean(excluded)}`,
      });
      this._notify();
      return { sourceSessionId: id, excluded: Boolean(excluded) };
    });
  }

  /** Mark one document's category/status, and optionally exclude it. */
  async markDocument(docId, { category, status, excluded, reason = 'user' } = {}) {    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const doc = this.state.docs.find((item) => item.id === docId);
      if (!doc) {
        const error = new Error('记忆不存在');
        error.code = 'DOC_NOT_FOUND';
        throw error;
      }
      const changes = [];
      if (category !== undefined) {
        if (!CATEGORIES.includes(category)) throw new Error('无效的记忆分类');
        doc.category = category;
        changes.push(`category=${category}`);
      }
      if (status !== undefined) {
        if (!STATUSES.includes(status)) throw new Error('无效的记忆状态');
        doc.status = status;
        if (status === 'confirmed') doc.lastConfirmedAt = nowIso();
        changes.push(`status=${status}`);
      }
      if (excluded !== undefined) {
        const exists = this.state.exclusions.some((item) => item.docId === docId);
        if (excluded && !exists) {
          if (this.state.exclusions.length >= LIMITS.exclusions) throw new LimitError('排除项数量超过上限');
          this.state.exclusions.push({ docId, reason: String(reason).slice(0, 120), createdAt: nowIso() });
          changes.push('excluded=true');
        } else if (!excluded && exists) {
          this.state.exclusions = this.state.exclusions.filter((item) => item.docId !== docId);
          changes.push('excluded=false');
        }
      }
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: excluded ? 'memory.exclude' : 'memory.mark',
        workspaceIds: [doc.workspaceId],
        outcome: 'ok',
        detail: `${doc.id.slice(0, 24)}; ${changes.join('; ')}`.slice(0, 300),
      });
      this._notify();
      return { doc: this.publicDoc(doc) };
    });
  }

  /** Update blocked terms (pre-retrieval exclusion). */
  async setBlockedTerms(terms) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      if (!Array.isArray(terms)) throw new Error('blockedTerms 必须是数组');
      const cleaned = [];
      for (const value of terms) {
        if (typeof value !== 'string') continue;
        const term = value.trim();
        if (term.length === 0) continue;
        if (Array.from(term).length > LIMITS.blockedTermChars) throw new LimitError('敏感词过长');
        if (!cleaned.includes(term)) cleaned.push(term);
        if (cleaned.length > LIMITS.blockedTerms) throw new LimitError('敏感词数量超过上限');
      }
      this.state.blockedTerms = cleaned;
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({
        actor: 'user-ui',
        action: 'security.blocked_terms',
        outcome: 'ok',
        detail: `count=${cleaned.length}`,
      });
      this._notify();
      return { blockedTerms: cleaned };
    });
  }

  /** Update non-secret settings with bounds. */
  async updateSettings(patch) {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      const current = { ...DEFAULT_SETTINGS, ...(this.state.settings ?? {}) };
      if (patch.maxResults !== undefined) {
        current.maxResults = Math.max(1, Math.min(LIMITS.searchResults, Number(patch.maxResults) || 8));
      }
      if (patch.maxContextChars !== undefined) {
        current.maxContextChars = Math.max(1000, Math.min(LIMITS.contextChars, Number(patch.maxContextChars) || 8000));
      }
      if (patch.blockHighRisk !== undefined) current.blockHighRisk = Boolean(patch.blockHighRisk);
      if (patch.autoLockMinutes !== undefined) {
        current.autoLockMinutes = Math.max(1, Math.min(240, Number(patch.autoLockMinutes) || 30));
      }
      this.state.settings = current;
      await writeVault(this.vaultPath, this.state, this.key, this.header);
      await this._audit({ actor: 'user-ui', action: 'security.settings', outcome: 'ok' });
      this._notify();
      return current;
    });
  }

  /** Redacted document projection for the UI. */
  publicDoc(doc, { includeContent = true } = {}) {
    if (!doc) return null;
    const excluded = this.state?.exclusions?.some((item) => item.docId === doc.id) ?? false;
    const excludedSession = Boolean(doc.sourceSessionId)
      && (this.state?.excludedSessions?.some((item) => item.sourceSessionId === doc.sourceSessionId) ?? false);
    return {
      id: doc.id,
      workspaceId: doc.workspaceId,
      sourceKind: doc.sourceKind,
      sourceRef: doc.sourceRef,
      sourceSessionId: doc.sourceSessionId ?? null,
      sourceSeq: doc.sourceSeq ?? null,
      conversationTitle: doc.conversationTitle ?? '',
      role: doc.role,
      title: doc.title,
      content: includeContent ? doc.content : undefined,
      createdAt: doc.createdAt,
      importedAt: doc.importedAt,
      lastConfirmedAt: doc.lastConfirmedAt ?? null,
      category: doc.category,
      status: doc.status,
      tags: Array.isArray(doc.tags) ? doc.tags : [],
      risk: doc.risk,
      language: doc.language,
      excluded,
      excludedSession,
    };
  }

  /** Aggregate counts only; safe for the status tool. */
  stats() {
    this.assertUnlocked({ requireAudit: false });
    const byWorkspace = new Map();
    for (const doc of this.state.docs) {
      const bucket = byWorkspace.get(doc.workspaceId) ?? { documents: 0, chars: 0 };
      bucket.documents += 1;
      bucket.chars += textLength(doc.content);
      byWorkspace.set(doc.workspaceId, bucket);
    }
    return {
      workspaces: this.state.workspaces.length,
      grants: this.state.grants.length,
      documents: this.state.docs.length,
      chars: totalChars(this.state.docs),
      sessions: Object.keys(this.state.sessions).length,
      exclusions: this.state.exclusions.length,
      excludedSessions: this.state.excludedSessions.length,
      excludedSources: this.state.excludedSources.length,
      sessionScopes: Object.keys(this.state.sessionScopes ?? {}).length,
      byWorkspace,
    };
  }

  /** Full UI projection. Only call after a valid bearer session. */
  snapshot() {
    this.assertUnlocked({ requireAudit: false });
    const now = Date.now();
    const counts = this.stats();
    const exclusions = new Set(this.state.exclusions.map((item) => item.docId));
    const excludedSessions = new Set(this.state.excludedSessions.map((item) => item.sourceSessionId));
    return {
      initialized: true,
      unlocked: true,
      profile: this.profile,
      vaultPath: this.vaultPath,
      vaultId: this.state.vaultId,
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      audit: this.auditStatus(),
      settings: { ...DEFAULT_SETTINGS, ...(this.state.settings ?? {}) },
      blockedTerms: [...this.state.blockedTerms],
      exclusions: this.state.exclusions.map((item) => ({ ...item })),
      excludedSessions: this.state.excludedSessions.map((item) => ({ ...item })),
      excludedSources: this.state.excludedSources.map((item) => ({ ...item })),
      workspaces: this.state.workspaces.map((workspace) => {
        const grant = this.state.grants.find((item) => item.workspaceId === workspace.id);
        const expires = parseTime(grant?.expiresAt);
        const expired = expires !== null && expires <= now;
        return {
          ...workspace,
          documents: counts.byWorkspace.get(workspace.id)?.documents ?? 0,
          chars: counts.byWorkspace.get(workspace.id)?.chars ?? 0,
          grant: grant
            ? {
                ...grant,
                expired,
                active: !grant.paused && !expired,
              }
            : null,
        };
      }),
      counts: {
        documents: counts.documents,
        chars: counts.chars,
        sessions: counts.sessions,
        exclusions: exclusions.size,
        excludedSessions: excludedSessions.size,
        excludedSources: this.state.excludedSources.length,
        sessionScopes: Object.keys(this.state.sessionScopes ?? {}).length,
      },
    };
  }

  /** Delete all local data and lock. */
  async deleteEverything() {
    return this._enqueue(async () => {
      this.assertUnlocked({ requireAudit: false });
      this.key?.fill(0);
      this.auditLedger?.dispose();
      this.key = null;
      this.state = null;
      this.header = null;
      this.auditLedger = null;
      await deleteVaultFiles(this.vaultPath, this.auditPath);
      cleanupTempFiles(this.dir);
      this.initialized = false;
      this.status = 'uninitialized';
      this._notify();
      return { deleted: true };
    });
  }

  /** Read raw sizes without decrypting. */
  async fileInfo() {
    const info = { vaultBytes: 0, auditBytes: 0, dir: this.dir };
    try { info.vaultBytes = (await stat(this.vaultPath)).size; } catch { /* absent */ }
    try { info.auditBytes = (await stat(this.auditPath)).size; } catch { /* absent */ }
    return info;
  }

  /** Hash a query for audit without retaining its text. */
  static queryHash(query) {
    return sha256(String(query ?? ''));
  }

  /** Validate state shape on load (defensive). */
  validateState(state) {
    if (!state || state.format !== STATE_FORMAT || state.version !== STATE_VERSION) {
      throw new Error('保险库状态格式不受支持');
    }
    if (!Array.isArray(state.workspaces) || !Array.isArray(state.grants) || !Array.isArray(state.docs)) {
      throw new Error('保险库状态结构损坏');
    }
    return true;
  }
}
