/**
 * Local management surface for dsh-secure-memory.
 *
 * Security notes:
 * - The bearer token exists only in this module's memory; it is never written
 *   to localStorage/sessionStorage/cookies or rendered into the DOM.
 * - All server-provided text is rendered through textContent, never innerHTML.
 * - No third-party scripts, fonts, images, analytics, or network calls exist.
 */
'use strict';

const app = document.getElementById('app');
const toastRoot = document.getElementById('toast-root');
const busyEl = document.getElementById('busy');

let token = null;
let state = null;
let currentTab = 'workspaces';
let lastSearch = null;
let searchSelection = new Set();
let searchSelectionTouched = false;
let graphSelection = new Set();
let graphSelectionTouched = false;
let timelineSelection = new Set();
let timelineSelectionTouched = false;
let lastUiActivity = Date.now();
let uiIdleTimer = null;

/** Send the in-memory token to the same-origin composer bar. Never storage. */
function notifyParentToken(value = token) {
  if (window.parent === window) return;
  try {
    window.parent.postMessage({ type: 'cwm-session-token-from-frame', token: value }, window.location.origin);
  } catch { /* parent unavailable */ }
}

const CATEGORY_LABELS = {
  decision: '已确认的最终决策',
  verified: '已验证的技术方案',
  idea: '讨论中的想法',
  tentative: '暂时性结论',
  deprecated: '已废弃的方案',
  unresolved: '尚未解决的问题',
  background: '项目背景信息',
  preference: '用户明确表达的偏好',
};
const STATUS_LABELS = {
  active: '有效（未人工确认）',
  unverified: '未验证',
  confirmed: '已人工确认',
  deprecated: '已废弃',
};
const RISK_LABELS = { low: '低风险', medium: '中风险', high: '高风险' };
const TABS = [
  ['workspaces', '工作区'],
  ['search', '检索'],
  ['graph', '知识图谱'],
  ['timeline', '时间线'],
  ['security', '安全中心'],
];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') node[key] = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  node.replaceChildren();
  return node;
}

function badge(text, tone = '') {
  return el('span', { class: `badge ${tone}`.trim() }, text);
}

function button(text, onClick, { tone = '', small = false, disabled = false, title = '' } = {}) {
  return el('button', {
    type: 'button',
    class: `btn ${tone} ${small ? 'small' : ''}`.trim(),
    disabled,
    title,
    onClick,
  }, text);
}

function field(labelText, control, hint) {
  return el('div', { class: 'field' },
    el('label', {}, labelText),
    control,
    hint ? el('div', { class: 'hint' }, hint) : null,
  );
}

function showToast(message, tone = '') {
  const node = el('div', { class: `toast ${tone}`.trim(), role: 'status' }, message);
  toastRoot.append(node);
  setTimeout(() => { node.remove(); }, 5200);
}

async function withBusy(fn) {
  busyEl.hidden = false;
  try {
    return await fn();
  } finally {
    busyEl.hidden = true;
  }
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function shortId(value, length = 10) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function categoryLabel(value) { return CATEGORY_LABELS[value] ?? value ?? '未知'; }
function statusLabel(value) { return STATUS_LABELS[value] ?? value ?? '未知'; }
function riskTone(value) { return value === 'high' ? 'danger' : value === 'medium' ? 'warn' : 'good'; }

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`./api/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
  });
  let data = {};
  try { data = await response.json(); } catch { /* empty/HTML error */ }
  if (response.status === 401 && token) {
    const message = data?.error?.message || '管理会话已过期，请重新解锁。';
    token = null;
    state = null;
    lastSearch = null;
    notifyParentToken(null);
    renderAuth('unlock', message);
    const error = new Error(message);
    error.code = 'UNAUTHORIZED';
    throw error;
  }
  if (!response.ok) {
    const message = data?.error?.message || `请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.code = data?.error?.code;
    throw error;
  }
  lastUiActivity = Date.now();
  return data;
}

async function fetchBootstrap() {
  const response = await fetch('./api/bootstrap', { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) throw new Error(`无法连接本地插件（HTTP ${response.status}）`);
  return response.json();
}

function showFatal(error) {
  app.className = 'shell auth-shell';
  clear(app).append(
    el('div', { class: 'card auth-card' },
      el('h1', { class: 'auth-title' }, 'Cross-Workspace Memory'),
      el('p', { class: 'auth-sub' }, '本地管理界面加载失败。'),
      el('div', { class: 'callout danger' }, String(error?.message ?? error)),
      el('p', { class: 'hint' }, '请确认 dsh-secure-memory 插件已启用，并刷新页面。'),
    ),
  );
}

async function init() {
  try {
    const bootstrap = await fetchBootstrap();
    if (token) {
      try {
        await loadState();
        return;
      } catch (error) {
        showToast(error.message, 'warn');
      }
    }
    if (bootstrap.setupAllowed) renderAuth('setup');
    else renderAuth('unlock', bootstrap.locked ? '' : '宿主保险库仍处于解锁状态，但此页面没有管理会话。请重新输入口令以建立新的本地管理会话。');
  } catch (error) {
    showFatal(error);
  }
  startHostLockWatch();
}
/**
 * React to a Host-side auto-lock/lock without extending its idle lifetime.
 * This replaces the old iframe-local idle lock, which could lock the shared
 * vault while the user was active in the composer bar.
 */
let hostLockTimer = null;
function startHostLockWatch() {
  if (hostLockTimer) return;
  const check = async () => {
    if (!token && !state) return;
    try {
      const bootstrap = await fetchBootstrap();
      if (bootstrap.locked) {
        token = null;
        state = null;
        lastSearch = null;
        notifyParentToken(null);
        renderAuth('unlock', '宿主保险库已自动锁定。请重新解锁。');
      }
    } catch { /* transient local API failure */ }
  };
  hostLockTimer = setInterval(() => { void check(); }, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
}

function startUiIdleWatch() {
  if (uiIdleTimer) return;
  const touch = () => {
    if (token && state) {
      const minutes = Number(state.autoLockMinutes) || 30;
      if (Date.now() - lastUiActivity > minutes * 60_000) {
        void lockUi('空闲超时，已清除页面中的记忆数据并锁定保险库。');
        return;
      }
    }
    lastUiActivity = Date.now();
  };
  for (const event of ['pointerdown', 'keydown', 'touchstart', 'focus']) {
    window.addEventListener(event, touch, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') touch();
  });
  uiIdleTimer = setInterval(() => {
    if (!token || !state) return;
    const minutes = Number(state.autoLockMinutes) || 30;
    if (Date.now() - lastUiActivity > minutes * 60_000) {
      void lockUi('空闲超时，已清除页面中的记忆数据并锁定保险库。');
    }
  }, 15_000);
}

async function lockUi(reason) {
  if (!token) return;
  try {
    await api('lock', { method: 'POST', body: {} });
  } catch { /* the local lock still clears the page below */ }
  token = null;
  state = null;
  lastSearch = null;
  notifyParentToken(null);
  renderAuth('unlock', reason);
}

function renderAuth(mode, message = '') {
  token = null;
  state = null;
  lastSearch = null;
  app.className = 'shell auth-shell';
  const isSetup = mode === 'setup';
  const errorBox = el('div', { class: 'error-text', role: 'alert' });
  const passphrase = el('input', {
    class: 'input',
    type: 'password',
    autocomplete: isSetup ? 'new-password' : 'current-password',
    placeholder: isSetup ? '至少 12 个字符' : '输入保险库口令',
    required: true,
    minlength: '12',
    maxlength: '1024',
  });
  const confirm = el('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'new-password',
    placeholder: '再次输入口令',
    required: true,
    minlength: '12',
    maxlength: '1024',
  });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, isSetup ? '创建本地保险库并解锁' : '解锁');

  const form = el('form', { class: 'form' },
    field('口令', passphrase, isSetup ? '口令只用于本地 scrypt 派生密钥；不会保存，也不会发送到网络。' : ''),
    isSetup ? field('确认口令', confirm) : null,
    errorBox,
    el('div', { class: 'actions' }, submit),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.textContent = '';
    const value = passphrase.value;
    if (isSetup && value !== confirm.value) {
      errorBox.textContent = '两次输入的口令不一致。';
      return;
    }
    if (Array.from(value).length < 12) {
      errorBox.textContent = '口令至少需要 12 个字符。';
      return;
    }
    await withBusy(async () => {
      try {
        const result = await api(isSetup ? 'setup' : 'unlock', { method: 'POST', body: { passphrase: value } });
        token = result.token;
        notifyParentToken(token);
        passphrase.value = '';
        confirm.value = '';
        await loadState();
        showToast(isSetup ? '本地加密保险库已创建。' : '保险库已解锁。', 'good');
      } catch (error) {
        errorBox.textContent = error.message;
        if (error.code === 'VAULT_EXISTS') {
          setTimeout(() => { void init(); }, 600);
        }
      }
    });
  });

  const cloudNote = el('div', { class: 'callout warn' },
    el('strong', {}, '官方云端连接器不可用。'),
    ' DeepSeek 云聊天没有公开的工作区/历史读取 API。官方支持的手动导出路径是：',
    el('br'),
    el('code', { class: 'inline' }, 'DeepSeek → 头像 → 设置 → 数据管理 → 导出所有历史对话'),
    el('br'),
    '本项目不会绕过此限制。DSH 本地工作区可通过官方本地服务在逐工作区授权后索引；云聊天历史需要手动导入。',
  );

  app.append(
    el('div', { class: 'auth-card' },
      el('div', { class: 'auth-brand' },
        el('img', { src: './icon.svg', alt: '' }),
        el('div', {},
          el('div', { class: 'brand-title' }, 'Cross-Workspace Memory'),
          el('div', { class: 'brand-sub' }, '跨工作区记忆 · 本地加密 · 逐工作区授权 · 默认拒绝'),
        ),
      ),
      el('div', { class: 'card' },
        el('h1', { class: 'auth-title' }, isSetup ? '建立本地加密保险库' : '解锁本地加密保险库'),
        el('p', { class: 'auth-sub' }, isSetup
          ? '这是本机上的第一个记忆保险库。它的密钥只存在于 DSH 进程内存中。'
          : '保险库已存在。输入口令后，才能查看授权和检索跨工作区记忆。'),
        message ? el('div', { class: 'callout' }, message) : null,
        el('div', { class: 'callout warn' },
          el('strong', {}, isSetup ? '口令丢失不可恢复。' : '安全提示。'),
          isSetup
            ? ' 没有后门、没有找回流程。请把口令保存在可信的密码管理器中。'
            : ' 解锁后，AI 只能通过三个只读 Tool 检索你已授权的工作区；AI 不能授权、撤销或删除。',
        ),
        cloudNote,
        form,
      ),
      el('p', { class: 'auth-foot' }, '仅本地回环访问 · AES-256-GCM · scrypt · 无第三方 Embedding · 无云端向量库'),
    ),
  );
}

async function loadState() {
  state = await api('state');
  reconcileSelections();
  renderShell();
}

function activeWorkspaces() {
  return (state?.workspaces ?? []).filter((workspace) => workspace.grant?.active);
}

function activeIds() {
  return activeWorkspaces().map((workspace) => workspace.id);
}

function reconcileSelections() {
  const ids = new Set(activeIds());
  if (!searchSelectionTouched) searchSelection = new Set(ids);
  else searchSelection = new Set([...searchSelection].filter((id) => ids.has(id)));
  if (!graphSelectionTouched) graphSelection = new Set(ids);
  else graphSelection = new Set([...graphSelection].filter((id) => ids.has(id)));
  if (!timelineSelectionTouched) timelineSelection = new Set(ids);
  else timelineSelection = new Set([...timelineSelection].filter((id) => ids.has(id)));
}

function renderShell() {
  if (!state) { renderAuth('unlock'); return; }
  app.className = 'shell';
  const view = el('div', { class: 'view' });
  const tabs = el('nav', { class: 'tabs', 'aria-label': '功能分区' },
    TABS.map(([key, label]) => el('button', {
      type: 'button',
      class: `tab ${currentTab === key ? 'active' : ''}`,
      'aria-current': currentTab === key ? 'page' : null,
      onClick: () => { currentTab = key; renderShell(); },
    }, label)),
  );
  const auditTone = state.audit?.intact ? 'good' : 'danger';
  const header = el('header', { class: 'app-header' },
    el('div', { class: 'brand' },
      el('img', { src: './icon.svg', alt: '' }),
      el('div', {},
        el('div', { class: 'brand-title' }, 'Cross-Workspace Memory'),
        el('div', { class: 'brand-sub' }, '跨工作区记忆 · 本地加密 · 来源可追溯'),
      ),
    ),
    el('div', { class: 'header-actions' },
      el('span', { class: 'pill' }, el('span', { class: 'dot good' }), '已解锁'),
      el('span', { class: 'pill' }, el('span', { class: `dot ${auditTone}` }), state.audit?.intact ? '审计链完整' : '审计链异常'),
      el('span', { class: 'pill' }, `已授权 ${activeWorkspaces().length} / ${state.workspaces.length}`),
      button('刷新', () => withBusy(async () => { await loadState(); showToast('状态已刷新。', 'good'); }), { small: true }),
      button('锁定', async () => {
        await withBusy(async () => {
          try {
            await api('lock', { method: 'POST', body: {} });
            token = null;
            state = null;
            notifyParentToken(null);
            renderAuth('unlock', '保险库已锁定。所有管理令牌已失效。');
            showToast('已锁定并清除内存密钥。', 'good');
          } catch (error) { showToast(error.message, 'danger'); }
        });
      }, { small: true, tone: 'ghost' }),
    ),
  );

  app.append(header, tabs, view);
  renderTab(view);
}

function renderTab(view) {
  clear(view);
  if (currentTab === 'workspaces') renderWorkspaces(view);
  else if (currentTab === 'search') renderSearch(view);
  else if (currentTab === 'graph') renderGraph(view);
  else if (currentTab === 'timeline') renderTimeline(view);
  else renderSecurity(view);
}

function viewHead(title, description, actions = null) {
  return el('div', { class: 'view-head' },
    el('div', {},
      el('h2', { class: 'view-title' }, title),
      description ? el('p', { class: 'view-desc' }, description) : null,
    ),
    actions,
  );
}

/* ------------------------------- Workspaces ------------------------------- */

function renderWorkspaces(view) {
  const filterInput = el('input', { class: 'input', type: 'search', placeholder: '搜索工作区名称或路径', maxlength: '200' });
  const grid = el('div', { class: 'grid' });
  const all = state.workspaces.slice().sort((a, b) => {
    const score = (ws) => (ws.live ? 0 : 4) + (ws.grant?.active ? 0 : 2) + (ws.kind === 'manual-import' ? 1 : 0);
    return score(a) - score(b) || String(a.title).localeCompare(String(b.title), 'zh-CN');
  });
  const draw = () => {
    clear(grid);
    const query = filterInput.value.trim().toLowerCase();
    const items = all.filter((workspace) => {
      if (!query) return true;
      return `${workspace.title} ${workspace.path ?? ''} ${workspace.description ?? ''}`.toLowerCase().includes(query);
    });
    if (items.length === 0) {
      grid.append(el('div', { class: 'empty' }, el('strong', {}, '没有匹配的工作区'), '清除筛选或等待 DSH 工作区出现。'));
      return;
    }
    for (const workspace of items) grid.append(workspaceCard(workspace));
  };
  filterInput.addEventListener('input', draw);
  draw();

  const importPanel = importCard();

  view.append(
    viewHead('工作区授权', '每个工作区独立授权。未授权、暂停或过期的工作区不会进入检索候选集。DSH 本地工作区通过官方本地服务读取；云聊天历史只能手动导入。'),
    el('div', { class: 'callout warn' },
      el('strong', {}, '能力边界：'),
      state.officialCloud?.reason,
      el('br'),
      `官方手动导出路径：${state.officialCloud?.exportPath ?? '设置 → 数据管理 → 导出所有历史对话'}`,
    ),
    el('div', { class: 'inline' }, filterInput,
      el('span', { class: 'hint' }, '工作区列表来自 DSH workspaceRegistry（本地目录），不代表 DeepSeek 云端工作区。'),
    ),
    grid,
    importPanel,
  );
}

function workspaceStatusBadges(workspace) {
  const badges = [];
  badges.push(badge(workspace.kind === 'manual-import' ? '手动导入源' : 'DSH 本地工作区', workspace.kind === 'manual-import' ? 'violet' : 'info'));
  if (workspace.live === false) badges.push(badge('DSH 目录缺失', 'danger'));
  if (!workspace.grant) badges.push(badge('未授权', 'warn'));
  else if (workspace.grant.paused) badges.push(badge('已暂停', 'warn'));
  else if (workspace.grant.expired) badges.push(badge('已过期', 'danger'));
  else if (workspace.grant.mode === 'long-term') badges.push(badge('长期授权', 'good'));
  else badges.push(badge('临时授权', 'info'));
  if (workspace.grant?.defaultRetrieval && workspace.grant?.active) badges.push(badge('默认检索', 'good'));
  if (workspace.kind === 'manual-import') badges.push(badge('手动快照', 'violet'));
  return badges;
}

function workspaceCard(workspace) {
  const card = el('article', { class: 'card' });
  const title = el('div', { class: 'card-head' },
    el('div', {},
      el('div', { class: 'card-title' }, workspace.title),
      el('div', { class: 'card-sub' }, workspace.description || '（无描述）'),
    ),
    el('div', { class: 'inline' }, workspaceStatusBadges(workspace)),
  );
  const meta = el('div', { class: 'meta-row' },
    el('span', {}, '会话 ', el('b', {}, String(workspace.sessionCount ?? 0))),
    el('span', {}, '已索引 ', el('b', {}, String(workspace.documents ?? 0)), ' 条'),
    el('span', {}, '最近同步 ', el('b', {}, fmtDate(workspace.lastSyncAt))),
    workspace.grant?.expiresAt ? el('span', {}, '到期 ', el('b', {}, fmtDate(workspace.grant.expiresAt))) : null,
  );
  const path = workspace.path ? el('div', { class: 'source-line mono' }, workspace.path) : null;
  const actions = el('div', { class: 'actions' });

  if (!workspace.grant) {
    const duration = el('select', { class: 'input', 'aria-label': '授权时长' },
      el('option', { value: '3600000' }, '1 小时'),
      el('option', { value: '86400000' }, '24 小时'),
      el('option', { value: '604800000', selected: true }, '7 天'),
      el('option', { value: '2592000000' }, '30 天'),
      el('option', { value: 'long' }, '长期（直到撤销）'),
    );
    const authorize = async (sync) => withBusy(async () => {
      const selected = duration.value;
      try {
        await api(`workspaces/${encodeURIComponent(workspace.id)}/authorize`, {
          method: 'POST',
          body: {
            mode: selected === 'long' ? 'long-term' : 'temporary',
            ttlMs: selected === 'long' ? undefined : Number(selected),
            defaultRetrieval: true,
            sync,
          },
        });
        await loadState();
        showToast(sync ? '已授权并完成本地索引。' : '已授权；尚未同步索引。', 'good');
      } catch (error) { showToast(error.message, 'danger'); }
    });
    actions.append(
      duration,
      workspace.live && workspace.kind === 'dsh-local' ? button('授权并索引', () => authorize(true), { tone: 'primary' }) : null,
      button(workspace.live && workspace.kind === 'dsh-local' ? '仅授权' : '授权', () => authorize(false)),
    );
  } else {
    const defaultToggle = el('label', { class: 'chip' },
      el('input', {
        type: 'checkbox',
        checked: Boolean(workspace.grant.defaultRetrieval),
        onChange: async (event) => {
          const enabled = event.target.checked;
          await withBusy(async () => {
            try {
              await api(`workspaces/${encodeURIComponent(workspace.id)}/default`, { method: 'POST', body: { enabled } });
              await loadState();
              showToast(enabled ? '已加入默认检索范围。' : '已从默认检索范围移除。', 'good');
            } catch (error) { showToast(error.message, 'danger'); }
          });
        },
      }),
      '参与默认检索',
    );
    actions.append(defaultToggle);
    if (workspace.live && workspace.kind === 'dsh-local') {
      actions.append(button('同步索引', async () => {
        await withBusy(async () => {
          try {
            const result = await api(`workspaces/${encodeURIComponent(workspace.id)}/sync`, { method: 'POST', body: {} });
            await loadState();
            const warning = result.warnings?.length ? `；${result.warnings.length} 条警告` : '';
            showToast(`同步完成：${result.indexedDocuments} 条文档${warning}。`, result.warnings?.length ? 'warn' : 'good');
          } catch (error) { showToast(error.message, 'danger'); }
        });
      }, { small: true }));
    }
    actions.append(
      button(workspace.grant.paused ? '恢复访问' : '暂停访问', async () => {
        await withBusy(async () => {
          try {
            await api(`workspaces/${encodeURIComponent(workspace.id)}/pause`, { method: 'POST', body: { paused: !workspace.grant.paused } });
            await loadState();
            showToast(workspace.grant.paused ? '已恢复授权。' : '已暂停；索引仍加密保留，但检索拒绝。', 'good');
          } catch (error) { showToast(error.message, 'danger'); }
        });
      }, { small: true }),
      button('撤销并删除索引', async () => {
        if (!window.confirm(`撤销“${workspace.title}”的授权，并立即删除其本地索引？`)) return;
        await withBusy(async () => {
          try {
            const result = await api(`workspaces/${encodeURIComponent(workspace.id)}/revoke`, { method: 'POST', body: {} });
            await loadState();
            showToast(`授权已撤销，删除 ${result.purgedDocuments} 条本地文档。`, 'good');
          } catch (error) { showToast(error.message, 'danger'); }
        });
      }, { small: true, tone: 'danger' }),
    );
  }

  card.append(title, meta);
  if (path) card.append(path);
  card.append(actions);
  return card;
}

function importCard() {
  const file = el('input', {
    class: 'input',
    type: 'file',
    accept: '.json,.md,.markdown,.txt,application/json,text/markdown,text/plain',
  });
  const fileName = el('span', { class: 'hint' }, '未选择文件');
  file.addEventListener('change', () => {
    fileName.textContent = file.files?.[0]?.name ?? '未选择文件';
  });
  const title = el('input', { class: 'input', type: 'text', placeholder: '可选：工作区名称', maxlength: '200' });
  const mode = el('select', { class: 'input' },
    el('option', { value: 'long-term' }, '长期授权（直到撤销）'),
    el('option', { value: 'temporary' }, '临时授权（24 小时）'),
  );
  const error = el('div', { class: 'error-text', role: 'alert' });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, '导入并授权');
  const form = el('form', { class: 'form' },
    el('div', { class: 'form-row' },
      field('文件（JSON / Markdown，≤ 8 MB）', file, '支持规范化记忆包、常见 conversations JSON、Markdown。不支持 ZIP。'),
      field('可选工作区名称', title),
      field('授权模式', mode),
    ),
    fileName,
    error,
    el('div', { class: 'actions' }, submit),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const selected = file.files?.[0];
    if (!selected) { error.textContent = '请选择文件。'; return; }
    if (selected.size > 8 * 1024 * 1024) { error.textContent = '文件超过 8 MB 上限。'; return; }
    await withBusy(async () => {
      try {
        const content = await selected.text();
        const result = await api('import', {
          method: 'POST',
          body: {
            filename: selected.name,
            content,
            title: title.value.trim() || undefined,
            mode: mode.value,
            ttlMs: mode.value === 'temporary' ? 86_400_000 : undefined,
          },
        });
        await loadState();
        showToast(`手动快照已导入：${result.documents} 条文档。`, 'good');
      } catch (err) { error.textContent = err.message; }
    });
  });
  return el('details', { class: 'card flat' },
    el('summary', {}, '手动导入 DeepSeek 导出 / 记忆包 / Markdown（明确标记为手动快照）'),
    el('div', { class: 'callout warn' },
      el('strong', {}, '这不是自动跨工作区读取。'),
      ' 导入的文件只在本机解析并加密存储；请先使用官方“导出所有历史对话”，不要把账号 Cookie 或令牌交给任何工具。',
    ),
    form,
  );
}

/* -------------------------------- Search --------------------------------- */

function renderSearch(view) {
  const active = activeWorkspaces();
  if (active.length === 0) {
    view.append(
      viewHead('跨工作区检索', '先在工作区页授权至少一个工作区；未授权工作区不会出现在候选集中。'),
      el('div', { class: 'empty' }, el('strong', {}, '当前没有已授权工作区'), 'AI 和手动检索都无法访问未授权内容。'),
    );
    return;
  }
  const chips = el('div', { class: 'chip-list' });
  const results = el('div', { class: 'stack' });
  const query = el('input', { class: 'input', type: 'search', placeholder: '例如：之前讨论过如何设计多 Agent 协作架构吗？', maxlength: '500', required: true });
  const mode = el('select', { class: 'input' },
    el('option', { value: 'hybrid' }, '混合（BM25 + 本地字符向量）'),
    el('option', { value: 'keyword' }, '关键词（BM25）'),
    el('option', { value: 'vector' }, '本地字符向量'),
  );
  const from = el('input', { class: 'input', type: 'date' });
  const to = el('input', { class: 'input', type: 'date' });
  const category = el('select', { class: 'input' },
    el('option', { value: '' }, '全部分类'),
    Object.entries(CATEGORY_LABELS).map(([key, label]) => el('option', { value: key }, label)),
  );
  const error = el('div', { class: 'error-text', role: 'alert' });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, '检索已授权记忆');
  const form = el('form', { class: 'form' },
    field('自然语言查询', query),
    el('div', { class: 'form-row' },
      field('检索方式', mode),
      field('起始日期（可选）', from),
      field('结束日期（可选）', to),
      field('分类（可选）', category),
    ),
    error,
    el('div', { class: 'actions' }, submit),
  );

  const renderChips = () => {
    clear(chips);
    for (const workspace of active) {
      const checked = searchSelection.has(workspace.id);
      const chip = el('label', { class: `chip ${checked ? 'checked' : ''}` },
        el('input', {
          type: 'checkbox',
          checked,
          onChange: (event) => {
            searchSelectionTouched = true;
            if (event.target.checked) searchSelection.add(workspace.id);
            else searchSelection.delete(workspace.id);
            chip.classList.toggle('checked', event.target.checked);
          },
        }),
        workspace.title,
      );
      chips.append(chip);
    }
  };
  renderChips();

  const selectAll = button('全选', () => {
    searchSelectionTouched = true;
    searchSelection = new Set(active.map((workspace) => workspace.id));
    renderChips();
  }, { small: true, tone: 'ghost' });
  const clearAll = button('取消全选', () => {
    searchSelectionTouched = true;
    searchSelection = new Set();
    renderChips();
  }, { small: true, tone: 'ghost' });

  const run = async (event) => {
    event.preventDefault();
    error.textContent = '';
    const text = query.value.trim();
    if (!text) { error.textContent = '请输入查询。'; return; }
    if (searchSelection.size === 0) { error.textContent = '请至少选择一个已授权工作区。'; return; }
    const args = {
      query: text,
      workspaceIds: [...searchSelection],
      includeNonDefault: true,
      mode: mode.value,
      filters: {},
      limit: 8,
    };
    if (from.value) args.filters.from = from.value;
    if (to.value) args.filters.to = `${to.value}T23:59:59`;
    if (category.value) args.filters.categories = [category.value];
    await withBusy(async () => {
      try {
        const result = await api('search', { method: 'POST', body: args });
        lastSearch = { args, result };
        renderSearchResults(results, args, result, contextPanel);
      } catch (err) {
        error.textContent = err.message;
      }
    });
  };
  form.addEventListener('submit', run);

  const contextPanel = el('div', { class: 'context-panel' });
  view.append(
    viewHead('跨工作区检索', '只检索当前有效授权范围。结果包含来源、时间、分类、状态和启发式可信度提示；冲突不会自动裁决。'),
    el('div', { class: 'callout' },
      el('strong', {}, '检索边界：'),
      ' 授权只在本地生效；AI 的自动检索使用“参与默认检索”的工作区。任何未授权 ID 都会被后端拒绝，而不是被前端隐藏。',
    ),
    el('div', { class: 'card flat' },
      el('div', { class: 'inline' }, el('span', { class: 'hint' }, '授权范围：'), selectAll, clearAll),
      chips,
    ),
    el('div', { class: 'card' }, form),
    contextPanel,
    results,
  );

  if (lastSearch) {
    renderSearchResults(results, lastSearch.args, lastSearch.result, contextPanel);
  }
}

function renderSearchResults(container, args, result, contextPanel = null) {
  clear(container);
  if (result.status === 'denied') {
    container.append(
      el('div', { class: 'callout danger' },
        el('strong', {}, '检索被拒绝。'),
        result.reason === 'UNAUTHORIZED_WORKSPACE'
          ? ` 请求包含未授权/暂停/过期的工作区：${(result.denied ?? []).join('、')}`
          : ' 当前没有已授权且参与默认检索的工作区。',
        el('br'),
        '后端在检索前拒绝了请求；没有读取或返回未授权内容。',
      ),
    );
    return;
  }
  const summary = el('div', { class: 'meta-row' },
    el('span', {}, '查询 ', el('b', {}, shortId(result.queryHash, 12))),
    el('span', {}, '候选 ', el('b', {}, String(result.candidateCount ?? 0))),
    el('span', {}, '结果 ', el('b', {}, String(result.results?.length ?? 0))),
    el('span', {}, '模式 ', el('b', {}, result.scoreMode ?? args.mode)),
  );
  container.append(
    el('div', { class: 'card flat' },
      el('div', { class: 'card-head' },
        el('div', {},
          el('div', { class: 'card-title' }, result.status === 'no_results' ? '没有匹配结果' : `检索结果 ${result.results.length} 条`),
          el('div', { class: 'card-sub' }, '查询正文不写入审计；审计只记录哈希、范围、结果数和来源标识。'),
        ),
        button('生成 AI 上下文', () => renderContextPanel(contextPanel ?? container, args), { tone: 'primary', small: true }),
      ),
      summary,
    ),
  );
  if (result.blockedByTerms > 0) {
    container.append(el('div', { class: 'callout warn' }, `${result.blockedByTerms} 条文档因命中“禁止检索内容”规则被排除。`));
  }
  if ((result.conflicts ?? []).length > 0) {
    const conflictBox = el('div', { class: 'callout warn' }, el('strong', {}, '检测到潜在冲突（未自动裁决）：'));
    for (const conflict of result.conflicts) {
      conflictBox.append(el('div', { class: 'small' },
        `主题「${conflict.topic}」：`,
        conflict.docs.map((doc) => `${workspaceTitle(doc.workspaceId)} / ${fmtDate(doc.createdAt)}`).join(' ↔ '),
        '。请由用户或项目负责人确认。',
      ));
    }
    container.append(conflictBox);
  }
  if (!result.results || result.results.length === 0) {
    container.append(el('div', { class: 'empty' }, el('strong', {}, '没有结果'), '尝试更宽泛的关键词、扩大授权范围或同步最新工作区。'));
    return;
  }
  const grid = el('div', { class: 'grid' });
  for (const item of result.results) grid.append(searchResultCard(item));
  container.append(grid);
}

function searchResultCard(item) {
  const badges = el('div', { class: 'inline' },
    badge(categoryLabel(item.category), 'info'),
    badge(statusLabel(item.status)),
    badge(RISK_LABELS[item.risk] ?? item.risk, riskTone(item.risk)),
    item.potentialConflict || (item.conflictIds ?? []).length > 0 ? badge('潜在冲突', 'warn') : null,
    item.duplicateCount > 1 ? badge(`近似重复 ×${item.duplicateCount}`) : null,
  );
  const score = item.confidence?.score ?? 0;
  const progress = el('progress', { max: '1', value: String(score) });
  const details = el('details', {},
    el('summary', {}, '可信度构成（启发式，不是事实保证）'),
    el('ul', { class: 'factor-list' }, (item.confidence?.factors ?? []).map((factor) => el('li', {}, factor))),
    item.confidence?.disclaimer ? el('p', { class: 'hint' }, item.confidence.disclaimer) : null,
  );
  const actions = el('div', { class: 'actions' },
    button('标记确认', () => markMemory(item.id, { status: 'confirmed' }), { small: true }),
    button('标记废弃', () => markMemory(item.id, { status: 'deprecated', category: 'deprecated' }), { small: true }),
    button('排除此条', () => markMemory(item.id, { excluded: true }), { small: true, tone: 'danger' }),
    item.sourceSessionId ? button('排除此会话', () => excludeSession(item.sourceSessionId, true), { small: true, tone: 'danger' }) : null,
    item.sourceName && item.sourceKind !== 'dsh-session' ? button('排除来源文件', () => excludeSource(item.sourceName, true), { small: true, tone: 'danger' }) : null,
  );
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('div', { class: 'card-title' }, item.title || '未命名记忆'),
        el('div', { class: 'card-sub' }, `${workspaceTitle(item.workspaceId)} · ${fmtDate(item.createdAt)} · ${item.role}`),
      ),
      badges,
    ),
    item.quarantined
      ? el('div', { class: 'callout danger' }, '高风险：该片段可能包含提示词注入或被隔离的指令，不会进入 AI 上下文；请人工查看原始来源。')
      : el('pre', { class: 'snippet' }, item.snippet || '（无摘要）'),
    el('div', { class: 'progress-row' },
      progress,
      el('span', { class: 'small' }, `${item.confidence?.label ?? '—'} ${score.toFixed(2)}`),
      item.time?.stale ? badge('可能过期', 'warn') : null,
    ),
    details,
    el('div', { class: 'source-line' }, `来源：${item.sourceRef ?? '—'}`),
    item.sourceSessionId ? el('div', { class: 'source-line' }, `会话：${item.sourceSessionId}${item.sourceSeq !== null && item.sourceSeq !== undefined ? ` · 事件 #${item.sourceSeq}` : ''}`) : null,
    actions,
  );
}

function renderContextPanel(container, args) {
  if (!container) return;
  clear(container);
  const output = el('pre', { class: 'context-block' }, '正在生成…');
  const copy = button('复制', async () => {
    try {
      await navigator.clipboard.writeText(output.textContent);
      showToast('上下文已复制到剪贴板。', 'good');
    } catch {
      showToast('剪贴板不可用；请手动选择文本。', 'warn');
    }
  }, { small: true });
  container.append(el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('div', { class: 'card-title' }, 'AI 参考上下文预览'),
        el('div', { class: 'card-sub' }, '片段会进入当前模型上下文；未授权内容不会出现。高风险片段会被隔离。'),
      ),
      copy,
    ),
    output,
  ));
  withBusy(async () => {
    try {
      const result = await api('context', { method: 'POST', body: args });
      output.textContent = result.text || result.message || '没有可放入上下文的内容。';
      if (result.quarantined > 0) copy.after(el('div', { class: 'callout warn' }, `${result.quarantined} 条高风险片段被隔离，未放入上下文。`));
    } catch (error) {
      output.textContent = `上下文生成失败：${error.message}`;
    }
  });
}

async function markMemory(docId, patch) {
  await withBusy(async () => {
    try {
      await api(`memory/${encodeURIComponent(docId)}/mark`, { method: 'POST', body: patch });
      showToast('记忆状态已更新。', 'good');
      if (lastSearch) {
        const result = await api('search', { method: 'POST', body: lastSearch.args });
        lastSearch.result = result;
        renderShell();
      } else {
        await loadState();
      }
    } catch (error) { showToast(error.message, 'danger'); }
  });
}

async function excludeSession(sourceSessionId, excluded) {
  await withBusy(async () => {
    try {
      await api(`sessions/${encodeURIComponent(sourceSessionId)}/exclude`, {
        method: 'POST',
        body: { excluded, reason: 'user-ui' },
      });
      showToast(excluded ? '该会话已从检索中排除。' : '该会话已恢复检索。', 'good');
      if (lastSearch) {
        const result = await api('search', { method: 'POST', body: lastSearch.args });
        lastSearch.result = result;
        renderShell();
      } else {
        await loadState();
      }
    } catch (error) { showToast(error.message, 'danger'); }
  });
}

async function excludeSource(sourceName, excluded) {
  await withBusy(async () => {
    try {
      await api('sources/exclude', {
        method: 'POST',
        body: { sourceName, excluded, reason: 'user-ui' },
      });
      showToast(excluded ? '该来源文件已从检索中排除。' : '该来源文件已恢复检索。', 'good');
      if (lastSearch) {
        const result = await api('search', { method: 'POST', body: lastSearch.args });
        lastSearch.result = result;
        renderShell();
      } else {
        await loadState();
      }
    } catch (error) { showToast(error.message, 'danger'); }
  });
}

function workspaceTitle(id) {
  return state.workspaces.find((workspace) => workspace.id === id)?.title ?? shortId(id, 12);
}

/* --------------------------------- Graph ---------------------------------- */

function renderGraph(view) {
  const active = activeWorkspaces();
  if (active.length === 0) {
    view.append(viewHead('知识图谱', '只显示当前已授权工作区的主题关联。'), el('div', { class: 'empty' }, el('strong', {}, '没有已授权工作区'), '授权后可查看跨工作区主题关联。'));
    return;
  }
  const chips = el('div', { class: 'chip-list' });
  const output = el('div');
  const refresh = async () => {
    clear(output).append(el('div', { class: 'empty' }, '正在读取已授权图谱…'));
    await withBusy(async () => {
      try {
        const ids = [...graphSelection];
        const graph = await api(`graph?workspaceIds=${encodeURIComponent(ids.join(','))}`);
        clear(output).append(renderGraphBody(graph));
      } catch (error) {
        clear(output).append(el('div', { class: 'callout danger' }, error.message));
      }
    });
  };
  const renderChips = () => {
    clear(chips);
    for (const workspace of active) {
      const checked = graphSelection.has(workspace.id);
      const chip = el('label', { class: `chip ${checked ? 'checked' : ''}` },
        el('input', {
          type: 'checkbox', checked,
          onChange: (event) => {
            graphSelectionTouched = true;
            if (event.target.checked) graphSelection.add(workspace.id);
            else graphSelection.delete(workspace.id);
            chip.classList.toggle('checked', event.target.checked);
            refresh();
          },
        }),
        workspace.title,
      );
      chips.append(chip);
    }
  };
  renderChips();
  view.append(
    viewHead('知识图谱', '基于共同主题标签与分类的本地共现关系；不是因果推理，也不会跨授权边界。', button('刷新', refresh, { small: true })),
    el('div', { class: 'callout' }, '节点只包含工作区、分类和主题标签；不包含正文。每个节点仍受工作区授权约束。'),
    el('div', { class: 'inline' }, el('span', { class: 'hint' }, '授权范围：'), chips),
    output,
  );
  refresh();
}

function renderGraphBody(graph) {
  const wrap = el('div', { class: 'graph-shell' });
  if (!graph.nodes || graph.nodes.length === 0) {
    wrap.append(el('div', { class: 'empty' }, el('strong', {}, '没有可绘制的节点'), '同步工作区后重试。'));
    return wrap;
  }
  const byKind = {
    workspace: graph.nodes.filter((node) => node.kind === 'workspace'),
    category: graph.nodes.filter((node) => node.kind === 'category'),
    topic: graph.nodes.filter((node) => node.kind === 'topic'),
  };
  const maxCount = Math.max(byKind.workspace.length, byKind.category.length, byKind.topic.length, 1);
  const height = Math.max(380, 80 + maxCount * 38);
  const width = 1000;
  const xFor = { workspace: 210, category: 500, topic: 790 };
  const positions = new Map();
  for (const kind of Object.keys(byKind)) {
    const list = byKind[kind];
    const gap = list.length > 1 ? (height - 120) / (list.length - 1) : 0;
    list.forEach((node, index) => {
      const y = list.length === 1 ? height / 2 : 60 + index * gap;
      positions.set(node.id, { x: xFor[kind], y, node });
    });
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'graph-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '跨工作区知识关联图');
  for (const edge of graph.edges) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('class', `edge ${edge.kind === 'has-topic' ? 'has-topic' : ''}`);
    svg.append(line);
  }
  for (const [id, position] of positions) {
    const { node } = position;
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', position.x);
    circle.setAttribute('cy', position.y);
    circle.setAttribute('r', node.kind === 'workspace' ? '7' : node.kind === 'category' ? '5.5' : '4.5');
    circle.setAttribute('class', `node-${node.kind}`);
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${node.label}${node.count !== undefined ? ` · ${node.count}` : ''}`;
    circle.append(title);
    group.append(circle);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.textContent = node.label.length > 22 ? `${node.label.slice(0, 22)}…` : node.label;
    if (node.kind === 'workspace') {
      text.setAttribute('x', String(position.x - 14));
      text.setAttribute('y', String(position.y + 4));
      text.setAttribute('text-anchor', 'end');
      text.setAttribute('class', 'workspace-label');
    } else if (node.kind === 'category') {
      text.setAttribute('x', String(position.x));
      text.setAttribute('y', String(position.y - 14));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('class', 'category-label');
    } else {
      text.setAttribute('x', String(position.x + 14));
      text.setAttribute('y', String(position.y + 4));
      text.setAttribute('text-anchor', 'start');
    }
    group.append(text);
    if (node.kind !== 'workspace' && node.count) {
      const count = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      count.textContent = String(node.count);
      count.setAttribute('x', String(position.x + (node.kind === 'topic' ? 14 : 0)));
      count.setAttribute('y', String(position.y + (node.kind === 'topic' ? 18 : -26)));
      count.setAttribute('text-anchor', node.kind === 'topic' ? 'start' : 'middle');
      count.setAttribute('class', 'node-count');
      group.append(count);
    }
    svg.append(group);
  }
  const scroll = el('div', { class: 'graph-scroll' });
  scroll.append(svg);
  wrap.append(scroll);
  wrap.append(el('div', { class: 'legend' },
    el('span', {}, el('i', { class: 'ws' }), '工作区'),
    el('span', {}, el('i', { class: 'cat' }), '记忆分类'),
    el('span', {}, el('i', { class: 'topic' }), '共同主题'),
    el('span', { class: 'faint' }, graph.summary?.note ?? ''),
  ));
  const summary = el('div', { class: 'stack' },
    el('div', { class: 'meta-row' },
      el('span', {}, '已授权工作区 ', el('b', {}, String(graph.summary?.authorizedWorkspaces ?? 0))),
      el('span', {}, '文档 ', el('b', {}, String(graph.summary?.documents ?? 0))),
      el('span', {}, '主题 ', el('b', {}, String(graph.summary?.topics ?? 0))),
    ),
  );
  if ((graph.summary?.crossWorkspaceTopics ?? []).length > 0) {
    summary.append(el('div', { class: 'callout good' },
      el('strong', {}, '跨工作区共同主题：'),
      graph.summary.crossWorkspaceTopics.map((topic) => topic.tag).join('、'),
    ));
  }
  const shell = el('div', { class: 'stack' });
  shell.append(summary, wrap);
  return shell;
}

/* -------------------------------- Timeline -------------------------------- */

function renderTimeline(view) {
  const active = activeWorkspaces();
  if (active.length === 0) {
    view.append(viewHead('记忆时间线', '只显示已授权工作区的记忆。'), el('div', { class: 'empty' }, el('strong', {}, '没有已授权工作区'), '授权后可查看时间线。'));
    return;
  }
  const chips = el('div', { class: 'chip-list' });
  const output = el('div');
  let cached = null;
  const category = el('select', { class: 'input' },
    el('option', { value: '' }, '全部分类'),
    Object.entries(CATEGORY_LABELS).map(([key, label]) => el('option', { value: key }, label)),
  );
  const status = el('select', { class: 'input' },
    el('option', { value: '' }, '全部状态'),
    Object.entries(STATUS_LABELS).map(([key, label]) => el('option', { value: key }, label)),
  );
  const draw = () => {
    if (!cached) return;
    clear(output);
    const items = cached.items.filter((item) => (!category.value || item.category === category.value) && (!status.value || item.status === status.value));
    if (items.length === 0) {
      output.append(el('div', { class: 'empty' }, '没有符合筛选条件的记忆。'));
      return;
    }
    const timeline = el('div', { class: 'timeline' });
    for (const item of items) {
      const tone = item.potentialConflict ? 'conflict' : item.stale ? 'stale' : '';
      timeline.append(el('article', { class: `timeline-item ${tone}` },
        el('div', { class: 'card flat' },
          el('div', { class: 'card-head' },
            el('div', {},
              el('div', { class: 'card-title' }, item.title),
              el('div', { class: 'card-sub' }, `${workspaceTitle(item.workspaceId)} · ${fmtDate(item.createdAt)} · ${item.role}`),
            ),
            el('div', { class: 'inline' },
              badge(categoryLabel(item.category), 'info'),
              badge(statusLabel(item.status)),
              item.stale ? badge('可能过期', 'warn') : null,
              item.potentialConflict ? badge('潜在冲突', 'warn') : null,
              item.excluded ? badge('已排除', 'danger') : null,
            ),
          ),
          el('div', { class: 'meta-row' },
            el('span', {}, '可信度 ', el('b', {}, item.confidence?.label ?? '—')),
            el('span', {}, '最近确认 ', el('b', {}, fmtDate(item.lastConfirmedAt))),
            el('span', {}, '导入 ', el('b', {}, fmtDate(item.importedAt))),
          ),
          (item.tags ?? []).length ? el('div', { class: 'source-line' }, `主题：${item.tags.filter((tag) => !tag.startsWith('category:')).join('、')}`) : null,
          el('div', { class: 'source-line' }, `来源：${item.sourceRef ?? '—'}`),
          el('div', { class: 'actions' },
            button('确认', () => markTimeline(item.id, { status: 'confirmed' }), { small: true }),
            button('废弃', () => markTimeline(item.id, { status: 'deprecated', category: 'deprecated' }), { small: true }),
            button(item.excluded ? '恢复检索' : '排除', () => markTimeline(item.id, { excluded: !item.excluded }), { small: true, tone: item.excluded ? '' : 'danger' }),
            item.sourceSessionId ? button(item.excludedSession ? '恢复此会话' : '排除此会话', () => excludeSession(item.sourceSessionId, !item.excludedSession), { small: true, tone: item.excludedSession ? '' : 'danger' }) : null,
            item.sourceName && item.sourceKind !== 'dsh-session' ? button(item.excludedSource ? '恢复来源文件' : '排除来源文件', () => excludeSource(item.sourceName, !item.excludedSource), { small: true, tone: item.excludedSource ? '' : 'danger' }) : null,
          ),
        ),
      ));
    }
    output.append(timeline);
  };
  const load = async () => {
    clear(output).append(el('div', { class: 'empty' }, '正在读取已授权时间线…'));
    await withBusy(async () => {
      try {
        cached = await api(`timeline?workspaceIds=${encodeURIComponent([...timelineSelection].join(','))}&limit=200`);
        draw();
      } catch (error) { clear(output).append(el('div', { class: 'callout danger' }, error.message)); }
    });
  };
  const renderChips = () => {
    clear(chips);
    for (const workspace of active) {
      const checked = timelineSelection.has(workspace.id);
      const chip = el('label', { class: `chip ${checked ? 'checked' : ''}` },
        el('input', {
          type: 'checkbox', checked,
          onChange: (event) => {
            timelineSelectionTouched = true;
            if (event.target.checked) timelineSelection.add(workspace.id);
            else timelineSelection.delete(workspace.id);
            chip.classList.toggle('checked', event.target.checked);
            load();
          },
        }),
        workspace.title,
      );
      chips.append(chip);
    }
  };
  category.addEventListener('change', draw);
  status.addEventListener('change', draw);
  renderChips();
  view.append(
    viewHead('记忆时间线', '显示记忆首次出现、最近确认和来源；过期与潜在冲突只做提示，不替用户裁决。', button('刷新', load, { small: true })),
    el('div', { class: 'form-row' },
      field('授权范围', chips),
      field('分类筛选', category),
      field('状态筛选', status),
    ),
    output,
  );
  load();
}

async function markTimeline(docId, patch) {
  await withBusy(async () => {
    try {
      await api(`memory/${encodeURIComponent(docId)}/mark`, { method: 'POST', body: patch });
      showToast('记忆状态已更新。', 'good');
      currentTab = 'timeline';
      renderShell();
    } catch (error) { showToast(error.message, 'danger'); }
  });
}

/* -------------------------------- Security -------------------------------- */

function renderSecurity(view) {
  const auditTone = state.audit?.intact ? 'good' : 'danger';
  const grants = state.workspaces.filter((workspace) => workspace.grant);
  const auditBox = el('div');
  const terms = el('textarea', { class: 'input mono', rows: '4', placeholder: '每行一个禁止检索的词或短语' });
  terms.value = (state.blockedTerms ?? []).join('\n');
  const maxResults = el('input', { class: 'input', type: 'number', min: '1', max: '12', value: String(state.settings?.maxResults ?? 8) });
  const maxContext = el('input', { class: 'input', type: 'number', min: '1000', max: '8000', step: '500', value: String(state.settings?.maxContextChars ?? 8000) });
  const autoLock = el('input', { class: 'input', type: 'number', min: '1', max: '240', value: String(state.settings?.autoLockMinutes ?? 30) });
  const blockHigh = el('input', { type: 'checkbox', checked: state.settings?.blockHighRisk !== false });

  const grantsTable = el('div', { class: 'table-wrap' });
  if (grants.length === 0) {
    grantsTable.append(el('div', { class: 'empty' }, '当前没有任何授权。'));
  } else {
    const table = el('table', {},
      el('thead', {}, el('tr', {}, ['工作区', '模式', '到期', '状态', '默认检索', '操作'].map((head) => el('th', {}, head)))),
    );
    const body = el('tbody');
    for (const workspace of grants) {
      const grant = workspace.grant;
      body.append(el('tr', {},
        el('td', {}, el('div', {}, workspace.title), el('div', { class: 'faint mono small' }, shortId(workspace.id, 20))),
        el('td', { class: 'nowrap' }, grant.mode === 'long-term' ? '长期' : '临时'),
        el('td', { class: 'nowrap' }, grant.expiresAt ? fmtDate(grant.expiresAt) : '—'),
        el('td', {}, grant.paused ? badge('暂停', 'warn') : grant.active ? badge('有效', 'good') : badge('过期', 'danger')),
        el('td', {}, grant.defaultRetrieval ? '是' : '否'),
        el('td', {}, el('div', { class: 'inline' },
          button(grant.paused ? '恢复' : '暂停', async () => {
            await withBusy(async () => {
              try {
                await api(`workspaces/${encodeURIComponent(workspace.id)}/pause`, { method: 'POST', body: { paused: !grant.paused } });
                await loadState();
                showToast('授权状态已更新。', 'good');
              } catch (error) { showToast(error.message, 'danger'); }
            });
          }, { small: true }),
          button('撤销', async () => {
            if (!window.confirm(`撤销“${workspace.title}”并删除其索引？`)) return;
            await withBusy(async () => {
              try {
                await api(`workspaces/${encodeURIComponent(workspace.id)}/revoke`, { method: 'POST', body: {} });
                await loadState();
                showToast('已撤销并删除索引。', 'good');
              } catch (error) { showToast(error.message, 'danger'); }
            });
          }, { small: true, tone: 'danger' }),
        )),
      ));
    }
    table.append(body);
    grantsTable.append(table);
  }

  const auditTable = el('div', { class: 'table-wrap' });
  const loadAudit = async () => {
    clear(auditBox);
    try {
      const audit = await api('audit?limit=200');
      if (!audit.integrity?.intact) {
        auditBox.append(el('div', { class: 'callout danger' },
          el('strong', {}, '审计链校验失败。'),
          ' 检索已被安全策略拒绝。请检查本地文件是否被篡改；如确认环境安全，可显式重建审计链。',
          el('div', { class: 'actions' }, button('重建审计链', async () => {
            if (!window.confirm('重建审计链会丢弃旧审计内容，仅保留一条“重建”告警。确定继续？')) return;
            await withBusy(async () => {
              try {
                await api('security/repair-audit', { method: 'POST', body: {} });
                await loadState();
                showToast('审计链已重建；旧审计内容已丢弃。', 'warn');
              } catch (error) { showToast(error.message, 'danger'); }
            });
          }, { small: true, tone: 'danger' })),
        ));
      }
      clear(auditTable);
      if (!audit.items?.length) {
        auditTable.append(el('div', { class: 'empty' }, '暂无审计记录。'));
      } else {
        const table = el('table', {},
          el('thead', {}, el('tr', {}, ['时间', '主体', '动作', '结果', '范围', '结果数', '说明'].map((head) => el('th', {}, head)))),
        );
        const body = el('tbody');
        for (const entry of audit.items) {
          body.append(el('tr', {},
            el('td', { class: 'nowrap' }, fmtDate(entry.ts)),
            el('td', { class: 'nowrap' }, entry.actor),
            el('td', { class: 'nowrap mono' }, entry.action),
            el('td', { class: 'nowrap' }, entry.outcome === 'ok' ? badge('成功', 'good') : entry.outcome === 'denied' ? badge('拒绝', 'warn') : badge('错误', 'danger')),
            el('td', { class: 'wrap mono small' }, (entry.workspaceIds ?? []).join(', ') || '—'),
            el('td', {}, String(entry.resultCount ?? 0)),
            el('td', { class: 'wrap' }, entry.detail || '—'),
          ));
        }
        table.append(body);
        auditTable.append(table);
      }
      auditBox.append(auditTable);
    } catch (error) {
      auditBox.append(el('div', { class: 'callout danger' }, `审计读取失败：${error.message}`));
    }
  };

  const saveSettings = async () => {
    await withBusy(async () => {
      try {
        await api('settings', {
          method: 'POST',
          body: {
            maxResults: Number(maxResults.value),
            maxContextChars: Number(maxContext.value),
            autoLockMinutes: Number(autoLock.value),
            blockHighRisk: blockHigh.checked,
          },
        });
        await loadState();
        showToast('设置已保存。', 'good');
      } catch (error) { showToast(error.message, 'danger'); }
    });
  };

  view.append(
    viewHead('安全中心', '查看授权、审计、存储和生命周期控制。所有破坏性操作都需要本页面的管理令牌。'),
    el('div', { class: 'two-col' },
      el('div', { class: 'stat-box' },
        el('div', { class: 'stat-label' }, '审计链'),
        el('div', { class: `stat-value ${state.audit?.intact ? 'good' : 'danger'}` }, state.audit?.intact ? '完整' : '异常'),
        el('div', { class: 'stat-note' }, `条目 ${state.audit?.count ?? 0} · HMAC 链`),
      ),
      el('div', { class: 'stat-box' },
        el('div', { class: 'stat-label' }, '静态加密'),
        el('div', { class: 'stat-value good' }, 'AES-256-GCM'),
        el('div', { class: 'stat-note' }, 'scrypt N=32768 · 密钥只在内存'),
      ),
      el('div', { class: 'stat-box' },
        el('div', { class: 'stat-label' }, '模型上下文传输'),
        el('div', { class: 'stat-value warn' }, '按需'),
        el('div', { class: 'stat-note' }, '片段进入当前对话时会发送给模型服务商'),
      ),
      el('div', { class: 'stat-box' },
        el('div', { class: 'stat-label' }, '自动锁定'),
        el('div', { class: 'stat-value' }, `${state.autoLockMinutes ?? 30} 分钟`),
        el('div', { class: 'stat-note' }, '空闲后清除内存密钥'),
      ),
    ),
    el('div', { class: 'callout warn' },
      el('strong', {}, '云端能力边界：'),
      state.officialCloud?.reason,
      el('br'),
      state.privacy?.disclosure,
    ),
    el('div', { class: 'card' },
      el('h3', { class: 'card-title' }, '授权管理'),
      el('p', { class: 'card-sub' }, '每个工作区独立授权。撤销会立即删除该工作区索引；暂停只阻止检索，索引仍加密保留。'),
      grantsTable,
    ),
    el('div', { class: 'card' },
      el('h3', { class: 'card-title' }, '排除规则'),
      el('p', { class: 'card-sub' }, '排除的会话/单条记忆不会进入检索、上下文或图谱；可随时恢复。'),
      el('div', { class: 'two-col' },
        el('div', {},
          el('div', { class: 'small muted' }, `排除的会话（${(state.excludedSessions ?? []).length}）`),
          (state.excludedSessions ?? []).length === 0
            ? el('div', { class: 'empty' }, '没有排除的会话。')
            : el('div', { class: 'stack' }, (state.excludedSessions ?? []).map((item) => el('div', { class: 'card flat' },
              el('div', { class: 'mono small' }, shortId(item.sourceSessionId, 36)),
              el('div', { class: 'hint' }, `排除于 ${fmtDate(item.createdAt)} · ${item.reason ?? 'user'}`),
              el('div', { class: 'actions' }, button('恢复检索', () => excludeSession(item.sourceSessionId, false), { small: true })),
            ))),
        ),
        el('div', {},
          el('div', { class: 'small muted' }, `排除的单条记忆（${(state.exclusions ?? []).length}）`),
          (state.exclusions ?? []).length === 0
            ? el('div', { class: 'empty' }, '没有按条排除的记忆。')
            : el('div', { class: 'stack' }, (state.exclusions ?? []).map((item) => el('div', { class: 'card flat' },
              el('div', { class: 'mono small' }, shortId(item.docId, 36)),
              el('div', { class: 'hint' }, `排除于 ${fmtDate(item.createdAt)} · ${item.reason ?? 'user'}`),
              el('div', { class: 'actions' }, button('恢复检索', () => markMemory(item.docId, { excluded: false }), { small: true })),
            ))),
        ),
        el('div', {},
          el('div', { class: 'small muted' }, `排除的来源文件（${(state.excludedSources ?? []).length}）`),
          (state.excludedSources ?? []).length === 0
            ? el('div', { class: 'empty' }, '没有排除的来源文件。')
            : el('div', { class: 'stack' }, (state.excludedSources ?? []).map((item) => el('div', { class: 'card flat' },
              el('div', { class: 'small' }, item.sourceName),
              el('div', { class: 'hint' }, `排除于 ${fmtDate(item.createdAt)} · ${item.reason ?? 'user'}`),
              el('div', { class: 'actions' }, button('恢复检索', () => excludeSource(item.sourceName, false), { small: true })),
            ))),
        ),
      ),
    ),
    el('div', { class: 'card' },
      el('h3', { class: 'card-title' }, '存储与数据生命周期'),
      el('dl', { class: 'kv' },
        el('dt', {}, '保险库'), el('dd', { class: 'mono' }, state.storage?.dir ?? state.vaultPath ?? '—'),
        el('dt', {}, 'Profile'), el('dd', { class: 'mono' }, state.profile ?? '—'),
        el('dt', {}, '密文大小'), el('dd', {}, `${state.storage?.vaultBytes ?? 0} bytes`),
        el('dt', {}, '审计文件'), el('dd', {}, `${state.storage?.auditBytes ?? 0} bytes`),
        el('dt', {}, '文档 / 字符'), el('dd', {}, `${state.counts?.documents ?? 0} / ${state.counts?.chars ?? 0}`),
        el('dt', {}, '备份'), el('dd', {}, '不自动创建；可自行复制加密文件，口令丢失不可恢复。'),
      ),
      el('p', { class: 'hint' }, '删除会移除密文、审计文件与内存密钥；受 SSD 磨损均衡限制，不能承诺物理介质不可恢复。'),
    ),
    el('div', { class: 'split' },
      el('div', { class: 'card' },
        el('h3', { class: 'card-title' }, '禁止检索内容'),
        el('p', { class: 'card-sub' }, '命中任一短语的文档在检索前被排除；规则加密存储。'),
        field('每行一个词或短语', terms),
        el('div', { class: 'actions' }, button('保存规则', async () => {
          await withBusy(async () => {
            try {
              const values = terms.value.split(/[\n,，]+/).map((value) => value.trim()).filter(Boolean);
              await api('security/blocked-terms', { method: 'POST', body: { terms: values } });
              await loadState();
              showToast('禁止检索规则已保存。', 'good');
            } catch (error) { showToast(error.message, 'danger'); }
          });
        }, { tone: 'primary', small: true })),
      ),
      el('div', { class: 'card' },
        el('h3', { class: 'card-title' }, '检索设置'),
        el('div', { class: 'form-row' },
          field('最多结果数', maxResults),
          field('上下文最大字符', maxContext),
          field('自动锁定（分钟）', autoLock),
        ),
        el('label', { class: 'chip' }, blockHigh, '隔离高风险提示词注入内容'),
        el('div', { class: 'actions' }, button('保存设置', saveSettings, { tone: 'primary', small: true })),
      ),
    ),
    el('div', { class: 'card' },
      el('h3', { class: 'card-title' }, '一键断开与删除'),
      el('p', { class: 'card-sub' }, '断开 = 撤销全部授权、清空索引、锁定保险库并使所有管理令牌失效。'),
      el('div', { class: 'actions' },
        button('一键断开（撤销全部并锁定）', async () => {
          if (!window.confirm('撤销全部授权、删除全部索引并锁定？此操作不可撤销。')) return;
          await withBusy(async () => {
            try {
              await api('security/revoke-all', { method: 'POST', body: {} });
              await api('lock', { method: 'POST', body: {} });
              token = null; state = null;
              notifyParentToken(null);
              renderAuth('unlock', '已撤销全部授权、清空索引并锁定。');
              showToast('已断开所有跨工作区访问。', 'good');
            } catch (error) { showToast(error.message, 'danger'); }
          });
        }, { tone: 'danger' }),
        button('删除整个保险库', async () => {
          const answer = window.prompt('这将删除密文、审计和内存密钥，且不可恢复。请输入 DELETE 确认：');
          if (answer !== 'DELETE') return;
          await withBusy(async () => {
            try {
              await api('security/delete-all', { method: 'POST', body: { confirm: 'DELETE' } });
              token = null; state = null;
              notifyParentToken(null);
              showToast('保险库已删除。', 'good');
              await init();
            } catch (error) { showToast(error.message, 'danger'); }
          });
        }, { tone: 'danger' }),
      ),
    ),
    el('div', { class: 'card' },
      el('h3', { class: 'card-title' }, '审计记录'),
      el('p', { class: 'card-sub' }, '不含完整查询、正文、口令或令牌。查询仅以哈希标识。'),
      auditBox,
    ),
  );
  loadAudit();
}

/* --------------------------------- Start ---------------------------------- */

/**
 * The composer bar and Settings iframe are same-origin frames. The bar may
 * already have a page-lifetime token; accept it in memory so the user does not
 * re-enter the passphrase merely to open Settings. The token is never stored.
 */
async function adoptParentToken(event) {
  if (event.origin !== window.location.origin) return;
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.type !== 'cwm-session-token') return;
  if (typeof data.token === 'string' && data.token.length >= 20) {
    if (data.token === token && state) return;
    token = data.token;
    try {
      await loadState();
    } catch (error) {
      showToast(error.message, 'warn');
    }
    return;
  }
  if (data.token === null) {
    token = null;
    state = null;
    lastSearch = null;
    renderAuth('unlock', '主界面已锁定保险库。请重新解锁。');
  }
}

window.addEventListener('message', adoptParentToken);
startHostLockWatch();
try {
  // Ask the parent for its page-lifetime management token. The parent answers
  // with an in-memory token only; nothing is written to browser storage.
  window.parent.postMessage({ type: 'cwm-frame-ready' }, window.location.origin);
} catch { /* parent unavailable */ }
init();

