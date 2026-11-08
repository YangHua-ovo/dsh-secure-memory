/**
 * Shared constants and limits.
 *
 * The limits are deliberately conservative: this plugin handles personal
 * conversation history and must fail closed rather than grow without bound.
 */

export const PLUGIN_NAME = 'dsh-secure-memory';
export const VAULT_FORMAT = 'dsh-secure-memory-vault';
export const STATE_FORMAT = 'dsh-secure-memory';
export const STATE_VERSION = 1;
export const AUDIT_FORMAT = 'dsh-secure-memory-audit';
export const AUDIT_VERSION = 1;

export const SCRYPT = Object.freeze({
  name: 'scrypt',
  N: 32768,
  r: 8,
  p: 1,
  keyLen: 32,
  maxmem: 128 * 1024 * 1024,
});

export const LIMITS = Object.freeze({
  passphraseMin: 12,
  passphraseMax: 1024,
  bodyBytes: 8 * 1024 * 1024,
  queryChars: 500,
  docChars: 100_000,
  workspaceDocs: 3_000,
  workspaceChars: 4_000_000,
  libraryDocs: 10_000,
  libraryChars: 15_000_000,
  syncSessions: 500,
  syncEventsPerSession: 4_000,
  syncCharsPerWorkspace: 4_000_000,
  searchResults: 12,
  contextResults: 8,
  contextChars: 8_000,
  snippetChars: 420,
  auditEntries: 2_000,
  auditDetailChars: 500,
  blockedTerms: 100,
  blockedTermChars: 120,
  exclusions: 5_000,
  excludedSessions: 2_000,
  sessionScopeWorkspaces: 64,
  sessionIdChars: 200,
  autoLockMinutes: 30,
  apiTokenIdleMinutes: 30,
  maxImportDocs: 3_000,
});

export const GRANT_MODES = Object.freeze(['temporary', 'long-term']);

export const CATEGORIES = Object.freeze([
  'decision',
  'verified',
  'idea',
  'tentative',
  'deprecated',
  'unresolved',
  'background',
  'preference',
]);

export const CATEGORY_LABELS = Object.freeze({
  decision: '已确认的最终决策',
  verified: '已验证的技术方案',
  idea: '讨论中的想法',
  tentative: '暂时性结论',
  deprecated: '已废弃的方案',
  unresolved: '尚未解决的问题',
  background: '项目背景信息',
  preference: '用户明确表达的偏好',
});

export const STATUSES = Object.freeze([
  'active',
  'unverified',
  'confirmed',
  'deprecated',
]);

export const STATUS_LABELS = Object.freeze({
  active: '有效（未人工确认）',
  unverified: '未验证',
  confirmed: '已人工确认',
  deprecated: '已废弃',
});

export const SOURCE_KINDS = Object.freeze([
  'dsh-session',
  'manual-pack',
  'deepseek-export',
  'markdown',
]);

export const ACTIONS = Object.freeze({
  SETUP: 'vault.setup',
  UNLOCK: 'vault.unlock',
  LOCK: 'vault.lock',
  GRANT: 'grant.add',
  REVOKE: 'grant.revoke',
  PAUSE: 'grant.pause',
  RESUME: 'grant.resume',
  EXPIRE: 'grant.expire',
  SYNC: 'memory.sync',
  IMPORT: 'memory.import',
  SEARCH: 'memory.search',
  CONTEXT: 'memory.context',
  STATUS: 'memory.status',
  GRAPH: 'memory.graph',
  TIMELINE: 'memory.timeline',
  MARK: 'memory.mark',
  EXCLUDE: 'memory.exclude',
  INCLUDE: 'memory.include',
  BLOCKED_TERMS: 'security.blocked_terms',
  SESSION_SCOPE: 'session.scope',
  SESSION_SYNC: 'session.sync',
  REVOKE_ALL: 'security.revoke_all',
  DELETE_ALL: 'security.delete_all',
  AUDIT_REPAIR: 'security.audit_repair',
  DENY: 'security.deny',
});

export const TOOL_NAMES = Object.freeze({
  SEARCH: 'xw_memory_search',
  CONTEXT: 'xw_memory_context',
  STATUS: 'xw_memory_status',
});

export const DEFAULT_SETTINGS = Object.freeze({
  maxResults: 8,
  maxContextChars: 8_000,
  blockHighRisk: true,
  autoLockMinutes: LIMITS.autoLockMinutes,
});
