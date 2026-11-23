# Spec: 项目级 MCP（Project-scoped MCP）

- **归档日期**: 2026-11-05
- **状态**: 待实现 (Ready for Implementation)
- **上游**: 全局 MVP 见 [mcp-management-plugin-20261105.md](mcp-management-plugin-20261105.md)（已安装并验收）
- **目标 DSH 版本**: Desktop `0.2.2-rc.1`，profile `desktop`
- **一句话**: 复用项目里已有的 `.mcp.json`（Claude Code）与 `.codex/config.toml`（Codex）声明，把 MCP server **按会话隔离挂载**，并在对话输入框权限控件旁提供一个可查看/信任/开关/重载的入口。

## 1. 背景与核心诉求 (Background)

项目级 MCP 的目标不是再发明一套项目配置格式，而是：项目里已经写好的 MCP 声明（Claude Code 的 `.mcp.json`、Codex 的 `.codex/config.toml`）能被 DSH 识别，并且**只在该项目的会话里生效**；用户在对话窗口内就能看到"当前会话有哪些 MCP、是否已信任、哪些启用了"，而不是去翻设置页或手改主机配置。

**核心诉求**：在项目会话中，MCP 可见、可控、默认安全（不信任不执行）；不打断对话；全局 MCP 管理不受影响。

### 事实基础（本机核实，非推测）

| 事实 | 证据/影响 |
|---|---|
| 官方存在 per-session MCP 先例 | `dsh-acp` 在会话 setup 中 `await agentCtx.plugin(McpClient, config)`（`lib/index.js:216-218,619`），stdio 用 `cwd: sessionCwd`、`failOnStartupError: true` |
| 作用域隔离是框架能力 | `dsh-mcp-client` 用 `scopeOf(ctx) ?? ctx.root` 保留 `serverName`；`agent.ctx` 上的注册只对该 Agent 可见；`dsh-experimental-tool-agent-team` 已在 profile 插件中监听 `agent/created` → 往 `agent.ctx` 注册 → `agent/disposed` 清理 |
| 挂载时点可用 | `agent/created` 为 serial 事件、在排队输入前触发、允许 await 异步安装 |
| 声明格式（Claude） | 项目根 `.mcp.json`：`{"mcpServers":{name:{command,args,env} \| {type:"http"\|"sse",url,headers}}}`；支持 `${VAR}`/`${VAR:-default}` 展开 |
| 声明格式（Codex） | 全局 `~/.codex/config.toml`，项目层 `<cwd>/.codex/config.toml`；`[mcp_servers.<name>]` 含 `command/args/env(_vars)/cwd/enabled/startup_timeout_sec/url`，env 为嵌套表；官方语义为项目根→cwd 多层合并、最近者胜 |
| 本机已有真实样本 | `~/.codex/config.toml`（computer-use/node_repl/sshs）与多个项目的 `.mcp.json`（如 `~/2026/pocketdns/.mcp.json`） |
| `.dsh/` 已是 DSH 项目级约定 | `<projectRoot>/.dsh/skills` 先例（本方案不新增 `.dsh` 配置文件） |
| 安全事实 | 项目文件里的 stdio server 以 Host 进程用户身份直接 spawn，**无 OS 沙箱**；只做环境变量清洗 |
| action card 不能主动弹 | 卡片只能由模型在该轮加载 kind 的 skill 后调用 `propose_action` 产生，一轮一张、仅主会话；**因此不做 action card，改为 composer 图标 + 面板** |
| composer 插槽 | `conversation.input.permission` 为单值槽（被系统占用）；`conversation.input.left` 为列表槽且声明顺序紧邻 permission；composer 内固定覆盖层必须 portal 到 `document.body` |
| rc.1 mcp-client 限制 | 无 `startupTimeoutMs` / 无连接状态或 probe API；启动等待受 SDK 60s 默认超时约束 |

## 2. 讨论澄清与方案决策 (Clarifications & Decisions)

### 2.1 已澄清边界

- 项目声明文件**只读**：插件永远不写项目文件（不新增、不编辑、不自动格式化）。
- 项目级 MCP 与全局 MCP 是**两个平面**：全局仍由设置→MCP 管理；项目级入口在会话内。
- 不做 action card（框架不支持插件主动发起）；也不做 composer dock 提示条（被图标角标 + 面板替代）。
- 项目 server 只在**当前会话**可见，不跨会话共享实例。
- 不读取全局 Codex 配置 `~/.codex/config.toml` 的 `mcp_servers`（避免与 DSH 全局平面重复/冲突）；只读项目层声明文件。

### 2.2 方案取舍

| 决策点 | 选定 | 放弃的备选及原因 |
|---|---|---|
| 激活姿态 | **信任后自动生效**：默认不启动；显式信任一次后该项目会话自动挂载 | 全自动（克隆仓库即可执行命令，无沙箱）；每会话手动（重复成本高）；纯白名单（门槛高） |
| 实例模型 | **每会话独立实例**（`agent.ctx.plugin(McpClient, config)`），随会话销毁 | 每项目共享实例（agent scope 父链已绑定 preset，需自建 scope 池/引用计数）；共享连接池 + 自建代理（等于重写 mcp bridge） |
| 声明文件 | **只读兼容两份**：`.mcp.json`（最近祖先）与 `.codex/config.toml`（最近祖先）；同名冲突 **Claude 优先** | 只做 `.dsh/mcp.json`（新增第三套格式）；只做 Codex（缺失 Claude 生态）；两边都可写（TOML 保真写回成本高） |
| 发现与合并 | **两文件各取最近一份**，不做 Codex 官方根→cwd 多层合并 | 严格 Codex 层叠（与"只取最近"相比多约半天且 monorepo 场景未必需要）；冲突不挂载（会让已有配置报错）；逐项选择（交互过重） |
| 信任存储 | **home 级独立文件** `$DSH_HOME/dsh-mcp/trust.json`（跨 profile 共享，原子写+锁） | profile 级文件（换 profile 要重复信任）；写插件自己的 profile config（给用户 patch 加噪且需 Config schema）；复用 Codex trust_level（把安全决定权交给另一个工具的全局文件） |
| 信任粒度 | **纯路径信任**（不记录配置指纹） | 逐 server 指纹（更安全但结构复杂）；整文件指纹（改超时字段也要重批）；冻结清单（维护成本高）。**接受风险：git pull 新命令自动执行** |
| 启动时机 | `agent/created` **并行挂载 + 总预算 2s**；超时后台继续，工具随后出现 | 等待全部就绪（坏 server 可拖到 60s）；只后台挂载（首轮大概率没工具）；首轮前等待（发送消息可感知延迟） |
| 目录变化 | **跟随后一步生效**：检测 cwd 变化 → 卸载旧项目 server → 按新目录重解析（有界等待） | 不跟随（与 DSH 自身 cwd 可变语义不一致）；变化时提示由用户确认（多一步交互） |
| 同名冲突 | **项目优先覆盖全局**（scope shadow），面板/日志标注"覆盖全局 mcp-x" | 跳过提示（更安全但改变"项目声明即事实"的直觉）；全局优先；不处理（行为难解释） |
| 语义映射 | **完整映射**：`${VAR}`/`${VAR:-default}` 展开；`enabled=false` 跳过；`env_vars` 透传；`http_headers` 静态映射；`env_http_headers` 从环境解析；`bearer_token_env_var` 补 `Authorization: Bearer`；`tool_timeout_sec`→`toolCallTimeoutMs`；`startup_timeout_sec` 忽略并 warning | 不展开变量（配置静默失效）；只支持最小共通字段（Codex 配置失真） |
| 会话内形态 | **composer 工具行、权限控件旁的 MCP 图标按钮**（注册 `conversation.input.left`）；有全局 MCP 或项目声明时才显示；未信任/有变化时加角标；点击弹出面板（portal 到 body） | action card（插件无法主动发起）；composer dock 提示条（占空间且信息不完整）；设置页项目区（离对话太远，已否决作为主入口） |
| 面板内容 | 上半「本项目」：来源文件、信任状态、逐 server 开关 + 状态 + 重新加载 + 信任并启用；下半「全局」：只读列表（含工具数/状态）+「去设置管理」链接 | 只列项目（看不到全局）；全部可含全局会话级开关（需工具限制，实现更重） |
| 入口分工 | **会话内面板 = 项目级唯一入口**；设置→MCP 保持纯全局管理，不新增项目区 | 设置页加项目概览/完整管理（双入口同步成本） |
| 细粒度控制 | 项目内 **per-server 开关** + 会话内 **重新加载项目 MCP** | 仅全项目开关（不够灵活） |

### 2.3 技术决策

- **新增依赖**：`smol-toml`（只读解析 TOML）；维持纯 ESM、无构建。沿用现有 `yaml`、`@deepseek-ai/dsh-atomic-write`。
- **模块划分**：
  - `lib/project-config.js`：纯函数（发现目录、解析 `.mcp.json`/`.codex/config.toml`、冲突合并、语义映射到 mcp-client config、secret 掩码判定）。无 DSH 依赖，便于单测。
  - `lib/project-host.js`：Host 生命周期（trust store 读写、按 session 的挂载注册表、cwd 变更跟随、2s 预算、状态投影）。
  - `client.js`：扩展第二个 slot 注册（`conversation.input.left` 图标按钮）与面板组件；沿用现有 locale 字典与 style 注入机制（新增 `dm-mcp-panel-*` scoped 样式）。
- **信任数据结构**（`$DSH_HOME/dsh-mcp/trust.json`）：

```jsonc
{
  "version": 1,
  "projects": {
    "/abs/project/dir": {
      "trustedAt": "2026-11-05T08:00:00.000Z",
      "servers": { "github": true, "internal": false }   // 缺省 = true
    }
  }
}
```

- **挂载注册表**（Host 内存）：`Map<sessionId, { dir, mounts: Map<serverName, { fiber, phase, lastError }> }>`；`agent/disposed` 与插件卸载时全部 dispose。
- **状态投影**（rc.1 无状态 API 的近似）：fiber state + 工具名前缀 `mcp__<name>__` 是否出现 → `starting | connected | failed`；失败原因取 fiber reject 错误。
- **cwd 跟随**：在 `agent/pre-step` 对比会话当前目录快照；变化时置一个"待切换"，在下一步前完成（预算 2s，超时后台继续）。
- **Host API 扩展**（在现有 `/dsh-mcp/api` 下新增 action，遵守同源 POST + 路由 `auth:'required'` 准入；本文成文时的 `connection.requestRejection` 已被 DSH ≥0.2.2-rc.2 删除）：
  - `project/session` `{ sessionId }` → `{ project: { dir, files: [{path, format}], trusted, servers: [...], global: [...] } }`
  - `project/trust` `{ dir, trusted }` → `{ trusted }`
  - `project/toggle` `{ sessionId, serverName, enabled }` → 更新 trust.json 的 per-server 意愿，并对当前会话立即生效
  - `project/reload` `{ sessionId }` → 重新解析文件并重挂（用于手改文件后）
  - 项目 server 投影字段：`name / source('claude'|'codex') / transport / enabled / trusted / status / lastError / overridesGlobal`
- **渲染细节**：图标按钮 28×28 ghost；有内容才渲染；未信任或有新变化时右上角 6px 角标（aria-label 说明）；面板宽 360、最大高 60vh、内部滚动；overlay portal 到 `document.body`；Esc/外点关闭；焦点归还。

## 3. 功能清单与验收标准 (User Stories & Acceptance)

1. **As a** 项目会话用户, **I want** 在输入框权限控件旁看到 MCP 入口, **so that** 不用切页面就知道当前会话有哪些 MCP。
   - [ ] 有全局 MCP 或项目声明时显示图标；都没有时隐藏；未信任/有变化时显示角标
   - [ ] 点击打开面板，Esc/外点关闭，焦点归还，`aria-*` 完整
2. **As a** 用户, **I want** 面板里区分"本项目"和"全局", **so that** 我知道哪一份配置在起作用。
   - [ ] 本项目区展示来源文件（`.mcp.json`/`.codex/config.toml` 路径）、信任状态、每个 server 的开关/状态/失败原因/是否覆盖全局
   - [ ] 全局区只读展示 server 与工具数，附「去设置管理」跳转
3. **As a** 用户, **I want** 信任一次后自动生效, **so that** 日常不用重复确认。
   - [ ] 未信任时面板提供「信任并启用」，点击后当前会话立即挂载（≤预算）并持久化到 trust.json
   - [ ] 信任后新会话自动挂载且无角标
4. **As a** 用户, **I want** 逐 server 开关与重新加载, **so that** 能临时关掉某个 server、手改文件后不用重开会话。
   - [ ] 开关即时生效且持久化（trust.json per-server），不修改项目文件
   - [ ] 「重新加载项目 MCP」重新解析文件并重挂
5. **As a** 用户, **I want** 会话切换目录后项目 MCP 跟着变, **so that** 不用重开会话。
   - [ ] cwd 从项目 A 切到 B（B 已信任）后，下一步工具变为 B 的；切回 A 恢复
6. **As a** 维护者, **I want** 故障不阻塞会话且全局不受影响, **so that** 项目配置坏了也能正常聊天。
   - [ ] 坏 JSON/TOML、缺 command、server 启动失败：不阻塞会话创建，面板/日志给出原因
   - [ ] 全局管理（列表/增删改/启停/写盘保真）零回归（现有 74 tests + e2e）

**验收标准（端到端 + 隔离 + 降级）**

1. 临时项目写入 `.mcp.json`（stdio 指向仓库 fixture server）→ 新建该目录会话 → 图标带角标 → 面板「信任并启用」→ ≤2s 预算内工具出现且 `mcp__<name>__ping` 可调用。
2. 未信任项目会话：不启动 server 进程（工具不存在；面板显示未信任）。
3. 信任后新建同一项目会话：自动挂载、无角标、面板状态 `connected`。
4. 撤销信任（面板内）：当前会话卸载、后续会话不挂载。
5. cwd 跟随：项目 A 会话中切到已信任项目 B → 下一步工具列表替换为 B 的；切回 A 恢复。
6. 同名覆盖：全局已有同名 serverName 时，项目定义生效（工具来自项目配置），面板标注「覆盖全局 mcp-x」。
7. 语义映射：`${VAR}` 展开生效；`enabled=false` 跳过；Codex `env_vars` 透传；`http_headers` 静态映射；`env_http_headers` 从环境解析、缺变量跳过并 warning；`bearer_token_env_var` 补 `Authorization: Bearer`（显式 Authorization 优先）；`startup_timeout_sec` 忽略且日志 warning；`tool_timeout_sec` 映射到 `toolCallTimeoutMs`。
8. 多会话隔离：同项目两个会话各自独立 server 进程；一个 server 崩溃/失败不影响另一个会话。
9. 降级：坏 `.mcp.json`、坏 TOML、缺 command、连接失败均不阻塞会话创建，面板显示原因。
10. 全局零回归：现有 74 项测试全绿；全局 MCP 列表/新增/编辑/启停/删除/保真回环仍通过。
11. per-server 开关：面板关掉某 server → 工具立即消失；重开恢复；状态持久化到下次会话。

## 4. 实现设计与测试策略 (Design & Test Seams)

### 4.1 发现与解析（`lib/project-config.js`，纯函数）

- 从会话目录向上查找**最近**的 `.mcp.json` 与 `.codex/config.toml`（各自独立查找；不越过文件系统根）。
- `.mcp.json`：`mcpServers` 对象；stdio 形态 `command/args/env/cwd`；http 形态 `type` 或 `url`/`headers`；`${VAR}`/`${VAR:-default}` 展开（只读环境，不落盘）。
- `.codex/config.toml`：`mcp_servers.<name>`；`command/args/env`（嵌套表）/`env_vars`（透传名单）/`cwd`/`url`/`enabled`/`tool_timeout_sec`；`startup_timeout_sec` 忽略并记 warning；`cwd` 相对路径按配置文件所在目录解析。
- 合并：两文件各自取最近一份；同名 serverName 时 `.mcp.json` 优先并标记；输出统一内部结构 `ProjectServer { name, source, config, warnings }`。
- 掩码：面板展示时 env/headers 值一律掩码（与全局一致）。

### 4.2 Host 生命周期（`lib/project-host.js`）

- `agent/created`：解析目录 → 读 trust.json → 过滤（未信任 / server 关闭 / 与全局同名按规则）→ 并行 `agent.ctx.plugin(McpClient, config)`（`failOnStartupError:false`，`toolCallTimeoutMs` 按映射）→ `Promise.race(allSettled, 2s)`；超时项留在后台。
- `agent/disposed` / 插件卸载：dispose 该会话全部 mount；清理注册表。
- `agent/pre-step`：对比目录快照；变化时按新目录重算并切换（有界等待）。
- trust 写入：`withFileLock` + `writeFileAtomic`（沿用 `@deepseek-ai/dsh-atomic-write`）。
- 状态近似：fiber state + `ctx.tools.schemas()` 前缀探测。

### 4.3 Host API 与客户端

- 新增 action 见 §2.3；错误码沿用现有 envelope（`INVALID_ARGUMENT`/`NOT_FOUND`/`WRITE_FAILED` 等）。
- 客户端新增 slot 注册（`conversation.input.left`）与面板组件；数据经新 action 获取；轮询/事件刷新策略：打开面板时拉取一次，操作后重拉；角标数据在会话变更/`tools/change` 时轻量刷新（避免高频轮询）。
- 面板样式沿用 `.dm-mcp` 设计语言（token、圆角、语义色、reduced-motion），新增 scoped 类名前缀 `dm-mcp-panel-`。

### 4.4 测试接缝（Test Seam）

- **单元（黑盒）**：`lib/project-config.js` 用 fixture 文件树测试发现/解析/合并/映射/掩码/坏文件降级；TOML 用 Codex 真实样本脱敏。
- **Host 集成**：mock Cordis ctx + 假 McpClient 插件（stub `apply` 注册工具）测试：信任过滤、并行预算、cwd 切换、dispose、per-server 开关、trust.json 读写与并发。
- **端到端**：仓库 fixture stdio server + 临时项目目录；真实 DSH 下验证 §3 的 11 条验收（工具调用、进程隔离、降级）。
- **回归**：现有 `npm run verify` 74 项必须全绿。

### 4.5 实施分期

- **P0** 解析层：`lib/project-config.js` + 单测（Claude/Codex/合并/映射/坏文件）。
- **P1** Host 生命周期：挂载/预算/cwd 跟随/dispose + trust.json + Host API action + 集成测试。
- **P2** 客户端：图标按钮 + 角标 + 面板（本项目/全局、信任、开关、重载）+ 视觉自检。
- **P3** 端到端验收 + 文档（spec/契约/README/验证记录）。

### 4.6 已知风险

- **link 安装的模块解析**：linked bundle 不在 `$DSH_HOME/profiles/node_modules` 祖先链上，必须把 `@deepseek-ai/dsh-mcp-client` 声明为 `peerDependencies` 才能被运行时解析（实测修复，不要删除该 peer）。
- **纯路径信任**：`git pull` 或他人修改项目文件后新增命令自动执行（已明确接受）。缓解：面板显示来源文件与最后修改时间，便于察觉。
- **只取最近一份**与 Codex 官方"根→cwd 逐层合并"有偏差：monorepo 根层声明在子目录会话可能不可见。
- rc.1 mcp-client 无启动超时/状态 API：2s 预算只能"停止等待"，慢连接会后台继续；状态为近似值。
- 同项目多会话 = 多份 server 进程（资源成本）。
- 项目文件只读：新增/删除 server 仍需手改文件。
- 项目声明变化后不自动重载（除 cwd 变化/手动重载按钮），避免频繁重启进程。

## 5. 范围外 (Out of Scope)

- 写项目文件 / 从 UI 新增或删除项目 MCP server（只读声明，手改文件）
- Codex 官方多层合并语义（本版只取最近一份）
- 配置指纹与变更后的二次确认（信任为纯路径级）
- 读取全局 Codex `~/.codex/config.toml` 的 `mcp_servers`
- 其他工具格式（Cursor `.cursor/mcp.json`、VS Code `.vscode/mcp.json` 等）
- Codex `auth`（OAuth）与 `enabled_tools` / `disabled_tools`（保留 warning，不映射）
- 项目级 server 的探测（probe）/精确连接状态（依赖未来 mcp-client API）
- 空闲实例释放、每项目共享实例/连接池
- 设置页项目区/所有项目信任列表管理
- 多 profile / 多机器同步 trust 列表
