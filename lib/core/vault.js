import { readFile } from 'node:fs/promises';
import { AUDIT_FORMAT, AUDIT_VERSION, STATE_FORMAT, STATE_VERSION, VAULT_FORMAT } from './constants.js';
import {
  auditAad,
  createSalt,
  decryptJson,
  deriveSubkey,
  deriveVaultKey,
  encryptJson,
  hmacHex,
  VaultUnlockError,
  validatePassphrase,
  vaultAad,
} from './crypto.js';
import { atomicWriteFile, nowIso, removeFile, stableJson, uuid } from './util.js';

const VAULT_ALGORITHM = 'aes-256-gcm';

/** Create an empty in-memory state document. */
export function createEmptyState({ profile, vaultId = uuid() }) {
  const now = nowIso();
  return {
    format: STATE_FORMAT,
    version: STATE_VERSION,
    vaultId,
    profile,
    createdAt: now,
    updatedAt: now,
    workspaces: [],
    grants: [],
    docs: [],
    exclusions: [],
    excludedSessions: [],
    excludedSources: [],
    sessionScopes: {},
    blockedTerms: [],
    sessions: {},
    settings: {
      maxResults: 8,
      maxContextChars: 8000,
      blockHighRisk: true,
      autoLockMinutes: 30,
    },
  };
}

/** Read a JSON file, returning null when it does not exist. */
async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Create a new vault file and its empty audit ledger.
 * Returns the derived key and both headers. The caller owns key zeroing.
 */
export async function createVaultFiles({ vaultPath, auditPath, passphrase, profile }) {
  const check = validatePassphrase(passphrase);
  if (!check.ok) throw new Error(check.error);
  const now = nowIso();
  const vaultId = uuid();
  const salt = createSalt();
  const key = await deriveVaultKey(passphrase, salt);
  const header = {
    format: VAULT_FORMAT,
    version: 1,
    algorithm: VAULT_ALGORITHM,
    vaultId,
    profile,
    createdAt: now,
    kdf: {
      name: 'scrypt',
      N: 32768,
      r: 8,
      p: 1,
      keyLen: 32,
      salt: salt.toString('base64'),
    },
  };
  const state = createEmptyState({ profile, vaultId });
  await writeVault(vaultPath, state, key, header);
  const auditLedger = new AuditLedger({ vaultPath, auditPath, profile, vaultId, createdAt: now, key });
  await auditLedger.init();
  return { key, header, state, auditLedger };
}

/** Load and decrypt an existing vault. */
export async function loadVaultFile({ vaultPath, auditPath, passphrase }) {
  let raw;
  try {
    raw = JSON.parse(await readFile(vaultPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const err = new Error('保险库不存在');
      err.code = 'VAULT_NOT_FOUND';
      throw err;
    }
    throw new VaultUnlockError('保险库文件无法读取或格式损坏');
  }
  if (!raw || raw.format !== VAULT_FORMAT || raw.version !== 1 || raw.algorithm !== VAULT_ALGORITHM) {
    throw new VaultUnlockError('保险库格式不受支持');
  }
  const kdf = raw.kdf;
  if (!kdf || kdf.name !== 'scrypt' || kdf.N !== 32768 || kdf.r !== 8 || kdf.p !== 1 || kdf.keyLen !== 32) {
    throw new VaultUnlockError('保险库 KDF 参数不受支持');
  }
  let salt;
  try {
    salt = Buffer.from(kdf.salt, 'base64');
  } catch {
    throw new VaultUnlockError('保险库盐值损坏');
  }
  if (salt.length !== 32) throw new VaultUnlockError('保险库盐值损坏');
  const key = await deriveVaultKey(passphrase, salt, { N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 128 * 1024 * 1024 });
  let state;
  try {
    state = decryptJson(
      { iv: raw.cipher?.iv, tag: raw.cipher?.tag, payload: raw.payload },
      key,
      vaultAad(raw),
    );
  } catch (error) {
    key.fill(0);
    throw error;
  }
  if (!state || state.format !== STATE_FORMAT || state.version !== STATE_VERSION) {
    key.fill(0);
    throw new VaultUnlockError('保险库内容格式不受支持');
  }
  const header = {
    format: raw.format,
    version: raw.version,
    algorithm: raw.algorithm,
    vaultId: raw.vaultId,
    profile: raw.profile,
    createdAt: raw.createdAt,
    kdf: raw.kdf,
  };
  const auditLedger = new AuditLedger({
    vaultPath,
    auditPath,
    profile: raw.profile,
    vaultId: raw.vaultId,
    createdAt: raw.createdAt,
    key,
  });
  await auditLedger.load();
  return { key, header, state, auditLedger };
}

/** Encrypt and atomically persist the state. */
export async function writeVault(vaultPath, state, key, header) {
  state.updatedAt = nowIso();
  const cipher = encryptJson(state, key, vaultAad(header));
  const document = {
    format: header.format,
    version: header.version,
    algorithm: header.algorithm,
    vaultId: header.vaultId,
    profile: header.profile,
    createdAt: header.createdAt,
    kdf: header.kdf,
    cipher: { iv: cipher.iv, tag: cipher.tag },
    payload: cipher.payload,
  };
  await atomicWriteFile(vaultPath, JSON.stringify(document));
}

/**
 * Separate encrypted audit ledger.
 *
 * Keeping audit outside the large state document means a search does not
 * re-encrypt the whole index, while every audited action is still durable.
 */
export class AuditLedger {
  constructor({ vaultPath, auditPath, profile, vaultId, createdAt, key }) {
    this.vaultPath = vaultPath;
    this.auditPath = auditPath;
    this.profile = profile;
    this.vaultId = vaultId;
    this.createdAt = createdAt;
    this.encKey = deriveSubkey(key, 'dsh-secure-memory/audit-encryption/v1');
    this.hmacKey = deriveSubkey(key, 'dsh-secure-memory/audit-hmac/v1');
    this.anchor = null;
    this.entries = [];
    this.intact = false;
    this.reason = 'not-loaded';
  }

  header() {
    return {
      format: AUDIT_FORMAT,
      version: AUDIT_VERSION,
      vaultId: this.vaultId,
      profile: this.profile,
      createdAt: this.createdAt,
      anchor: this.anchor,
    };
  }

  async init() {
    this.entries = [];
    this.anchor = null;
    this.intact = true;
    this.reason = 'new';
    await this.write();
  }

  async load() {
    const raw = await readJsonIfExists(this.auditPath);
    if (!raw || raw.format !== AUDIT_FORMAT || raw.version !== AUDIT_VERSION) {
      this.entries = [];
      this.anchor = null;
      this.intact = false;
      this.reason = 'missing-or-unsupported';
      return;
    }
    if (raw.vaultId !== this.vaultId || raw.profile !== this.profile) {
      this.entries = [];
      this.anchor = null;
      this.intact = false;
      this.reason = 'identity-mismatch';
      return;
    }
    let document;
    try {
      document = decryptJson(
        { iv: raw.cipher?.iv, tag: raw.cipher?.tag, payload: raw.payload },
        this.encKey,
        auditAad(raw),
      );
    } catch {
      this.entries = [];
      this.anchor = null;
      this.intact = false;
      this.reason = 'decrypt-failed';
      return;
    }
    this.anchor = typeof raw.anchor === 'string' ? raw.anchor : null;
    this.entries = Array.isArray(document?.entries) ? document.entries : [];
    this.intact = this.verify();
    this.reason = this.intact ? 'ok' : 'chain-invalid';
  }

  verify() {
    let prev = this.anchor ?? 'GENESIS';
    for (const entry of this.entries) {
      if (!entry || entry.prevHash !== prev) return false;
      const { hash, ...unsigned } = entry;
      const expected = hmacHex(this.hmacKey, stableJson(unsigned));
      if (hash !== expected) return false;
      prev = hash;
    }
    return true;
  }

  async write() {
    const body = { entries: this.entries };
    const cipher = encryptJson(body, this.encKey, auditAad(this.header()));
    const document = {
      ...this.header(),
      cipher: { iv: cipher.iv, tag: cipher.tag },
      payload: cipher.payload,
    };
    await atomicWriteFile(this.auditPath, JSON.stringify(document));
  }

  /**
   * Append one entry. `detail` must never contain conversation bodies,
   * passphrases, keys, tokens, or full queries.
   */
  async append(entry) {
    const seq = (this.entries[this.entries.length - 1]?.seq ?? 0) + 1;
    const prevHash = this.entries[this.entries.length - 1]?.hash ?? this.anchor ?? 'GENESIS';
    const unsigned = {
      seq,
      ts: nowIso(),
      actor: String(entry.actor ?? 'system').slice(0, 32),
      action: String(entry.action ?? 'unknown').slice(0, 64),
      workspaceIds: Array.isArray(entry.workspaceIds)
        ? entry.workspaceIds.filter((id) => typeof id === 'string').slice(0, 32)
        : [],
      queryHash: typeof entry.queryHash === 'string' ? entry.queryHash.slice(0, 64) : null,
      resultCount: Number.isInteger(entry.resultCount) ? entry.resultCount : 0,
      outcome: ['ok', 'denied', 'error'].includes(entry.outcome) ? entry.outcome : 'error',
      detail: String(entry.detail ?? '').slice(0, 500),
      prevHash,
    };
    const hash = hmacHex(this.hmacKey, stableJson(unsigned));
    this.entries.push({ ...unsigned, hash });
    if (this.entries.length > 2000) {
      const dropped = this.entries.shift();
      this.anchor = dropped.hash;
    }
    await this.write();
    return { ...unsigned, hash };
  }

  list(limit = 200) {
    const numeric = Number(limit);
    const count = Number.isFinite(numeric) ? Math.max(1, Math.min(1000, Math.floor(numeric))) : 200;
    return this.entries.slice(-count).reverse();
  }

  async resetAfterTamper({ actor = 'user-ui' } = {}) {
    this.entries = [];
    this.anchor = null;
    this.intact = true;
    this.reason = 'rebuilt';
    await this.append({
      actor,
      action: 'security.audit_repair',
      outcome: 'ok',
      detail: '审计链此前校验失败；用户确认后重建。旧审计内容已丢弃，无法验证。',
    });
  }

  dispose() {
    this.encKey.fill(0);
    this.hmacKey.fill(0);
    this.entries = [];
    this.anchor = null;
    this.intact = false;
    this.reason = 'disposed';
  }
}

/** Delete vault and audit files. */
export async function deleteVaultFiles(vaultPath, auditPath) {
  await removeFile(auditPath);
  await removeFile(vaultPath);
}
