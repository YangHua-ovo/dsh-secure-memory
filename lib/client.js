/**
 * Client half of Cross-Workspace Memory (dsh-secure-memory v0.1.0).
 *
 * Two surfaces:
 *  - A compact, session-scoped bar in conversation.input.dock (above the composer).
 *  - The existing Settings iframe, retained as the management surface.
 *
 * Security / behavior:
 *  - No password or bearer token is written to localStorage/sessionStorage.
 *  - The management token lives in this module's closure for the page lifetime.
 *  - All state changes use local React state and local fetch requests.
 *  - This file deliberately contains no session creation, fork, prompt,
 *    location, or history navigation calls.
 */
;(() => {
  const makeFactory = () => (require) => {
    const module = { exports: {} };
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    const name = 'secure-memory';
    const inject = ['slots'];
    const PRODUCT = 'Cross-Workspace Memory';
    const TOKEN_EVENT = 'cwm-token-changed';
    const STATE_EVENT = 'cwm-state-changed';
    const API_ROOT = '/secure-memory/api';

    // Page-lifetime only. Never persisted. The host validates this token and
    // applies its own idle TTL; status polling is a no-touch heartbeat.
    let managementToken = null;
    let fallbackUsed = false;
    let settingsFrameWindow = null;
    const tokenSubscribers = new Set();
    // The management iframe reports state changes here. The composer bar then
    // re-reads its status in place; no page reload and no conversation change.
    const stateSubscribers = new Set();

    function notifyStateChanged() {
      for (const subscriber of stateSubscribers) {
        try { subscriber(); } catch { /* UI observer */ }
      }
    }

    function setManagementToken(value) {
      managementToken = typeof value === 'string' && value.length >= 20 ? value : null;
      for (const subscriber of tokenSubscribers) {
        try { subscriber(managementToken); } catch { /* UI observer */ }
      }
      if (typeof window !== 'undefined') {
        try { window.dispatchEvent(new Event(TOKEN_EVENT)); } catch { /* old webview */ }
      }
    }

    async function api(path, { method = 'GET', body, useToken = true } = {}) {
      const headers = {};
      const requestToken = managementToken;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (useToken && managementToken) headers.Authorization = `Bearer ${managementToken}`;
      const response = await fetch(`${API_ROOT}/${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
      });
      let data = {};
      try { data = await response.json(); } catch { /* empty/non-json */ }
      if (response.status === 401 && useToken && managementToken === requestToken) {
        setManagementToken(null);
        const error = new Error(data?.error?.message || '管理会话已过期，请重新解锁');
        error.code = 'UNAUTHORIZED';
        error.status = 401;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(data?.error?.message || `请求失败（HTTP ${response.status}）`);
        error.code = data?.error?.code;
        error.status = response.status;
        throw error;
      }
      return data;
    }

    function fmtDate(value) {
      if (!value) return '—';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return String(value);
      return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    function shortText(value, length = 64) {
      const text = String(value ?? '');
      return text.length > length ? `${text.slice(0, length)}…` : text;
    }

    function retrievalLabel(status, busy) {
      if (busy) return { text: '更新中', tone: 'warn' };
      if (!status) return { text: '读取中', tone: '' };
      if (!status.session?.enabled) return { text: '未启用', tone: '' };
      const retrieval = status.retrieval ?? {};
      if (retrieval.state === 'retrieving') return { text: '正在检索', tone: 'info' };
      if (retrieval.state === 'completed') return { text: `检索完成 · ${retrieval.resultCount ?? 0} 条`, tone: 'good' };
      if (retrieval.state === 'no_results') return { text: '暂无相关记忆', tone: '' };
      if (retrieval.state === 'denied') return { text: '范围受限', tone: 'warn' };
      if (retrieval.state === 'error') return { text: '服务异常', tone: 'danger' };
      if (retrieval.state === 'disabled') return { text: '未启用', tone: '' };
      return { text: '已启用', tone: 'good' };
    }

    function statusText(phase, busy, error) {
      if (phase === 'setup') return { text: '未初始化', tone: 'warn' };
      if (phase === 'locked') return { text: '已锁定', tone: 'warn' };
      if (phase === 'error') return { text: '状态异常', tone: 'danger' };
      if (phase === 'loading') return { text: '读取中', tone: '' };
      if (error) return { text: '需处理', tone: 'warn' };
      return { text: '就绪', tone: 'good' };
    }

    function CwmButton({ label, onClick, disabled, tone = '', title, ariaLabel }) {
      return h('button', {
        type: 'button',
        className: `cwm-btn ${tone ? `cwm-btn-${tone}` : ''}`.trim(),
        onClick,
        disabled,
        title,
        'aria-label': ariaLabel || label,
      }, label);
    }

    function CrossWorkspaceBar(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      // Anchor every request to the conversation this bar was mounted for. A
      // late response must never write into a different conversation, and the
      // plugin must never navigate to make its UI update.
      const sessionRef = useRef(sessionId);
      const [phase, setPhase] = useState('loading');
      const [status, setStatus] = useState(null);
      const [expanded, setExpanded] = useState(false);
      const [compact, setCompact] = useState(false);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [passphrase, setPassphrase] = useState('');
      const [tokenEpoch, setTokenEpoch] = useState(0);
      const rootRef = useRef(null);
      const mountedRef = useRef(true);
      const refreshingRef = useRef(false);
      const requestEpochRef = useRef(0);
      const identityRef = useRef('');
      const statusSessionRef = useRef('');
      const mutationRef = useRef(null);
      const identity = `${sessionId}:${tokenEpoch}`;
      if (identityRef.current !== identity) {
        identityRef.current = identity;
        sessionRef.current = sessionId;
        requestEpochRef.current += 1;
        mutationRef.current = null;
      }

      useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
      }, []);

      useEffect(() => {
        sessionRef.current = sessionId;
      }, [sessionId]);

      useEffect(() => {
        const subscriber = () => setTokenEpoch((value) => value + 1);
        tokenSubscribers.add(subscriber);
        return () => tokenSubscribers.delete(subscriber);
      }, []);

      const refresh = useCallback(async ({ silent = false } = {}) => {
        const activeSessionId = sessionRef.current || sessionId;
        const epoch = requestEpochRef.current;
        if (!activeSessionId) {
          setPhase('error');
          setError('缺少会话标识，无法读取本次会话范围。');
          return;
        }
        if (!managementToken) {
          setPhase('locked');
          setStatus(null);
          return;
        }
        if (mutationRef.current !== null || refreshingRef.current === epoch) return;
        refreshingRef.current = epoch;
        try {
          const data = await api(`session/${encodeURIComponent(activeSessionId)}/status`);
          if (!mountedRef.current || sessionRef.current !== activeSessionId || requestEpochRef.current !== epoch) return;
          statusSessionRef.current = activeSessionId;
          setStatus(data);
          setPhase('ready');
          setError('');
        } catch (requestError) {
          if (!mountedRef.current || sessionRef.current !== activeSessionId || requestEpochRef.current !== epoch) return;
          if (requestError.code === 'UNAUTHORIZED') {
            setPhase('locked');
            setStatus(null);
          } else if (requestError.code === 'VAULT_LOCKED' || requestError.code === 'AUDIT_INTEGRITY') {
            setPhase('locked');
            setStatus(null);
            setError(requestError.message);
          } else {
            setError(requestError.message);
            if (!silent) setPhase('error');
          }
        } finally {
          if (refreshingRef.current === epoch) refreshingRef.current = false;
        }
      }, [sessionId]);

      // The Settings surface is an iframe; it reports every successful state
      // change here. Reload only this bar's status — never the page and never
      // the conversation.
      useEffect(() => {
        const subscriber = () => { void refresh(); };
        stateSubscribers.add(subscriber);
        return () => { stateSubscribers.delete(subscriber); };
      }, [refresh]);

      // Bootstrap or reconnect whenever the session or token changes.
      useEffect(() => {
        let cancelled = false;
        setStatus(null);
        setBusy(false);
        setError('');
        setPhase('loading');
        (async () => {
          try {
            if (!managementToken) {
              const bootstrap = await api('bootstrap', { useToken: false });
              if (cancelled) return;
              if (!bootstrap.initialized) {
                setPhase('setup');
                setStatus(null);
                return;
              }
              setPhase('locked');
              setStatus(null);
              return;
            }
            await refresh();
          } catch (bootstrapError) {
            if (cancelled) return;
            setError(bootstrapError.message);
            setPhase('error');
          }
        })();
        return () => { cancelled = true; };
      }, [sessionId, tokenEpoch, refresh]);

      // Read-only status heartbeat. The host does not extend the token/vault
      // idle lifetime for this endpoint. It runs even while this conversation
      // is disabled so a Settings change appears in place without a reload.
      useEffect(() => {
        if (phase !== 'ready') return undefined;
        const interval = status?.session?.enabled ? 3000 : 5000;
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') void refresh({ silent: true });
        }, interval);
        return () => clearInterval(timer);
      }, [phase, status?.session?.enabled, refresh]);

      useEffect(() => {
        setExpanded(false);
      }, [sessionId]);

      useEffect(() => {
        const element = rootRef.current;
        if (!element) return undefined;
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect?.width ?? 0;
            setCompact(width < 620);
          });
          observer.observe(element);
          return () => observer.disconnect();
        }
        const onResize = () => setCompact((rootRef.current?.clientWidth ?? 0) < 620);
        window.addEventListener('resize', onResize);
        onResize();
        return () => window.removeEventListener('resize', onResize);
      }, []);

      const persistScope = async (enabled, workspaceIds, selections = status?.scope?.selections, tokenBudget = status?.scope?.tokenBudget) => {
        const activeSessionId = sessionRef.current || sessionId;
        if (mutationRef.current !== null || !activeSessionId) return;
        const epoch = ++requestEpochRef.current;
        mutationRef.current = epoch;
        setBusy(true);
        setError('');
        try {
          const activeIds = new Set((status?.workspaces ?? []).filter((workspace) => workspace.active).map((workspace) => workspace.id));
          selections = selections?.filter((item) => workspaceIds.includes(item.workspaceId) && activeIds.has(item.workspaceId));
          if (selections) workspaceIds = selections.map((item) => item.workspaceId);
          const data = await api(`session/${encodeURIComponent(activeSessionId)}/scope`, {
            method: 'POST',
            body: { enabled, workspaceIds, selections, tokenBudget },
          });
          if (!mountedRef.current || sessionRef.current !== activeSessionId || requestEpochRef.current !== epoch) return;
          statusSessionRef.current = activeSessionId;
          setStatus(data);
          setPhase('ready');
        } catch (requestError) {
          if (!mountedRef.current || sessionRef.current !== activeSessionId || requestEpochRef.current !== epoch) return;
          if (requestError.code === 'UNAUTHORIZED') {
            setPhase('locked');
            setStatus(null);
          } else {
            setError(requestError.message);
          }
        } finally {
          if (mutationRef.current === epoch) { mutationRef.current = null; setBusy(false); }
        }
      };

      const submitUnlock = async (event) => {
        event.preventDefault();
        if (!passphrase || busy) return;
        setBusy(true);
        setError('');
        try {
          const data = await api('unlock', {
            method: 'POST',
            body: { passphrase },
            useToken: false,
          });
          setPassphrase('');
          setManagementToken(data.token);
        } catch (unlockError) {
          setError(unlockError.message);
        } finally {
          setBusy(false);
        }
      };

      const lock = async () => {
        setBusy(true);
        try {
          await api('lock', { method: 'POST', body: {} });
        } catch (lockError) {
          if (lockError.code !== 'UNAUTHORIZED') setError(lockError.message);
        } finally {
          setManagementToken(null);
          setStatus(null);
          setPhase('locked');
          setExpanded(false);
          setBusy(false);
        }
      };

      const refreshSetup = async () => {
        setBusy(true);
        setError('');
        try {
          const bootstrap = await api('bootstrap', { useToken: false });
          if (!bootstrap.initialized) {
            setPhase('setup');
          } else if (managementToken) {
            await refresh();
          } else {
            setPhase('locked');
          }
        } catch (bootstrapError) {
          setError(bootstrapError.message);
        } finally {
          setBusy(false);
        }
      };

      const toggleMemory = () => {
        if (phase !== 'ready' || !status) {
          setExpanded(true);
          return;
        }
        const activeIds = new Set(status.workspaces.filter((workspace) => workspace.active).map((workspace) => workspace.id));
        const selected = status.scope.workspaceIds.filter((id) => activeIds.has(id));
        const nextEnabled = !status.session.enabled;
        if (nextEnabled) setExpanded(true);
        void persistScope(nextEnabled, selected);
      };

      const toggleWorkspace = (workspaceId, checked) => {
        if (!status) return;
        const selections = status.scope.selections.filter((item) => item.workspaceId !== workspaceId);
        if (checked) selections.push({ workspaceId, mode: 'sessions', sessionIds: [] });
        void persistScope(status.session.enabled, selections.map((item) => item.workspaceId), selections);
      };

      const selectSessions = (workspaceId, mode, sessionIds) => {
        const selections = status.scope.selections.filter((item) => item.workspaceId !== workspaceId);
        selections.push({ workspaceId, mode, sessionIds });
        void persistScope(status.session.enabled, selections.map((item) => item.workspaceId), selections);
      };

      const selectAll = () => {
        if (!status) return;
        const ids = status.workspaces.filter((workspace) => workspace.active).map((workspace) => workspace.id);
        void persistScope(status.session.enabled, ids, ids.map((workspaceId) => ({ workspaceId, mode: 'all', sessionIds: [] })));
      };

      const clearAll = () => {
        if (!status) return;
        void persistScope(status.session.enabled, [], []);
      };

      const syncIndex = async () => {
        const activeSessionId = sessionRef.current || sessionId;
        if (!activeSessionId || busy) return;
        const epoch = ++requestEpochRef.current;
        mutationRef.current = epoch;
        setBusy(true);
        setError('');
        try {
          const data = await api(`session/${encodeURIComponent(activeSessionId)}/sync`, { method: 'POST', body: {} });
          if (!mountedRef.current || sessionRef.current !== activeSessionId || requestEpochRef.current !== epoch) return;
          if (data.session) { statusSessionRef.current = activeSessionId; setStatus(data.session); }
          const failed = Array.isArray(data.results) ? data.results.filter((item) => item.ok === false) : [];
          if (failed.length > 0) setError(`${failed.length} 个工作区同步失败；请查看设置中的状态。`);
        } catch (syncError) {
          if (!mountedRef.current || sessionRef.current !== activeSessionId || requestEpochRef.current !== epoch) return;
          if (syncError.code === 'UNAUTHORIZED') {
            setPhase('locked');
            setStatus(null);
          } else {
            setError(syncError.message);
          }
        } finally {
          if (mutationRef.current === epoch) { mutationRef.current = null; setBusy(false); }
        }
      };

      const isReady = phase === 'ready' && Boolean(status) && statusSessionRef.current === sessionId;
      const enabled = isReady && Boolean(status?.session?.enabled);
      const selectedCount = status?.counts?.selected ?? status?.scope?.effectiveWorkspaceIds?.length ?? 0;
      const selectedDocuments = status?.counts?.selectedDocuments ?? 0;
      const label = isReady ? retrievalLabel(status, busy) : statusText(phase, busy, error);
      const workspaces = status?.workspaces ?? [];
      const activeCount = workspaces.filter((workspace) => workspace.active).length;
      const retrieval = status?.retrieval ?? {};
      const sources = Array.isArray(retrieval.sources) ? retrieval.sources : [];
      const conflicts = Array.isArray(status?.conflicts) ? status.conflicts : [];
      const selectedDsh = workspaces.filter((workspace) => workspace.effectiveSelected && workspace.kind === 'dsh-local');
      const rootClass = [
        'cwm-root',
        compact ? 'cwm-compact' : '',
        expanded ? 'cwm-expanded' : '',
        enabled ? 'cwm-enabled' : '',
      ].filter(Boolean).join(' ');

      const workspaceOption = (workspace) => {
        const checked = Boolean(status?.scope?.workspaceIds?.includes(workspace.id));
        const disabled = busy || !workspace.active;
        const meta = [
          `${workspace.documents ?? 0} 条`,
          workspace.kind === 'dsh-local' ? 'DSH 本地' : '手动来源',
          workspace.paused ? '已暂停' : workspace.expired ? '已过期' : null,
        ].filter(Boolean).join(' · ');
        const selection = status?.scope?.selections?.find((item) => item.workspaceId === workspace.id);
        return h('div', {
          key: workspace.id,
          className: `cwm-workspace ${workspace.active ? '' : 'cwm-workspace-inactive'}`.trim(),
          title: workspace.reason ? `不可选：${workspace.reason}` : workspace.title,
        },
          h('input', {
            type: 'checkbox',
            checked,
            disabled,
            onChange: (event) => toggleWorkspace(workspace.id, event.target.checked),
          }),
          h('span', { className: 'cwm-workspace-body' },
            h('span', { className: 'cwm-workspace-title' }, workspace.title),
            h('span', { className: 'cwm-workspace-meta' }, meta),
          ),
          checked ? h('div', { className: 'cwm-session-options' },
            h('label', {}, h('input', { type: 'checkbox', checked: selection?.mode === 'all', disabled,
              onChange: (event) => selectSessions(workspace.id, event.target.checked ? 'all' : 'sessions', []),
            }), '全部已授权会话（含以后新增的会话）'),
            ...(workspace.sessions ?? []).map((sourceSession) => h('label', { key: sourceSession.id, style: { display: 'block' } },
              h('input', { type: 'checkbox', disabled: disabled || selection?.mode === 'all',
                checked: selection?.mode === 'all' || Boolean(selection?.sessionIds.includes(sourceSession.id)),
                onChange: (event) => {
                  const ids = new Set(selection?.sessionIds ?? []);
                  if (event.target.checked) ids.add(sourceSession.id); else ids.delete(sourceSession.id);
                  selectSessions(workspace.id, 'sessions', [...ids]);
                },
              }), `${sourceSession.title} · ${sourceSession.documents} 条`,
            )),
            !(workspace.sessions ?? []).length ? h('span', { className: 'cwm-muted' }, '尚无已索引会话；可刷新索引。无会话来源可显式选择全部范围。') : null,
          ) : null,
        );
      };

      const panel = expanded ? h('div', { className: 'cwm-panel' },
        phase === 'setup' ? h('div', { className: 'cwm-panel-section' },
          h('div', { className: 'cwm-panel-title' }, '首次使用'),
          h('p', { className: 'cwm-muted' }, '请先在“设置 → Cross-Workspace Memory”中创建本地加密保险库。创建后点击下方刷新。'),
          h('div', { className: 'cwm-actions' },
            h(CwmButton, { label: '我已完成，刷新状态', onClick: refreshSetup, disabled: busy, tone: 'primary' }),
          ),
        ) : null,
        phase === 'locked' ? h('div', { className: 'cwm-panel-section' },
          h('div', { className: 'cwm-panel-title' }, '解锁保险库'),
          h('p', { className: 'cwm-muted' }, '口令只在本机内存中校验，不保存、不写入浏览器存储。本次页面运行期间解锁后，切换会话/收起功能栏不需要重复输入；刷新页面或宿主锁定后需要重新解锁。'),
          h('form', { className: 'cwm-unlock', onSubmit: submitUnlock },
            h('input', {
              className: 'cwm-input',
              type: 'password',
              autoComplete: 'current-password',
              placeholder: '输入保险库口令',
              value: passphrase,
              maxLength: 1024,
              disabled: busy,
              onChange: (event) => setPassphrase(event.target.value),
              'aria-label': '保险库口令',
            }),
            h('button', { className: 'cwm-btn cwm-btn-primary', type: 'submit', disabled: busy || !passphrase }, busy ? '解锁中…' : '解锁'),
          ),
        ) : null,
        phase === 'error' ? h('div', { className: 'cwm-panel-section' },
          h('div', { className: 'cwm-panel-title' }, '无法读取状态'),
          h('p', { className: 'cwm-error' }, error || '未知错误'),
          h('div', { className: 'cwm-actions' },
            h(CwmButton, { label: '重试', onClick: () => refresh(), disabled: busy, tone: 'primary' }),
          ),
        ) : null,
        isReady ? h('div', { className: 'cwm-panel-section' },
          h('div', { className: 'cwm-panel-heading' },
            h('span', { className: 'cwm-panel-title' }, '本次会话关联'),
            h('span', { className: 'cwm-muted' }, `${selectedCount}/${activeCount} 个有效工作区 · ${selectedDocuments} 条索引`),
            h('div', { className: 'cwm-panel-heading-actions' },
              h(CwmButton, { label: '全选', onClick: selectAll, disabled: busy || activeCount === 0 }),
              h(CwmButton, { label: '清空', onClick: clearAll, disabled: busy || selectedCount === 0 }),
            ),
          ),
          h('p', { className: 'cwm-muted cwm-small' },
            enabled
              ? '已启用；来源目录定义可用来源，只有本次勾选的会话参与检索。新勾选工作区后，请选择会话或显式选择全部。'
              : '当前未启用；勾选工作区后打开左侧开关才会参与 AI 检索。',
          ),
          h('label', { className: 'cwm-muted' }, '本次上下文 Token 预算 ',
            h('select', { value: status.scope.tokenBudget ?? 1200, disabled: busy,
              onChange: (event) => persistScope(enabled, status.scope.workspaceIds, status.scope.selections, Number(event.target.value)),
            }, ...[...new Set([800, 1200, 1500, status.scope.tokenBudget ?? 1200])].sort((a, b) => a - b).map((value) => h('option', { key: value, value }, String(value)))),
          ),
          retrieval.metrics ? h('div', { className: 'cwm-muted' }, `最近注入 ${retrieval.metrics.injectedTokens}/${retrieval.metrics.budgetTokens} Token${retrieval.metrics.exact ? '' : '（保守估算）'}`) : null,
          workspaces.length === 0
            ? h('div', { className: 'cwm-empty' }, '还没有已授权工作区。请先在设置中完成授权。')
            : h('div', { className: 'cwm-workspace-grid' }, workspaces.map(workspaceOption)),
          h('div', { className: 'cwm-actions' },
            h(CwmButton, {
              label: '刷新状态',
              onClick: () => { void refresh(); },
              disabled: busy,
              title: '只刷新当前页面的插件状态，不重载页面、不切换对话',
            }),
            h(CwmButton, {
              label: busy ? '同步中…' : '刷新索引',
              onClick: syncIndex,
              disabled: busy || !enabled || selectedDsh.length === 0,
              title: selectedDsh.length === 0 ? '当前没有选中可同步的 DSH 本地工作区' : '只读同步本次关联的 DSH 本地会话',
            }),
            h(CwmButton, { label: '锁定', onClick: lock, disabled: busy }),
          ),
          sources.length > 0 ? h('div', { className: 'cwm-sources' },
            h('div', { className: 'cwm-subhead' }, `最近检索来源 · ${retrieval.resultCount ?? sources.length} 条`),
            sources.map((source, index) => h('div', { className: 'cwm-source', key: `${source.workspaceId}-${index}` },
              h('div', { className: 'cwm-source-line' },
                h('strong', {}, source.workspaceTitle || source.workspaceId),
                h('span', { className: 'cwm-muted' }, ` · ${fmtDate(source.createdAt)}`),
              ),
              source.title ? h('div', { className: 'cwm-source-title' }, shortText(source.title, 96)) : null,
              h('div', { className: 'cwm-source-ref', title: source.sourceRef }, shortText(source.sourceRef, 96)),
              h('div', { className: 'cwm-source-meta' },
                [source.category, source.status, source.confidence === null ? null : `可信度 ${source.confidence}`]
                  .filter(Boolean).join(' · '),
              ),
            )),
          ) : h('div', { className: 'cwm-empty' }, retrieval.state === 'retrieving' ? '正在检索…' : '还没有检索来源。对话中让 AI 使用记忆后，这里会显示来源摘要。'),
          h('div', { className: 'cwm-security-line' },
            `审计 ${status?.security?.auditIntact ? '完整' : '异常'} · 自动锁定 ${status?.security?.autoLockMinutes ?? 30} 分钟 · 口令不保存`,
          ),
          conflicts.length > 0 ? h('div', { className: 'cwm-warn' },
            `插件适配：${conflicts.map((conflict) => `${conflict.kind}:${conflict.requested || conflict.name || ''}→${conflict.selected || ''}`).join('；')}`,
          ) : null,
          fallbackUsed ? h('div', { className: 'cwm-warn' }, '主输入区扩展位不可用，功能栏已降级到输入框下方。') : null,
          h('div', { className: 'cwm-fingerprint' }, `会话指纹 ${status?.session?.idHash ?? '—'} · 授权与本次关联分离 · AI 不能扩权`),
        ) : null,
        error && phase !== 'error' ? h('div', { className: 'cwm-error cwm-panel-section' }, error) : null,
      ) : null;

      return h('div', { className: rootClass, ref: rootRef, 'data-cwm-surface': fallbackUsed ? 'composer-dock' : 'input-dock' },
        h('div', { className: 'cwm-row' },
          h('div', { className: 'cwm-brand', title: PRODUCT },
            h('span', { className: 'cwm-brand-mark', 'aria-hidden': 'true' }, '◈'),
            h('span', { className: 'cwm-brand-text' }, PRODUCT),
          ),
          h('button', {
            type: 'button',
            className: `cwm-switch ${enabled ? 'cwm-switch-on' : ''}`.trim(),
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': '本次会话启用跨工作区记忆',
            disabled: busy || !isReady,
            onClick: toggleMemory,
            title: isReady ? (enabled ? '关闭本次会话记忆' : '开启本次会话记忆') : '解锁后可开启',
          },
            h('span', { className: 'cwm-switch-track' }, h('span', { className: 'cwm-switch-thumb' })),
          ),
          h('span', { className: `cwm-pill cwm-pill-${label.tone || 'muted'}`.trim() },
            h('span', { className: 'cwm-dot' }),
            h('span', { className: 'cwm-pill-text' }, label.text),
          ),
          h('button', {
            type: 'button',
            className: 'cwm-ws-trigger',
            onClick: () => setExpanded((value) => !value),
            'aria-expanded': expanded,
            title: '选择本次会话关联的工作区',
          },
            h('span', { className: 'cwm-ws-count' }, `关联 ${selectedCount}`),
            h('span', { className: 'cwm-caret', 'aria-hidden': 'true' }, expanded ? '▴' : '▾'),
          ),
          h('span', { className: 'cwm-index-count' }, `${selectedDocuments} 条`),
          h('button', {
            type: 'button',
            className: 'cwm-expand',
            onClick: () => setExpanded((value) => !value),
            'aria-expanded': expanded,
            title: expanded ? '收起功能栏' : '展开功能栏',
          }, expanded ? '收起' : '展开'),
          phase === 'locked'
            ? h(CwmButton, { label: '解锁', onClick: () => setExpanded(true), disabled: busy, tone: 'primary' })
            : isReady
              ? h(CwmButton, { label: '锁定', onClick: lock, disabled: busy })
              : null,
        ),
        panel,
      );
    }

    function MemoryPanel() {
      const frameRef = useRef(null);
      useEffect(() => {
        const send = () => {
          const frame = frameRef.current;
          if (!frame || !frame.contentWindow) return;
          try {
            frame.contentWindow.postMessage({ type: 'cwm-session-token', token: managementToken }, window.location.origin);
          } catch { /* frame not ready */ }
        };
        send();
        window.addEventListener(TOKEN_EVENT, send);
        return () => {
          window.removeEventListener(TOKEN_EVENT, send);
          settingsFrameWindow = null;
        };
      }, []);
      return h('iframe', {
        ref: (node) => {
          frameRef.current = node;
          // Restrict the token bridge to this exact same-origin frame. No other
          // plugin iframe or page script may request or inject the token.
          settingsFrameWindow = node?.contentWindow ?? null;
        },
        className: 'cwm-frame',
        src: '/secure-memory/',
        title: PRODUCT,
        loading: 'eager',
        referrerPolicy: 'no-referrer',
        // No allow-top-navigation / allow-popups: the management document can
        // never replace the current conversation's page. It only updates its
        // own DOM and reports changes to the composer bar in place.
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals',
        allow: 'clipboard-write',
        width: '100%',
        height: '760',
        frameBorder: '0',
        onLoad: () => {
          const frame = frameRef.current;
          if (!frame || !frame.contentWindow) return;
          try {
            frame.contentWindow.postMessage({ type: 'cwm-session-token', token: managementToken }, window.location.origin);
          } catch { /* frame not ready */ }
        },
      });
    }

    function installStyle() {
      if (typeof document === 'undefined') return () => {};
      const existing = document.querySelector('style[data-dsh-secure-memory]');
      if (existing) return () => {};
      const style = document.createElement('style');
      style.dataset.dshSecureMemory = 'ui';
      style.textContent = `
.cwm-root{width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary,#e6edf3);font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--dsw-alias-bg-layer-1,#111820);border:1px solid var(--dsw-alias-border-l2,#263442);border-radius:12px;padding:6px 8px;margin:0 0 6px;position:relative}
.cwm-row{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:nowrap}
.cwm-brand{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary,#9fb0c0)}
.cwm-brand-mark{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d9fff) 18%,transparent);color:var(--dsw-alias-state-business-primary,#4d9fff);font-size:13px;flex:none}
.cwm-brand-text{white-space:nowrap;font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3);font-size:12px}
.cwm-switch{appearance:none;border:0;background:transparent;padding:0;cursor:pointer;flex:none;line-height:0}
.cwm-switch:disabled{opacity:.45;cursor:default}
.cwm-switch-track{display:block;width:30px;height:17px;border-radius:999px;background:var(--dsw-alias-border-l2,#334454);position:relative;transition:background .15s ease;border:1px solid var(--dsw-alias-border-l2,#334454);box-sizing:border-box}
.cwm-switch-thumb{display:block;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8fa2b4);position:absolute;left:2px;top:2px;transition:transform .15s ease,background .15s ease}
.cwm-switch-on .cwm-switch-track{background:var(--dsw-alias-state-business-primary,#4d9fff);border-color:var(--dsw-alias-state-business-primary,#4d9fff)}
.cwm-switch-on .cwm-switch-thumb{transform:translateX(13px);background:#fff}
.cwm-pill{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l2,#263442);border-radius:999px;padding:2px 7px;color:var(--dsw-alias-label-secondary,#9fb0c0);white-space:nowrap;min-width:0;font-size:11px}
.cwm-pill-text{overflow:hidden;text-overflow:ellipsis;max-width:190px}
.cwm-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8fa2b4);flex:none}
.cwm-pill-good .cwm-dot{background:var(--dsw-alias-state-success-primary,#38c98b)}
.cwm-pill-warn .cwm-dot{background:var(--dsw-alias-state-warning-primary,#d6a44a)}
.cwm-pill-danger .cwm-dot{background:var(--dsw-alias-state-error-primary,#e36b6b)}
.cwm-pill-info .cwm-dot{background:var(--dsw-alias-state-business-primary,#4d9fff)}
.cwm-ws-trigger,.cwm-expand{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,#263442);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#9fb0c0);padding:3px 7px;cursor:pointer;white-space:nowrap;font:inherit}
.cwm-ws-trigger:hover,.cwm-expand:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff0d);color:var(--dsw-alias-label-primary,#e6edf3)}
.cwm-caret{font-size:10px;color:var(--dsw-alias-label-tertiary,#8fa2b4)}
.cwm-index-count{color:var(--dsw-alias-label-tertiary,#8fa2b4);white-space:nowrap;font-size:11px}
.cwm-btn{border:1px solid var(--dsw-alias-border-l2,#263442);background:transparent;color:var(--dsw-alias-label-primary,#e6edf3);border-radius:7px;padding:3px 8px;cursor:pointer;font:inherit;white-space:nowrap}
.cwm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#ffffff0d)}
.cwm-btn:disabled{opacity:.45;cursor:default}
.cwm-btn-primary{border-color:var(--dsw-alias-state-business-primary,#4d9fff);background:var(--dsw-alias-state-business-primary,#4d9fff);color:#fff}
.cwm-btn-primary:hover:not(:disabled){filter:brightness(1.05);background:var(--dsw-alias-state-business-primary,#4d9fff)}
.cwm-panel{margin-top:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#1d2935);display:flex;flex-direction:column;gap:8px;max-height:420px;overflow:auto}
.cwm-panel-section{display:flex;flex-direction:column;gap:6px;min-width:0}
.cwm-panel-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cwm-panel-heading-actions{margin-left:auto;display:flex;gap:5px}
.cwm-panel-title{font-weight:600;color:var(--dsw-alias-label-primary,#e6edf3);font-size:12px}
.cwm-muted{color:var(--dsw-alias-label-tertiary,#8fa2b4)}
.cwm-small{font-size:11px}
.cwm-workspace-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:5px}
.cwm-workspace{display:flex;flex-wrap:wrap;gap:7px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1,#1d2935);border-radius:8px;padding:5px 7px;min-width:0}
.cwm-session-options{flex-basis:100%;padding-left:20px;max-height:160px;overflow:auto;font-size:11px;line-height:1.8}
.cwm-workspace:hover{border-color:var(--dsw-alias-border-l2,#334454);background:var(--dsw-alias-interactive-bg-hover,#ffffff08)}
.cwm-workspace-inactive{opacity:.55;cursor:default}
.cwm-workspace input{margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary,#4d9fff);flex:none}
.cwm-workspace-body{display:flex;flex-direction:column;gap:1px;min-width:0}
.cwm-workspace-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6edf3)}
.cwm-workspace-meta{color:var(--dsw-alias-label-tertiary,#8fa2b4);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cwm-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.cwm-unlock{display:flex;gap:6px;align-items:center}
.cwm-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#334454);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#0b1118);color:var(--dsw-alias-label-primary,#e6edf3);padding:4px 7px;font:inherit;min-width:180px;flex:1}
.cwm-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4d9fff)}
.cwm-empty{border:1px dashed var(--dsw-alias-border-l2,#334454);border-radius:8px;padding:8px;color:var(--dsw-alias-label-tertiary,#8fa2b4);text-align:center;font-size:11px}
.cwm-sources{border:1px solid var(--dsw-alias-border-l1,#1d2935);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:4px}
.cwm-subhead{font-weight:600;color:var(--dsw-alias-label-secondary,#9fb0c0);font-size:11px}
.cwm-source{padding:3px 0;border-top:1px solid var(--dsw-alias-border-l1,#1d2935)}
.cwm-source:first-of-type{border-top:0}
.cwm-source-line{display:flex;gap:5px;align-items:baseline;min-width:0}
.cwm-source-title{color:var(--dsw-alias-label-primary,#e6edf3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cwm-source-ref{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-tertiary,#8fa2b4);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.cwm-source-meta{color:var(--dsw-alias-label-tertiary,#8fa2b4);font-size:10px}
.cwm-security-line,.cwm-fingerprint{color:var(--dsw-alias-label-tertiary,#8fa2b4);font-size:10px}
.cwm-warn,.cwm-error{color:var(--dsw-alias-state-warning-primary,#d6a44a);font-size:11px;overflow-wrap:anywhere}
.cwm-error{color:var(--dsw-alias-state-error-primary,#e36b6b)}
.cwm-frame{display:block;width:100%;height:calc(100vh - 132px);min-height:640px;border:0;border-radius:12px;background:#0b0f14;color-scheme:light dark}
.cwm-compact .cwm-brand-text{display:none}
.cwm-compact .cwm-index-count{display:none}
.cwm-compact .cwm-pill-text{max-width:110px}
.cwm-compact .cwm-expand{padding-left:6px;padding-right:6px}
@media (max-width:760px){.cwm-frame{height:calc(100vh - 96px);min-height:540px;border-radius:8px}.cwm-index-count{display:none}.cwm-pill-text{max-width:95px}}
`;
      document.head.appendChild(style);
      return () => {
        try { style.remove(); } catch { /* page teardown */ }
      };
    }

    function installTokenBridge() {
      if (typeof window === 'undefined') return () => {};
      const onMessage = (event) => {
        if (event.origin !== window.location.origin) return;
        if (!settingsFrameWindow || event.source !== settingsFrameWindow) return;
        const data = event.data;
        if (!data) return;
        if (data.type === 'cwm-frame-ready' && event.source && typeof event.source.postMessage === 'function') {
          try {
            event.source.postMessage({ type: 'cwm-session-token', token: managementToken }, window.location.origin);
          } catch { /* frame gone */ }
          return;
        }
        if (data.type === STATE_EVENT) {
          notifyStateChanged();
          return;
        }
        if (data.type !== 'cwm-session-token-from-frame') return;
        if (typeof data.token === 'string' && data.token.length >= 20) {
          setManagementToken(data.token);
        } else if (data.token === null) {
          setManagementToken(null);
        }
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }

    function apply(ctx) {
      ctx.effect(installStyle, 'dsh-secure-memory: composer bar style');
      ctx.effect(installTokenBridge, 'dsh-secure-memory: settings token bridge');
      if (!ctx.slots || typeof ctx.slots.inject !== 'function') {
        console.warn('[dsh-secure-memory] slots service unavailable; Settings panel not registered');
        return;
      }

      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          {
            name: 'settings.section',
            id: 'secure-memory',
            order: 46,
            label: () => PRODUCT,
          },
          MemoryPanel,
        );
      });

      let primaryMounted = false;
      let fallbackDispose = null;
      ctx.slots.inject('conversation.input.dock', function* () {
        if (fallbackDispose) return;
        primaryMounted = true;
        yield ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'cwm-main-bar-v2',
            order: 30,
            label: () => PRODUCT,
          },
          CrossWorkspaceBar,
        );
      });

      // The official Client slots service does not expose an occupant list.
      // Try the secondary composer dock after a short grace period only when
      // the primary input dock never declared itself.
      ctx.effect(() => {
        const timer = setTimeout(() => {
          if (primaryMounted) return;
          fallbackUsed = true;
          try {
            fallbackDispose = ctx.slots.inject('conversation.composer.dock', function* () {
              yield ctx.slots.register(
                {
                  name: 'conversation.composer.dock',
                  id: 'cwm-main-bar-fallback',
                  order: 30,
                  label: () => PRODUCT,
                },
                CrossWorkspaceBar,
              );
            });
          } catch { /* settings fallback remains */ }
        }, 1500);
        return () => {
          clearTimeout(timer);
          try { fallbackDispose?.(); } catch { /* plugin teardown */ }
        };
      }, 'dsh-secure-memory: composer bar fallback');
    }

    module.exports = { name, inject, apply };
    return module.exports;
  };

  window.__ModuleLoader__.load({
    id: 'dsh-secure-memory',
    factory: makeFactory(),
  });
})();
