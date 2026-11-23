# Spec: DSH MCP 管理插件（全局 MVP）

- **归档日期**: 2026-11-05
- **状态**: 待实现 (Ready for Implementation)
- **包名（暂定）**: `@lixiangzhong/dsh-mcp`
- **目标 DSH 版本**: 本机 Desktop `0.2.2-rc.1`（profile: `desktop`）

## 1. 背景与核心诉求 (Background)

当前 DSH 的全局 MCP 只能以手写 Loader 行的方式配置，没有任何管理界面：

- 每个 MCP server 是一条 `@deepseek-ai/dsh-mcp-client` 的 `insert` 行，写在本机 `~/.dsh/profiles/desktop/cordis.patch.yml`（当前 4 条：sshs / stitch / dbx / chrome-devtools，含明文 API key）。
- 新增、修改、启停、删除 server 都必须手改 YAML 并等 HMR 重载；无法看到连接状态与工具数；凭据会明文回显在文件里。

**官方能力现状（2026-11-05 实测，非推测）：**

| 检查项 | 结论 |
|---|---|
| npm `@deepseek-ai/dsh-mcp-manager` | **404 未发布** |
| Desktop nightly feed 最新构建 | `0.2.2-rc.1`（2026-11-04），即当前安装版本，无更新可用 |
| 本机 `dsh-mcp-client` | 缺少 `connectionStatusOf` / `probeServer` / `expandTemplates` / `startupTimeoutMs`（master 版 manager 依赖这些 API） |
| 官方 master `packages/mcp/mcp-manager` | 仅 Host 服务层（`servers` 字典 + 动态挂载 + status/probe/watch），**无配套 Web UI 页**，且明确 "Global plane only" |
| 社区市场 | 已有多个同类插件（`@xxxyz/dsh-mcp-manager`、`@moon16u/dsh-mcp-console`、`dsh-mcp-tools`、项目级 `dsh-project-mcp` / `dsh-mcp-autoload`） |

**核心诉求**：现在就要能用的全局 MCP 管理——可视化增删改、启停、看到是否生效与工具数；代码归自己维护，且未来可平滑迁移到官方 manager。项目级 MCP 作为下一里程碑。

> **变更（2026-11-05）**：用户决定移除「导入/导出」功能，MVP 范围相应收敛（商城/分享配置需求不在本版本）。

## 2. 讨论澄清与方案决策 (Clarifications & Decisions)

### 2.1 已澄清边界

- **不采用现成方案**：官方 manager 未发布且无 UI；社区插件虽可用，但用户要自己的代码与可控演进，因此自研（采用社区插件被评估后放弃）。
- **真相源是 profile patch 里的原生行**，不是插件自有 JSON 文件，也不是官方同构的 `servers` 字典。
- **只写 profile 层**：home patch（`~/.dsh/cordis.patch.yml`）、bundle patch、以及 CLI overlay 只读展示，不写。
- **MVP 不做**：测试连接（probe）、凭据模板/引用、行级重启、项目级作用域。
- **不做内置备份**：用户明确选择"外部自己保障"；写盘仅保证原子替换、冲突检测、回读校验。
- **官方未来会发布 manager（含 UI）**：本项目与之共存/迁移路径需在设计中保留，不承诺自动迁移。

### 2.2 方案取舍

| 决策点 | 选定 | 放弃的备选及原因 |
|---|---|---|
| 真相源 | **C. 托管原生行**（每 server 一行，直接编辑 profile `cordis.patch.yml`） | A. 官方同构（一条 `mcp` 行 + `servers` 字典 + `configEditor.edit()`）：写路径最安全、与官方 manager 结构一致，但现有 4 条手写行不在字典内、MVP 只能只读；B. 自有配置文件 + 动态挂载：实现最简单，但形成第二真相源，"管理 profiles 下的 MCP"名不副实。用户选择 C 以保持与现状同构、现有行直接可管。 |
| 运行时实现 | **零实现**：原生行由 Loader 自行挂载/卸载/重连，插件只做"配置编辑器 + 只读状态投影" | 动态挂 `dsh-mcp-client` 子实例（官方型）：需要自建 reconcile 队列与生命周期，且当前 mcp-client 无状态 API，收益低。 |
| 纳管范围 | **按模块名匹配**：profile patch 中所有 `name: '@deepseek-ai/dsh-mcp-client'` 的 `insert` 行 | 仅 `mcp-` 前缀 id（隐式命名契约）；显式纳入管理（多一层状态与交互）；全部纳管 + 每次写盘 YAML diff 确认（摩擦大）。 |
| 启停表达 | **行内 `disabled: true`**（启用=删除该字段） | 独立 id-targeted override 行（文件里两处状态，易脱节）。 |
| UI 入口 | **设置 → MCP**（client `settings.section`，id `mcp`） | 侧边栏 Plugins 页新 tab（该页语义是 bundle 管理）；独立侧边栏面板（与"配置类"功能位置割裂）；仅 agent tools（不满足"可视化"初衷）。 |
| MVP 范围 | 列表 + 增删改 + 启停 + 状态/工具数 | 只读优先（不足以"能用"）；全量贴近官方含 probe/凭据（工期显著变长）；最小可用无状态（"看不见是否生效"）。 |
| 写盘安全 | 原子替换 + 冲突检测 + 回读校验，**无内置备份/回滚** | 自动备份 + UI 回滚；备份 + 写前 diff 确认；均被用户放弃。 |
| 路线图 | **先全局 MVP，再做项目级** | 第一版同时做项目级（风险叠加）；只做全局（放弃最初核心差异化）。 |

### 2.3 技术决策

- **形态**：DSH profile bundle（`dsh.bundle.patch`），Host + Client 两半；开发期以 `link:` 方式装入 desktop profile 迭代。纯 ESM JavaScript（无构建步骤，符合官方模板形态），必要时后续再引入 TypeScript。
- **写入管线**（Host 侧）：
  1. 读取当前 profile patch 全文 → `yaml` `parseDocument`（`customTags` 注册 `tag:yaml.org,2002:js`，还原 `!!js` 为 `__jsExpr` 惰性节点）；
  2. 在 **内存文档** 上执行字段级最小编辑（只改目标节点/增删目标行）；
  3. **冲突检测**：写前重新读取文件并与基线比对，目标行或 `insert` 块已被外部改动则拒绝写入并提示重试；
  4. 在 `withFileLock(<profile>/package.json)` 内用 `writeFileAtomic` 替换文件（与 `@deepseek-ai/dsh-config-editor`、plugin-manager 共用同一把 profile 写锁）；
  5. 回读校验（重新 parse 并断言目标语义）；
  6. 监听 `app-boot/config-reload` 事件向 UI 报告"已生效"，超时（默认 10s）则提示查看日志。
- **编辑保真**：未改动字段保持原 YAML 节点（注释、引号风格、`!!js` 标签、锚点均不动）；仅被修改的标量替换 value/style；新增字段按目标行既有风格序列化。
- **增删落位**：
  - 新增：追加到**最后一个包含 mcp-client 行的 `- insert:` 块**末尾；若不存在则新建带注释 `# MCP servers managed by dsh-mcp` 的块；
  - 删除：移除行节点（含其 commentBefore）+ 指向该 id 的 `disabled`/`config` override 行；`insert` 块变空则移除整个块项。
- **状态与诊断**：来自 `pluginInventory/list`（Remote，`entry id` / `effectiveEnabled` / `fiber phase: pending|loading|active|failed|unloading|null` / 失败诊断），按 `name === '@deepseek-ai/dsh-mcp-client'` 过滤；工具数由 Host 读 `ctx.tools.schemas()` 按 `mcp__<serverName>__` 前缀聚合（serverName 取自行 config；归一化哈希后缀不影响前缀统计）。
- **密钥处理**：`headers`/`env` 值在 API 返回与 UI 中一律 mask；编辑时留空 = 保持原值；不提供"显示明文"。
- **Client ↔ Host 通信**：M0 定型，候选为官方 Typert Remote（生成 `typert.host`/`typert.remote-client`）或 `ctx.webServer.register` 自定义路由；优先 Typert Remote（与 `pluginInventory` 同一套 Remote 机制，鉴权复用 connection peer）。

## 3. 功能清单与验收标准 (User Stories & Acceptance)

1. **As a** DSH 用户, **I want** 在设置里看到所有 MCP server 及其状态, **so that** 不用翻 YAML 也知道现在挂了什么。
   - [ ] 列表展示：`serverName`、id、transport（stdio/http）、命令或 URL、启用状态、fiber phase、已注册工具数、来源层（profile insert / home patch / bundle）
   - [ ] 失败行展示 `pluginInventory` 给出的启动诊断
   - [ ] 打开页面自动刷新；提供手动刷新；写操作后自动刷新
2. **As a** DSH 用户, **I want** 图形化新增 MCP server, **so that** 不用手写 YAML。
   - [ ] 表单按 transport 切换字段；必填校验（stdio: command；http: url）；`serverName` 符合 `^[A-Za-z0-9_-]{1,32}$` 且与纳管行内唯一
   - [ ] 保存后 ≤5s 行变 `active`，工具出现在会话工具列表
3. **As a** DSH 用户, **I want** 编辑已有行, **so that** 改超时/命令/header 不求人。
   - [ ] 编辑只替换被改字段；未改动节点（注释/`!!js`/其他行）字节级不变
   - [ ] 密钥字段留空表示不修改
4. **As a** DSH 用户, **I want** 启停与删除, **so that** 临时不用的 server 不占工具位。
   - [ ] 停用写 `disabled: true`，工具消失、行保留；启用删除该字段并恢复
   - [ ] 删除需二次确认；行与关联 override 一起移除；空 `insert` 块一并清理
5. **As a** 维护者, **I want** 保真与端到端验证, **so that** 改动不会破坏用户手写内容。
   - [ ] 对现有 4 行执行"改一个字段再改回"，`cordis.patch.yml` 除目标字段外**逐字节不变**
   - [ ] 重启 DSH 后配置仍然存在且生效

**验收标准（端到端 + 保真，最终判定）**

使用仓库内自写的极简 stdio MCP fixture（零依赖、手写 JSON-RPC：`initialize` / `tools/list` / `tools/call`）在本机 desktop profile 上完成：

1. UI 新增 fixture server → ≤5s 行变 `active`，`mcp__fixture__ping` 出现在会话工具列表并可调用成功
2. 修改 `serverName` → 旧工具消失、新工具出现
3. 停用 → 工具消失、行保留；启用 → 工具恢复
4. 删除 → 行消失、工具消失
5. 重启 DSH → 配置仍在且生效
6. 保真测试（对现有 4 行改字段再改回，文件逐字节对比）通过

## 4. 实现设计与测试策略 (Design & Test Seams)

### 4.1 包结构与仓库布局

```
dsh-mcp/
  package.json                 # name: @lixiangzhong/dsh-mcp; dsh.bundle.patch + dsh.client
  cordis.patch.yml             # 插入本插件 Host 行（id: dsh-mcp-manager；不可用 mcp-manager，会挤掉 DSH 原生行）
  index.js                     # Host 入口：服务 + 写盘管线 + 状态聚合
  client.js                    # Client 入口：注册 settings.section(id: mcp)
  locale/{en,zh}.json          # 显示元数据与 UI 文案
  icon.svg
  lib/                         # 纯函数：patch AST 编辑、行模型、mask（可单测）
  fixtures/stdio-mcp-server.js # 验收用极简 stdio MCP server
  docs/specs/                  # 本文件
```

### 4.2 行模型（托管行示例）

```yaml
- insert:
    - id: mcp-fixture
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: fixture
        transport: stdio
        command: node
        args: ['/abs/path/fixtures/stdio-mcp-server.js']
        # disabled: true        # 停用时由管理页写入；启用时删除该行
```

字段来源：`config` 即官方 `dsh-mcp-client` Config（`serverName`、`transport`、`command/args/env/cwd`、`url/headers`、`toolCallTimeoutMs`、`maxInstructionBytes`、`failOnStartupError`、`reconnect`）。

### 4.3 模块与接口

- `lib/patch-document.js`：`loadDocument(text)` / `listMcpRows(doc)` / `insertRow(doc, row)` / `updateRowFields(doc, id, diff)` / `removeRow(doc, id)` / `serialize(doc)`；全部纯函数，输入输出文本，便于 golden 测试。
- `lib/row-model.js`：行 ↔ UI 模型转换、mask 规则、校验（serverName 唯一、transport 字段互斥）。
- Host `index.js`：服务方法 `list()` / `upsert(row)` / `remove(id)` / `toggle(id, enabled)`；写盘管线；`app-boot/config-reload` 监听；Remote 暴露。
- Client `client.js`：settings.section 页（列表 + 表单 + 确认 + mask + 错误提示 + 状态徽标）。

### 4.4 测试接缝（Test Seam）

- **单元（黑盒）**：`lib/patch-document.js` 用 golden 文本测试——给定输入 patch 与操作，输出文本必须与期望一致（覆盖：注释保留、`!!js` 保留、双 insert 块、空块清理、override 行清理、字段最小 diff）。
- **单元**：`row-model` 校验与 mask。
- **集成**：写盘管线在临时目录副本上运行（不碰真实 profile）：锁、冲突拒绝、回读校验。
- **端到端（人工/半自动）**：desktop profile 安装 link bundle → 用 fixture 走验收 6 步；状态断言轮询 `pluginInventory/list` + 工具调用。
- **回归**：新增/编辑/删除后，对 patch 中**非目标行**做字节级 sha256 对比。

### 4.5 实施分期

- **M0** 脚手架：package/bundle patch/client manifest/locale/icon → `link:` 安装 → 设置页出现空页（验证 client 注册与 Host↔Client 通信选型）
- **M1** 读链路：patch AST 解析 + `pluginInventory` + 工具聚合 → 列表页（只读）
- **M2** 写链路：增/删/改/启停 + 锁/原子写/冲突检测 + 生效监听
- **M3** Settings 页完整交互（表单、mask、二次确认、错误提示）
- **M4** fixture + 端到端验收

### 4.6 待实现期验证的技术点

1. Client↔Host：Typert Remote 生成 vs `ctx.webServer.register` 路由（M0 定型）
2. `settings.section` 注册所需的 client manifest 形态与 locale 约定（rc.1 实测）
3. HMR 对 patch 文件的真实生效延迟（`awaitWriteFinish` 约 2s），决定 UI "应用中" 文案与超时阈值
4. 在已装第三方 bundle 的 profile 上 `link:` 安装本 bundle 的兼容性（pnpm/link 与 runtime resolution）

### 4.7 已知风险

- **无内置备份**：写坏只能靠外部（git/同步）恢复；写盘管线仅保证原子性与冲突拒绝。
- **YAML 保真边界**：`yaml` 库对极端格式（自定义锚点、flow 风格混用）的往返不保证逐字节稳定；保真测试以现有 4 行为基线，超出范围的情况需显式报错而非静默改写。
- **HMR 延迟**：保存后约 2s 才生效；用户连续操作时可能出现中间态。
- **与官方 manager 的未来共存**：官方发布后可能出现两套管理入口；本项目不自动迁移，但在设计中保留"行模型 ↔ servers 字典"的映射可能。
- **工具名归一化**：超长/非法工具名会被 mcp-client 追加 12 位哈希后缀；前缀统计不受影响，但 UI 展示完整工具名时需注意。
- **并发写**：共用 profile 锁只能串行化协作方；用户在外部编辑器同时保存仍需冲突检测兜底。

## 5. 范围外 (Out of Scope)

- 项目级 MCP（下一里程碑：`agent/created` + `agent.ctx` 挂载方案；已单独成文：[project-level-mcp-20261105.md](project-level-mcp-20261105.md)）
- 测试连接（probe）、行级重启、凭据模板/引用与 redaction
- 内置备份/回滚、写前 YAML diff 确认
- 管理 home patch / bundle patch / CLI overlay 中的 MCP 行（只读展示）
- 多 profile 同时管理（只管理当前 `DSH_PROFILE`）
- 官方同构的 `servers` 字典迁移
- npm 发布/插件市场上架、非 web 平台客户端
- Agent tools（模型侧管理入口）
