import { CATEGORY_LABELS } from './constants.js';

/**
 * Build a bounded, permission-filtered knowledge association graph.
 * Nodes contain only labels and counts, never document bodies.
 */
export function buildGraph(docs, workspaces, allowedWorkspaceIds, { maxTopics = 40, maxNodes = 220, maxEdges = 480 } = {}) {
  const allowed = new Set(allowedWorkspaceIds ?? []);
  const scoped = docs.filter((doc) => allowed.has(doc.workspaceId));
  const nodeById = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const topicCounts = new Map();
  const topicWorkspaces = new Map();
  const categoryCounts = new Map();

  const addNode = (node) => {
    if (nodeById.size >= maxNodes) return false;
    if (!nodeById.has(node.id)) nodeById.set(node.id, node);
    return true;
  };
  const addEdge = (source, target, kind, weight) => {
    if (edges.length >= maxEdges) return;
    const key = `${source}|${target}|${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target, kind, weight });
  };

  for (const workspace of workspaces) {
    if (!allowed.has(workspace.id)) continue;
    addNode({
      id: `ws:${workspace.id}`,
      kind: 'workspace',
      label: workspace.title,
      count: scoped.filter((doc) => doc.workspaceId === workspace.id).length,
      workspaceId: workspace.id,
    });
  }

  for (const doc of scoped) {
    const workspaceNode = `ws:${doc.workspaceId}`;
    if (!nodeById.has(workspaceNode)) continue;
    const catId = `cat:${doc.category}`;
    addNode({ id: catId, kind: 'category', label: CATEGORY_LABELS[doc.category] ?? doc.category, count: 0 });
    if (nodeById.has(catId)) {
      nodeById.get(catId).count += 1;
      addEdge(workspaceNode, catId, 'has-category', 1);
    }
    for (const tag of doc.tags ?? []) {
      if (typeof tag !== 'string' || tag.startsWith('category:')) continue;
      topicCounts.set(tag, (topicCounts.get(tag) ?? 0) + 1);
      if (!topicWorkspaces.has(tag)) topicWorkspaces.set(tag, new Set());
      topicWorkspaces.get(tag).add(doc.workspaceId);
    }
    categoryCounts.set(doc.category, (categoryCounts.get(doc.category) ?? 0) + 1);
  }

  const topTopics = [...topicCounts.entries()]
    .filter(([tag]) => !/^\d+$/.test(tag))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTopics);
  for (const [tag, count] of topTopics) {
    const tagId = `tag:${tag}`;
    addNode({
      id: tagId,
      kind: 'topic',
      label: tag,
      count,
      workspaces: [...(topicWorkspaces.get(tag) ?? [])].length,
    });
    if (!nodeById.has(tagId)) continue;
    for (const workspaceId of topicWorkspaces.get(tag) ?? []) {
      const workspaceNode = `ws:${workspaceId}`;
      if (nodeById.has(workspaceNode)) addEdge(workspaceNode, tagId, 'has-topic', count);
    }
  }

  const sharedTopics = topTopics
    .filter(([tag]) => (topicWorkspaces.get(tag)?.size ?? 0) >= 2)
    .slice(0, 12)
    .map(([tag, count]) => ({ tag, count, workspaces: [...(topicWorkspaces.get(tag) ?? [])] }));

  return {
    nodes: [...nodeById.values()],
    edges,
    summary: {
      authorizedWorkspaces: allowed.size,
      documents: scoped.length,
      topics: topicCounts.size,
      categories: Object.fromEntries(categoryCounts),
      crossWorkspaceTopics: sharedTopics,
      note: '图谱基于共同标签与分类的本地共现关系，是检索辅助，不代表语义因果或事实确定性。',
    },
  };
}
