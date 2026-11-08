import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { SCRYPT } from './constants.js';
import { fromBase64, stableJson } from './util.js';

const scryptAsync = promisify(scrypt);
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** Typed error for a wrong passphrase or corrupt authenticated payload. */
export class VaultUnlockError extends Error {
  constructor(message = '解锁失败：口令错误或保险库文件已损坏') {
    super(message);
    this.name = 'VaultUnlockError';
    this.code = 'VAULT_UNLOCK_FAILED';
  }
}

/** Validate the passphrase before spending KDF work. */
export function validatePassphrase(passphrase) {
  if (typeof passphrase !== 'string') {
    return { ok: false, error: '口令必须是字符串' };
  }
  const chars = Array.from(passphrase);
  if (chars.length < SCRYPT_PASSPHRASE_MIN) {
    return { ok: false, error: `口令至少需要 ${SCRYPT_PASSPHRASE_MIN} 个字符` };
  }
  if (chars.length > 1024) {
    return { ok: false, error: '口令过长' };
  }
  if (passphrase.trim().length === 0) {
    return { ok: false, error: '口令不能全部为空白' };
  }
  if (new Set(chars).size < 4) {
    return { ok: false, error: '口令重复字符过多，请使用更长的随机短语' };
  }
  const common = new Set([
    'password123456', '123456789012', 'qwertyuiop12', 'deepseek123456',
    'passwordpassword', 'letmein123456', 'administrator', '111111111111',
    'aaaaaaaaaaaa', '1234567890123456',
  ]);
  if (common.has(passphrase.toLowerCase())) {
    return { ok: false, error: '该口令过于常见，请更换' };
  }
  return { ok: true };
}

const SCRYPT_PASSPHRASE_MIN = 12;

/** Derive a 32-byte vault key with scrypt. Salt is per-vault and random. */
export async function deriveVaultKey(passphrase, salt, params = SCRYPT) {
  const derived = await scryptAsync(passphrase, salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
  return Buffer.from(derived);
}

/** Create a fresh random salt. */
export function createSalt() {
  return randomBytes(32);
}

/** Encrypt a UTF-8 JSON payload with AES-256-GCM and return base64 fields. */
export function encryptJson(value, key, aad) {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  plaintext.fill(0);
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    payload: ciphertext.toString('base64'),
  };
}

/** Decrypt an AES-256-GCM payload. Throws a generic unlock error on failure. */
export function decryptJson(cipherInfo, key, aad) {
  try {
    const iv = fromBase64(cipherInfo.iv, 'iv');
    const tag = fromBase64(cipherInfo.tag, 'tag');
    const payload = fromBase64(cipherInfo.payload, 'payload');
    if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
      throw new Error('invalid cipher parameters');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    const value = JSON.parse(plaintext.toString('utf8'));
    plaintext.fill(0);
    return value;
  } catch {
    throw new VaultUnlockError();
  }
}

/** Derive an independent key with HKDF from the vault key. */
export function deriveSubkey(vaultKey, info, length = 32) {
  return Buffer.from(hkdfSync('sha256', vaultKey, Buffer.alloc(0), Buffer.from(info, 'utf8'), length));
}

/** Constant-time compare two buffers of equal length. */
export function safeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Build a canonical AAD string for vault metadata. */
export function vaultAad(header) {
  return stableJson({
    format: header.format,
    version: header.version,
    algorithm: header.algorithm,
    vaultId: header.vaultId,
    profile: header.profile,
    createdAt: header.createdAt,
    kdf: header.kdf,
  });
}

/** Build a canonical AAD string for the audit ledger. */
export function auditAad(header) {
  return stableJson({
    format: header.format,
    version: header.version,
    vaultId: header.vaultId,
    profile: header.profile,
    createdAt: header.createdAt,
    anchor: header.anchor ?? null,
  });
}

/** HMAC-SHA256 hex digest. */
export function hmacHex(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}
