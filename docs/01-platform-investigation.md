# 阶段一：DeepSeek 官方平台能力与安全可行性调查报告

- 调查日期：2026-11-08
- 调查对象：DeepSeek 官方云聊天产品、DeepSeek 开放平台 API、DeepSeek Harness（DSH）桌面端插件运行时
- 结论等级：只依据可公开访问的官方文档与当前运行中的 DSH 实例。未验证的能力一律不当作存在。

## 0. 给项目负责人的一句话结论

**当前没有官方、公开、可授权的方式让第三方程序自动读取 DeepSeek 云聊天中其他“工作区”的历史会话。** DeepSeek 官方确认的历史数据出口是用户在“设置 → 数据管理 → 导出所有历史对话”中主动导出；DSH 提供的是**本地目录工作区 + 本地会话日志**，与云聊天历史不是同一数据源。因此本项目不会伪造云端跨工作区读取，而是交付一个诚实、可用的本地优先系统：

1. 对 DSH 本地工作区：通过官方 `workspaceRegistry` / `sessionPersistence` 服务，在用户逐工作区授权后读取本地会话文本并建立本地加密索引；
2. 对 DeepSeek 云聊天历史：只支持用户主动导入官方导出文件或规范化记忆包，明确标记为“手动快照”，不伪装成实时同步；
3. 对“官方云工作区实时连接器”：标记为**不可用**，不实现绕过访问控制的接口。

这满足项目的最高验收原则：**宁可功能少，也不降低数据安全标准。**

## 1. 能力矩阵

| # | 待验证能力 | 结论 | 依据与说明 |
|---|---|---|---|
| 1 | 读取 DeepSeek 云聊天的工作区列表 | **不支持（公开能力）** | 官方 API 参考只列出模型调用、文件、搜索/抓取、余额等端点，没有工作区或会话端点。官方隐私政策描述的是账号下的历史对话，没有公开的“工作区 API”。 |
| 2 | 官方历史对话导出 | **已确认支持（手动导出）** | 官方《DeepSeek 隐私政策》第 6.2.2 条明确给出路径：“点击头像账号区域 → 选择‘设置’ → 选择‘数据管理’ → ‘导出所有历史对话’”。这是用户主动发起的文件导出，不是 API。 |
| 3 | 公开 API 读取工作区历史信息 | **不支持** | 官方 API 端点清单没有 conversations / workspaces / messages history 读取接口；Messages API 与 Chat Completions API 都是**无状态**的，要求每次请求在 `messages` 中携带当前需要的对话历史。 |
| 4 | 第三方应用接入工作区 | **未确认 / 不提供公开授权流程** | 官方文档未提供针对云聊天历史的 OAuth、工作区授权或第三方应用数据访问流程。没有官方流程就不应自行拼接登录态。 |
| 5 | MCP 或类似工具协议 | **云 API 不支持原生 MCP；DSH 支持插件/Tool** | DeepSeek 的 Anthropic 兼容 Messages API 文档明确写着兼容字段 `mcp_servers` 会被忽略；官方 API 参考没有 MCP 服务端接入。DSH 是独立的本地 Agent Harness，提供 Tool/Plugin 扩展点，不能等同于云聊天支持 MCP。 |
| 6 | 插件向当前 AI 对话提供外部检索结果 | **云聊天：不支持；DSH：已确认支持** | DeepSeek 云聊天没有公开的上下文注入 API。DSH 的 Tool 结果会进入当前 Agent 上下文。本项目在 DSH 内通过 Tool 提供检索结果，并在 Tool 输出中明确标记为不可信历史参考。 |
| 7 | 安全获取原始对话和文档 | **部分支持：官方手动导出；DSH 本地只读服务** | 云聊天只能由用户手动导出。DSH 的 `SessionPersistence.open(id, 'read')` 只读打开本地会话；`WorkspaceRegistry` 提供本地工作区元数据。两者都不是云聊天接口。 |
| 8 | 用户授权与撤销授权 | **云聊天：没有细粒度第三方授权；DSH：由本项目实现本地授权** | 云聊天侧只能通过账号设置管理和导出数据。本项目只能在 DSH 进程内实现逐工作区授权，不能声称代表 DeepSeek 云端授权。 |
| 9 | 本地处理数据 | **已确认可行（DSH 本地插件）** | DSH 插件在用户设备上运行；本次实现使用 Node 内置 `crypto` 做本地加密、内置检索，不调用外部 Embedding/向量库。 |
| 10 | 官方认可的数据访问方式 | **官方手动导出 + DSH 官方本地服务** | 不把浏览器 Cookie、Session、内部接口、页面抓取作为数据源。 |

## 2. 关键证据

### 2.1 DeepSeek 开放平台 API 是无状态推理 API

官方 API 参考的端点包括：

- Chat Completions API
- Responses API
- Messages API
- FIM Completion API
- Lists Models
- Get User Balance
- Files（上传/列出/读取/删除文件）
- Search / Fetch

参考：[DeepSeek API Docs](https://api-docs.deepseek.com/)、[Messages API](https://api-docs.deepseek.com/api/create-message/)、[Lists Models](https://api-docs.deepseek.com/api/list-models/)。

Messages API 文档原文说明：

> “The conversation history. At least one message is required. This API is stateless: include the messages needed for the current turn in every request.”

这说明服务端不提供“读取某工作区历史”的会话对象；模型调用方必须自己携带历史。该文档还说明 `mcp_servers` 等兼容字段会被忽略。

### 2.2 官方历史导出是用户主动操作，不是 API

DeepSeek《隐私政策》第 6.2.2 条：

> “导出历史对话：点击头像账号区域--选择‘设置’--选择‘数据管理’--导出所有历史对话”

参考：[DeepSeek 隐私政策（中文）](https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html)。

该路径确认了官方数据出口存在，但它是手动文件导出。导出格式、文件结构可能随版本变化；本项目不能保证自动识别所有历史版本格式，因此同时提供规范化记忆包格式，并把“官方导出导入”明确标为手动快照。

### 2.3 DSH 工作区是本地目录，不是云聊天工作区

DSH 官方文档对 Workspace 的定义：

> “A workspace is the persistent record of a directory the user works in: a stable id over a canonical path, a display title, and the ordered account of sessions that belong to it.”

参考：[Workspaces](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/workspace.md)。

DSH 的会话持久化是本地追加日志；读取通过：

- `ctx.workspaceRegistry.list()` / `get(id)`
- `ctx.sessionPersistence.open(sessionId, 'read')`
- `SessionHandle.read(offset, length)`
- `SessionHandle.close()`

参考：[Session Persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence.md)。

因此：

- **可以**在 DSH 中实现“当前用户已授权的本地工作区之间”的跨项目记忆检索；
- **不可以**把 DSH 本地会话称为 DeepSeek 云聊天历史；
- 两者在 UI、审计和文档中必须使用不同名称。

### 2.4 DSH 支持 Tool 与 Client Slot，但没有云聊天注入通道

DSH 官方开发文档确认：

- 插件可以注册 Tool，Tool 结果进入当前 Agent 上下文（[Build a tool](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool.md)）；
- 插件可向 `settings.section` 等 Client Slot 注册管理界面（[Web Client Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots)）。

这只能证明 **DSH 内**的注入能力。DeepSeek 云聊天没有对应的公开插件 API，不能在云聊天页面中直接注入。

## 3. 禁止使用的方式（本项目不实现）

以下方式即使能“跑通”，也不属于合规实现：

- 读取浏览器 Cookie、LocalStorage、SessionStorage 或登录令牌；
- 调用 `chat.deepseek.com` 未公开的内部接口；
- 用用户账号密码/短信验证码模拟登录；
- 通过浏览器扩展抓取历史对话后静默上传；
- 把导出文件上传到第三方向量数据库或 Embedding 服务；
- 先取全量数据再在前端过滤；
- 把“手动导入”包装成“自动跨工作区同步”；
- 在日志中记录完整对话、密码、令牌或可逆凭据。

## 4. 合规替代方案（本项目的实现边界）

| 需求 | 合规实现 |
|---|---|
| 查看工作区 | DSH 本地工作区列表（官方服务）；手动导入的记忆源列表（明确标记） |
| 逐工作区授权 | 本地加密保险库内的授权记录；UI 主动授权；AI 无授权工具 |
| 跨工作区检索 | 只检索当前有效授权范围内的本地索引 |
| 云聊天历史 | 用户手动导出后导入；标为 `manual_snapshot` |
| AI 自动检索 | DSH Tool 调用；AI 可选择检索，但不能扩权 |
| 上下文提供 | Tool 返回带来源、状态、时间、冲突提示的不可信参考块 |
| 撤销授权 | 立即删除该工作区索引并从检索范围移除 |
| 删除数据 | 删除加密保险库及内存密钥；不保留可检索副本 |
| 审计 | 加密存储的元数据审计链；不存储完整查询和对话正文 |

## 5. 技术限制清单

1. **无云端实时连接器。** 不能自动读取 DeepSeek 云聊天历史；只能手动导入。
2. **DSH 本地工作区 ≠ 云工作区。** UI 会分别标注“DSH 本地工作区”和“手动导入源”。
3. **官方导出格式不保证稳定。** 提供规范化 JSON 记忆包与尽力解析；解析失败时不会猜测或上传。
4. **只能读取本地会话中的文本块。** 不索引系统提示、开发者消息、推理内容、工具调用参数/结果、图片和附件，以减少敏感数据收集。
5. **需要用户先解锁保险库。** 密钥只存在内存；重启/空闲锁定后 AI 检索会失败（安全降级）。
6. **本地 HTTP 回环传输。** DSH Web GUI 默认在 `127.0.0.1` 提供页面；插件拒绝非回环请求。若用户把 DSH 暴露到网络，该功能应停用，不应把口令跨网络发送。
7. **无法保证 SSD 物理擦除。** “删除”会删除密钥与密文文件并清空内存；受限于文件系统/SSD 磨损均衡，不能承诺物理介质不可恢复。
8. **不是多租户服务。** 数据隔离基于操作系统用户 + DSH profile + 用户口令；同一 OS 账号下共享进程的恶意软件不在可防御边界内。
9. **检索不是神经语义理解。** MVP 使用 BM25 + 本地字符 n-gram 向量；不调用第三方 Embedding，不把“相关性”伪装成“事实正确性”。
10. **AI 使用检索结果时，片段会进入当前模型上下文。** 插件本身不联网上传，但 DSH 会把当前对话（含工具结果）发送给当前模型服务商；这是 AI 使用记忆的必要传输，UI 必须明确告知。

## 6. 调查结论

- **可以交付**：一个在 DSH 内真实可用的、本地优先的跨工作区安全记忆系统。
- **不能交付**：一个读取 DeepSeek 云聊天工作区的自动连接器。
- **交付时必须显著说明**：DSH 本地工作区、手动 DeepSeek 导出、云 API 不可用，是三种不同状态，不能混为一谈。
- **安全优先级**：授权、加密、审计、撤销、删除先于检索功能；任何异常默认拒绝。
