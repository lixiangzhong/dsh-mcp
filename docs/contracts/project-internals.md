# 项目级 MCP 内部接口契约（P0/P1/P2 并行用）

本文件是项目级 MCP 并行开发的接口真相源；对应设计见 [docs/specs/project-level-mcp-20261105.md](../specs/project-level-mcp-20261105.md)。任一侧要改接口，先改本文件并通知 Lead。

## 0. 总体分工与写作用域

| 工作流 | 负责人 | 写作用域 |
|---|---|---|
| P0 解析层 | `row-model` 队员 | `lib/project-config.js`、`test/project-config.test.js`、`test/fixtures/project/**` |
| P1 Host 生命周期 | `patch-engine` 队员 | `lib/project-host.js`、`test/project-host.test.js`、`test/fixtures/mcp-stub.js` |
| P2 客户端 UI | `client-ui` 队员 | `client.js`、`locale/`（内联字典在 client.js 也行） |
| P3 集成/路由/验收 | Lead | `lib/host-service.js`、`index.js`、`package.json`、`docs/**`、`test/host-service.test.js` |

依赖：P1 依赖 P0 的导出（本文件 §1 已冻结签名）；P2 只依赖 Host API（§3）；P3 把 P0/P1/P2 接起来。**任何一方不得改别人的写作用域文件。**

## 1. P0：`lib/project-config.js`（纯函数、零 DSH 依赖）

依赖：仅 Node 标准库 + `smol-toml`（仓库已安装）。禁止 import `@deepseek-ai/*`。

```js
/** 从 startDir 向上找最近的文件（相对路径）。返回绝对路径或 null。 */
export function findNearestFile(startDir, relativePath)

/**
 * 内部统一 server 形状（P0 输出 / P1 输入）。
 * @typedef {object} ProjectServer
 * @property {string} name            // serverName（[A-Za-z0-9_-]{1,32}）
 * @property {'claude'|'codex'} source
 * @property {'stdio'|'streamable-http'} transport
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {Record<string,string>} [env]   // parse 阶段保留 ${VAR} 原文；明文只出现在 toClientConfig 输出的 config
 * @property {string[]} [envVars]            // Codex env_vars 透传名单（parse 保留，toClientConfig 时从注入 env 取值）
 * @property {Record<string,string>} [envHeaderVars] // Codex env_http_headers：header 名 → 环境变量名（toClientConfig 时解析）
 * @property {string} [bearerTokenEnvVar]    // Codex bearer_token_env_var：环境变量名，值作为 Authorization: Bearer（无显式 Authorization 时才补）
 * @property {string} [cwd]
 * @property {string} [url]
 * @property {Record<string,string>} [headers]
 * @property {boolean} enabled               // 文件里的 enabled（Codex；Claude 默认 true）
 * @property {number} [toolCallTimeoutMs]    // codex tool_timeout_sec * 1000
 */

/**
 * 解析 .mcp.json 文本。
 * @returns {{ servers: ProjectServer[], warnings: string[] }}
 * 坏 JSON → warnings 记录并返回空 servers，不抛异常。
 */
export function parseClaudeConfig(text)

/**
 * 解析 .codex/config.toml 文本。
 * @returns {{ servers: ProjectServer[], warnings: string[] }}
 * 支持：command/args/env(嵌套表)/env_vars(透传 process.env)/cwd/url/enabled/tool_timeout_sec；
 * startup_timeout_sec 忽略并写 warning；坏 TOML → warnings + 空 servers。
 */
export function parseCodexConfig(text)

/**
 * 合并两份文件（各自已被 findNearestFile 定位），同名时 Claude 优先。
 * @param {{ claudePath?: string|null, claudeText?: string, codexPath?: string|null, codexText?: string }} input
 * @returns {{ servers: ProjectServer[], files: Array<{path:string, format:'claude'|'codex'}>, warnings: string[] }}
 */
export function buildProjectServers(input)

/**
 * 语义映射到 mcp-client config（展开 ${VAR}/${VAR:-default}、env_vars 已在上层处理、剔除 null、cwd 绝对化）。
 * @param {ProjectServer} server
 * @param {{ env?: Record<string,string|undefined>, projectDir?: string }} options
 * @returns {{ config: object, warnings: string[] }}
 */
export function toClientConfig(server, options)

/**
 * 面板展示用（掩码）：不返回任何 secret 明文。
 * args 必须做保守脱敏：flag/赋值/URL query 中形如 api-key/token/secret/password/auth/credential/bearer 的值 → MASK。
 * @param {ProjectServer} server
 * @returns {{ name, source, transport, enabled, command?, args?, cwd?, url?, envKeys: string[], headerKeys: string[] }}
 */
export function maskServerForPanel(server)

/** 从 cwd 发现项目声明（内部调用 findNearestFile + parse + build）。 */
export function discoverProject(cwd, readFileSync, options?) // options.homeDir 仅用于排除全局 Codex 配置与单测；返回 { projectDir, files, servers, warnings }

/** 项目身份键：取两个声明文件中"项目根更深"的那个所在目录（Codex 项目根 = 去掉 .codex 层）；同深度按声明路径长度、再 Claude 优先；无文件返回 null。 */
export function resolveProjectDir(cwd, found)
```

约束：全部纯函数可单测；错误降级为 warnings，不向调用方抛异常（除非参数类型非法）。

已确认的偏差与约定（P0 交付后冻结）：
- `ProjectServer` 增加可选 `envVars?: string[]`（Codex `env_vars` 名单）。
- `discoverProject(cwd, readFileSync, options?)` 的 `options.homeDir` 用于排除全局 Codex 配置（`~/.codex/config.toml`、`$CODEX_HOME/config.toml`），不得当作项目声明。
- Codex `http_headers` → `headers`（静态）；`env_http_headers` → `envHeaderVars`（连接时从注入 env 解析，未设置跳过 + warning）；`bearer_token_env_var` → `bearerTokenEnvVar`（无显式 `Authorization` 时补 `Bearer`，未设置/冲突 warning）。
- Codex `auth`（OAuth）与 `enabled_tools` / `disabled_tools` 本版仍不映射，检测到写 warning（范围外，见 spec §5）。

## 2. P1：`lib/project-host.js`（Host 生命周期）

依赖：Node 标准库、`@deepseek-ai/dsh-atomic-write`、`@deepseek-ai/dsh-mcp-client`（`import * as McpClient` + 运行时动态 import）、`./project-config.js`。**不修改 host-service.js。**

> 集成约束（实测）：本 bundle 以 `link:` 安装时，必须把 `@deepseek-ai/dsh-mcp-client` 写进 `package.json` 的 `peerDependencies`，否则 linked 目录不在 profile `node_modules` 祖先链上，运行时解析会报 `Cannot find package`。`applyProjectRuntime` 通过 `options.mcpClient` 注入已解析的模块命名空间（`index.js` 负责动态 import）；未注入时自带懒加载兜底。

```js
/**
 * 安装项目级运行时（agent/created、agent/disposed、agent/pre-step 监听；插件卸载时清理）。
 * @param {object} ctx Cordis context（host-service 传入 profile 作用域 ctx）
 * @param {{ mcpClient?: object, env?: Record<string,string|undefined>, trustPath?: string }} [options]
 *   mcpClient 可注入假插件用于测试；默认使用真实 @deepseek-ai/dsh-mcp-client。
 * @returns {ProjectRuntime}
 */
export function applyProjectRuntime(ctx, options = {})

/** ProjectRuntime（host-service 与测试使用） */
{
  /** 读取一个会话的项目视图（不启动/不修改任何东西）。 */
  async view(sessionId) // -> { cwd, projectDir, files, trusted, servers, warnings }
  /** 轻量角标数据：{ relevant: boolean, badge: 'untrusted'|'failed'|null } */
  async badge(sessionId)
  /** 信任/撤销一个项目目录（写 trust.json）。 */
  async trust(projectDir, trusted)
  /** 切换某个项目 server 的启用意愿（写 trust.json），对当前会话立即生效/卸载。 */
  async toggle(sessionId, serverName, enabled)
  /** 重新读取声明并重建当前会话的本项目挂载。 */
  async reload(sessionId)
  /** 卸载全部并停止监听（插件卸载时调用）。 */
  async dispose()
}
```

行为要求：
- `agent/created`：发现项目 → 未信任则只记录、不挂载；已信任则过滤（文件 `enabled:false`、trust 里 per-server false）后**并行** `agent.ctx.plugin(mcpClient, toClientConfig(...).config)`，总等待预算 **2000ms**（`Promise.race`），超时留后台；`failOnStartupError:false`。
- `agent/disposed`：dispose 该会话所有 mount。
- `agent/pre-step`：对比会话当前目录快照；变化时置待切换，并在下一步前（预算 2s）卸载旧项目 mount、按新目录重建。
- 状态近似：fiber state + `ctx.tools.schemas()` 的 `mcp__<name>__` 前缀 → `starting|connected|failed|stopped`；失败原因取 fiber reject 错误字符串（截断 300 字）。
- trust 文件：`$DSH_HOME/dsh-mcp/trust.json`（可用 options.trustPath 覆盖测试）；`withFileLock` + `writeFileAtomic`；结构见 spec §2.3；读损坏时降级为空并在 warnings 说明。
- 同名覆盖全局：直接挂载（scope shadow），视图里标 `overridesGlobal: true`；全局名单由 host-service 传给 view 合并，project-host 不读全局行。
- 绝不写项目文件。

## 3. Host API 扩展（Lead 在 host-service 实现）

沿用 `/dsh-mcp/api` 前缀、同源 POST、`ctx.connection.requestRejection` 准入、`{ok:true,data}` / `{ok:false,error}` envelope。

| action | 请求 | 响应 data |
|---|---|---|
| `project/session` | `{ sessionId }` | `{ cwd, projectDir, files, trusted, servers:[...], warnings, global:[{name,id,phase,toolCount,enabled}] }`；servers 中每项为 `maskServerForPanel` 结果 + `{ active, status, lastError, overridesGlobal, fileEnabled }` |
| `project/trust` | `{ dir, trusted:boolean }` | `{ dir, trusted }` |
| `project/toggle` | `{ sessionId, serverName, enabled:boolean }` | `{ serverName, enabled }` |
| `project/reload` | `{ sessionId }` | 同 `project/session` 视图 |
| `project/badge` | `{ sessionId }` | `{ relevant:boolean, badge:'untrusted'\|'failed'\|null }` |

错误码沿用：`INVALID_ARGUMENT` / `NOT_FOUND` / `WRITE_FAILED` / `INTERNAL`。

## 4. P2：客户端（client.js）

- 新增 slot 注册：`conversation.input.left`（list 类）：
  ```js
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'mcp-project', order: -10,
    label: () => t('composer.buttonLabel'),
  }, McpProjectButton))
  ```
- 组件 props：该 slot 提供 `sessionId`、`useSession`、`useProjection`、`useRemoteAccess` 等标准 props；只用 `sessionId` + 我们自己的 fetch 即可。
- 显示条件：`project/badge` 的 `relevant` 为 true 才渲染图标（全局有 MCP 或项目有声明）。badge 为 `untrusted`/`failed` 时右上角 6px 角标（aria-label 说明）。
- 点击面板：`project/session` 拉数据；面板 portal 到 `document.body`；宽 360、max-height 60vh、内部滚动；Esc/外点关闭、焦点归还。
- 面板交互：本项目区（信任并启用/撤销信任、逐 server switch、重新加载、来源文件、状态、lastError、覆盖全局标记、全局只读 + 去设置管理链接）。
- 复用现有 `callAction`/`failureText`/locale/样式机制；新增样式全部 scoped（`dm-mcp-panel-*` 可放在现有 `<style id="dm-mcp-style">` 里）。
- 不新增依赖、无构建、`node --check` 必须过。

## 5. 测试与验收接缝

| 层 | 位置 | 要求 |
|---|---|---|
| P0 单测 | `test/project-config.test.js` | 发现/解析/合并/映射/掩码/坏文件降级；用真实 Codex 样本脱敏 + 临时 JSON fixture |
| P1 单测 | `test/project-host.test.js` | 假 McpClient（stub apply 注册工具）+ mock ctx：信任过滤、2s 预算、并行、cwd 切换、dispose、per-server 开关、trust.json 损坏降级 |
| P3 集成 | `test/host-service.test.js` | 用注入的 fake runtime 测 4 个新 action 的 envelope/错误码；真实端到端由 Lead 在 DSH 里跑 |
| E2E | Lead | spec §3 的 11 条验收 + 全局零回归 |
