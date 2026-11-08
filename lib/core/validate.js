import { CATEGORY_LABELS, STATUS_LABELS } from './constants.js';
import { tokenize } from './tokenize.js';
import { clamp, parseTime } from './util.js';

const BASE = {
  decision: 0.72,
  verified: 0.78,
  preference: 0.66,
  background: 0.52,
  idea: 0.40,
  tentative: 0.36,
  unresolved: 0.32,
  deprecated: 0.12,
};

const STATUS_BONUS = {
  confirmed: 0.10,
  active: 0.02,
  unverified: 0,
  deprecated: -0.18,
};

function tokenSet(doc) {
  return new Set(tokenize(`${doc.title ?? ''}\n${doc.content ?? ''}`).keys());
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const token of small) if (large.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function topicTags(doc) {
  return (doc.tags ?? []).filter((tag) => typeof tag === 'string' && !tag.startsWith('category:'));
}

function daysBetween(a, b) {
  return Math.abs(a - b) / (24 * 60 * 60 * 1000);
}

/**
 * Heuristic credibility hint. This is deliberately not presented as a truth
 * score: it combines source completeness, recency, corroboration and conflict
 * signals only to help a human prioritize review.
 */
export function confidenceFor(doc, { allDocs = [], conflictIds = new Set(), now = Date.now() } = {}) {
  const factors = [];
  let score = BASE[doc.category] ?? 0.4;
  factors.push(`分类：${CATEGORY_LABELS[doc.category] ?? doc.category}（基础 ${score.toFixed(2)}）`);
  const statusBonus = STATUS_BONUS[doc.status] ?? 0;
  score += statusBonus;
  if (statusBonus !== 0) factors.push(`状态：${STATUS_LABELS[doc.status] ?? doc.status}（${statusBonus >= 0 ? '+' : ''}${statusBonus.toFixed(2)}）`);

  const created = parseTime(doc.createdAt);
  if (created !== null) {
    const ageDays = (now - created) / (24 * 60 * 60 * 1000);
    let recency = 0;
    let label = '';
    if (ageDays <= 30) { recency = 0.10; label = '30 天内'; }
    else if (ageDays <= 180) { recency = 0.05; label = '180 天内'; }
    else if (ageDays <= 365) { recency = 0; label = '一年内'; }
    else if (ageDays <= 730) { recency = -0.15; label = '超过一年'; }
    else { recency = -0.25; label = '超过两年'; }
    score += recency;
    factors.push(`时间：${label}（${recency >= 0 ? '+' : ''}${recency.toFixed(2)}）`);
  } else {
    score -= 0.05;
    factors.push('时间：缺失（-0.05）');
  }

  let completeness = 0;
  if (doc.sourceSessionId) completeness += 0.02;
  if (Number.isInteger(doc.sourceSeq)) completeness += 0.02;
  if (doc.conversationTitle) completeness += 0.01;
  if (completeness > 0) {
    score += completeness;
    factors.push(`来源完整度：+${completeness.toFixed(2)}`);
  }

  // Corroboration: only compare within docs that share a real topic tag.
  let corroboration = 0;
  if (allDocs.length > 0 && topicTags(doc).length > 0) {
    const ownTopics = new Set(topicTags(doc));
    const ownTokens = tokenSet(doc);
    let compared = 0;
    for (const other of allDocs) {
      if (compared >= 80) break;
      if (other.id === doc.id || other.workspaceId === doc.workspaceId) continue;
      const shared = topicTags(other).filter((tag) => ownTopics.has(tag));
      if (shared.length === 0) continue;
      compared += 1;
      if (jaccard(ownTokens, tokenSet(other)) >= 0.35) corroboration += 0.04;
      if (corroboration >= 0.08) break;
    }
    if (corroboration > 0) {
      score += corroboration;
      factors.push(`多来源印证：+${corroboration.toFixed(2)}`);
    }
  }

  if (conflictIds.has(doc.id)) {
    score -= 0.16;
    factors.push('存在潜在冲突：-0.16（需人工判断）');
  }

  score = clamp(score, 0.05, 0.92);
  const label = score >= 0.75 ? '较高（启发式）' : score >= 0.5 ? '中等（启发式）' : '较低（启发式）';
  return {
    score: Math.round(score * 100) / 100,
    label,
    factors,
    disclaimer: '这是辅助排序的启发式提示，不是事实确定性，也不替代人工确认。',
  };
}

/** Find potential cross-workspace divergence for human review. */
export function detectConflicts(docs, { limit = 20 } = {}) {
  const eligible = docs.filter((doc) => ['decision', 'verified'].includes(doc.category) && doc.status !== 'deprecated');
  const tokenSets = new Map(eligible.map((doc) => [doc.id, tokenSet(doc)]));
  const byTag = new Map();
  for (const doc of eligible) {
    for (const tag of topicTags(doc)) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(doc);
    }
  }
  const pairs = [];
  const seenPairs = new Set();
  for (const [tag, group] of byTag) {
    if (group.length < 2 || group.length > 80) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (a.workspaceId === b.workspaceId) continue;
        const key = [a.id, b.id].sort().join('|');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const similarity = jaccard(tokenSets.get(a.id), tokenSets.get(b.id));
        if (similarity > 0.28) continue;
        const timeA = parseTime(a.createdAt);
        const timeB = parseTime(b.createdAt);
        const days = timeA !== null && timeB !== null ? daysBetween(timeA, timeB) : null;
        if (days !== null && days < 1) continue;
        const sharedTopics = topicTags(a).filter((item) => topicTags(b).includes(item)).slice(0, 4);
        pairs.push({
          id: `conflict_${a.id.slice(-8)}_${b.id.slice(-8)}`,
          topic: tag,
          sharedTopics,
          similarity: Math.round(similarity * 100) / 100,
          daysApart: days === null ? null : Math.round(days),
          docs: [a, b].map((doc) => ({
            id: doc.id,
            workspaceId: doc.workspaceId,
            title: doc.title,
            createdAt: doc.createdAt,
            category: doc.category,
            status: doc.status,
            sourceRef: doc.sourceRef,
            sourceSessionId: doc.sourceSessionId,
          })),
          message: '两个已确认/已验证来源在共同主题上差异较大。系统不判断谁正确，请由用户或项目负责人确认。',
        });
        if (pairs.length >= limit) return pairs;
      }
    }
  }
  return pairs;
}

/** Build the set of doc ids participating in a potential conflict. */
export function conflictDocIds(conflicts) {
  const ids = new Set();
  for (const conflict of conflicts) for (const doc of conflict.docs) ids.add(doc.id);
  return ids;
}

/** Add confidence, time, and conflict metadata to result objects. */
export function assessResults(results, allDocs, { now = Date.now() } = {}) {
  const docById = new Map(allDocs.map((doc) => [doc.id, doc]));
  const resultDocs = results.map((result) => docById.get(result.id)).filter(Boolean);
  const resultIds = new Set(resultDocs.map((doc) => doc.id));
  // Conflict detection is only needed for the result set and documents that
  // share a topic with it. This keeps a 10k-document vault search bounded.
  const pool = new Map(resultDocs.map((doc) => [doc.id, doc]));
  const resultTopics = new Set(resultDocs.flatMap((doc) => topicTags(doc)));
  for (const doc of allDocs) {
    if (pool.size >= 400) break;
    if (resultIds.has(doc.id) || resultTopics.size === 0) continue;
    if (topicTags(doc).some((tag) => resultTopics.has(tag))) pool.set(doc.id, doc);
  }
  const conflicts = detectConflicts([...pool.values()], { limit: 50 });
  const conflictIds = conflictDocIds(conflicts);
  const relevantConflicts = conflicts.filter((conflict) => conflict.docs.some((doc) => resultIds.has(doc.id)));
  return {
    results: results.map((result) => {
      const fullDoc = docById.get(result.id) ?? result;
      const confidence = confidenceFor(fullDoc, { allDocs, conflictIds, now });
      const created = parseTime(fullDoc.createdAt);
      return {
        ...result,
        confidence,
        time: {
          firstSeen: fullDoc.createdAt,
          lastConfirmedAt: fullDoc.lastConfirmedAt ?? null,
          ageDays: created === null ? null : Math.max(0, Math.round((now - created) / (24 * 60 * 60 * 1000))),
          stale: created !== null && now - created > 365 * 24 * 60 * 60 * 1000,
        },
        conflictIds: relevantConflicts
          .filter((conflict) => conflict.docs.some((doc) => doc.id === fullDoc.id))
          .map((conflict) => conflict.id),
        categoryLabel: CATEGORY_LABELS[fullDoc.category] ?? fullDoc.category,
        statusLabel: STATUS_LABELS[fullDoc.status] ?? fullDoc.status,
      };
    }),
    conflicts: relevantConflicts,
    allConflicts: conflicts,
    conflictIds,
  };
}

/** Timeline projection for the UI. */
export function buildTimeline(docs, { limit = 200, now = Date.now() } = {}) {
  const numericLimit = Number(limit);
  const safeLimit = Number.isFinite(numericLimit) ? Math.max(1, Math.min(1000, Math.floor(numericLimit))) : 200;
  const sorted = docs
    .slice()
    .sort((a, b) => (parseTime(b.createdAt) ?? 0) - (parseTime(a.createdAt) ?? 0))
    .slice(0, safeLimit);
  const conflicts = detectConflicts(docs, { limit: 100 });
  const conflictIds = conflictDocIds(conflicts);
  return sorted.map((doc) => {
    const confidence = confidenceFor(doc, { allDocs: docs, conflictIds, now });
    const created = parseTime(doc.createdAt);
    return {
      id: doc.id,
      workspaceId: doc.workspaceId,
      title: doc.title,
      createdAt: doc.createdAt,
      importedAt: doc.importedAt,
      lastConfirmedAt: doc.lastConfirmedAt ?? null,
      category: doc.category,
      categoryLabel: CATEGORY_LABELS[doc.category] ?? doc.category,
      status: doc.status,
      statusLabel: STATUS_LABELS[doc.status] ?? doc.status,
      tags: doc.tags,
      risk: doc.risk,
      sourceKind: doc.sourceKind,
      sourceName: doc.sourceName,
      sourceRef: doc.sourceRef,
      sourceSessionId: doc.sourceSessionId,
      role: doc.role,
      confidence,
      stale: created !== null && now - created > 365 * 24 * 60 * 60 * 1000,
      potentialConflict: conflictIds.has(doc.id),
      excluded: false,
    };
  });
}
