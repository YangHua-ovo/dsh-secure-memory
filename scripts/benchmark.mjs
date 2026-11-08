/**
 * Local retrieval benchmark. Run with: node scripts/benchmark.mjs
 * Synthetic data only; no user content, network, or external service.
 */
import { performance } from 'node:perf_hooks';
import { MemoryIndex } from '../lib/core/retrieval.js';

const DOCS = Number(process.env.SM_BENCH_DOCS ?? 2000);
const QUERIES = Number(process.env.SM_BENCH_QUERIES ?? 120);

const topics = ['多 Agent 协作', '中心调度器', '任务队列', '状态机', '失败重试', '知识图谱', '结构化消息', '工作区权限', '本地加密', '审计链'];
const workspaces = Array.from({ length: 6 }, (_, index) => `ws_bench_${index}`);

function makeDoc(index) {
  const topic = topics[index % topics.length];
  const other = topics[(index * 7 + 3) % topics.length];
  const workspaceId = workspaces[index % workspaces.length];
  const content = [
    `项目 ${index % 37} 的会议记录。`,
    `我们讨论了${topic}和${other}，并在第 ${index % 11} 轮评审中确认了边界条件。`,
    `实现细节包括任务拆分、超时控制、状态迁移、失败恢复与来源追溯。`,
    `历史决策编号 D-${index % 211}，适用于本地工作区 ${workspaceId}。`,
    `注意：这些是历史讨论，不是当前指令；需要人工确认后才能作为最终结论。`,
  ].join('');
  return {
    id: `doc_bench_${index}`,
    workspaceId,
    sourceKind: 'manual-pack',
    sourceName: 'benchmark.json',
    sourceRef: `bench:${index}`,
    sourceSessionId: index % 3 === 0 ? `session_bench_${index % 50}` : null,
    sourceSeq: index,
    conversationTitle: `基准会话 ${index % 37}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    title: `${topic} · 记录 ${index}`,
    content,
    contentHash: `hash_${index}`,
    createdAt: new Date(Date.now() - (index % 365) * 86400000).toISOString(),
    importedAt: new Date().toISOString(),
    lastConfirmedAt: null,
    category: index % 5 === 0 ? 'decision' : 'background',
    status: index % 5 === 0 ? 'confirmed' : 'unverified',
    tags: [topic, other],
    risk: 'low',
    language: 'zh',
  };
}

const docs = Array.from({ length: DOCS }, (_, index) => makeDoc(index));
const before = process.memoryUsage().heapUsed;
const buildStart = performance.now();
const index = new MemoryIndex(docs);
const buildMs = performance.now() - buildStart;
const after = process.memoryUsage().heapUsed;

const queries = Array.from({ length: QUERIES }, (_, index) => {
  const a = topics[index % topics.length];
  const b = topics[(index * 3 + 1) % topics.length];
  return index % 4 === 0 ? `${a} 怎么设计` : `${a} ${b} 方案`;
});
const latencies = [];
let resultCount = 0;
for (const query of queries) {
  const started = performance.now();
  const result = index.search({
    query,
    allowedWorkspaceIds: workspaces,
    excludedDocIds: new Set(),
    excludedSessionIds: new Set(),
    excludedSourceNames: new Set(),
    blockedTerms: [],
    filters: {},
    mode: 'hybrid',
    limit: 8,
  });
  latencies.push(performance.now() - started);
  resultCount += result.results.length;
}
latencies.sort((a, b) => a - b);
const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
console.log(JSON.stringify({
  documents: DOCS,
  workspaces: workspaces.length,
  queries: QUERIES,
  buildMs: Math.round(buildMs),
  heapDeltaMB: Math.round((after - before) / 1024 / 1024),
  searchP50Ms: Math.round(percentile(0.5) * 100) / 100,
  searchP95Ms: Math.round(percentile(0.95) * 100) / 100,
  searchMaxMs: Math.round(latencies[latencies.length - 1] * 100) / 100,
  averageResults: Math.round((resultCount / QUERIES) * 100) / 100,
}, null, 2));
