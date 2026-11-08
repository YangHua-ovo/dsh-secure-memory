# 阶段二：安全架构与数据设计

## 1. 设计原则

1. **默认拒绝（Zero Trust）**：保险库锁定、无授权、授权过期、校验异常、审计链异常，一律拒绝检索。
2. **逐工作区独立授权**：A 工作区的授权永远不等于 B 工作区授权。
3. **权限先于检索**：先构造“当前有效授权工作区集合”，再只在该集合内取候选文档；禁止先全量检索再前端过滤。
4. **AI 不能扩权**：Agent 只有 `xw_memory_search` / `xw_memory_context` / `xw_memory_status` 三个只读工具；不存在授予、暂停、撤销、删除、导入工具。授权只能由已解锁管理界面（Bearer 会话令牌）发起。
5. **本地优先**：加密、索引、检索、知识图谱全部在本机进程内完成；不调用第三方 Embedding、向量数据库或云存储。
6. **最小收集**：DSH 同步只读取 `user/message` 与 `assistant/message` 的文本块；不读取系统提示、推理、工具调用参数/结果、图片、附件。
7. **最小保留**：撤销授权立即删除对应索引；临时授权到期自动清理；删除保险库同时销毁密钥和密文。
8. **来源透明**：每条记忆保留工作区 ID、会话 ID、事件序号、事件时间、角色、导入时间、分类、状态。
9. **历史不等于指令**：检索内容被视为不可信数据，经过转义、风险检测和隔离；高风险内容不进入模型上下文。
10. **失败安全降级**：密钥缺失、口令错误、审计链损坏、请求来源异常、数据损坏时拒绝访问，不尝试绕过。

## 2. 系统上下文

```text
┌──────────────────────────────────────────────────────────────────┐
│ DeepSeek 云聊天（chat.deepseek.com）                              │
│  · 无公开工作区/历史读取 API                                      │
│  · 仅支持用户手动“导出所有历史对话”                                │
└──────────────────────────────┬───────────────────────────────────┘
                               │ 用户主动导出文件（手动快照）
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ DSH 本地 Harness（本插件运行的边界）                              │
│                                                                  │
│  DSH 本地工作区（workspaceRegistry，本地目录）                    │
│  DSH 本地会话日志（sessionPersistence，只读）                     │
│                    │                                             │
│                    ▼                                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ dsh-secure-memory Host 插件                                │  │
│  │  Workspace Connector → Permission Gate → Indexer           │  │
│  │  → Retrieval Engine → Validator → Context Builder          │  │
│  │  → Security Center（加密/审计/删除）                       │  │
│  └───────────────┬───────────────────────────┬────────────────┘  │
│                  │ Tool 结果（只读、不可信） │ 本地回环 HTTP     │
│                  ▼                           ▼                   │
│          当前 Agent 上下文              管理界面（iframe）       │
│                  │                           │                   │
│                  ▼                           ▼                   │
│          当前模型服务商（由 DSH 配置）   用户显式授权/撤销         │
└──────────────────────────────────────────────────────────────────┘
```

**边界声明**：图中“当前模型服务商”可能是 DeepSeek。插件本身不发起外网请求，但 Tool 返回的记忆片段会作为当前对话上下文发送给模型服务商。UI 必须向用户说明这一点。

## 3. 组件架构

| 组件 | 文件 | 职责 | 关键安全约束 |
|---|---|---|---|
| Host 入口 | `lib/index.js` | 注册 Tool、HTTP 路由、生命周期 | 不注册任何授权/删除 Tool |
| Vault | `lib/core/vault.js` | scrypt 派生密钥、AES-256-GCM 加解密、原子写入 | 密钥只在内存；错误口令不泄露细节 |
| Store | `lib/core/store.js` | 状态、授权、文档、审计、排除规则 | 所有写入串行化；授权变更记审计 |
| Authz | `lib/core/authz.js` | 有效授权集合、过期清理、撤销清理 | 先鉴权后检索；默认拒绝 |
| Ingest | `lib/core/ingest.js` | DSH 会话只读提取、导入解析、脱敏 | 只读；不读工具/推理/附件；大小上限 |
| Retrieval | `lib/core/retrieval.js` | BM25 + 字符 n-gram 向量 + 混合排序 | 只接收已授权候选集；片段化 |
| Validator | `lib/core/validate.js` | 可信度启发式、时间、潜在冲突 | 不替用户裁决冲突；只提示 |
| Sanitizer | `lib/core/sanitize.js` | 控制字符/零宽字符清理、注入检测、转义 | 高风险内容隔离，不进入模型 |
| Context | `lib/core/context.js` | 去重、排序、分组、结构化参考块 | 固定安全头；内容转义；总量上限 |
| HTTP API | `lib/server/routes.js` | 本地管理 API、静态 UI | 回环限制；Bearer 会话令牌；Origin 检查 |
| UI | `lib/assets/*` | 六个功能面板 | 不在 Storage 持久化令牌；无第三方资源 |

## 4. 权限模型

### 4.1 身份

本插件是单机单用户插件，不引入服务端账户系统。有效身份由三层组成：

1. 操作系统用户（文件系统隔离）；
2. DSH profile（`DSH_PROFILE`，数据目录隔离）；
3. 用户口令（保险库加密密钥，解锁后才可访问）。

文档中仍保留 `vaultId` 与 `profile` 标识，避免不同 profile 的数据进入同一保险库。插件不读取 DSH 账号令牌，不把 DSH 账号 ID 当授权依据。

### 4.2 授权记录

```json
{
  "workspaceId": "ws_...",
  "mode": "temporary" | "long-term",
  "expiresAt": "2026-11-09T12:00:00.000Z" | null,
  "paused": false,
  "defaultRetrieval": true,
  "grantedAt": "...",
  "grantedBy": "local-user-ui",
  "source": "dsh-local" | "manual-import"
}
```

授权状态：

| 状态 | 判定 |
|---|---|
| 未授权 | 无 grant 记录 |
| 临时授权 | `mode=temporary` 且未过期且未暂停 |
| 长期授权 | `mode=long-term` 且未暂停 |
| 暂停访问 | `paused=true` |
| 已撤销 | grant 被删除，审计中保留 `grant.revoke` 事件 |
| 数据同步中 | 仅 UI 瞬时状态，不持久化 |
| 已过期 | `now >= expiresAt`，自动删除索引与 grant |

### 4.2a 会话级关联（v0.0.2）

在原有 grant 之上增加**进一步收窄**：

```jsonc
"sessionScopes": {
  "session-...": { "enabled": true, "workspaceIds": ["ws_a", "ws_c"], "updatedAt": "ISO" }
}
```

- 新会话默认 `enabled=false, workspaceIds=[]`，不继承其他会话。
- AI Tool 先读当前 sessionId 的 scope，再与有效 grant 求交集；只会变窄，不会变宽。
- Tool 显式 workspaceIds 必须是当前会话有效 scope 的子集，否则拒绝。
- 授权 A/B/C、会话选 A/C → B 不参与评分、上下文、来源和状态。
- 撤销/过期会从所有 sessionScopes 中移除该 workspace。
- 会话 scope 只由已解锁管理 token 的 UI 写入；AI Tool 没有写入能力。
- Settings 手动检索是管理面，仍可按全部有效 grant 搜索；不冒充当前会话 AI 检索。

### 4.3 鉴权顺序

```text
请求 / Tool 调用
  → 保险库已解锁？否 → 拒绝 LOCKED
  → 审计链完整？否 → 拒绝 INTEGRITY
  → 处理过期/撤销授权（删除索引）
  → 解析请求的工作区范围
  → [v0.0.2 AI Tool] 当前会话 enabled？否 → 拒绝 SESSION_DISABLED
  → [v0.0.2 AI Tool] 与有效 grant 求交集；请求范围必须是子集
  → 每个工作区都有有效 grant？否 → 拒绝 DENIED（不返回任何内容）
  → 只从授权集合构造候选文档
  → 检索 / 图谱 / 时间线
  → 写审计
  → 返回结果
```

**硬性规则**：`index.search()` 的输入包含 `allowedWorkspaceIds`，内部第一步就是 `docs.filter(allowed)`；不存在“先检索全部再隐藏”的路径。

### 4.4 AI 能力面

| 能力 | Agent Tool | 管理 API |
|---|---|---|
| 搜索已授权记忆 | ✅ 只读 | ✅ 需 Bearer |
| 获取结构化上下文 | ✅ 只读 | ✅ 需 Bearer |
| 查看授权/索引统计 | ✅ 仅计数 | ✅ |
| 授权工作区 | ❌ | ✅ |
| 暂停/撤销 | ❌ | ✅ |
| 导入/同步 | ❌ | ✅ |
| 修改记忆状态/排除 | ❌ | ✅ |
| 删除保险库 | ❌ | ✅ 需确认短语 |

Agent 即使被历史对话注入，也无法通过 Tool 扩权。若 Agent 拥有通用 `bash` 工具，它可以尝试访问本地 HTTP 接口；接口要求解锁时生成的随机 Bearer 令牌，该令牌只存在于管理页面内存中，不写入 DOM/Storage/日志。该边界在“OS 用户 + DSH 进程”信任模型内成立。

## 5. 数据流

### 5.1 DSH 本地工作区同步

```text
用户点击“授权并索引”
  → 本地回环 API（Bearer）验证
  → WorkspaceRegistry.get(id) 校验工作区真实存在
  → 写入 grant（临时/长期）
  → SessionPersistence.open(sessionId,'read')（只读）
  → 读取事件，仅提取 user/assistant 文本块
  → 排除 system/developer/reasoning/tool/附件
  → 秘密扫描与脱敏（API key/私钥/密码赋值等）
  → 字符规范化、长度/数量上限
  → 生成 doc（workspaceId/sessionId/seq/time/role/title/hash）
  → 追加到内存状态
  → AES-256-GCM 加密写盘（原子替换）
  → 审计 sync
```

### 5.2 手动导入

```text
用户选择 JSON / Markdown 文件
  → 浏览器读取文本（不上传外网）
  → 本地回环 API（Bearer）
  → 解析规范化记忆包 / 尽力解析常见导出 JSON
  → 逐文档验证类型、长度、时间
  → 脱敏
  → 创建“手动导入源”工作区
  → 授权并写入加密保险库
  → 审计 import
```

手动导入不会标记为云端实时连接；UI 显示 `MANUAL SNAPSHOT` 徽标。

### 5.3 检索与上下文

```text
Agent 调用 xw_memory_context
  → Authz 取有效授权集合
  → Retrieval 仅在该集合内计算 BM25 + 向量
  → 去重 / 过滤排除项 / 高风险隔离
  → Validator 计算可信度提示、时间、潜在冲突
  → Context Builder 生成带安全边界和来源的参考块
  → 审计 search（查询哈希，不存原文）
  → Tool 返回文本给当前 Agent
```

## 6. 数据库/状态结构

保险库是单个加密 JSON 文件；逻辑结构如下（写入前序列化，AES-256-GCM 加密）。

```jsonc
{
  "format": "dsh-secure-memory",
  "version": 1,
  "vaultId": "uuid",
  "profile": "desktop",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "workspaces": [
    {
      "id": "ws_...",
      "kind": "dsh-local" | "manual-import",
      "externalId": "DSH WorkspaceId / null",
      "title": "...",
      "description": "...",
      "createdAt": "ISO",
      "lastSyncAt": "ISO | null",
      "sessionCount": 0
    }
  ],
  "grants": [
    {
      "workspaceId": "ws_...",
      "mode": "temporary" | "long-term",
      "expiresAt": "ISO | null",
      "paused": false,
      "defaultRetrieval": true,
      "grantedAt": "ISO"
    }
  ],
  "docs": [
    {
      "id": "doc_...",
      "workspaceId": "ws_...",
      "sourceKind": "dsh-session" | "manual-pack" | "deepseek-export",
      "sourceRef": "session:<id>#seq:<n> | file:<name>#<index>",
      "sourceSessionId": "... | null",
      "sourceSeq": 0,
      "conversationTitle": "...",
      "role": "user" | "assistant" | "document",
      "title": "...",
      "content": "脱敏后的文本",
      "contentHash": "sha256",
      "createdAt": "ISO",
      "importedAt": "ISO",
      "lastConfirmedAt": "ISO | null",
      "category": "decision|verified|idea|tentative|deprecated|unresolved|background|preference",
      "status": "active|unverified|confirmed|deprecated",
      "tags": ["..."],
      "risk": "low|medium|high",
      "language": "zh|en|mixed"
    }
  ],
  "exclusions": [
    { "docId": "doc_...", "reason": "user", "createdAt": "ISO" }
  ],
  "excludedSessions": [
    { "sourceSessionId": "…", "reason": "user", "createdAt": "ISO" }
  ],
  "excludedSources": [
    { "sourceName": "deepseek-export.json", "reason": "user", "createdAt": "ISO" }
  ],
  "blockedTerms": ["..."],
  "sessions": {
    "sessionId": {
      "workspaceId": "ws_...",
      "revision": "opaque",
      "indexedAt": "ISO",
      "documentCount": 0
    }
  },
  "settings": {
    "maxResults": 8,
    "maxContextChars": 8000,
    "blockHighRisk": true,
    "autoLockMinutes": 30
  }
}
```

> 审计不放进上述大状态文件，而是独立加密为 `audit.enc`：这样一次搜索只写一条小审计，不会重新加密整个索引。审计条目结构见第 9 节。

### 6.1 文档上限

- 单文档正文：100,000 字符（超出截断并标记）
- 单次同步每工作区：3,000 文档 / 4,000,000 字符
- 全库：10,000 文档 / 15,000,000 字符
- 单次导入文件：8 MB；单次导入最多 3,000 文档
- 单会话同步事件：最近 4,000 个事件；超出会明确警告，不静默全量
- 搜索查询：500 字符
- 搜索结果：最多 12 条；上下文：最多 8 条 / 8,000 字符

超限时拒绝或截断，不静默丢弃安全告警。

## 7. 加密与密钥管理

### 7.1 文件格式

```json
{
  "format": "dsh-secure-memory-vault",
  "version": 1,
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "keyLen": 32, "salt": "base64" },
  "cipher": { "name": "aes-256-gcm", "iv": "base64", "tag": "base64" },
  "createdAt": "ISO",
  "payload": "base64(ciphertext)"
}
```

- KDF：`scrypt(passphrase, salt, N=32768, r=8, p=1)`，`maxmem=128 MiB`。
- 加密：AES-256-GCM；每次保存生成新的 12 字节随机 IV。
- AAD：`format|version|createdAt|kdf` 的规范化字符串，防止参数替换。
- 口令：至少 12 个 Unicode 字符；拒绝常见弱口令；不保存、不记录、不回显。
- 密钥：只保存在 Host 进程内存；锁定/空闲超时/插件卸载时 `key.fill(0)` 并丢弃状态。
- 写入：临时文件 + `fsync` + 原子 `rename`；权限尽量设为 0600（Windows 上由用户目录 ACL 提供主要保护）。
- 审计 HMAC：从保险库密钥经 HKDF 派生独立审计密钥；审计链断裂时检索失败，直到用户在 Security Center 显式重建（保留告警）。
- 状态/审计一致性：保险库状态先写入，审计随后追加。解锁时比较 `state.updatedAt` 与最后一条审计时间；若状态明显新于审计（>2 秒容差），按审计异常处理，拒绝检索。该检查能发现“写状态后崩溃、审计未落盘”的窗口。
- 本地管理 API：只接受回环 socket；`Host` 必须是 `127.0.0.1` / `localhost` / `[::1]`，防止 DNS rebinding；`Origin` 必须同源；数据接口要求解锁时颁发的内存 Bearer 令牌。令牌不写入 URL/Storage/日志。

### 7.2 威胁模型

| 威胁 | 影响 | 缓解 |
|---|---|---|
| 未授权工作区被读取 | 数据泄露 | 默认无 grant；同步/检索都校验 grant；撤销立即删索引 |
| 历史提示注入让 AI 扩权 | 越权读取/外传 | Agent 无授权工具；检索结果标记不可信；高风险隔离；固定安全提示 |
| 本地文件被复制 | 离线泄露 | AES-256-GCM + scrypt；密钥不与密文同存 |
| 口令被日志记录 | 密钥泄露 | 口令只进 KDF；日志/审计不记录请求体；UI 不持久化 |
| API 被本机其他进程调用 | 数据泄露 | 回环限制 + Bearer 解锁令牌 + Origin 检查；令牌只在页面内存 |
| 审计被篡改 | 事后掩盖 | HMAC 链；损坏则 fail-closed |
| 撤销后仍可搜到 | 违反用户意愿 | revoke 原子删除 docs/sessions 并写盘；搜索前再次校验 |
| 第三方 Embedding 泄露 | 数据外流 | 不使用外部 Embedding；本地字符向量 |
| 模型将历史当当前指令 | 行为劫持 | 参考块固定声明、转义、注入检测、高风险不进入上下文 |
| SSD 物理恢复 | 删除不彻底 | 删除密钥+密文；文档明确不可承诺物理擦除 |
| 远程 DSH 暴露 | 口令/数据过网 | 拒绝非回环请求、非回环 Host、非回环 Origin；文档要求不要在远程暴露时使用 |
| DNS rebinding | 浏览器经恶意域名访问本地 API | Host 白名单 + Origin 同源 + 回环检查 + Bearer |
| 审计/状态撕裂 | 状态已变更但审计未落盘 | 解锁时比较 `state.updatedAt` 与最后审计时间；异常则拒绝检索 |

### 7.3 非目标/边界

- 不防御已取得 OS 用户权限、能读取浏览器进程内存的恶意软件。
- 不防御用户主动把解锁后的浏览器交给他人。
- 不把“加密”宣传为“绝对安全”；口令丢失不可恢复。
- 不提供云端多租户隔离，因为本插件不运行云服务。

## 8. 数据生命周期

| 阶段 | 行为 |
|---|---|
| 创建 | 用户设置口令 → 生成随机盐/密钥 → 写入空保险库 |
| 收集 | 仅 DSH 用户/助手文本块或用户手动导入文件 |
| 索引 | 内存中构建；加密落盘；无外部服务 |
| 使用 | 先鉴权；按需检索；每次检索写最小审计 |
| 暂停 | 保留加密索引，但检索拒绝 |
| 撤销 | 删除该工作区 docs/sessions/grant；写审计；立即生效 |
| 排除会话/来源/单条 | 在检索前排除；不进入上下文/图谱；可恢复 |
| 临时到期 | 自动执行撤销清理 |
| 锁定 | 清空内存密钥与解密状态；Tool 拒绝 |
| 删除单条 | UI 可排除/标记；排除项在同步后仍保留 |
| 删除全部 | 删除密文、临时文件与目录；清空内存；审计随保险库一起删除 |
| 备份 | 不自动创建；用户可自行复制加密文件；插件不保留隐藏副本 |

## 9. 审计设计

记录字段：

- 时间、actor（用户 UI / Agent Tool / system）
- 动作（unlock/lock/grant/revoke/pause/sync/import/search/deny/delete/repair）
- 工作区 ID 列表
- 查询哈希（SHA-256，不存原文）
- 结果数量
- 结果来源 ID（仅计数或前 N 个 ID，不含正文）
- 权限拒绝原因
- 授权变更
- 删除操作

不记录：

- 完整对话正文
- 口令、密钥、Bearer 令牌
- 完整查询原文
- 文件内容
- 第三方令牌

审计保留在加密保险库内，用户可在 Security Center 查看最近 200 条。删除保险库会删除审计；删除前 UI 可导出审计摘要（可选）。

## 10. 关键安全不变量（测试必须覆盖）

1. 无 grant 的工作区文档数量对检索贡献为 0。
2. 撤销后同一查询不再返回该工作区任何内容。
3. 临时授权过期后自动删除文档与 grant。
4. 搜索候选集构造前先过滤授权，不可通过请求参数指定越权 ID。
5. 保险库锁定/口令错误/文件损坏时 Tool 返回失败，不返回缓存数据。
6. 高风险注入内容不进入 `xw_memory_context`。
7. 历史文本中的 `</untrusted_reference_data>` 等闭合标签被转义。
8. 密文文件中不出现已知明文、口令、API key。
9. API 无 Bearer 时不能读取工作区列表/文档/审计。
10. 非回环请求被拒绝。
11. 删除保险库后，原路径不存在且 Tool 失败。
12. 审计链断裂或状态新于审计时，检索失败。
13. 同步只读取 user/assistant 文本块，不读取 tool/reasoning/system 内容。
14. 撤销/删除后内存中不再保留可检索文档（至少清空索引缓存）。
15. AI Tool 参数不能触发授权、撤销、删除或导入。
16. 被排除的单条记忆、会话或来源文件在检索前被过滤，且不出现在图谱中。
17. 非回环 Host（DNS rebinding）与跨源 Origin 请求被拒绝。
18. 管理 API 无 Bearer 时不能读取状态、记忆、图谱、时间线或审计。

## 11. 与 DSH 官方扩展点对应

| 扩展点 | 用途 | 官方依据 |
|---|---|---|
| `ctx.tools.register` | 注册三个只读 Tool | DSH Tool 文档 |
| `ctx.webServer.register` | 本地管理页与 API | DSH Web Server / 插件实践 |
| `ctx.workspaceRegistry` | 列出/校验本地工作区 | DSH Workspace 文档 |
| `ctx.sessionPersistence` | 只读打开会话日志 | DSH Session Persistence 文档 |
| Client `settings.section` slot | 在设置中挂载管理界面 | DSH Slots 文档 |
| `ctx.effect` | 生命周期清理 | Cordis/DSH 插件文档 |

不使用任何未公开的云聊天接口、浏览器凭据或页面抓取。
