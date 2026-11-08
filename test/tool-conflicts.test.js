import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTools } from '../lib/tools.js';

function fakeCtx(occupied = []) {
  const registered = [];
  const ctx = {
    tools: {
      get(name) {
        return occupied.includes(name) ? { name } : undefined;
      },
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    effect(callback) {
      const dispose = callback();
      return () => { if (typeof dispose === 'function') dispose(); };
    },
  };
  return { ctx, registered };
}

function fakeService() {
  return {
    toolNames: null,
    conflicts: [],
    async search() { return { status: 'no_results', results: [] }; },
    async context() { return { status: 'no_results', text: '', used: 0 }; },
    async status() { return { locked: true }; },
  };
}

test('tool names remain backward-compatible when free', () => {
  const { ctx, registered } = fakeCtx();
  const service = fakeService();
  registerTools(ctx, service);
  assert.deepEqual(registered.map((tool) => tool.name), ['xw_memory_search', 'xw_memory_context', 'xw_memory_status']);
  assert.deepEqual(service.conflicts, []);
});

test('occupied tool names are namespaced without overwriting another plugin', () => {
  const { ctx, registered } = fakeCtx(['xw_memory_search', 'cwm_memory_search']);
  const service = fakeService();
  registerTools(ctx, service);
  assert.equal(registered[0].name, 'cwm_memory_search_2');
  assert.equal(registered[1].name, 'xw_memory_context');
  assert.equal(registered[2].name, 'xw_memory_status');
  assert.equal(service.toolNames.SEARCH, 'cwm_memory_search_2');
  assert(service.conflicts.some((conflict) => conflict.kind === 'tool-name' && conflict.requested === 'xw_memory_search'));
});
