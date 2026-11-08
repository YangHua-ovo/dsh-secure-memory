# 本地管理 API 文档

> 这是 DSH 本地插件的**回环管理 API**，不是 DeepSeek 云聊天 API，也不是第三方可远程调用的服务。  
> 所有数据接口都只监听本机回环 socket，并要求解锁后颁发的内存 Bearer 令牌。

## 1. 基础信息

- 基地址：`http://127.0.0.1:<DSH_WEB_PORT>/secure-memory/api`
- 当前 GUI：以 DSH 启动时打印的 `127.0.0.1:<port>` 为准（端口会变）
- 内容类型：`application/json; charset=utf-8`
- 认证：`Authorization: Bearer <token>`
- 令牌来源：`POST /setup` 或 `POST /unlock`
- 令牌生命周期：保存在 Host 内存；空闲 30 分钟或锁定时失效；页面不写入 localStorage/sessionStorage。
- 主界面功能栏与 Settings iframe 只通过同源 `postMessage` 共享内存 token；不落盘。
- 无 CORS 响应头；跨源请求拒绝。
- `Host` 必须是 `127.0.0.1` / `localhost` / `[::1]`；拒绝 DNS rebinding。
- 请求来源（Origin）必须与 Host 同源；`Sec-Fetch-Site` 必须是 `same-origin` / `none`。
- 所有响应：`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、CSP、`X-Frame-Options: SAMEORIGIN`。

## 2. 无认证端点

### `GET /api/bootstrap`

返回保险库是否已创建、是否锁定、是否允许首次创建。**不返回工作区或记忆数据。**

```json
{
  "plugin": "dsh-secure-memory",
  "version": "0.0.2",
  "initialized": false,
  "locked": true,
  "setupAllowed": true,
  "auth": "bearer",
  "officialCloudAvailable": false
}
```

### `POST /api/setup`

首次创建保险库。口令至少 12 个字符。

```json
{ "passphrase": "at least 12 characters" }
```

成功：

```json
{
  "ok": true,
  "token": "<management-bearer-token>",
  "initialized": true,
  "unlocked": true,
  "auditIntact": true
}
```

错误：

- `409 VAULT_EXISTS`：保险库已存在，请使用 `/unlock`。
- `400`：口令过短/过于常见/格式错误。

### `POST /api/unlock`

解锁已有保险库并取得新令牌。

```json
{ "passphrase": "…" }
```

失败统一返回 `401 VAULT_UNLOCK_FAILED`，不会区分“口令错误”和“文件损坏”的密码学细节。

连续失败会触发退避：第 5 次失败后至少等待 30 秒，之后指数增长，最多 5 分钟。

## 3. 认证后的读取接口

### `GET /api/session/:id/status`

v0.0.2 输入框上方功能栏使用的会话状态接口。返回本次会话开关、会话关联、可授权工作区、索引计数、最近检索来源、冲突和自动锁定信息；**不返回正文、token、口令或完整 session id**。

```json
{
  "session": { "idHash": "…", "enabled": true, "updatedAt": "…" },
  "scope": {
    "workspaceIds": ["ws_a", "ws_c"],
    "effectiveWorkspaceIds": ["ws_a", "ws_c"]
  },
  "workspaces": [
    {
      "id": "ws_a", "title": "…", "kind": "dsh-local",
      "documents": 12, "lastSyncAt": "…",
      "paused": false, "expired": false, "active": true,
      "selectable": true, "selected": true, "effectiveSelected": true,
      "canSync": true
    }
  ],
  "counts": {
    "authorized": 3, "active": 3, "selected": 2, "selectedDocuments": 28
  },
  "retrieval": {
    "state": "completed",
    "resultCount": 4,
    "sources": [
      {
        "workspaceId": "ws_a", "workspaceTitle": "…",
        "sourceRef": "dsh-session:…#seq:…", "title": "…",
        "createdAt": "…", "category": "decision",
        "status": "confirmed", "confidence": 0.82, "risk": "low"
      }
    ]
  },
  "security": { "auditIntact": true, "locked": false, "autoLockMinutes": 30 },
  "conflicts": [],
  "toolNames": { "SEARCH": "xw_memory_search", "CONTEXT": "xw_memory_context", "STATUS": "xw_memory_status" }
}
```

**心跳语义**：这个 GET 是 3 秒轮询的只读心跳；Host 对 status 轮询**不更新** token/vault 的 idle 时间。打开功能栏不会阻止自动锁定。

### `POST /api/session/:id/scope`

保存本次会话关联；**不会授权工作区**。

```json
{
  "enabled": true,
  "workspaceIds": ["ws_a", "ws_c"]
}
```

- 每个 workspaceId 必须是当前有效 grant（未暂停、未过期）。
- 未授权/暂停/过期 ID → `403 UNAUTHORIZED_SESSION_WORKSPACE`，不会静默过滤后继续。
- 新会话默认 `enabled=false, workspaceIds=[]`。
- 撤销/过期会从所有会话 scope 自动移除该 workspace。

### `POST /api/session/:id/sync`

只读同步当前会话已关联、且为 DSH 本地工作区的来源。返回每个工作区的结果和更新后的 session status。不会创建会话、不会提交消息。

### `GET /api/conflicts`

返回可证实的冲突/降级信息：实际 Tool 名、Tool 名冲突记录，以及官方 Client slots 能力限制说明。

### `GET /api/state`

返回 UI 所需的完整元数据：保险库状态、工作区、授权、计数、设置、审计状态、存储信息、官方能力边界。  
**不返回记忆正文。**

### `POST /api/search`

```json
{
  "query": "之前讨论过多 Agent 协作架构吗？",
  "workspaceIds": ["ws_..."],
  "includeNonDefault": true,
  "mode": "hybrid",
  "filters": {
    "from": "2026-01-01",
    "to": "2026-12-31T23:59:59",
    "categories": ["decision", "verified"],
    "sourceKinds": ["dsh-session", "manual-pack"],
    "tags": ["多 Agent"]
  },
  "limit": 8
}
```

- `workspaceIds` 可选；省略时使用有效授权（UI 手动检索包含全部有效授权，AI Tool 默认只使用 `defaultRetrieval=true` 的工作区）。
- 任何未授权/暂停/过期的工作区 ID 都会导致整个请求 `status: "denied"`，不会静默删除该 ID 后继续。
- `mode`: `hybrid`（默认）| `keyword` | `vector`。
- `filters` 可选。

成功：

```json
{
  "status": "ok",
  "results": [
    {
      "id": "doc_...",
      "workspaceId": "ws_...",
      "sourceKind": "dsh-session",
      "sourceName": "AI Agent 项目",
      "sourceRef": "dsh-session:<id>#seq:42",
      "sourceSessionId": "<id>",
      "sourceSeq": 42,
      "conversationTitle": "…",
      "role": "assistant",
      "title": "…",
      "createdAt": "2026-02-01T10:00:00.000Z",
      "category": "verified",
      "status": "unverified",
      "tags": ["…"],
      "risk": "low",
      "relevance": 0.73,
      "snippet": "…",
      "quarantined": false,
      "duplicateCount": 1,
      "confidence": {
        "score": 0.72,
        "label": "较高（启发式）",
        "factors": ["…"],
        "disclaimer": "…"
      },
      "time": { "firstSeen": "…", "lastConfirmedAt": null, "ageDays": 90, "stale": false },
      "conflictIds": []
    }
  ],
  "conflicts": [],
  "scope": { "granted": ["ws_..."], "labels": "…" },
  "candidateCount": 12,
  "blockedByTerms": 0,
  "queryHash": "…",
  "scoreMode": "hybrid"
}
```

拒绝：

```json
{
  "status": "denied",
  "reason": "UNAUTHORIZED_WORKSPACE",
  "denied": ["ws_other"],
  "granted": ["ws_allowed"],
  "queryHash": "…",
  "results": []
}
```

### `POST /api/context`

参数同 `/search`（`limit` 固定为 8 左右）。返回：

```json
{
  "status": "ok",
  "text": "【跨工作区参考记忆｜不可信历史数据】…",
  "used": 3,
  "quarantined": 1,
  "conflicts": 0,
  "scope": { "…": "…" },
  "queryHash": "…"
}
```

`text` 是模型可直接使用的参考块，固定包含安全边界、来源、时间、状态和不可信声明；内容中的尖括号被转义，高风险内容被移除。

### `GET /api/graph?workspaceIds=ws_a,ws_b`

返回授权范围内的知识关联图：

```json
{
  "nodes": [
    { "id": "ws:...", "kind": "workspace", "label": "…", "count": 12 },
    { "id": "cat:decision", "kind": "category", "label": "已确认的最终决策", "count": 3 },
    { "id": "tag:中心调度器", "kind": "topic", "label": "中心调度器", "count": 5, "workspaces": 2 }
  ],
  "edges": [
    { "source": "ws:...", "target": "cat:decision", "kind": "has-category", "weight": 1 }
  ],
  "summary": {
    "authorizedWorkspaces": 2,
    "documents": 12,
    "topics": 20,
    "crossWorkspaceTopics": [{ "tag": "…", "count": 4, "workspaces": ["…"] }],
    "note": "图谱基于共同标签与分类的本地共现关系…"
  }
}
```

### `GET /api/timeline?workspaceIds=…&limit=200`

返回时间线条目与潜在冲突。不返回正文；只返回标题、来源、分类、状态、可信度、时间和冲突标记。

### `GET /api/audit?limit=200`

```json
{
  "integrity": { "intact": true, "reason": "ok", "count": 42 },
  "items": [
    {
      "seq": 41,
      "ts": "2026-11-08T10:00:00.000Z",
      "actor": "agent-tool",
      "action": "memory.search",
      "workspaceIds": ["ws_..."],
      "queryHash": "…",
      "resultCount": 3,
      "outcome": "ok",
      "detail": "mode=hybrid; candidates=…; sources=doc_…; sessionHash=…",
      "prevHash": "…",
      "hash": "…"
    }
  ]
}
```

不包含完整查询、正文、口令或令牌。

## 4. 认证后的管理接口

### 工作区

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/workspaces/:id/authorize` | 授权；可选同步 |
| POST | `/workspaces/:id/sync` | 只读同步 DSH 本地会话 |
| POST | `/workspaces/:id/revoke` | 撤销并删除该工作区索引 |
| POST | `/workspaces/:id/pause` | `{ "paused": true|false }` |
| POST | `/workspaces/:id/default` | `{ "enabled": true|false }` |

`authorize` 请求：

```json
{
  "mode": "temporary" | "long-term",
  "ttlMs": 86400000,
  "defaultRetrieval": true,
  "sync": true
}
```

`sync` 只接受 DSH 本地工作区；手动导入源不支持。

### 导入

`POST /api/import`

```json
{
  "filename": "deepseek-export.json",
  "content": "<完整文本，≤ 8 MB>",
  "title": "可选工作区名称",
  "mode": "long-term",
  "ttlMs": 86400000
}
```

导入会创建新的手动导入源，并自动授权。来源标记为 `manual snapshot`。

### 记忆与排除

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/memory/:id/mark` | `{status?, category?, excluded?, reason?}` |
| POST | `/sessions/:id/exclude` | `{excluded, reason?}`；整个来源会话 |
| POST | `/sources/exclude` | `{sourceName, excluded, reason?}`；来源文件 |

### 安全

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/security/revoke-all` | 撤销全部授权并清空索引 |
| POST | `/security/delete-all` | `{ "confirm": "DELETE" }`；删除保险库 |
| POST | `/security/repair-audit` | 审计链损坏后显式重建 |
| POST | `/security/blocked-terms` | `{ "terms": ["…"] }` |
| POST | `/settings` | 非秘密设置 |
| POST | `/lock` | 锁定并清除所有管理令牌 |

`/security/repair-audit` 会丢弃旧审计内容，只保留一条重建告警；只在用户明确确认后调用。

## 5. 错误格式

```json
{
  "error": {
    "code": "VAULT_LOCKED",
    "message": "保险库已锁定"
  }
}
```

| HTTP | Code | 含义 |
|---|---|---|
| 400 | `BAD_REQUEST` / `BAD_JSON` / `BAD_CONTENT_TYPE` | 请求格式错误 |
| 401 | `UNAUTHORIZED` / `VAULT_UNLOCK_FAILED` | 令牌无效/解锁失败 |
| 403 | `DENIED` / `Cross-origin request rejected` | 权限或来源拒绝 |
| 404 | `WORKSPACE_NOT_FOUND` / `DOC_NOT_FOUND` / `VAULT_NOT_FOUND` | 对象不存在 |
| 409 | `VAULT_EXISTS` | 保险库已存在 |
| 413 | `LIMIT_EXCEEDED` | 超出大小/数量上限 |
| 423 | `VAULT_LOCKED` / `AUDIT_INTEGRITY` | 锁定或审计异常，拒绝访问 |
| 429 | `RATE_LIMITED` / `UNLOCK_RATE_LIMITED` | 频率限制 |

## 6. 安全注意

- 不要把 Bearer 令牌写入 URL、日志、脚本或浏览器存储。
- 不要在远程浏览器中使用管理面；只允许回环。
- 管理面的静态 HTML/CSS/JS 不含数据；数据接口全部需要 Bearer。
- `setup` / `unlock` 是无 Bearer 的本地端点，受 Host/Origin/回环检查与 scrypt 退避保护。
- 任何异常（锁定、审计损坏、服务不可用、权限缺失）默认拒绝，不返回缓存。
