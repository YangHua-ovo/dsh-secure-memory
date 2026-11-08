import { homedir } from 'node:os';
import { join } from 'node:path';
import { SecureMemoryService } from './core/service.js';
import { SecureMemoryStore } from './core/store.js';
import { createRoutes } from './server/routes.js';
import { registerTools } from './tools.js';

const VERSION = '0.0.2';

export const name = 'dsh-secure-memory';
export const inject = ['tools', 'webServer'];

/**
 * Resolve a DSH service through ctx.get so optional dependencies do not keep
 * the plugin pending when a minimal profile lacks them.
 */
function optionalService(ctx, key) {
  try {
    if (typeof ctx.get === 'function') return ctx.get(key);
  } catch { /* optional */ }
  try {
    return ctx[key];
  } catch {
    return undefined;
  }
}

export function apply(ctx) {
  const dataRoot = process.env.DSH_HOME || join(homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE || 'default';
  const store = new SecureMemoryStore({ dataRoot, profile });
  store.initSync();

  const service = new SecureMemoryService({
    store,
    profile,
    getWorkspaceRegistry: () => optionalService(ctx, 'workspaceRegistry'),
    getSessionPersistence: () => optionalService(ctx, 'sessionPersistence'),
  });

  const handler = createRoutes({ service, version: VERSION });

  ctx.effect(() => {
    service.start();
    return () => {
      void service.dispose();
    };
  }, 'dsh-secure-memory: lifecycle');

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/secure-memory',
      handler,
    }),
    'dsh-secure-memory: management route',
  );

  registerTools(ctx, service);

  // Do not log the vault path or any content. The UI shows storage details
  // only after an authenticated unlock.
  console.info(`[dsh-secure-memory] loaded (${store.initialized ? 'vault present, locked' : 'no vault yet'})`);
}
