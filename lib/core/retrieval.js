import { LIMITS } from './constants.js';
import { humanPreview } from './ingest.js';
import { normalizeText, sha256, truncateChars } from './util.js';
import { tokenize } from './tokenize.js';
import { docInSelections } from './scope.js';

const VECTOR_DIMS = 384;
const K1 = 1.5;
const B = 0.75;

function hashToken(token) {
  // FNV-1a 32-bit, deterministic and dependency-free.
  let h = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    h ^= token.charCodeAt(index);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function addToVector(vector, token, weight) {
  const h = hashToken(token);
  const bucket = h % VECTOR_DIMS;
  const sign = (h & 0x80000000) !== 0 ? -1 : 1;
  vector[bucket] += sign * weight;
  // A second projection reduces collisions without doubling memory.
  const second = hashToken(`#${token}`) % VECTOR_DIMS;
  vector[second] += sign * weight * 0.5;
}

function normalizeVector(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  }
  return vector;
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index] * b[index];
  return dot;
}

function jaccard(a, b) {
  if (!a || !b) return 0;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const token of smaller) if (larger.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function textForSnippet(doc) {
  return String(doc.content ?? '');
}

/** Build a short snippet around the first query match. */
function makeSnippet(doc, tokens) {
  const text = textForSnippet(doc);
  const lower = text.toLowerCase();
  let start = -1;
  for (const token of tokens) {
    const index = lower.indexOf(token.toLowerCase());
    if (index >= 0 && (start < 0 || index < start)) start = index;
  }
  const chars = Array.from(text);
  if (start < 0) return humanPreview(text, LIMITS.snippetChars);
  // Map UTF-16 index to code-point index approximately, then center a window.
  const prefix = Array.from(text.slice(0, start)).length;
  const from = Math.max(0, prefix - 100);
  const window = chars.slice(from, from + LIMITS.snippetChars).join('');
  return (from > 0 ? '…' : '') + humanPreview(window, LIMITS.snippetChars) + (from + LIMITS.snippetChars < chars.length ? '…' : '');
}

/**
 * Local hybrid retrieval over an already-authorized candidate set.
 * No method accepts an "all docs" scope: allowedWorkspaceIds is mandatory.
 */
export class MemoryIndex {
  constructor(docs) {
    this.docs = [];
    this.docById = new Map();
    this.postings = new Map();
    this.docLengths = new Map();
    this.vectors = new Map();
    this.avgLength = 0;
    this.builtAt = new Date().toISOString();
    this._build(docs);
  }

  _build(docs) {
    this.docs = Array.isArray(docs) ? docs.slice() : [];
    let totalLength = 0;
    for (const doc of this.docs) {
      const tokens = tokenize(`${doc.title ?? ''}\n${doc.content ?? ''}`);
      const length = [...tokens.values()].reduce((sum, count) => sum + count, 0);
      this.docById.set(doc.id, doc);
      this.docLengths.set(doc.id, Math.max(1, length));
      totalLength += Math.max(1, length);
      const vector = new Float32Array(VECTOR_DIMS);
      for (const [token, count] of tokens) {
        let posting = this.postings.get(token);
        if (!posting) {
          posting = new Map();
          this.postings.set(token, posting);
        }
        posting.set(doc.id, count);
        addToVector(vector, token, 1 + Math.log(count));
      }
      this.vectors.set(doc.id, normalizeVector(vector));
    }
    this.avgLength = this.docs.length > 0 ? totalLength / this.docs.length : 1;
  }

  _candidateDocs({ allowedWorkspaceIds, selections, excludedDocIds, excludedSessionIds, excludedSourceNames, blockedTerms, filters = {} }) {
    const allowed = new Set(allowedWorkspaceIds ?? []);
    if (allowed.size === 0) return { candidates: [], blockedByTerms: 0 };
    const excluded = excludedDocIds instanceof Set ? excludedDocIds : new Set(excludedDocIds ?? []);
    const excludedSessions = excludedSessionIds instanceof Set ? excludedSessionIds : new Set(excludedSessionIds ?? []);
    const excludedSources = excludedSourceNames instanceof Set ? excludedSourceNames : new Set(excludedSourceNames ?? []);
    const terms = (blockedTerms ?? []).filter((term) => typeof term === 'string' && term.length > 0).map((term) => term.toLowerCase());
    const from = filters.from ? Date.parse(filters.from) : null;
    const to = filters.to ? Date.parse(filters.to) : null;
    const categories = filters.categories ? new Set(filters.categories) : null;
    const sourceKinds = filters.sourceKinds ? new Set(filters.sourceKinds) : null;
    const tags = filters.tags ? filters.tags.map((tag) => String(tag).toLowerCase()) : null;
    const candidates = [];
    let blockedByTerms = 0;
    for (const doc of this.docs) {
      if (!allowed.has(doc.workspaceId)) continue;
      if (!docInSelections(doc, selections)) continue;
      if (excluded.has(doc.id)) continue;
      if (doc.sourceSessionId && excludedSessions.has(doc.sourceSessionId)) continue;
      if (doc.sourceName && excludedSources.has(doc.sourceName)) continue;
      if (categories && !categories.has(doc.category)) continue;
      if (sourceKinds && !sourceKinds.has(doc.sourceKind)) continue;
      if (tags && tags.length > 0) {
        const haystack = (doc.tags ?? []).map((tag) => String(tag).toLowerCase());
        if (!tags.some((tag) => haystack.includes(tag))) continue;
      }
      if (from !== null || to !== null) {
        const created = Date.parse(doc.createdAt);
        if (!Number.isFinite(created)) continue;
        if (from !== null && created < from) continue;
        if (to !== null && created > to) continue;
      }
      if (terms.length > 0) {
        const haystack = `${doc.title}\n${doc.permissionText ?? doc.content}`.toLowerCase();
        if (terms.some((term) => haystack.includes(term))) {
          blockedByTerms += 1;
          continue;
        }
      }
      candidates.push(doc);
    }
    return { candidates, blockedByTerms };
  }

  /**
   * Search only within allowedWorkspaceIds.
   * @param {object} request
   * @param {string} request.query
   * @param {string[]} request.allowedWorkspaceIds - mandatory, already authorized
   */
  search({
    query,
    allowedWorkspaceIds,
    selections,
    excludedDocIds,
    excludedSessionIds,
    excludedSourceNames,
    blockedTerms,
    filters = {},
    mode = 'hybrid',
    limit = 8,
  }) {
    if (!Array.isArray(allowedWorkspaceIds)) {
      throw new Error('allowedWorkspaceIds is required');
    }
    const cleanQuery = normalizeText(query);
    if (cleanQuery.length === 0) {
      return { results: [], candidateCount: 0, blockedByTerms: 0, queryTokens: [] };
    }
    if (Array.from(cleanQuery).length > LIMITS.queryChars) {
      throw new Error(`查询超过 ${LIMITS.queryChars} 字符上限`);
    }
    const queryTokens = tokenize(cleanQuery);
    const tokensForSnippet = [...queryTokens.keys()].sort((a, b) => b.length - a.length).slice(0, 30);
    const { candidates, blockedByTerms } = this._candidateDocs({
      allowedWorkspaceIds,
      selections,
      excludedDocIds,
      excludedSessionIds,
      excludedSourceNames,
      blockedTerms,
      filters,
    });
    if (candidates.length === 0) {
      return { results: [], candidateCount: 0, blockedByTerms, queryTokens: tokensForSnippet };
    }
    const candidateIds = new Set(candidates.map((doc) => doc.id));
    const n = candidates.length;
    const idf = new Map();
    for (const [token] of queryTokens) {
      const posting = this.postings.get(token);
      if (!posting) {
        idf.set(token, 0);
        continue;
      }
      let df = 0;
      for (const docId of posting.keys()) if (candidateIds.has(docId)) df += 1;
      idf.set(token, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
    }

    const queryVector = new Float32Array(VECTOR_DIMS);
    for (const [token, count] of queryTokens) addToVector(queryVector, token, 1 + Math.log(count));
    normalizeVector(queryVector);

    const scored = [];    let maxBm25 = 1;
    for (const doc of candidates) {
      let bm25 = 0;
      let hasOverlap = false;
      const docLength = this.docLengths.get(doc.id) ?? 1;
      for (const [token, qtf] of queryTokens) {
        const posting = this.postings.get(token);
        if (!posting) continue;
        const tf = posting.get(doc.id) ?? 0;
        if (tf === 0) continue;
        hasOverlap = true;
        const tokenIdf = idf.get(token) ?? 0;
        bm25 += tokenIdf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLength / this.avgLength)))) * (1 + Math.log(qtf));
      }
      if (bm25 > maxBm25) maxBm25 = bm25;
      const vectorScore = Math.max(0, cosine(queryVector, this.vectors.get(doc.id)));
      scored.push({ doc, bm25, vectorScore, hasOverlap });
    }
    for (const item of scored) {
      const bm25Norm = item.bm25 / maxBm25;
      const exact = cleanQuery.length >= 2 && `${item.doc.title}\n${item.doc.content}`.toLowerCase().includes(cleanQuery.toLowerCase()) ? 0.08 : 0;
      let score;
      if (mode === 'keyword') score = bm25Norm;
      else if (mode === 'vector') score = item.vectorScore;
      else score = bm25Norm * 0.58 + item.vectorScore * 0.42 + exact;
      const created = Date.parse(item.doc.createdAt) || 0;
      item.score = score;
      item.created = created;
    }
    scored.sort((a, b) => b.score - a.score || b.created - a.created);

    const results = [];
    const seenHashes = new Map();
    for (const item of scored) {
      if (results.length >= Math.max(1, Math.min(LIMITS.searchResults, Number(limit) || 8))) break;
      if (!item.hasOverlap) continue;
      if (item.score <= 0.0001) continue;
      const source = { docId: item.doc.id, workspaceId: item.doc.workspaceId, sessionId: item.doc.sourceSessionId, sourceRef: item.doc.sourceRef };
      const exactDuplicate = item.doc.contentHash ? seenHashes.get(item.doc.contentHash) : null;
      if (exactDuplicate) { exactDuplicate.sources.push(source); exactDuplicate.duplicateCount += 1; continue; }
      // Similar wording can still describe different decisions or projects.
      // Only identical content is collapsed; never discard differing evidence.
      const highRisk = item.doc.risk === 'high';
      results.push({
        id: item.doc.id,
        sources: [source],
        workspaceId: item.doc.workspaceId,
        sourceKind: item.doc.sourceKind,
        sourceName: item.doc.sourceName,
        sourceRef: item.doc.sourceRef,
        sourceSessionId: item.doc.sourceSessionId,
        sourceSeq: item.doc.sourceSeq,
        conversationTitle: item.doc.conversationTitle,
        role: item.doc.role,
        title: item.doc.title,
        createdAt: item.doc.createdAt,
        category: item.doc.category,
        status: item.doc.status,
        tags: item.doc.tags,
        risk: item.doc.risk,
        language: item.doc.language,
        relevance: Math.round(Math.max(0, Math.min(1, item.score)) * 1000) / 1000,
        bm25: Math.round(item.bm25 * 1000) / 1000,
        vector: Math.round(item.vectorScore * 1000) / 1000,
        snippet: highRisk ? '' : makeSnippet(item.doc, tokensForSnippet),
        quarantined: highRisk,
        duplicateCount: 1,
        contentChars: Array.from(textForSnippet(item.doc)).length,
      });
      if (item.doc.contentHash) seenHashes.set(item.doc.contentHash, results.at(-1));
    }
    return {
      results,
      candidateCount: candidates.length,
      blockedByTerms,
      queryTokens: tokensForSnippet.slice(0, 8),
    };
  }
}

/** Build a deterministic content fingerprint for test/debug. */
export function fingerprintDocs(docs) {
  const normalized = docs
    .map((doc) => `${doc.id}:${sha256(doc.content)}`)
    .sort()
    .join('|');
  return sha256(normalized);
}

/** Clip a snippet for a specific length (used by context builder). */
export function clipSnippet(value, maxChars) {
  return truncateChars(value, maxChars).text;
}
