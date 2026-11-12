# Cross-Workspace Memory v0.1.0

[![DeepSeek Harness](https://img.shields.io/badge/DSH-Plugin-blue)](https://github.com/topics/dsh-plugin)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](https://github.com/YangHua-ovo/dsh-secure-memory/releases/tag/v0.1.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Security: AES-256-GCM](https://img.shields.io/badge/Security-AES--256--GCM-green)](https://github.com/YangHua-ovo/dsh-secure-memory)

**面向 DeepSeek Harness 的本地加密记忆插件：会话级精确关联、三级记忆检索、可配置上下文预算，以及原对话内的状态更新。**

[下载 v0.1.0](https://github.com/YangHua-ovo/dsh-secure-memory/releases/tag/v0.1.0) · [发布说明](docs/releases/v0.1.0.md) · [使用手册](docs/04-user-guide.md)

> v0.1.0 基础能力版：支持指定来源会话、三级检索与上下文预算；在原对话组件中更新状态。
> 安全优先于功能完整性，隐私优先于检索便利性。如果官方能力不足，本插件选择明确拒绝，而不是绕过访问控制。

---

## v0.1.0 基础能力

- 在上方功能栏勾选工作区后，选择具体会话，或显式选择“全部已授权会话”。空会话列表不参与检索。
- L1 关键记忆优先，L2 使用抽取式摘要，L3 保留原文片段；询问原因/依据时继续检索原文。所有层都在所选且已授权的范围内召回。
- 每个会话可选择 800 / 1,200 / 1,500 的上下文预算，包含来源和安全说明。默认计数是 UTF-8 字节上界估算，**不是模型实际 Token 用量**；精确计数器接口与限制见实现说明。
- 修复状态请求与范围保存、会话切换的竞态，迟到响应不能覆盖新状态。

详见 [实现、数据兼容及验收说明](docs/v0.1.0-implementation.md)。本版使用抽取式摘要和本地词法哈希向量；侧边栏关联目录、设置页重建和神经语义 Embedding 模型尚未实现。

## 0. 当前版本速览

- 输入框上方新增 **Cross-Workspace Memory** 紧凑功能栏。
- 每个会话独立选择来源工作区及具体会话；选择 B1/C3 后，B2 不参与检索。也可显式选择整个已授权工作区。
- L1 优先返回关键记忆；L2 提供抽取式摘要；L3 在需要依据或结果不足时召回原文。
- 默认上下文预算 1,200，功能栏提供 800 / 1,200 / 1,500 预设；默认显示保守估算，不冒充模型实际 Token 用量。
- 新会话默认 **未启用、空选择**，不会继承其他会话。
- 开关/选择/收起/刷新全部是本地状态更新，不提交消息、不创建会话。
- 设置页保存配置或授权后，通过同源消息让功能栏原地刷新；不重载页面、不切换对话。
- 解锁 token 在 DSH 页面运行期内存复用；打开 Settings 不需要重复输入（刷新整页/重启仍需解锁，不保存口令）。
- Settings 页面保留，继续负责首次设置、授权、删除和审计。

升级兼容性、已知限制及验收记录见 [v0.1.0 实现说明](docs/v0.1.0-implementation.md)。

---

## 1. 先说清楚能力边界

### 已确认支持

| 能力 | 实现 |
|---|---|
| DeepSeek 官方历史对话导出 | 用户在官方 App/网页「设置 → 数据管理 → 导出所有历史对话」手动导出，再导入本插件 |
| DSH 本地工作区列表 | 通过官方 `ctx.workspaceRegistry` 读取 |
| DSH 本地会话读取 | 通过官方 `ctx.sessionPersistence.open(id, 'read')` 只读读取 |
| 逐工作区授权/暂停/撤销 | 本地管理界面 + 加密保险库 |
| 会话级精确关联 | 按来源工作区选择全部或指定会话；加密保存；新会话默认关闭 |
| 三级记忆检索 | L1 关键记忆 → L2 抽取式摘要 → L3 原文；依据类问题访问原文 |
| 混合召回 | BM25 + 本地词法哈希向量；先检查授权与会话选择，再召回 |
| 上下文预算 | 预算包含正文、来源与安全说明；默认保守估算，可接入匹配模型的计数器 |
| AI 参考上下文 | 三个只读 Tool；结果固定标记为不可信历史参考 |
| 来源追溯 | 工作区 ID、会话 ID、事件序号、事件时间、来源引用 |
| 检索状态反馈 | 未启用/已启用/正在检索/完成/无结果/受限/异常 + 来源摘要 |
| 知识图谱 / 时间线 / 冲突提示 | 基于授权内容的本地共现、分类与时间启发式 |
| 加密、审计、删除 | AES-256-GCM、scrypt、HMAC 审计链、一键断开与删除 |

### 明确不支持

- **不能自动读取 DeepSeek 云聊天工作区。** 官方没有公开的工作区/历史会话读取 API。
- **不能向 DeepSeek 云聊天页面注入插件结果。** 云聊天没有公开插件/上下文注入 API。
- **不能把手动导入包装成自动同步。** 手动导入的每个来源都会标记为 `manual snapshot`。
- **不能绕过 DeepSeek 的账号、Cookie、Session、权限或内部接口。** 本插件不读取它们。
- **不使用第三方 Embedding 或云端向量数据库。** 检索完全在本机进行。

官方依据与完整调查见：[平台能力调查报告](docs/01-platform-investigation.md)。

---

## 2. 功能

- **Composer Bar（v0.1.0）**：输入框上方总开关、来源工作区与会话多选、上下文预算、检索状态、来源摘要、锁定/解锁、紧凑模式。
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

- Release 安装包：从 [v0.1.0 Release](https://github.com/YangHua-ovo/dsh-secure-memory/releases/tag/v0.1.0) 下载 `dsh-secure-memory-0.1.0.tgz` 并解压，选择解压后的 `package` 目录。`SHA256SUMS.txt` 提供安装包校验值。
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
4. 回到当前对话，在输入框上方的功能栏选择来源工作区，再选择具体会话或显式勾选“全部已授权会话”，然后开启本次会话记忆。
   - 授权 ≠ 关联；未选中的工作区与会话不参与本次检索。新勾选工作区时默认没有选择来源会话。
   - 若列表还没有会话，可先开启并点击“刷新索引”，再选择需要的会话；索引动作本身不会扩大选择。
   - 每个会话独立；新会话默认关闭、空选择。
5. 在功能栏设置上下文预算，正常对话；AI 只能检索当前会话明确选择且仍有授权的来源。询问原因或依据时可继续检索原文。
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
npm test                 # 完整回归测试
npm run benchmark:v010   # v0.1.0 分层检索、范围与上下文预算基准
npm run benchmark        # 原有词法混合检索基准
```

**v0.1.0：29/29 项测试通过。** 覆盖加密、授权、审计、注入隔离、精确会话范围、空选择、旧数据兼容、三级召回、上下文预算、并发权限变更、HTTP API、页面请求竞态与 Tool 名冲突。

测试和合成基准记录见 [v0.1.0 实现与验收说明](docs/v0.1.0-implementation.md)。安装包只含运行文件与文档；运行测试请使用源码归档或克隆仓库。

---

## 9. 文档

- [v0.1.0 发布说明](docs/releases/v0.1.0.md)
- [v0.1.0 实现、数据模型、Token 计量与验收](docs/v0.1.0-implementation.md)
- [用户操作手册](docs/04-user-guide.md)
- [本地 API 文档](docs/05-api.md)

历史版本与架构背景：

- [v0.0.2 分析](docs/v0.0.2-analysis.md)
- [v0.0.2 技术设计](docs/v0.0.2-design.md)
- [v0.0.2 变更说明](docs/v0.0.2-changes.md)
- [v0.0.2 测试与验收报告](docs/v0.0.2-test-report.md)
- [平台能力调查报告](docs/01-platform-investigation.md)
- [安全架构与威胁模型](docs/02-security-architecture.md)
- [v0.0.1 安全测试报告](docs/03-security-test-report.md)
- [已知限制与后续规划](docs/06-limitations.md)

---

## 10. 许可证

MIT。见 [LICENSE](LICENSE)。
