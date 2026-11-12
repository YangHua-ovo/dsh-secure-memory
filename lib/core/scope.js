/** Canonical, bounded session selections. An empty explicit list never means all. */
export function normalizeSelections(workspaceIds = [], selections) {
  const fail = (message) => { const error = new Error(message); error.code = 'INVALID_SESSION_SCOPE'; throw error; };
  if (!Array.isArray(workspaceIds) || workspaceIds.length > 64 || workspaceIds.some((id) => typeof id !== 'string' || !id)) fail('无效的工作区范围');
  if (selections === undefined) return workspaceIds.map((workspaceId) => ({ workspaceId, mode: 'all', sessionIds: [] }));
  if (!Array.isArray(selections) || selections.length > 64) fail('无效的会话选择');
  const seen = new Set();
  return selections.map((item) => {
    if (!item || typeof item.workspaceId !== 'string' || !item.workspaceId || seen.has(item.workspaceId)) fail('工作区选择无效或重复');
    seen.add(item.workspaceId);
    if (!['all', 'sessions'].includes(item.mode)) fail('范围必须为 all 或 sessions');
    if (!Array.isArray(item.sessionIds) || item.sessionIds.length > 500 || item.sessionIds.some((id) => typeof id !== 'string' || !id || id.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(id))) fail('无效的会话标识');
    if (new Set(item.sessionIds).size !== item.sessionIds.length) fail('会话选择重复');
    if (item.mode === 'all' && item.sessionIds.length) fail('整个工作区范围不能同时指定会话');
    return { workspaceId: item.workspaceId, mode: item.mode, sessionIds: [...item.sessionIds] };
  });
}

export function docInSelections(doc, selections) {
  if (selections === undefined) return true; // management-only workspace view
  const selected = selections.find((item) => item.workspaceId === doc.workspaceId);
  return Boolean(selected && (selected.mode === 'all' || (doc.sourceSessionId && selected.sessionIds.includes(doc.sourceSessionId))));
}
