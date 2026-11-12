import { randomBytes } from 'node:crypto';
import { ACTIONS, LIMITS } from './constants.js';
import { buildContext, scopeLabelFor } from './context.js';
import { buildGraph } from './graph.js';
import { assertImportSize, extractDshWorkspace, parseImport } from './ingest.js';
import { LayeredMemoryIndex } from './layers.js';
import { docInSelections } from './scope.js';
import { dshWorkspaceId, SecureMemoryStore } from './store.js';
import { assessResults, buildTimeline, confidenceFor, detectConflicts } from './validate.js';
import { nowIso, parseTime, sha256 } from './util.js';

/** Error used when the management UI or Agent exceeds a request budget. */
export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
    this.code = 'RATE_LIMITED';
  }
}

/**
 * Orchestrates storage, DSH workspace connectors, retrieval, validation, and
 * audit. Host tools call only the read methods; management mutations require a
 * UI bearer token enforced by the HTTP layer.
 */
export class SecureMemoryService {
  constructor({ store, profile, getWorkspaceRegistry, getSessionPersistence, countTokens, tokenCounter, autoLockMinutes = LIMITS.autoLockMinutes }) {
    this.store = store;
    this.profile = profile;
    this.countTokens = countTokens;
    this.tokenCounter = tokenCounter;
    this.getWorkspaceRegistry = getWorkspaceRegistry;
    this.getSessionPersistence = getSessionPersistence;
    this.autoLockMinutes = autoLockMinutes;
    this._index = null;
    this._tokens = new Map();
    this._lastActivity = Date.now();
    this._timer = null;
    this._unlockFailures = 0;
    this._unlockBlockedUntil = 0;
    this._searchTimes = [];
    this._disposed = false;
    this._sessionRuntime = new Map();
    this._revision = 0;
    this.toolNames = null;
    this.conflicts = [];
    this.store.onChange(() => {
      this._index = null;
      this._revision += 1;
      this._sessionRuntime.clear();
      this.touch();
    });
  }

  /** Start the idle-lock watchdog. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      if (this._disposed) return;
      if (this.store.unlocked && Date.now() - this._lastActivity > this._autoLockMinutes() * 60 * 1000) {
        this.lock({ actor: 'system', reason: 'idle-timeout' }).catch(() => {});
      }
    }, 30_000);
    this._timer.unref?.();
  }

  _autoLockMinutes() {
    const configured = Number(this.store.state?.settings?.autoLockMinutes);
    return Number.isFinite(configured) && configured >= 1 ? configured : this.autoLockMinutes;
  }

  /** Update the activity clock. */
  touch() {
    this._lastActivity = Date.now();
  }

  /** Stop timers and clear secrets. */
  async dispose() {
    this._disposed = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._tokens.clear();
    this._index = null;
    this._searchTimes = [];
    try { await this.store.lock({ audit: false }); } catch { /* best effort on unload */ }
  }

  /** Create the vault and issue a management token. */
  async setup(passphrase) {
    const result = await this.store.setup(passphrase);
    this.start();
    this.touch();
    return { ...result, token: this.issueToken() };
  }

  /** Unlock with rate limiting. */
  async unlock(passphrase) {
    const now = Date.now();
    if (now < this._unlockBlockedUntil) {
      const wait = Math.ceil((this._unlockBlockedUntil - now) / 1000);
      const error = new Error(`解锁尝试过多，请等待 ${wait} 秒后再试`);
      error.code = 'UNLOCK_RATE_LIMITED';
      throw error;
    }
    try {
      const result = await this.store.unlock(passphrase);
      this._unlockFailures = 0;
      this.start();
      this.touch();
      return { ...result, token: this.issueToken() };
    } catch (error) {
      this._unlockFailures += 1;
      if (this._unlockFailures >= 5) {
        this._unlockBlockedUntil = Date.now() + Math.min(5 * 60_000, 30_000 * 2 ** (this._unlockFailures - 5));
      }
      throw error;
    }
  }

  /** Lock, clear all browser tokens, and drop the in-memory index. */
  async lock({ actor = 'user-ui', reason = 'user' } = {}) {
    this._tokens.clear();
    this._index = null;
    this._searchTimes = [];
    this._sessionRuntime.clear();
    return this.store.lock({ audit: true, actor });
  }

  /** Create a management bearer token. It is not persisted anywhere. */
  issueToken() {
    const token = randomBytes(32).toString('base64url');
    this._tokens.set(token, { createdAt: Date.now(), lastUsed: Date.now() });
    if (this._tokens.size > 20) {
      const oldest = [...this._tokens.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) this._tokens.delete(oldest[0]);
    }
    return token;
  }

  /** Validate and touch a management token. */
  validateToken(token, { touch = true } = {}) {
    if (typeof token !== 'string' || token.length < 20) return false;
    if (!this.store.unlocked) return false;
    const record = this._tokens.get(token);
    if (!record) return false;
    const now = Date.now();
    if (now - record.lastUsed > LIMITS.apiTokenIdleMinutes * 60_000) {
      this._tokens.delete(token);
      return false;
    }
    if (touch) {
      record.lastUsed = now;
      this.touch();
    }
    return true;
  }

  /** Revoke all management tokens (used by panic actions). */
  revokeTokens() {
    this._tokens.clear();
  }

  /** Ensure this service can answer a protected read. */
  _assertSearchable() {
    if (!this.store.unlocked) {
      const error = new Error('保险库已锁定');
      error.code = 'VAULT_LOCKED';
      throw error;
    }
    if (!this.store.auditStatus().intact) {
      const error = new Error('审计链异常，检索已被拒绝');
      error.code = 'AUDIT_INTEGRITY';
      throw error;
    }
  }

  _assertNotDisposed() {
    if (this._disposed) {
      const error = new Error('插件已卸载');
      error.code = 'DISPOSED';
      throw error;
    }
  }

  /** Lazy index build; invalidated on every vault mutation. */
  getIndex() {
    this._assertSearchable();
    if (!this._index) this._index = new LayeredMemoryIndex(this.store.state.docs);
    return this._index;
  }

  _invalidateIndex() {
    this._index = null;
  }

  /** DSH local workspace metadata, never contents. */
  listDshWorkspaces() {
    const registry = this.getWorkspaceRegistry?.();
    if (!registry || typeof registry.list !== 'function') {
      return {
        available: false,
        reason: 'DSH workspaceRegistry 服务不可用；只能使用手动导入源。',
        items: [],
      };
    }
    try {
      const items = registry.list().map((workspace) => ({
        id: dshWorkspaceId(workspace.id),
        externalId: workspace.id,
        kind: 'dsh-local',
        title: workspace.title || '未命名工作区',
        description: 'DSH 本地工作区（本地目录，不是云聊天工作区）',
        path: workspace.path,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
        live: true,
      }));
      return { available: true, items };
    } catch (error) {
      return { available: false, reason: error?.message ?? '工作区列表读取失败', items: [] };
    }
  }

  /** Find a live DSH workspace by its stable stored id. */
  _liveByStoredId(workspaceId) {
    const list = this.listDshWorkspaces();
    return list.items.find((workspace) => workspace.id === workspaceId) ?? null;
  }

  /** Create a stored metadata record for a live DSH workspace on demand. */
  async _ensureWorkspace(workspaceId) {
    const existing = this.store.getWorkspace(workspaceId);
    if (existing) return existing;
    const live = this._liveByStoredId(workspaceId);
    if (!live) {
      const error = new Error('工作区不存在，或不是当前 DSH 注册的本地工作区');
      error.code = 'WORKSPACE_NOT_FOUND';
      throw error;
    }
    return this.store.upsertDshWorkspace({
      externalId: live.externalId,
      title: live.title,
      description: live.description,
    });
  }

  /** Full authenticated UI state. */
  async state() {
    this._assertNotDisposed();
    if (!this.store.unlocked) {
      const error = new Error('保险库已锁定');
      error.code = 'VAULT_LOCKED';
      throw error;
    }
    await this.store.refreshGrants(Date.now());
    const snapshot = this.store.snapshot();
    const dsh = this.listDshWorkspaces();
    const storedByExternal = new Map(
      snapshot.workspaces
        .filter((workspace) => workspace.kind === 'dsh-local' && workspace.externalId)
        .map((workspace) => [workspace.externalId, workspace]),
    );
    const merged = [];
    const seen = new Set();
    for (const live of dsh.items) {
      const stored = storedByExternal.get(live.externalId);
      if (stored) {
        merged.push({
          ...stored,
          live: true,
          path: live.path,
          sessionCount: live.sessionCount,
          externalTitle: live.title,
        });
        seen.add(stored.id);
      } else {
        merged.push({
          id: live.id,
          kind: 'dsh-local',
          externalId: live.externalId,
          title: live.title,
          description: live.description,
          path: live.path,
          createdAt: live.createdAt,
          updatedAt: live.updatedAt,
          lastSyncAt: null,
          sessionCount: live.sessionCount,
          documents: 0,
          chars: 0,
          grant: null,
          live: true,
          virtual: true,
        });
      }
    }
    for (const workspace of snapshot.workspaces) {
      if (workspace.kind === 'dsh-local' && workspace.externalId && seen.has(workspace.id)) continue;
      if (workspace.kind === 'dsh-local' && workspace.externalId) {
        merged.push({ ...workspace, live: false });
      } else {
        merged.push({ ...workspace, live: true });
      }
    }
    const fileInfo = await this.store.fileInfo();
    return {
      ...snapshot,
      workspaces: merged,
      dsh,
      officialCloud: {
        available: false,
        status: 'not-supported',
        title: 'DeepSeek 云聊天工作区实时连接',
        reason: '官方没有公开的工作区/历史会话读取 API；仅支持用户在官方设置中手动导出后导入。',
        exportPath: 'DeepSeek → 头像 → 设置 → 数据管理 → 导出所有历史对话',
      },
      privacy: {
        localOnly: true,
        externalEmbedding: false,
        cloudVectorDatabase: false,
        modelProviderTransmission: true,
        disclosure: '本插件不发起外网请求。但当你让 AI 使用记忆时，所选片段会进入当前对话上下文，并由 DSH 发送给当前模型服务商。',
        storage: 'AES-256-GCM 加密文件；密钥只存在于本机进程内存。',
      },
      storage: {
        ...fileInfo,
        profile: this.profile,
      },
      autoLockMinutes: this._autoLockMinutes(),
    };
  }

  /** Grant one workspace and optionally sync it in the same user action. */
  async authorize({ workspaceId, mode = 'temporary', ttlMs, defaultRetrieval = true, sync = false, signal }) {
    this._assertSearchable();
    const workspace = await this._ensureWorkspace(workspaceId);
    const grant = await this.store.grant({ workspaceId: workspace.id, mode, ttlMs, defaultRetrieval });
    this._invalidateIndex();
    let syncResult = null;
    if (sync) {
      syncResult = await this.syncWorkspace(workspace.id, { signal, actor: 'user-ui' });
    }
    return { workspace: this.store.getWorkspace(workspace.id), grant, sync: syncResult };
  }

  /** Read a DSH workspace's sessions and replace its local encrypted index. */
  async syncWorkspace(workspaceId, { signal, actor = 'user-ui' } = {}) {
    this._assertSearchable();
    this.touch();
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) {
      const error = new Error('工作区不存在');
      error.code = 'WORKSPACE_NOT_FOUND';
      throw error;
    }
    if (workspace.kind !== 'dsh-local') {
      const error = new Error('手动导入源不支持 DSH 会话同步');
      error.code = 'NOT_DSH_WORKSPACE';
      throw error;
    }
    const active = await this.store.activeGrants();
    if (!active.some((grant) => grant.workspaceId === workspaceId)) {
      await this.store.audit({
        actor,
        action: ACTIONS.DENY,
        workspaceIds: [workspaceId],
        outcome: 'denied',
        detail: 'sync denied: no active grant',
      });
      const error = new Error('该工作区没有有效授权，拒绝同步');
      error.code = 'DENIED';
      throw error;
    }
    const registry = this.getWorkspaceRegistry?.();
    const persistence = this.getSessionPersistence?.();
    if (!registry || !persistence) {
      const error = new Error('DSH 工作区或会话服务不可用');
      error.code = 'DSH_SERVICES_UNAVAILABLE';
      throw error;
    }
    const live = registry.list().find((item) => dshWorkspaceId(item.id) === workspaceId);
    if (!live) {
      const error = new Error('DSH 工作区已不存在');
      error.code = 'WORKSPACE_NOT_FOUND';
      throw error;
    }
    let extracted;
    try {
      extracted = await extractDshWorkspace({
        workspace: live,
        sessionPersistence: persistence,
        workspaceId,
        now: Date.now(),
        signal,
      });
    } catch (error) {
      await this.store.audit({
        actor,
        action: ACTIONS.SYNC,
        workspaceIds: [workspaceId],
        outcome: 'error',
        detail: `sync failed: ${String(error?.code ?? error?.name ?? 'error').slice(0, 40)}`,
      });
      throw error;
    }

    let indexedSessions = 0;
    let skippedSessions = 0;
    let indexedDocs = 0;
    const warnings = [...extracted.warnings];
    for (const session of extracted.sessions) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const previous = this.store.state.sessions[session.sessionId];
      if (previous && previous.revision === session.revision && previous.workspaceId === workspaceId) {
        skippedSessions += 1;
        continue;
      }
      try {
        const result = await this.store.replaceSessionDocs({
          workspaceId,
          sessionId: session.sessionId,
          revision: session.revision,
          docs: session.docs,
          conversationTitle: session.title,
        });
        indexedSessions += 1;
        indexedDocs += result.documents;
      } catch (error) {
        warnings.push(`会话 ${String(session.sessionId).slice(-10)} 未索引：${error?.message ?? 'limit'}`);
        if (error?.code === 'LIMIT_EXCEEDED') break;
      }
    }
    let pruned = { removedDocs: 0, removedSessions: 0 };
    if (!extracted.truncated) {
      const activeSessionIds = (live.sessionIds ?? []).slice(0, LIMITS.syncSessions);
      pruned = await this.store.pruneWorkspaceSessions(workspaceId, activeSessionIds);
    }
    await this.store.audit({
      actor,
      action: ACTIONS.SYNC,
      workspaceIds: [workspaceId],
      outcome: 'ok',
      detail: `indexedSessions=${indexedSessions}; skipped=${skippedSessions}; indexedDocuments=${indexedDocs}; prunedDocuments=${pruned.removedDocs}; warnings=${warnings.length}`,
    });
    this._invalidateIndex();
    return {
      workspaceId,
      title: workspace.title,
      sessionsSeen: extracted.sessions.length,
      indexedSessions,
      skippedSessions,
      indexedDocuments: indexedDocs,
      prunedDocuments: pruned.removedDocs,
      warnings: warnings.slice(0, 50),
      truncated: extracted.truncated,
    };
  }

  async revoke(workspaceId) {
    this._assertSearchable();
    const result = await this.store.revoke(workspaceId);
    this._invalidateIndex();
    return result;
  }

  async pause(workspaceId, paused) {
    this._assertSearchable();
    const grant = await this.store.setPaused(workspaceId, paused);
    this._invalidateIndex();
    return grant;
  }

  async setDefaultRetrieval(workspaceId, enabled) {
    this._assertSearchable();
    const grant = await this.store.setDefaultRetrieval(workspaceId, enabled);
    this._invalidateIndex();
    return grant;
  }

  async revokeAll() {
    this._assertSearchable();
    const result = await this.store.revokeAll();
    this.revokeTokens();
    this._invalidateIndex();
    return result;
  }

  /** Import a manual snapshot and create its grant. */
  async importMemory({ filename, content, title, mode = 'long-term', ttlMs } = {}) {
    this._assertSearchable();
    this.touch();
    const parsed = parseImport({ filename, content });
    assertImportSize(parsed);
    const result = await this.store.importWorkspace({
      title: title || parsed.title,
      description: parsed.description,
      docs: parsed.docs,
      sourceKind: parsed.sourceKind,
      mode,
      ttlMs,
    });
    this._invalidateIndex();
    return {
      workspace: result.workspace,
      documents: result.documents,
      warnings: parsed.warnings,
      stats: parsed.stats,
      manualSnapshot: true,
    };
  }

  _checkSearchRate(actor) {
    const now = Date.now();
    this._searchTimes = this._searchTimes.filter((time) => now - time < 60_000);
    const limit = actor === 'agent-tool' ? 30 : 60;
    if (this._searchTimes.length >= limit) throw new RateLimitError('检索频率超过每分钟上限');
    this._searchTimes.push(now);
  }

  /** Record a content-free retrieval state for the composer bar. */
  _recordRuntime(sessionId, patch) {
    if (!sessionId) return;
    const previous = this._sessionRuntime.get(sessionId) ?? {};
    this._sessionRuntime.set(sessionId, {
      ...previous,
      ...patch,
      at: nowIso(),
    });
  }

  /** Sources metadata for the status panel; never includes document bodies. */
  _sourceSummaries(assessedResults, workspaces) {
    const byId = new Map((workspaces ?? []).map((workspace) => [workspace.id, workspace]));
    return (assessedResults ?? []).slice(0, 4).map((result) => ({
      workspaceId: result.workspaceId,
      workspaceTitle: byId.get(result.workspaceId)?.title ?? result.workspaceId,
      sourceRef: String(result.sourceRef ?? '').slice(0, 240),
      title: String(result.title ?? '').slice(0, 160),
      createdAt: result.createdAt ?? null,
      category: result.category ?? null,
      status: result.status ?? null,
      confidence: result.confidence?.score ?? null,
      risk: result.risk ?? 'low',
      memoryLevel: result.memoryLevel ?? 'L3',
    }));
  }

  /**
   * Resolve the current session's effective workspace set. This is a pure
   * intersection of the session selection and currently active grants.
   */
  async _sessionScope(sessionId) {
    let scope;
    try {
      scope = this.store.getSessionScope(sessionId);
    } catch (error) {
      return { ok: false, reason: 'INVALID_SESSION_ID', denied: [], granted: [], scope: null };
    }
    const active = await this.store.activeGrants();
    const activeById = new Map(active.map((grant) => [grant.workspaceId, grant]));
    const effective = scope.workspaceIds.filter((id) => activeById.has(id));
    return {
      ok: true,
      scope,
      active,
      activeById,
      effective,
    };
  }

  async _scope(requestedWorkspaceIds, { includeNonDefault = false, sessionId = null, enforceSessionScope = false } = {}) {
    if (Array.isArray(requestedWorkspaceIds) && requestedWorkspaceIds.length > 64) {
      return { ok: false, reason: 'TOO_MANY_WORKSPACES', denied: ['<too-many>'], granted: [] };
    }
    if (Array.isArray(requestedWorkspaceIds) && requestedWorkspaceIds.some((id) => typeof id !== 'string')) {
      return { ok: false, reason: 'INVALID_WORKSPACE_ID', denied: ['<invalid>'], granted: [] };
    }
    if (enforceSessionScope) {
      if (!sessionId) {
        return { ok: false, reason: 'SESSION_REQUIRED', denied: [], granted: [] };
      }
      const session = await this._sessionScope(sessionId);
      if (!session.ok) {
        return { ok: false, reason: session.reason, denied: [], granted: [] };
      }
      if (!session.scope.enabled) {
        return { ok: false, reason: 'SESSION_DISABLED', denied: [], granted: [], sessionScope: session.scope };
      }
      const uniqueRequested = [...new Set(requestedWorkspaceIds ?? [])];
      const effectiveSet = new Set(session.effective);
      const denied = uniqueRequested.filter((id) => !effectiveSet.has(id));
      if (denied.length > 0) {
        return {
          ok: false,
          reason: 'UNAUTHORIZED_SESSION_WORKSPACE',
          denied,
          granted: uniqueRequested.filter((id) => effectiveSet.has(id)),
          sessionScope: session.scope,
        };
      }
      const chosen = uniqueRequested.length > 0 ? uniqueRequested : session.effective;
      if (chosen.length === 0) {
        return { ok: false, reason: 'NO_SESSION_WORKSPACES', denied: [], granted: [], sessionScope: session.scope };
      }
      const workspaces = chosen.map((workspaceId) => this.store.getWorkspace(workspaceId)).filter(Boolean);
      if (workspaces.length !== chosen.length) {
        return { ok: false, reason: 'WORKSPACE_METADATA_MISSING', denied: [], granted: [], sessionScope: session.scope };
      }
      return {
        ok: true,
        granted: chosen,
        workspaces,
        grants: chosen.map((id) => session.activeById.get(id)).filter(Boolean),
        sessionScope: session.scope,
      };
    }
    const authorization = await this.store.authorizeScope(requestedWorkspaceIds, { includeNonDefault });
    if (!authorization.allowed) {
      return {
        ok: false,
        reason: 'UNAUTHORIZED_WORKSPACE',
        denied: authorization.denied,
        granted: authorization.granted,
      };
    }
    if (authorization.granted.length === 0) {
      return {
        ok: false,
        reason: 'NO_DEFAULT_WORKSPACE',
        denied: [],
        granted: [],
      };
    }
    const workspaces = authorization.granted
      .map((workspaceId) => this.store.getWorkspace(workspaceId))
      .filter(Boolean);
    const missing = authorization.granted.filter((workspaceId) => !this.store.getWorkspace(workspaceId));
    if (missing.length > 0) {
      return { ok: false, reason: 'WORKSPACE_METADATA_MISSING', denied: missing, granted: [] };
    }
    return { ok: true, granted: authorization.granted, workspaces, grants: authorization.grants };
  }

  _scopedDocs(granted) {
    const allowed = new Set(granted);
    return this.store.state.docs.filter((doc) => allowed.has(doc.workspaceId));
  }

  /** Authorized and user-visible docs: excludes doc/session rules and blocked terms. */
  _visibleDocs(granted, selections) {
    const allowed = new Set(granted);
    const excludedDocs = new Set(this.store.state.exclusions.map((item) => item.docId));
    const excludedSessions = new Set(this.store.state.excludedSessions.map((item) => item.sourceSessionId));
    const excludedSources = new Set(this.store.state.excludedSources.map((item) => item.sourceName));
    const blockedTerms = (this.store.state.blockedTerms ?? [])
      .filter((term) => typeof term === 'string' && term.length > 0)
      .map((term) => term.toLowerCase());
    return this.store.state.docs.filter((doc) => {
      if (!allowed.has(doc.workspaceId)) return false;
      if (!docInSelections(doc, selections)) return false;
      if (excludedDocs.has(doc.id)) return false;
      if (doc.sourceSessionId && excludedSessions.has(doc.sourceSessionId)) return false;
      if (doc.sourceName && excludedSources.has(doc.sourceName)) return false;
      if (blockedTerms.length > 0) {
        const haystack = `${doc.title ?? ''}\n${doc.content ?? ''}`.toLowerCase();
        if (blockedTerms.some((term) => haystack.includes(term))) return false;
      }
      return true;
    });
  }

  _excludedSessionIds() {
    return new Set(this.store.state.excludedSessions.map((item) => item.sourceSessionId));
  }

  _excludedSourceNames() {
    return new Set(this.store.state.excludedSources.map((item) => item.sourceName));
  }

  // Recheck after asynchronous audit I/O: a concurrent revoke, lock or scope
  // change must not let an already computed result escape its old permissions.
  _scopeStillCurrent(scope, sessionId, revision) {
    this._assertSearchable();
    if (revision !== this._revision) return false;
    const now = Date.now();
    const active = new Set(this.store.state.grants.filter((grant) => !grant.paused
      && (parseTime(grant.expiresAt) === null || parseTime(grant.expiresAt) > now)).map((grant) => grant.workspaceId));
    if (scope.granted.some((id) => !active.has(id))) return false;
    if (scope.sessionScope) {
      const current = this.store.getSessionScope(sessionId);
      if (!current.enabled || JSON.stringify(current.selections) !== JSON.stringify(scope.sessionScope.selections)
        || current.tokenBudget !== scope.sessionScope.tokenBudget) return false;
    }
    return true;
  }

  /** Agent/UI search with mandatory pre-retrieval authorization. */
  async search({
    query,
    workspaceIds = [],
    includeNonDefault = false,
    mode = 'hybrid',
    filters = {},
    limit,
    actor = 'agent-tool',
    sessionId = null,
  } = {}) {
    this._assertSearchable();
    this.touch();
    this._checkSearchRate(actor);
    if (actor === 'agent-tool' && sessionId) {
      this._recordRuntime(sessionId, { state: 'retrieving', queryHash: SecureMemoryStore.queryHash(query), resultCount: 0, sources: [] });
    }
    const queryHash = SecureMemoryStore.queryHash(query);
    const scope = await this._scope(workspaceIds, {
      includeNonDefault,
      sessionId,
      enforceSessionScope: actor === 'agent-tool' || Boolean(sessionId),
    });
    if (!scope.ok) {
      this._recordRuntime(sessionId, {
        state: 'denied',
        reason: scope.reason,
        queryHash,
        resultCount: 0,
        sources: [],
      });
      await this.store.audit({
        actor,
        action: ACTIONS.DENY,
        workspaceIds: scope.denied,
        queryHash,
        outcome: 'denied',
        detail: `search denied: ${scope.reason}${sessionId ? `; sessionHash=${sha256(sessionId).slice(0, 12)}` : ''}`,
      });
      return {
        status: 'denied',
        reason: scope.reason,
        denied: scope.denied,
        granted: scope.granted,
        queryHash,
        results: [],
      };
    }
    const revision = this._revision;
    const allDocs = this._visibleDocs(scope.granted, scope.sessionScope?.selections);
    const index = this.getIndex();
    const excluded = new Set(this.store.state.exclusions.map((item) => item.docId));
    let raw;
    try {
      raw = index.search({
        query,
        allowedWorkspaceIds: scope.granted,
        selections: scope.sessionScope?.selections,
        excludedDocIds: excluded,
        excludedSessionIds: this._excludedSessionIds(),
        excludedSourceNames: this._excludedSourceNames(),
        blockedTerms: this.store.state.blockedTerms,
        filters,
        mode,
        limit: limit ?? this.store.state.settings?.maxResults ?? 8,
      });
    } catch (error) {
      this._recordRuntime(sessionId, {
        state: 'error',
        reason: 'RETRIEVAL_ERROR',
        queryHash,
        resultCount: 0,
        sources: [],
      });
      await this.store.audit({
        actor,
        action: ACTIONS.SEARCH,
        workspaceIds: scope.granted,
        queryHash,
        outcome: 'error',
        detail: String(error?.message ?? 'search error').slice(0, 160),
      });
      throw error;
    }
    const assessed = assessResults(raw.results, allDocs);
    const resultCount = assessed.results.length;
    this._recordRuntime(sessionId, {
      state: resultCount > 0 ? 'completed' : 'no_results',
      queryHash,
      resultCount,
      sources: this._sourceSummaries(assessed.results, scope.workspaces),
    });
    await this.store.audit({
      actor,
      action: ACTIONS.SEARCH,
      workspaceIds: scope.granted,
      queryHash,
      resultCount,
      outcome: 'ok',
      detail: `mode=${mode}; candidates=${raw.candidateCount}; quarantined=${assessed.results.filter((item) => item.quarantined).length}; blockedByTerms=${raw.blockedByTerms}; sources=${assessed.results.slice(0, 8).map((item) => item.id.slice(0, 20)).join(',') || 'none'}${sessionId ? `; sessionHash=${sha256(sessionId).slice(0, 12)}` : ''}`,
    });
    if (!this._scopeStillCurrent(scope, sessionId, revision)) return { status: 'denied', reason: 'SCOPE_CHANGED', denied: [], granted: [], results: [], queryHash };
    return {
      status: resultCount > 0 ? 'ok' : 'no_results',
      results: assessed.results,
      conflicts: assessed.conflicts,
      scope: {
        granted: scope.granted,
        workspaces: scope.workspaces.map((workspace) => ({ id: workspace.id, title: workspace.title, kind: workspace.kind })),
        labels: scopeLabelFor(scope.workspaces),
      },
      candidateCount: raw.candidateCount,
      blockedByTerms: raw.blockedByTerms,
      queryHash,
      scoreMode: mode,
      retrieval: raw.retrieval,
      contextBudget: scope.sessionScope?.tokenBudget ?? this.store.state.settings?.maxContextTokens ?? 1200,
    };
  }

  /** Build a context block for the current Agent. */
  async context({
    query,
    workspaceIds = [],
    includeNonDefault = false,
    mode = 'hybrid',
    filters = {},
    actor = 'agent-tool',
    sessionId = null,
  } = {}) {
    this._assertSearchable();
    this.touch();
    this._checkSearchRate(actor);
    const queryHash = SecureMemoryStore.queryHash(query);
    if (actor === 'agent-tool' && sessionId) {
      this._recordRuntime(sessionId, { state: 'retrieving', queryHash, resultCount: 0, sources: [] });
    }
    const scope = await this._scope(workspaceIds, {
      includeNonDefault,
      sessionId,
      enforceSessionScope: actor === 'agent-tool' || Boolean(sessionId),
    });
    if (!scope.ok) {
      this._recordRuntime(sessionId, {
        state: 'denied',
        reason: scope.reason,
        queryHash,
        resultCount: 0,
        sources: [],
      });
      await this.store.audit({
        actor,
        action: ACTIONS.DENY,
        workspaceIds: scope.denied,
        queryHash,
        outcome: 'denied',
        detail: `context denied: ${scope.reason}${sessionId ? `; sessionHash=${sha256(sessionId).slice(0, 12)}` : ''}`,
      });
      return { status: 'denied', reason: scope.reason, denied: scope.denied, text: '', results: [] };
    }
    let assessed;
    let built;
    const revision = this._revision;
    try {
      const allDocs = this._visibleDocs(scope.granted, scope.sessionScope?.selections);
      const index = this.getIndex();
      const excluded = new Set(this.store.state.exclusions.map((item) => item.docId));
      const raw = index.search({
        query,
        allowedWorkspaceIds: scope.granted,
        selections: scope.sessionScope?.selections,
        excludedDocIds: excluded,
        excludedSessionIds: this._excludedSessionIds(),
        excludedSourceNames: this._excludedSourceNames(),
        blockedTerms: this.store.state.blockedTerms,
        filters,
        mode,
        limit: Math.min(LIMITS.contextResults, this.store.state.settings?.maxResults ?? 8),
      });
      assessed = assessResults(raw.results, allDocs);
      const byId = new Map(allDocs.map((doc) => [doc.id, doc]));
      const withContent = assessed.results.map((result) => ({
        ...result,
        content: byId.get(result.id)?.content ?? '',
      }));
      const settings = this.store.state.settings ?? {};
      built = buildContext({
        results: withContent,
        conflicts: assessed.conflicts,
        workspaces: new Map(scope.workspaces.map((workspace) => [workspace.id, workspace])),
        maxChars: Math.min(LIMITS.contextChars, settings.maxContextChars ?? 8000),
        maxTokens: scope.sessionScope?.tokenBudget ?? settings.maxContextTokens ?? 1200,
        countTokens: this.countTokens,
        tokenCounter: this.tokenCounter,
        blockHighRisk: settings.blockHighRisk !== false,
        generatedAt: nowIso(),
        scopeLabel: scopeLabelFor(scope.workspaces),
        queryHash,
      });
      this._recordRuntime(sessionId, {
        state: built.used > 0 ? 'completed' : 'no_results',
        queryHash,
        resultCount: built.used,
        metrics: built.metrics,
        retrieval: raw.retrieval,
        sources: this._sourceSummaries(assessed.results.filter((r) => built.selectedIds.includes(r.id)), scope.workspaces),
      });
    } catch (error) {
      this._recordRuntime(sessionId, {
        state: 'error',
        reason: 'CONTEXT_ERROR',
        queryHash,
        resultCount: 0,
        sources: [],
      });
      await this.store.audit({
        actor,
        action: ACTIONS.CONTEXT,
        workspaceIds: scope.granted,
        queryHash,
        outcome: 'error',
        detail: String(error?.message ?? 'context error').slice(0, 160),
      });
      throw error;
    }
    await this.store.audit({
      actor,
      action: ACTIONS.CONTEXT,
      workspaceIds: scope.granted,
      queryHash,
      resultCount: built.used,
      outcome: 'ok',
      detail: `tokens=${built.metrics.injectedTokens}; counter=${built.metrics.tokenCounter}; budget=${built.metrics.budgetTokens}; quarantined=${built.quarantined}; sessionHash=${sessionId ? sha256(sessionId).slice(0, 12) : 'none'}`,
    });
    if (!this._scopeStillCurrent(scope, sessionId, revision)) return { status: 'denied', reason: 'SCOPE_CHANGED', denied: [], text: '', results: [] };
    return {
      status: built.used > 0 ? 'ok' : 'no_results',
      text: built.text,
      results: assessed.results.map((result) => {
        const { content, ...rest } = result;
        return rest;
      }),
      used: built.used,
      metrics: built.metrics,
      quarantined: built.quarantined,
      conflicts: built.conflicts,
      scope: {
        granted: scope.granted,
        labels: scopeLabelFor(scope.workspaces),
        workspaces: scope.workspaces.map((workspace) => ({ id: workspace.id, title: workspace.title })),
      },
      queryHash,
    };
  }

  /** Agent-safe status: counts and active grants, optionally scoped to a session. */
  async status({ sessionId = null } = {}) {
    if (!this.store.unlocked) {
      return { locked: true, initialized: this.store.initialized, auditIntact: false };
    }
    const audit = this.store.auditStatus();
    if (!audit.intact) {
      return { locked: false, initialized: true, auditIntact: false, reason: audit.reason };
    }
    const active = await this.store.activeGrants();
    let sessionScope = null;
    if (sessionId) {
      try {
        sessionScope = this.store.getSessionScope(sessionId);
      } catch (error) {
        return {
          locked: false,
          initialized: true,
          auditIntact: true,
          session: { enabled: false, workspaceIds: [] },
          sessionError: error?.code ?? 'INVALID_SESSION_ID',
          authorizedWorkspaces: 0,
          documents: 0,
          workspaces: [],
        };
      }
    }
    const activeIds = new Set(active.map((grant) => grant.workspaceId));
    const effective = sessionScope
      ? sessionScope.workspaceIds.filter((id) => activeIds.has(id))
      : [...activeIds];
    const docs = this.store.state.docs.filter((doc) => effective.includes(doc.workspaceId));
    const workspaces = this.store.state.workspaces
      .filter((workspace) => effective.includes(workspace.id))
      .map((workspace) => {
        const grant = active.find((item) => item.workspaceId === workspace.id);
        return {
          id: workspace.id,
          title: workspace.title,
          kind: workspace.kind,
          documents: docs.filter((doc) => doc.workspaceId === workspace.id).length,
          mode: grant.mode,
          expiresAt: grant.expiresAt,
          defaultRetrieval: grant.defaultRetrieval,
        };
      });
    return {
      locked: false,
      initialized: true,
      auditIntact: true,
      session: sessionScope
        ? { idHash: sha256(sessionId).slice(0, 12), enabled: sessionScope.enabled, workspaceIds: effective }
        : null,
      sessionEnabled: sessionScope ? sessionScope.enabled : null,
      authorizedWorkspaces: workspaces.length,
      documents: docs.length,
      workspaces,
      privacy: 'Local encrypted index; only authorized snippets enter model context when a tool is called.',
    };
  }

  /** Full content-free status for the composer bar. */
  async sessionStatus(sessionId) {
    this._assertSearchable();
    const scope = this.store.getSessionScope(sessionId);
    const active = await this.store.activeGrants();
    const activeById = new Map(active.map((grant) => [grant.workspaceId, grant]));
    const grantById = new Map(this.store.state.grants.map((grant) => [grant.workspaceId, grant]));
    const now = Date.now();
    const docs = this.store.state.docs;
    const grants = [];
    for (const workspace of this.store.state.workspaces) {
      const grant = grantById.get(workspace.id);
      if (!grant) continue;
      const expires = parseTime(grant.expiresAt);
      const expired = expires !== null && expires <= now;
      const isActive = activeById.has(workspace.id);
      const selected = scope.workspaceIds.includes(workspace.id);
      grants.push({
        id: workspace.id,
        title: workspace.title,
        kind: workspace.kind,
        externalId: workspace.externalId ?? null,
        lastSyncAt: workspace.lastSyncAt ?? null,
        documents: docs.filter((doc) => doc.workspaceId === workspace.id).length,
        mode: grant.mode,
        expiresAt: grant.expiresAt ?? null,
        paused: Boolean(grant.paused),
        expired,
        active: isActive,
        selectable: isActive,
        selected,
        effectiveSelected: selected && isActive,
        canSync: workspace.kind === 'dsh-local' && isActive,
        reason: grant.paused ? 'paused' : expired ? 'expired' : isActive ? null : 'inactive',
        sessions: isActive ? this.sourceSessions(workspace.id) : [],
      });
    }
    const effectiveIds = scope.workspaceIds.filter((id) => activeById.has(id));
    const selectedDocuments = this._visibleDocs(effectiveIds, scope.selections).length;
    const retrieval = this._sessionRuntime.get(sessionId) ?? {
      state: scope.enabled ? 'idle' : 'disabled',
      at: null,
      resultCount: 0,
      sources: [],
    };
    return {
      session: {
        idHash: sha256(sessionId).slice(0, 16),
        enabled: scope.enabled,
        updatedAt: scope.updatedAt,
      },
      scope: {
        workspaceIds: scope.workspaceIds,
        selections: scope.selections,
        tokenBudget: scope.tokenBudget,
        effectiveWorkspaceIds: effectiveIds,
      },
      workspaces: grants,
      counts: {
        authorized: grants.length,
        active: active.length,
        selected: effectiveIds.length,
        selectedDocuments,
      },
      retrieval,
      security: {
        auditIntact: true,
        locked: false,
        autoLockMinutes: this._autoLockMinutes(),
      },
      conflicts: this.conflicts ?? [],
      toolNames: this.toolNames ?? null,
    };
  }

  /** Persist the current session's association (never grants access). */
  sourceSessions(workspaceId) {
    const sessions = new Map();
    for (const [id, record] of Object.entries(this.store.state.sessions ?? {})) {
      if (record.workspaceId === workspaceId) sessions.set(id, { id, title: record.conversationTitle || id, documents: 0 });
    }
    for (const doc of this.store.state.docs) {
      if (doc.workspaceId !== workspaceId || !doc.sourceSessionId) continue;
      const previous = sessions.get(doc.sourceSessionId) ?? { id: doc.sourceSessionId, title: doc.conversationTitle || doc.sourceSessionId, documents: 0 };
      previous.documents += 1; sessions.set(doc.sourceSessionId, previous);
    }
    return [...sessions.values()];
  }

  async setSessionScope(sessionId, { enabled = false, workspaceIds = [], selections, tokenBudget } = {}) {
    this._assertSearchable();
    const saved = await this.store.setSessionScope(sessionId, { enabled, workspaceIds, selections, tokenBudget });
    this._recordRuntime(sessionId, {
      state: saved.enabled ? 'idle' : 'disabled',
      reason: null,
      resultCount: 0,
      sources: [],
    });
    return this.sessionStatus(sessionId);
  }

  /** Sync the selected DSH-local workspaces for one session. */
  async syncSession(sessionId, { signal } = {}) {
    this._assertSearchable();
    const status = await this.sessionStatus(sessionId);
    if (!status.session.enabled) {
      const error = new Error('当前会话未启用跨工作区记忆');
      error.code = 'SESSION_DISABLED';
      throw error;
    }
    const selectedDsh = status.workspaces.filter((workspace) => workspace.effectiveSelected && workspace.kind === 'dsh-local');
    const results = [];
    for (const workspace of selectedDsh) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const result = await this.syncWorkspace(workspace.id, { signal, actor: 'user-ui' });
        results.push({ workspaceId: workspace.id, title: workspace.title, ok: true, ...result });
      } catch (error) {
        results.push({
          workspaceId: workspace.id,
          title: workspace.title,
          ok: false,
          error: String(error?.code ?? error?.message ?? 'sync failed').slice(0, 160),
        });
      }
    }
    await this.store.audit({
      actor: 'user-ui',
      action: ACTIONS.SESSION_SYNC,
      workspaceIds: results.map((item) => item.workspaceId),
      outcome: results.every((item) => item.ok) ? 'ok' : 'error',
      detail: `sessionHash=${sha256(sessionId).slice(0, 16)}; workspaces=${results.length}; ok=${results.filter((item) => item.ok).length}`,
    });
    return { results, session: await this.sessionStatus(sessionId) };
  }

  /** Authorized knowledge graph for the management UI. */
  async graph({ workspaceIds = [] } = {}) {
    this._assertSearchable();
    const scope = await this._scope(workspaceIds, { includeNonDefault: true });
    if (!scope.ok) {
      const error = new Error('检索范围包含未授权工作区');
      error.code = 'DENIED';
      throw error;
    }
    const allowed = new Set(scope.granted);
    const docs = this._visibleDocs(scope.granted);
    const workspaces = this.store.state.workspaces.filter((workspace) => allowed.has(workspace.id));
    const graph = buildGraph(docs, workspaces, scope.granted);
    await this.store.audit({
      actor: 'user-ui',
      action: ACTIONS.GRAPH,
      workspaceIds: scope.granted,
      outcome: 'ok',
      detail: `nodes=${graph.nodes.length}; edges=${graph.edges.length}`,
    });
    return graph;
  }

  /** Authorized timeline for the management UI. */
  async timeline({ workspaceIds = [], limit = 200 } = {}) {
    this._assertSearchable();
    const scope = await this._scope(workspaceIds, { includeNonDefault: true });
    if (!scope.ok) {
      const error = new Error('检索范围包含未授权工作区');
      error.code = 'DENIED';
      throw error;
    }
    const allowed = new Set(scope.granted);
    const excludedDocs = new Set(this.store.state.exclusions.map((item) => item.docId));
    const excludedSessions = this._excludedSessionIds();
    const excludedSources = this._excludedSourceNames();
    const blockedTerms = (this.store.state.blockedTerms ?? [])
      .filter((term) => typeof term === 'string' && term.length > 0)
      .map((term) => term.toLowerCase());
    const visible = this.store.state.docs.filter((doc) => {
      if (!allowed.has(doc.workspaceId)) return false;
      if (blockedTerms.length > 0) {
        const haystack = `${doc.title ?? ''}\n${doc.content ?? ''}`.toLowerCase();
        if (blockedTerms.some((term) => haystack.includes(term))) return false;
      }
      return true;
    });
    const conflictDocs = visible.filter((doc) => !excludedDocs.has(doc.id)
      && !(doc.sourceSessionId && excludedSessions.has(doc.sourceSessionId))
      && !(doc.sourceName && excludedSources.has(doc.sourceName)));
    const conflicts = detectConflicts(conflictDocs, { limit: 100 });
    const conflictIds = new Set(conflicts.flatMap((conflict) => conflict.docs.map((doc) => doc.id)));
    const items = buildTimeline(visible, { limit }).map((item) => ({
      ...item,
      excluded: excludedDocs.has(item.id)
        || Boolean(item.sourceSessionId && excludedSessions.has(item.sourceSessionId))
        || Boolean(item.sourceName && excludedSources.has(item.sourceName)),
      excludedSession: Boolean(item.sourceSessionId && excludedSessions.has(item.sourceSessionId)),
      excludedSource: Boolean(item.sourceName && excludedSources.has(item.sourceName)),
      potentialConflict: conflictIds.has(item.id),
    }));
    await this.store.audit({
      actor: 'user-ui',
      action: ACTIONS.TIMELINE,
      workspaceIds: scope.granted,
      resultCount: items.length,
      outcome: 'ok',
      detail: `conflicts=${conflicts.length}`,
    });
    return {
      items,
      workspaces: scope.workspaces.map((workspace) => ({ id: workspace.id, title: workspace.title })),
      conflicts: conflicts.map((conflict) => ({
        ...conflict,
        docs: conflict.docs.map((doc) => ({ ...doc, potentialConflict: conflictIds.has(doc.id) })),
      })),
    };
  }

  async markDocument(docId, patch) {
    this._assertSearchable();
    const result = await this.store.markDocument(docId, patch);
    this._invalidateIndex();
    return result;
  }

  async setSessionExcluded(sourceSessionId, excluded, reason = 'user') {
    this._assertSearchable();
    const result = await this.store.setSessionExcluded(sourceSessionId, excluded, { reason });
    this._invalidateIndex();
    return result;
  }

  async setSourceExcluded(sourceName, excluded, reason = 'user') {
    this._assertSearchable();
    const result = await this.store.setSourceExcluded(sourceName, excluded, { reason });
    this._invalidateIndex();
    return result;
  }

  async setBlockedTerms(terms) {
    this._assertSearchable();
    return this.store.setBlockedTerms(terms);
  }

  async updateSettings(patch) {
    this._assertSearchable();
    return this.store.updateSettings(patch);
  }

  async auditList(limit = 200) {
    if (!this.store.unlocked) {
      const error = new Error('保险库已锁定');
      error.code = 'VAULT_LOCKED';
      throw error;
    }
    return {
      integrity: this.store.auditStatus(),
      items: this.store.listAudit(limit),
    };
  }

  async repairAudit() {
    if (!this.store.unlocked) {
      const error = new Error('保险库已锁定');
      error.code = 'VAULT_LOCKED';
      throw error;
    }
    const result = await this.store.repairAudit();
    await this.store.audit({
      actor: 'user-ui',
      action: ACTIONS.AUDIT_REPAIR,
      outcome: 'ok',
      detail: '用户显式重建审计链。',
    });
    return result;
  }

  async deleteAll() {
    this.revokeTokens();
    this._index = null;
    const result = await this.store.deleteEverything();
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return result;
  }
}
