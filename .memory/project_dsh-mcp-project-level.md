# 项目级 MCP（project-scoped）实现与关键坑

- **Type**: project
- **Topic**: dsh-mcp-project-level
- **Updated**: 2026-11-05T10:49:18Z

## Summary

项目级 MCP 已实现并验收；支持 Codex http_headers/env_http_headers/bearer_token_env_var；link 安装必须声明 mcp-client 为 peerDependencies。

## Why

项目级 MCP 是本项目第二个里程碑，其作用域/信任/挂载时机、link 安装 peer 依赖坑、以及 Codex 字段映射都会影响后续迭代。

## How to Apply

继续项目级 MCP 迭代（变更指纹、Codex 多层合并、OAuth、写项目文件）或排查挂载/鉴权字段时先读；`peerDependencies` 不要删。

## Context & Details

- 目标：复用项目里已有 `.mcp.json`（Claude Code，最近祖先）与 `.codex/config.toml`（Codex，最近祖先），只读；同名 Claude 优先；不读全局 `~/.codex/config.toml`。
- 激活：纯路径信任，trust 存 `$DSH_HOME/dsh-mcp/trust.json`（home 级，跨 profile）；默认不启动；信任后会话创建自动挂载。
- 实例：每会话独立，`agent/created` 时 `agent.ctx.plugin(McpClient, config)` 并行挂载 + 2000ms 预算，超时后台继续；`agent/disposed` 清理；cwd 变化在下一步切换。
- **关键坑（实测）**：bundle 以 `link:` 安装时，`@deepseek-ai/dsh-mcp-client` 必须声明为 `peerDependencies`（package.json 已声明 `>=0.2.1-rc.1 <0.3.0`），否则 linked 目录不在 profile node_modules 祖先链，动态 import 报 Cannot find package。加 peer 后重新组合即恢复。
- 入口：composer 工具行 `conversation.input.left`（id mcp-project, order -10）图标；badge 相关 = 项目未信任/失败，或全局有 MCP 行（Host 侧 badge 合并全局计数）；面板 portal 到 body，softui 双主题。
- 语义映射：`${VAR}`/`${VAR:-default}` 展开、`enabled=false` 跳过、Codex `env_vars` 透传、`http_headers` 静态映射、`env_http_headers` 从环境解析（缺变量跳过+warning）、`bearer_token_env_var` 无显式 Authorization 时补 Bearer（未设置/冲突 warning）、`tool_timeout_sec`→toolCallTimeoutMs、`startup_timeout_sec` 忽略+warning。
- 仍范围外：Codex `auth`（OAuth）、`enabled_tools`/`disabled_tools`（保留 warning）。
- 安全：面板 args 与 header/url query 启发式脱敏，env/headers 只给 key；纯路径信任接受 git pull 自动执行风险。
- 验证：`npm run verify` 151 tests；真实 e2e 已验 trust→挂载→`mcp__e2e__ping` 可见→开关/重载/撤销；Codex http 三件套 live fixture 验证无 not supported、headerKeys 正确且无明文泄漏。
- 已知限制：rc.1 无连接状态/probe API → 死端口 server 长时间 `starting`；声明文件改动不自动重载（需面板「重新加载」或切目录）；同项目多会话多进程。
