# Cross-Workspace Memory

[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-blue)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Security: AES-256-GCM](https://img.shields.io/badge/Security-AES--256--GCM-green)](https://github.com/YangHua-ovo/dsh-secure-memory)

**本地优先、逐工作区授权、逐会话关联、可撤销、可审计的跨工作区记忆插件（DSH / DeepSeek Harness）。**

> v0.0.2：主操作入口已迁移到对话输入框上方；工作区“授权”和“本次会话关联”严格分离。  
> 安全优先于功能完整性，隐私优先于检索便利性。如果官方能力不足，本插件选择明确拒绝，而不是绕过访问控制。

---

## v0.0.2 速览

- 输入框上方新增 **Cross-Workspace Memory** 紧凑功能栏。
- 每个会话独立选择工作区；已授权 A/B/C 但本会话只选 A/C 时，B 不参与检索。
- 新会话默认 **未启用、空选择**，不会继承其他会话。
- 开关/选择/收起/刷新全部是本地状态更新，不提交消息、不创建会话。
- 解锁 token 在 DSH 页面运行期内存复用；打开 Settings 不需要重复输入（刷新整页/重启仍需解锁，不保存口令）。
- Settings 页面保留，继续负责首次设置、授权、删除和审计。

详见：[v0.0.2 变更说明](docs/v0.0.2-changes.md) · [v0.0.2 测试报告](docs/v0.0.2-test-report.md)。

---

## 1. 明确能力边界

### 已确认支持

| 能力                | 实现                                                  |
| ----------------- | --------------------------------------------------- |
| DeepSeek 官方历史对话导出 | 用户在官方 App/网页「设置 → 数据管理 → 导出所有历史对话」手动导出，再导入本插件       |
| DSH 本地工作区列表       | 通过官方 `ctx.workspaceRegistry` 读取                     |
| DSH 本地会话读取        | 通过官方 `ctx.sessionPersistence.open(id, 'read')` 只读读取 |
| 逐工作区授权/暂停/撤销      | 本地管理界面 + 加密保险库                                      |
| 逐会话工作区关联          | 输入框上方功能栏 + 加密 `sessionScopes`；默认关闭                  |
| 跨工作区检索            | BM25 + 本地字符 n-gram 向量（混合检索）；仅会话关联范围                 |
| AI 参考上下文          | 三个只读 Tool；结果固定标记为不可信历史参考                            |
| 来源追溯              | 工作区 ID、会话 ID、事件序号、事件时间、来源引用                         |
| 检索状态反馈            | 未启用/已启用/正在检索/完成/无结果/受限/异常 + 来源摘要                    |
| 知识图谱 / 时间线 / 冲突提示 | 基于授权内容的本地共现、分类与时间启发式                                |
| 加密、审计、删除          | AES-256-GCM、scrypt、HMAC 审计链、一键断开与删除                 |

### 明确不支持

- **不能自动读取 DeepSeek 云聊天工作区。** 官方没有公开的工作区/历史会话读取 API。
- **不能向 DeepSeek 云聊天页面注入插件结果。** 云聊天没有公开插件/上下文注入 API。
- **不能把手动导入包装成自动同步。** 手动导入的每个来源都会标记为 `manual snapshot`。
- **不能绕过 DeepSeek 的账号、Cookie、Session、权限或内部接口。** 本插件不读取它们。
- **不使用第三方 Embedding 或云端向量数据库。** 检索完全在本机进行。

官方依据与完整调查见：[平台能力调查报告](docs/01-platform-investigation.md)。

---

## 2. 功能

- **Composer Bar（v0.0.2）**：输入框上方总开关、会话工作区选择、索引/检索状态、来源摘要、锁定/解锁、紧凑模式。
- **Workspace Selector**：Settings 中列出 DSH 本地工作区与手动导入源；逐工作区授权、临时/长期、暂停、撤销、默认检索。
- **Search Panel**：自然语言查询；混合/关键词/本地向量；按工作区、时间、分类、来源过滤。
- **Search Results**：摘要、相关度、分类、状态、可信度提示、风险、来源、时间、会话/事件定位。
- **Knowledge Graph**：工作区—分类—主题的授权范围内关联图；不包含正文。
- **Memory Timeline**：记忆首次出现、最近确认、来源、过期提示、潜在冲突。
- **Security Center**：授权、审计、存储位置、加密方式、禁止检索词、排除规则、自动锁定、一键断开、删除保险库。
- **AI Tools**：`xw_memory_search`、`xw_memory_context`、`xw_memory_status`。没有授权/撤销/导入/删除 Tool。

---

## 3. 安全设计要点

1. **默认拒绝（Zero Trust）**：无授权、暂停、过期、锁定、审计异常 → 拒绝检索。
2. **权限先于检索**：先构造有效授权集合，再只在该集合内取候选；不允许先全量检索再过滤。
3. **AI 不能扩权**：Agent 只有三个只读 Tool；授权只能由已解锁管理界面发起。
4. **逐工作区独立**：A 工作区授权不等于 B；撤销立即删除该工作区索引。
5. **本地加密**：AES-256-GCM + scrypt（N=32768）；密钥只在 Host 进程内存。
6. **审计链**：HMAC 链；每次检索、授权、撤销、同步、删除都记录最小元数据。
7. **提示词注入隔离**：历史内容经过转义、风险检测；高风险内容不进入 AI 上下文。
8. **最小收集**：只读取 DSH `user/message` 与 `assistant/message` 的文本块；不索引系统提示、推理、工具参数/结果、图片和附件。
9. **秘密脱敏**：常见 API Key、私钥、Bearer Token、密码赋值在入库前替换为 `[REDACTED_*]`。
10. **失败安全降级**：锁定/异常时不返回缓存数据；拒绝而不是绕过。
11. **逐会话最小范围**：AI Tool 只使用当前会话显式关联的有效授权工作区；会话开关默认关闭，不能借“已授权”自动扩到所有会话。
12. **无会话副作用**：功能栏只更新 React 状态和本地 API，不提交消息、不创建会话、不改变 sessionId。

完整架构、数据流、权限模型和威胁模型见：[安全架构](docs/02-security-architecture.md)。

---

## 4. 安装

本仓库是一个本地 DSH bundle：

```text
package.json          # dsh.bundle.patch + dsh.client
cordis.patch.yml      # 挂载 Host 插件
lib/index.js          # Host 入口（Tool + 本地 HTTP）
lib/client.js         # 输入框上方功能栏 + Settings iframe
lib/core/*            # 加密、授权、会话范围、索引、检索、校验
lib/server/routes.js  # 本地回环管理 API
lib/assets/*          # 无第三方资源的 Settings 管理 UI
```

在当前 Harness profile 中，通过插件管理器安装本地 bundle：

- 开发环境：使用 `plugin_manager` 的 `install_bundle`，目标为本目录绝对路径。
- 用户环境：使用 DSH 的插件安装入口选择本目录（或先打包为本地包再安装）。

安装/升级后刷新页面。日常入口是 **对话输入框上方的 Cross-Workspace Memory 功能栏**；首次创建保险库、工作区授权、审计与删除仍在 **设置 → Cross-Workspace Memory**。

> 本插件只在 `127.0.0.1` / `localhost` / `[::1]` 的 DSH GUI 中工作。自定义域名或远程暴露会被拒绝。

---

## 5. 首次使用

1. 打开 **设置 → Cross-Workspace Memory**。
2. 创建本地保险库：设置至少 12 个字符的口令。**口令丢失不可恢复。**
3. 在「工作区」中，对需要参与检索的 DSH 本地工作区点击 **授权并索引**。
   - 「仅授权」只授予检索权限，不读取会话；之后可手动「同步索引」。
   - 临时授权到期会自动删除该工作区索引。
4. 回到当前对话，在输入框上方的功能栏打开本次会话开关，勾选本次要用的工作区。
   - 授权 ≠ 关联；未勾选的已授权工作区不参与本次检索。
   - 每个会话独立；新会话默认关闭、空选择。
5. 正常对话；AI 只能检索当前会话关联的有效工作区。栏内显示检索状态和来源摘要。
6. Settings 仍用于审计、暂停/撤销授权、禁止检索词、一键断开/删除。

手动导入 DeepSeek 历史：

1. 在 DeepSeek 官方产品中：头像 → 设置 → 数据管理 → **导出所有历史对话**。
2. 在本插件「工作区」底部展开「手动导入」，选择 JSON/Markdown 文件（≤ 8 MB）。
3. 导入后来源会标记为「手动快照」，不是云端实时连接。

---

## 6. 数据位置与生命周期

- 数据目录：`%DSH_HOME%/secure-memory/profiles/<profile>/`
- `vault.enc`：AES-256-GCM 加密状态（工作区元数据、授权、记忆、设置）。
- `audit.enc`：独立加密的 HMAC 审计链。
- 不自动创建备份、不上传外网、不写第三方向量库。
- **撤销授权**：删除该工作区所有记忆与会话索引。
- **暂停**：保留加密索引，但检索拒绝。
- **一键断开**：撤销全部授权、清空索引、锁定、使所有管理令牌失效。
- **删除保险库**：删除密文、审计文件、内存密钥和临时文件。
- **限制**：受 SSD/文件系统磨损均衡影响，不能承诺物理介质不可恢复。

---

## 7. 隐私事实

插件本身不发起外网请求，不使用第三方 Embedding。  
但当你让 AI 使用记忆时，**所选片段会进入当前对话上下文，并由 DSH 发送给当前模型服务商**。这是 AI 使用记忆的必要传输；未授权内容不会进入。把 DSH 暴露到网络、把解锁后的浏览器交给他人、或让恶意软件取得 OS 用户权限，均超出本插件的防御边界。

---

## 8. 测试

```bash
npm test                 # 或 node test/core.test.js
npm run benchmark        # 本地检索基准，合成数据
```

当前测试覆盖：原有加密/权限/检索/审计/注入测试、会话级授权隔离、旧数据迁移、Session API、无会话创建静态检查、Tool 名冲突避让。**v0.0.2 当前 20/20 通过**（16 核心 + 2 静态 + 2 冲突）。

测试结果与性能数据见：[v0.0.2 测试与验收报告](docs/v0.0.2-test-report.md) 和 [v0.0.1 安全测试报告](docs/03-security-test-report.md)。

---

## 9. 文档

- [v0.0.2 分析](docs/v0.0.2-analysis.md)
- [v0.0.2 技术设计](docs/v0.0.2-design.md)
- [v0.0.2 变更说明](docs/v0.0.2-changes.md)
- [v0.0.2 测试与验收报告](docs/v0.0.2-test-report.md)
- [平台能力调查报告](docs/01-platform-investigation.md)
- [安全架构与威胁模型](docs/02-security-architecture.md)
- [v0.0.1 安全测试报告](docs/03-security-test-report.md)
- [用户操作手册](docs/04-user-guide.md)
- [本地 API 文档](docs/05-api.md)
- [已知限制与后续规划](docs/06-limitations.md)

---

## 10. 许可证

MIT。见 [LICENSE](LICENSE)。
