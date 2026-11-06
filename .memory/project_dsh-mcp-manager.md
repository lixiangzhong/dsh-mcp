# DSH MCP 管理插件（全局 MVP）关键约束

- **Type**: project
- **Topic**: dsh-mcp-manager
- **Updated**: 2026-11-05T07:13:20Z

## Summary

托管 profile patch 原生 mcp-client 行的 Settings 管理插件；保真 YAML 编辑 + 写锁 + revision 冲突检测；已安装并端到端验收。

## Why

后续迭代（项目级 MCP、视觉/重启验收、官方 manager 迁移）必须沿用这些已定取舍，避免推翻真相源与写入路径。

## How to Apply

在该仓库继续开发或排查 MCP 配置写入问题时先读；改动 lib/host-service.js 写盘管线或 lib/patch-doc.js 保真逻辑前先看 docs/verification-20261105.md 与契约。

## Context & Details

- 真相源：profile `cordis.patch.yml` 中原生 `@deepseek-ai/dsh-mcp-client` 的 insert 行（每 server 一行），不做官方同构 servers 字典、不做自有 JSON 文件。
- 写入管线：`withFileLock(<profile>/package.json)` + `writeFileAtomic` + sha256 revision 基线 + 回读校验 + 等 `app-boot/config-reload`（10s）。载荷是完整新文档的原子替换，但用 splice 做原位最小编辑以保注释/`!!js`/引号风格。
- `!!js` 表达式：patch 原文优先于 runtime config（runtime 可能已求值）；标量字段（toolCallTimeoutMs 等）请求省略时保留原表达式节点。
- 状态：`logger` entries 的 fiber state 映射 pending/loading/active/failed/unloading/null；failed 时 `await fiber.await()` 取诊断；工具数用 `ctx.tools.schemas()` 按 `mcp__<serverName>__` 前缀。
- Client↔Host：`ctx.webServer.register({kind:'prefix', path:'/dsh-mcp/api'})` + `ctx.connection.requestRejection(req)` 准入；浏览器同源 POST；不引入 Typert Remote。
- UI：settings.section id `mcp` order 90；client.js 内联 `ctx.locale.register('dsh-mcp',{zh,en})`。
- 验证：`npm run verify`（87 tests）+ docs/verification-20261105.md；真实 profile 增删改启停 + 保真回环（patch sha256 与操作前一致 cfffc149…b378）。
- 已知边界：无内置备份（用户决定）；不做 probe/凭据模板；UI 视觉与重启持久化待目视确认；项目级 MCP 是下一里程碑。
