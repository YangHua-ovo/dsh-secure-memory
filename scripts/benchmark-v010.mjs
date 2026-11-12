/** Deterministic synthetic quality/cost fixture. No user vault or model calls. */
import { performance } from 'node:perf_hooks';
import { LayeredMemoryIndex } from '../lib/core/layers.js';
import { MemoryIndex } from '../lib/core/retrieval.js';
import { makeDocument } from '../lib/core/ingest.js';
import { buildContext, estimateTokens } from '../lib/core/context.js';

const docs = [], queries = [];
for (let i = 0; i < 40; i++) {
  const topic = `project${i}architecture`;
  const add = (kind, content, extra = {}) => docs.push({ ...makeDocument({ workspaceId: i % 2 ? 'selected' : 'hidden',
    sourceSessionId: `s${i}`, sourceRef: `${topic}:${kind}`, sourceKind: 'manual-pack', content, ...extra }), id: `${topic}:${kind}` });
  add('decision', `最终决定 ${topic} 使用官方只读接口并保留授权检查。`, { category: 'decision', status: 'confirmed' });
  add('evidence', `${topic} 早期讨论。` + '讨论多个方案，需要比较可靠性和维护成本。'.repeat(80) + `放弃 ${topic} 内部接口的原因是升级后不稳定。`);
  if (i % 2) {
    queries.push({ query: `${topic} 最终方案`, expected: `${topic}:decision`, key: true });
    queries.push({ query: `为什么放弃 ${topic} 内部接口`, expected: `${topic}:evidence`, key: false });
  }
}
let start = performance.now(); const old = new MemoryIndex(docs); const legacyBuildMs = performance.now() - start;
start = performance.now(); const index = new LayeredMemoryIndex(docs); const buildMs = performance.now() - start;
const latencies = [], contextCounts = [], baselineCounts = [];
let recalled = 0, contextRecalled = 0, keyHits = 0, scoped = 0, returned = 0, duplicate = 0;
for (const fixture of queries) {
  start = performance.now();
  const found = index.search({ query: fixture.query, allowedWorkspaceIds: ['selected'], limit: 4 });
  const built = buildContext({ results: found.results, maxTokens: 1200 });
  latencies.push(performance.now() - start); contextCounts.push(built.metrics.injectedTokens);
  const baseline = old.search({ query: fixture.query, allowedWorkspaceIds: ['selected'], limit: 4 });
  baselineCounts.push(estimateTokens(baseline.results.map((r) => old.docById.get(r.id).content.slice(0, 1600)).join('\n').slice(0, 8000)));
  if (found.results.some((r) => r.id === fixture.expected)) recalled++;
  if (built.selectedIds.includes(fixture.expected)) contextRecalled++;
  if (fixture.key && found.results[0]?.id === fixture.expected && found.results[0].memoryLevel === 'L1') keyHits++;
  returned += found.results.length;
  scoped += found.results.filter((r) => r.workspaceId === 'selected').length;
  duplicate += found.results.length - new Set(found.results.map((r) => r.id)).size;
}
latencies.sort((a, b) => a - b);
const average = (values) => values.reduce((a, b) => a + b, 0) / values.length;
console.log(JSON.stringify({ fixture: '80 synthetic records; 40 labelled queries; no provider call',
  legacyBuildMs, buildMs, p50Ms: latencies[Math.floor(latencies.length * .5)], p95Ms: latencies[Math.floor(latencies.length * .95)],
  recallAt4: recalled / queries.length, keyTop1: keyHits / queries.filter((q) => q.key).length,
  contextRecall: contextRecalled / queries.length,
  scopeCorrectness: scoped / returned, duplicateRatio: duplicate / returned,
  counter: 'utf8-byte-upper-bound (estimate, not actual provider tokens)',
  meanLegacyBodyEstimate: average(baselineCounts), meanInjectedEstimate: average(contextCounts), maxInjectedEstimate: Math.max(...contextCounts),
  actualProviderTokens: null,
}, null, 2));
