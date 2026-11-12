import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Run the shipped component with a small hook scheduler and deferred HTTP.
// This tests response ordering and actual event handlers, without a host session.
async function harness() {
  const hooks = []; let cursor = 0, effects = [], component, api;
  const pending = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial;
      return [hooks[i], (value) => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useEffect(fn, deps) { const i = cursor++, old = hooks[i];
      if (!old || deps.some((value, j) => value !== old.deps[j])) { old?.cleanup?.(); const entry = { deps }; hooks[i] = entry; effects.push(() => { entry.cleanup = fn(); }); } },
    useCallback(fn) { cursor++; return fn; },
  };
  const source = (await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
    .replace('module.exports = { name, inject, apply };', 'module.exports = { name, inject, apply, CrossWorkspaceBar, setManagementToken, notifyStateChanged };');
  const window = { __ModuleLoader__: { load({ factory }) { api = factory(() => react); component = api.CrossWorkspaceBar; } },
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, location: Object.freeze({ origin: 'http://localhost' }) };
  runInNewContext(source, { window, Event: class {}, document: { visibilityState: 'visible' },
    ResizeObserver: class { observe() {} disconnect() {} }, setInterval: () => 1, clearInterval() {},
    fetch: (url, options) => new Promise((resolve) => pending.push({ url, options, resolve: (data) => resolve({ ok: true, status: 200, json: async () => data }) })),
  });
  api.setManagementToken('synthetic-token-at-least-20-chars');
  const render = (id) => { cursor = 0; const tree = component({ sessionId: id }); const next = effects; effects = []; next.forEach((fn) => fn()); return tree; };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { api, pending, render, settle };
}

function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)]; }
function status(enabled = false, selections = []) {
  return { session: { enabled, idHash: 'synthetic' }, scope: { workspaceIds: selections.map((s) => s.workspaceId), selections, tokenBudget: 1200 }, workspaces: [], counts: {}, security: {} };
}

test('switching sessions starts fresh status requests immediately and discards late prior-session responses', async () => {
  const h = await harness();
  h.render('a'); assert(h.pending[0].url.includes('/session/a/status'));
  h.render('b'); assert(h.pending[1].url.includes('/session/b/status'));
  h.pending[1].resolve(status(false)); await h.settle();
  let tree = h.render('b');
  assert.equal(nodes(tree).find((n) => n.props.role === 'switch').props['aria-checked'], false);
  h.pending[0].resolve(status(true)); await h.settle();
  tree = h.render('b');
  assert.equal(nodes(tree).find((n) => n.props.role === 'switch').props['aria-checked'], false);
  assert(h.pending.every((r) => r.options.method === 'GET'));
});

test('a status response started before a scope save cannot undo the saved state; all requests stay in the same conversation', async () => {
  const h = await harness(); h.render('original'); h.pending[0].resolve(status(false)); await h.settle();
  let tree = h.render('original');
  h.api.notifyStateChanged(); assert.equal(h.pending.length, 2);
  nodes(tree).find((n) => n.props.role === 'switch').props.onClick();
  assert.equal(h.pending.length, 3);
  assert(h.pending[2].url.endsWith('/session/original/scope'));
  assert.equal(JSON.parse(h.pending[2].options.body).enabled, true);
  h.pending[2].resolve(status(true)); await h.settle();
  h.pending[1].resolve(status(false)); await h.settle();
  tree = h.render('original');
  assert.equal(nodes(tree).find((n) => n.props.role === 'switch').props['aria-checked'], true);
  assert(h.pending.every((r) => r.url.includes('/session/original/')));
});
