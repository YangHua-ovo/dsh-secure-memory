import { MemoryIndex } from './retrieval.js';
import { sha256 } from './util.js';

const KEY = /决定|最终|采用|确认|必须|不要|prefer|decid|confirmed|must/i;
const EVIDENCE = /为什么|为何|原因|依据|原文|放弃|废弃|当时|对比|why|reason|evidence|original|abandon|trade.?off/i;

/** Extract whole sentences; never turn an inferred summary into a confirmed fact. */
function extract(text, maxChars, keyOnly = false) {
  const sentences = String(text).match(/[^\n。！？.!?]+[。！？.!?]?/gu) ?? [];
  const chosen = []; let used = 0;
  for (const sentence of sentences) {
    if (keyOnly && !KEY.test(sentence)) continue;
    if (used + sentence.length > maxChars) continue;
    if (chosen.includes(sentence.trim())) continue;
    chosen.push(sentence.trim()); used += sentence.length;
    if (chosen.length >= 5) break;
  }
  return chosen.join('\n');
}

export class LayeredMemoryIndex {
  constructor(docs) {
    this.originals = docs;
    this.rawById = new Map(docs.map((doc) => [doc.id, doc]));
    const l1 = [], l2 = [];
    for (const doc of docs) {
      if (doc.risk === 'high') continue;
      const important = ['decision', 'verified', 'preference'].includes(doc.category)
        && doc.status !== 'deprecated' && (doc.status === 'confirmed' || (doc.role === 'user' && KEY.test(doc.content)));
      if (important) {
        const content = extract(doc.content, 650, true) || extract(doc.content, 650);
        if (content) l1.push({ ...doc, content, permissionText: doc.content, contentHash: sha256(content) });
      }
      if (String(doc.content).length > 400) {
        const content = extract(doc.content, 700);
        if (content && content !== doc.content) l2.push({ ...doc, content, permissionText: doc.content, contentHash: sha256(content) });
      }
    }
    this.layers = { L1: new MemoryIndex(l1), L2: new MemoryIndex(l2), L3: new MemoryIndex(docs) };
  }

  search(request) {
    const needsEvidence = EVIDENCE.test(request.query);
    const stages = [], candidates = [];
    const run = (level) => {
      const found = this.layers[level].search({ ...request, limit: 12 });
      stages.push({ level, candidateCount: found.candidateCount, matches: found.results.length });
      for (const result of found.results) {
        if (result.relevance < 0.18) continue;
        const doc = this.layers[level].docById.get(result.id);
        candidates.push({ ...result, memoryLevel: level, memoryText: level === 'L3' ? result.snippet : doc.content,
          summaryMethod: level === 'L3' ? null : 'extractive',
          sources: result.sources ?? [{ docId: result.id, workspaceId: result.workspaceId, sessionId: result.sourceSessionId, sourceRef: result.sourceRef }],
          priority: result.relevance + (needsEvidence ? (level === 'L3' ? 0.3 : 0) : (level === 'L1' ? 0.3 : level === 'L2' ? 0.08 : 0)),
        });
      }
      return found;
    };
    run('L1');
    if (needsEvidence || candidates.filter((r) => !r.quarantined).length < 2) run('L2');
    let raw;
    if (needsEvidence || candidates.filter((r) => !r.quarantined).length < 2) raw = run('L3');
    candidates.sort((a, b) => b.priority - a.priority);
    const results = [], byDoc = new Set(), byHash = new Map();
    for (const item of candidates) {
      if (byDoc.has(item.id)) continue;
      byDoc.add(item.id);
      const hash = this.rawById.get(item.id)?.contentHash ?? sha256(item.memoryText);
      const duplicate = byHash.get(hash);
      if (duplicate) { duplicate.sources.push(...item.sources); duplicate.duplicateCount += 1; continue; }
      const { priority, ...result } = item;
      byHash.set(hash, result); results.push(result);
    }
    return { results: results.slice(0, Math.max(1, Math.min(12, request.limit ?? 8))),
      candidateCount: Math.max(0, ...stages.map((stage) => stage.candidateCount)), blockedByTerms: raw?.blockedByTerms ?? 0,
      retrieval: { stages, needsEvidence, method: 'bm25+lexical-hash-vector', summaryMethod: 'extractive' } };
  }
}
