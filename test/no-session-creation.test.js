import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CLIENT = new URL('../lib/client.js', import.meta.url);
const SETTINGS = new URL('../lib/assets/app.js', import.meta.url);

const FORBIDDEN = [
  { label: 'session creation', re: /startSession\s*\(/ },
  { label: 'session fork', re: /forkSession\s*\(|sessions\.fork\s*\(/ },
  { label: 'session open', re: /openSession\s*\(|connectWorkspace\s*\(/ },
  { label: 'session controller', re: /sessionController/ },
  { label: 'message prompt', re: /session\.prompt\s*\(|sessions\.prompt\s*\(/ },
  { label: 'window location assignment', re: /window\.location\s*=|location\.href\s*=/ },
  { label: 'history navigation', re: /history\.pushState\s*\(|history\.replaceState\s*\(/ },
  { label: 'window open', re: /window\.open\s*\(/ },
  { label: 'browser token storage', re: /\blocalStorage\s*\.|\bsessionStorage\s*\.|document\.cookie\s*=/ },
];

test('client and settings UI contain no session creation or navigation calls', async () => {
  for (const url of [CLIENT, SETTINGS]) {
    const source = await readFile(url, 'utf8');
    // Ignore comments; this is a code-path assertion, not a documentation ban.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const rule of FORBIDDEN) {
      assert.equal(rule.re.test(code), false, `${url.pathname} contains forbidden ${rule.label}`);
    }
  }
});

test('composer bar registers in the session-scoped input dock and keeps a settings fallback', async () => {
  const source = await readFile(CLIENT, 'utf8');
  assert(source.includes("conversation.input.dock"), 'composer bar must use conversation.input.dock');
  assert(source.includes("conversation.composer.dock"), 'fallback composer dock must exist');
  assert(source.includes("cwm-main-bar-v2"), 'composer bar id must be namespaced');
  assert(source.includes("const API_ROOT = '/secure-memory/api'"), 'bar must use the local API root');
  assert(source.includes('session/'), 'bar must use local session API paths');
  assert(!source.includes('defaultRetrieval'), 'composer bar must not conflate grant default with session association');
});
