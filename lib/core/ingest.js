import { LIMITS } from './constants.js';
import { analyzeText, neutralizeForHuman } from './sanitize.js';
import { extractTags, languageOf } from './tokenize.js';
import { charLength, makeTitle, nowIso, parseTime, sha256, truncateChars, uuid } from './util.js';

/**
 * Extract only user/assistant text blocks from a DSH session handle. This is a
 * deliberately narrow reader: system prompts, developer messages, reasoning,
 * tool calls/results, images, and attachments never enter the memory index.
 */

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function messageFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'user/message') {
    return event.data && typeof event.data === 'object' ? event.data : null;
  }
  if (event.type === 'assistant/message') {
    return event.data?.message && typeof event.data.message === 'object' ? event.data.message : null;
  }
  return null;
}

function eventRole(event) {
  if (event.type === 'user/message') return 'user';
  if (event.type === 'assistant/message') return 'assistant';
  return null;
}

function eventTime(event, fallbackMs) {
  const value = Number(event?.time);
  if (Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  return new Date(fallbackMs).toISOString();
}

const DECISION_RE = /(?:决定|最终|采用|选定|定稿|结论是|就这么|confirmed|final decision|we will use|decided to|going with)/i;
const VERIFIED_RE = /(?:已验证|验证通过|测试通过|上线成功|verified|tested successfully|works as expected)/i;
const DEPRECATED_RE = /(?:已废弃|废弃|不再使用|停止使用|deprecated|abandoned|superseded)/i;
const UNRESOLVED_RE = /(?:未解决|待定|尚未解决|open question|unresolved|TBD|still investigating)/i;
const IDEA_RE = /(?:想法|建议|或许|也许|可以考虑|proposal|idea|what if|could try)/i;
const TENTATIVE_RE = /(?:暂时|临时|先这样|tentative|for now|temporarily)/i;
const PREFERENCE_RE = /(?:我更喜欢|我偏好|请始终|不要用|prefer|I like|always use|never use)/i;

/** Conservative category inference; the UI always allows a human override. */
export function inferCategory(text, role = 'document') {
  const value = String(text ?? '');
  if (DEPRECATED_RE.test(value)) return 'deprecated';
  if (UNRESOLVED_RE.test(value)) return 'unresolved';
  if (DECISION_RE.test(value)) return 'decision';
  if (VERIFIED_RE.test(value)) return 'verified';
  if (PREFERENCE_RE.test(value)) return 'preference';
  if (TENTATIVE_RE.test(value)) return 'tentative';
  if (IDEA_RE.test(value)) return 'idea';
  return role === 'user' ? 'background' : 'background';
}

/** Build one memory document from a raw text segment. */
export function makeDocument({
  workspaceId,
  content,
  role = 'document',
  sourceKind,
  sourceRef,
  sourceSessionId = null,
  sourceSeq = null,
  conversationTitle = '',
  createdAt,
  title,
  category,
  status,
  tags,
  sourceName = '',
}) {
  const normalized = String(content ?? '');
  if (normalized.trim().length === 0) return null;
  const limited = truncateChars(normalized, LIMITS.docChars);
  const analyzed = analyzeText(limited.text);
  if (analyzed.text.trim().length === 0) return null;
  const inferredCategory = category ?? inferCategory(analyzed.text, role);
  const validCategories = new Set([
    'decision', 'verified', 'idea', 'tentative', 'deprecated', 'unresolved', 'background', 'preference',
  ]);
  const resolvedCategory = validCategories.has(inferredCategory) ? inferredCategory : 'background';
  const validStatuses = new Set(['active', 'unverified', 'confirmed', 'deprecated']);
  const resolvedStatus = validStatuses.has(status)
    ? status
    : resolvedCategory === 'deprecated' ? 'deprecated' : 'unverified';
  const now = nowIso();
  return {
    id: `doc_${sha256(`${workspaceId}|${sourceRef}|${analyzed.text}`).slice(0, 32)}`,
    workspaceId,
    sourceKind,
    sourceName: String(sourceName ?? '').slice(0, 240),
    sourceRef: String(sourceRef ?? '').slice(0, 500),
    sourceSessionId: sourceSessionId ? String(sourceSessionId).slice(0, 200) : null,
    sourceSeq: Number.isInteger(sourceSeq) ? sourceSeq : null,
    conversationTitle: String(conversationTitle ?? '').slice(0, 200),
    role: ['user', 'assistant', 'document'].includes(role) ? role : 'document',
    title: String(title || makeTitle(analyzed.text)).slice(0, 200),
    content: analyzed.text,
    contentHash: sha256(analyzed.text),
    createdAt: createdAt ?? now,
    importedAt: now,
    lastConfirmedAt: null,
    category: resolvedCategory,
    status: resolvedStatus,
    tags: Array.isArray(tags) && tags.length > 0
      ? tags.filter((tag) => typeof tag === 'string').slice(0, 12)
      : extractTags(analyzed.text, resolvedCategory, 8),
    risk: analyzed.risk,
    language: analyzed.language,
    redactions: analyzed.redactions,
  };
}

/**
 * Read one DSH workspace's sessions. The workspace account is supplied by the
 * official registry; no arbitrary directory traversal is performed.
 */
export async function extractDshWorkspace({ workspace, sessionPersistence, workspaceId, now = Date.now(), signal }) {
  if (!workspace || !Array.isArray(workspace.sessionIds)) {
    throw new Error('工作区对象缺少 sessionIds');
  }
  if (!sessionPersistence || typeof sessionPersistence.open !== 'function') {
    throw new Error('DSH sessionPersistence 服务不可用');
  }
  const sessions = [];
  const warnings = [];
  let totalChars = 0;
  let truncated = false;
  let stopWorkspace = false;
  const sessionIds = workspace.sessionIds.slice(0, LIMITS.syncSessions);
  if (workspace.sessionIds.length > LIMITS.syncSessions) {
    warnings.push(`会话数超过单次同步上限 ${LIMITS.syncSessions}，仅处理前 ${LIMITS.syncSessions} 个。`);
    truncated = true;
  }

  for (const sessionId of sessionIds) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let snapshot;
    try {
      snapshot = await sessionPersistence.stat(sessionId, { signal });
    } catch (error) {
      warnings.push(`会话 ${String(sessionId).slice(0, 18)} 读取元数据失败：${error?.message ?? 'unknown'}`);
      continue;
    }
    if (!snapshot) continue;
    if (snapshot.header?.origin === 'subagent' || Number(snapshot.header?.delegationDepth ?? 0) > 0) {
      continue;
    }
    let handle;
    try {
      handle = await sessionPersistence.open(sessionId, 'read', { signal });
      const totalEvents = Number(snapshot.eventCount);
      const readOffset = Number.isFinite(totalEvents) && totalEvents > LIMITS.syncEventsPerSession
        ? Math.max(0, totalEvents - LIMITS.syncEventsPerSession)
        : 0;
      if (readOffset > 0) {
        warnings.push(`会话 ${String(sessionId).slice(0, 18)} 仅索引最近 ${LIMITS.syncEventsPerSession} 个事件。`);
        truncated = true;
      }
      const result = await handle.read(readOffset, LIMITS.syncEventsPerSession, { signal });
      const events = Array.isArray(result?.events) ? result.events : [];
      const createdMs = Number(snapshot.header?.createdAt) || now;
      const rawMessages = [];
      for (const event of events) {
        const message = messageFromEvent(event);
        if (!message) continue;
        const role = eventRole(event);
        if (!role) continue;
        const text = contentToText(message.content);
        if (!text || charLength(text) < 4) continue;
        if (totalChars + charLength(text) > LIMITS.syncCharsPerWorkspace) {
          warnings.push(`工作区 ${String(workspace.title ?? workspaceId).slice(0, 40)} 达到单次文本上限，后续内容未同步。`);
          truncated = true;
          stopWorkspace = true;
          break;
        }
        rawMessages.push({
          role,
          text,
          seq: Number(event.seq) || 0,
          createdAt: eventTime(event, createdMs),
        });
        totalChars += charLength(text);
      }
      const firstUser = rawMessages.find((item) => item.role === 'user');
      const conversationTitle = firstUser ? makeTitle(firstUser.text, `会话 ${String(sessionId).slice(-8)}`) : makeTitle(rawMessages[0]?.text ?? '', `会话 ${String(sessionId).slice(-8)}`);
      const seen = new Set();
      const docs = [];
      for (const item of rawMessages) {
        const hash = sha256(item.text);
        if (seen.has(hash)) continue;
        seen.add(hash);
        const doc = makeDocument({
          workspaceId,
          content: item.text,
          role: item.role,
          sourceKind: 'dsh-session',
          sourceRef: `dsh-session:${sessionId}#seq:${item.seq}`,
          sourceSessionId: sessionId,
          sourceSeq: item.seq,
          conversationTitle,
          createdAt: item.createdAt,
          sourceName: String(workspace.title ?? ''),
        });
        if (doc) docs.push(doc);
      }
      sessions.push({
        sessionId,
        revision: String(snapshot.revision ?? ''),
        title: conversationTitle,
        docs,
        eventCount: events.length,
        totalEventCount: snapshot.eventCount,
      });
    } catch (error) {
      warnings.push(`会话 ${String(sessionId).slice(0, 18)} 读取失败：${error?.message ?? 'unknown'}`);
    } finally {
      if (handle) {
        try { await handle.close(); } catch { /* read handles close idempotently */ }
      }
    }
    if (stopWorkspace) break;
  }
  return { sessions, warnings, truncated, totalChars };
}

/** Remove high-risk instruction phrases from a human-facing title/body preview. */
export function humanPreview(value, maxChars = LIMITS.snippetChars) {
  const neutralized = neutralizeForHuman(value);
  return truncateChars(neutralized, maxChars).text;
}

function collectConversationMessages(conversation) {
  const messages = [];
  if (!conversation || typeof conversation !== 'object') return messages;
  const arrays = [
    conversation.messages,
    conversation.chat_messages,
    conversation.turns,
    conversation.entries,
  ];
  for (const array of arrays) {
    if (Array.isArray(array)) {
      for (const message of array) {
        if (!message || typeof message !== 'object') continue;
        const role = message.role ?? message.author?.role ?? message.sender ?? 'document';
        let content = message.content ?? message.text ?? message.message ?? message.body;
        if (content && typeof content === 'object' && !Array.isArray(content)) {
          content = content.parts ?? content.text ?? content.content;
        }
        if (Array.isArray(content)) content = contentToText(content);
        if (typeof content !== 'string' || content.trim().length === 0) continue;
        const createdAt = message.created_at ?? message.createdAt ?? message.timestamp ?? message.time ?? conversation.created_at;
        messages.push({
          role: ['user', 'assistant'].includes(role) ? role : 'document',
          content,
          createdAt,
          title: message.title,
        });
      }
      if (messages.length > 0) return messages;
    }
  }
  // ChatGPT-style mapping export.
  if (conversation.mapping && typeof conversation.mapping === 'object') {
    const nodes = Object.values(conversation.mapping)
      .filter((node) => node && node.message)
      .sort((a, b) => Number(a.message.create_time ?? 0) - Number(b.message.create_time ?? 0));
    for (const node of nodes) {
      const message = node.message;
      const role = message.author?.role ?? 'document';
      const content = contentToText(message.content?.parts ?? message.content?.text ?? '');
      if (!content) continue;
      messages.push({
        role: ['user', 'assistant'].includes(role) ? role : 'document',
        content,
        createdAt: message.create_time ? Number(message.create_time) * 1000 : conversation.create_time,
      });
    }
  }
  return messages;
}

function findConversationArray(root) {
  if (!root || typeof root !== 'object') return null;
  const candidates = [
    root.conversations,
    root.chats,
    root.sessions,
    root.data,
    root.items,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && Array.isArray(candidate.conversations)) return candidate.conversations;
  }
  if (Array.isArray(root)) return root;
  if (Array.isArray(root.messages)) return [root];
  return null;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Parse a user-supplied import file. No network, no ZIP/binary parsing.
 * Supported: normalized memory pack, generic conversation JSON, Markdown.
 */
export function parseImport({ filename, content, maxBytes = LIMITS.bodyBytes }) {
  if (typeof content !== 'string') throw new Error('导入内容必须是文本');
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw new Error(`导入文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
  }
  const baseName = String(filename || 'manual-import').replace(/^.*[\\/]/, '').slice(0, 200);
  const ext = baseName.toLowerCase().split('.').pop();
  const warnings = [];
  const trimmed = content.trim();
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (ext === 'md' || ext === 'markdown' || ext === 'txt' || !looksJson) {
    const workspaceTitle = baseName.replace(/\.(md|markdown|txt)$/i, '') || '手动导入的 Markdown 记忆';
    const doc = makeDocument({
      workspaceId: '__import__',
      content,
      role: 'document',
      sourceKind: 'markdown',
      sourceRef: `file:${baseName}`,
      sourceName: baseName,
      title: workspaceTitle,
      category: 'background',
      status: 'unverified',
    });
    if (!doc) throw new Error('文件中没有可索引的文本');
    return {
      title: workspaceTitle,
      description: `手动导入的 Markdown 快照（${baseName}）`,
      sourceKind: 'markdown',
      docs: [doc],
      warnings,
      stats: { documents: 1, chars: doc.content.length, sourceBytes: Buffer.byteLength(content) },
    };
  }

  let root;
  try {
    root = JSON.parse(trimmed);
  } catch {
    throw new Error('JSON 解析失败：文件不是有效 JSON 或 Markdown 文本');
  }

  // Normalized memory pack.
  const packDocs = Array.isArray(root?.documents) ? root.documents : Array.isArray(root?.docs) ? root.docs : null;
  const topLevelDocs = !packDocs && Array.isArray(root) && root.length > 0
    && root.every((item) => item && typeof item === 'object' && typeof (item.content ?? item.text ?? item.body) === 'string')
    ? root
    : null;
  if (packDocs || topLevelDocs) {
    const docsInput = packDocs ?? topLevelDocs;
    const workspaceInfo = root.workspace && typeof root.workspace === 'object' ? root.workspace : {};
    const title = String(workspaceInfo.name ?? workspaceInfo.title ?? root.title ?? baseName.replace(/\.json$/i, ''));
    const description = String(workspaceInfo.description ?? root.description ?? `手动导入记忆包（${baseName}）`);
    const docs = [];
    for (let index = 0; index < docsInput.length; index += 1) {
      const item = docsInput[index];
      if (!item || typeof item !== 'object') continue;
      const contentValue = item.content ?? item.text ?? item.body;
      if (typeof contentValue !== 'string' || contentValue.trim().length === 0) continue;
      const doc = makeDocument({
        workspaceId: '__import__',
        content: contentValue,
        role: item.role,
        sourceKind: 'manual-pack',
        sourceRef: String(item.sourceRef ?? item.id ?? `pack:${index}`),
        sourceSessionId: item.conversationId ?? null,
        sourceSeq: Number.isInteger(item.sourceSeq) ? item.sourceSeq : null,
        conversationTitle: item.conversationTitle ?? '',
        createdAt: normalizeTimestamp(item.createdAt ?? item.created_at ?? item.time) ?? undefined,
        title: item.title,
        category: item.category,
        status: item.status,
        tags: Array.isArray(item.tags) ? item.tags : undefined,
        sourceName: baseName,
      });
      if (doc) docs.push(doc);
    }
    if (docs.length === 0) throw new Error('记忆包中没有有效文档');
    if (docs.length > LIMITS.maxImportDocs) throw new Error(`导入文档数超过上限 ${LIMITS.maxImportDocs}`);
    return {
      title: title.slice(0, 200),
      description: description.slice(0, 1000),
      sourceKind: 'manual-pack',
      docs,
      warnings,
      stats: { documents: docs.length, chars: docs.reduce((sum, doc) => sum + charLength(doc.content), 0), sourceBytes: Buffer.byteLength(content) },
    };
  }

  // Generic conversation export (e.g. an official export JSON).
  let conversationRoot = root;
  if (Array.isArray(root) && root.length > 0 && root.every((item) => item && typeof item === 'object'
    && (item.role || item.author) && (item.content !== undefined || item.text !== undefined))) {
    conversationRoot = { title: baseName.replace(/\.json$/i, ''), messages: root };
  }
  const conversations = findConversationArray(conversationRoot);
  if (!conversations || conversations.length === 0) {
    throw new Error('无法识别该 JSON：既不是记忆包，也不包含 conversations/chats/sessions/messages');
  }
  const title = String(conversationRoot.title ?? conversationRoot.name ?? baseName.replace(/\.json$/i, ''));
  const description = `用户手动导入的对话快照（${baseName}）；不是云端实时连接。`;
  const docs = [];
  let index = 0;
  for (const conversation of conversations.slice(0, LIMITS.maxImportDocs)) {
    if (!conversation || typeof conversation !== 'object') continue;
    const conversationTitle = String(conversation.title ?? conversation.name ?? conversation.id ?? `对话 ${index + 1}`).slice(0, 200);
    const messages = collectConversationMessages(conversation);
    for (const message of messages) {
      const doc = makeDocument({
        workspaceId: '__import__',
        content: message.content,
        role: message.role,
        sourceKind: 'deepseek-export',
        sourceRef: `export:${conversation.id ?? conversationTitle}#${index}`,
        sourceSessionId: conversation.id ? String(conversation.id) : null,
        conversationTitle,
        createdAt: normalizeTimestamp(message.createdAt ?? conversation.created_at ?? conversation.createdAt) ?? undefined,
        title: message.title ?? conversationTitle,
        category: undefined,
        status: 'unverified',
        sourceName: baseName,
      });
      if (doc) docs.push(doc);
      index += 1;
    }
  }
  if (docs.length === 0) throw new Error('JSON 中没有可提取的 user/assistant 文本');
  if (docs.length > LIMITS.maxImportDocs) throw new Error(`导入文档数超过上限 ${LIMITS.maxImportDocs}`);
  return {
    title: title.slice(0, 200),
    description,
    sourceKind: 'deepseek-export',
    docs,
    warnings,
    stats: { documents: docs.length, chars: docs.reduce((sum, doc) => sum + charLength(doc.content), 0), sourceBytes: Buffer.byteLength(content) },
  };
}

/** Validate that an import's docs fit the same limits as the store. */
export function assertImportSize(parsed) {
  if (!parsed || !Array.isArray(parsed.docs)) throw new Error('导入结果无效');
  if (parsed.docs.length > LIMITS.maxImportDocs) throw new Error('导入文档数超过上限');
  const chars = parsed.docs.reduce((sum, doc) => sum + charLength(doc.content), 0);
  if (chars > LIMITS.workspaceChars) throw new Error('导入文本长度超过工作区上限');
  return true;
}

export { contentToText, messageFromEvent, normalizeTimestamp };
