# Host ↔ Client API contract (v0)

本文件是并行开发的**唯一接口真相源**。Host（`index.js` / `lib/host-service.js`）与 Client（`client.js`）各自按此实现；任一侧要改，先改本文件并通知对方。

## 1. 传输

- 基址：同源 `POST /dsh-mcp/api/<action>`（Web GUI 页面内直接 `fetch`，无需 URL 前缀）。
- 请求：`Content-Type: application/json`，body ≤ 1 MiB。
- 鉴权：Host 用 `ctx.connection.requestRejection(req) === undefined` 判定；不通过返回 HTTP 403 + `{ ok:false, error:{ code:'FORBIDDEN', message } }`。
- 非 POST / 非 JSON / 超大 body：HTTP 400 同 envelope。
- 业务错误一律 HTTP 200 + `{ ok:false, error }`（鉴权与协议错误除外，便于调试）。
- 成功：`{ ok:true, data:<payload> }`。

## 2. 常量

| 常量 | 值 | 含义 |
|---|---|---|
| `SECRET_KEEP` | `"__KEEP__"` | 写请求中 env/headers 的值等于它 = 保留原值（仅更新时合法） |
| `MASK` | `"••••••"` | list 中 secret 值的掩码 |
| `EXPRESSION` | `"__EXPRESSION__"` | 该值为 YAML `!!js` 表达式（不可编辑其求值结果，只能整体替换） |

## 3. 行模型（`Row`，list 返回）

```jsonc
{
  "id": "mcp-sshs",                         // Loader 行 id（写操作的唯一键）
  "serverName": "sshs",                     // mcp-client config.serverName
  "source": "profile",                      // profile | home | bundle | other
  "editable": true,                         // 仅 source=profile 且行位于 profile patch 的 insert 列表
  "disabled": false,                        // 行内 disabled 字段
  "transport": "streamable-http",           // stdio | streamable-http | null
  "command": null,                          // stdio: string | null
  "args": null,                             // string[] | null
  "cwd": null,                              // string | null
  "env": null,                              // Record<string,string> | null；值恒为 MASK 或 EXPRESSION
  "url": "http://127.0.0.1:7333/mcp",       // string | null
  "headers": { "Authorization": "••••••" }, // Record<string,string> | null；值恒为 MASK 或 EXPRESSION
  "toolCallTimeoutMs": null,                // number | null
  "maxInstructionBytes": null,              // number | null
  "failOnStartupError": false,              // boolean | null
  "reconnect": null,                        // object | null
  "phase": "active",                        // pending|loading|active|failed|unloading|null
  "diagnostic": null,                       // string | null：failed 时的启动诊断
  "toolCount": 12,                          // 已注册的 mcp__<serverName>__* 工具数
  "tools": ["mcp__sshs__ssh_exec"]          // 最多 50 个公开工具名
}
```

## 4. Actions

### 4.1 `list`

请求：`{}`（可带 `{}`；无参数）

响应 `data`：

```jsonc
{
  "rows": [ /* Row[] */ ],
  "profile": { "dir": "/Users/x/.dsh/profiles/desktop", "patchPath": "/Users/x/.dsh/profiles/desktop/cordis.patch.yml" },
  "revision": "sha256:…",   // 当前 patch 文件内容哈希；写操作的并发基线
  "generatedAt": "2026-11-05T06:40:00.000Z"
}
```

### 4.2 `upsert`（新增 / 编辑）

请求：

```jsonc
{
  "baseRevision": "sha256:…",       // 必填；与当前 revision 不一致 → CONFLICT
  "originalId": "mcp-sshs",         // 编辑时必填；新增时省略
  "row": {
    "serverName": "myserver",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "some-mcp"],
    "cwd": "",
    "env": { "TOKEN": "real-value" },   // 可选；仅编辑时允许 SECRET_KEEP
    "url": null,                         // http 时使用
    "headers": null,                     // http 时使用；同上
    "toolCallTimeoutMs": 60000,          // 可选
    "maxInstructionBytes": null,         // 可选
    "failOnStartupError": false,         // 可选
    "reconnect": null,                   // 可选
    "enabled": true                      // 必填：落为行内 disabled 的反面
  }
}
```

规则：

- `serverName` 必须匹配 `^[A-Za-z0-9_-]{1,32}$` 且在**可编辑行**中唯一（编辑自身时排除自己）。
- stdio 禁止 `url/headers`；http 禁止 `command/args/env/cwd`（Host 侧同样校验，返回 `INVALID_ARGUMENT` 并带 `field`）。
- 编辑时只写回出现差异的字段；未出现差异的节点必须保持原 YAML 节点（注释/`!!js`/引号风格不变）。
- 新行 id 由 Host 生成：`mcp-` + `slugify(serverName)`；冲突时追加 `-2`、`-3`。
- 写成功返回时 `revision` 为写后哈希。

响应 `data`：

```jsonc
{ "revision": "sha256:…", "row": { /* Row */ }, "applied": true, "timedOut": false, "tookMs": 1840 }
```

### 4.3 `remove`

请求：`{ "baseRevision": "sha256:…", "id": "mcp-sshs" }`
响应 `data`：`{ "revision": "sha256:…", "removedId": "mcp-sshs", "applied": true, "timedOut": false, "tookMs": 1900 }`
规则：删除行节点 + 指向该 id 的 override 行；空 `insert` 块一并移除；不可编辑行 → `NOT_EDITABLE`。

### 4.4 `toggle`

请求：`{ "baseRevision": "sha256:…", "id": "mcp-sshs", "enabled": false }`
响应 `data`：`{ "revision": "sha256:…", "row": { /* Row */ }, "applied": true, "timedOut": false, "tookMs": 1750 }`
规则：`enabled:false` → 行内写 `disabled: true`（已有则不动）；`enabled:true` → 删除行内 `disabled` 字段（若为 `!!js` 表达式 → `INVALID_ARGUMENT`，需手动处理）。

### 4.5 项目级 actions（`project/*`，设计与内部契约见 [project-internals.md](project-internals.md)）

均沿用 §1 的传输、准入与 envelope。`sessionId` 为当前会话 id；`dir` 必须是绝对路径。

| action | 请求 | 响应 data |
|---|---|---|
| `project/session` | `{ sessionId }` | `{ cwd, projectDir, files:[{path,format:'claude'\|'codex'}], trusted, servers:[ProjectServerView], warnings, global:[{name,id,phase,toolCount,enabled}] }`；ProjectServerView 不含 env/headers 值（只有 `envKeys`/`headerKeys`），含 `active`、`status`、`lastError`、`overridesGlobal`、`enabled` |
| `project/trust` | `{ dir, trusted:boolean }` | `{ dir, trusted }` |
| `project/toggle` | `{ sessionId, serverName, enabled:boolean }` | `{ serverName, enabled }` |
| `project/reload` | `{ sessionId }` | 同 `project/session` |
| `project/badge` | `{ sessionId }` | `{ relevant:boolean, badge:'untrusted'\|'failed'\|null }` |

失败沿用 §5 错误码；项目运行时未装载时返回 `INTERNAL`。

## 5. 错误码

| code | HTTP | 含义 | 附带 |
|---|---|---|---|
| `FORBIDDEN` | 403 | 请求准入失败 | — |
| `BAD_REQUEST` | 400 | 非 POST / 非 JSON / body 超限 | — |
| `INVALID_ARGUMENT` | 200 | 字段校验失败 | `field`, `details` |
| `CONFLICT` | 200 | `baseRevision` 过期 | `details.currentRevision` |
| `NOT_FOUND` | 200 | id 不存在 | — |
| `NOT_EDITABLE` | 200 | 行来自 home/bundle，只读 | — |
| `UNSUPPORTED` | 200 | 该行的 `disabled` 是 `!!js` 表达式等无法安全改写的形态 | — |
| `WRITE_FAILED` | 200 | 写盘/回读校验/文档解析失败 | `details.reason` |
| `INTERNAL` | 200 | 未预期异常 | — |

## 6. 生效语义

- 写入成功后 Host 在内存中等待 `app-boot/config-reload`（超时 10s）：收到 → `applied:true`；超时 → `applied:false, timedOut:true`（写入已提交，UI 提示"已保存，等待生效/查看日志"）。
- Client 写后重新 `list` 刷新，展示 phase/toolCount 变化。

## 7. Client 侧约定

- 页面通过 `settings.section`（`id: "mcp"`, `order: 90`, label 走 `ctx.locale.bind("dsh-mcp")`）注册。
- 所有文案走 `ctx.locale.register("dsh-mcp", { zh, en })`（client.js 内联字典），不写死中英文。
- 页面状态机：`loading → ready | error`；写操作期间的按钮 disabled + 一行状态文案；错误按 `error.code` 映射文案并展示 `field`。
- 错误码必须覆盖：`FORBIDDEN`、`BAD_REQUEST`、`INVALID_ARGUMENT`、`CONFLICT`、`NOT_FOUND`、`NOT_EDITABLE`、`UNSUPPORTED`、`WRITE_FAILED`、`INTERNAL`；未知 code 显示原文。
- 写后刷新：写操作成功（含 `applied:false, timedOut:true`）后应重新 `list`；`applied:false` 时提示"已保存，等待生效（查看日志）"。
- 表单中 secret 输入框初始为 MASK 占位；未修改则回传 `SECRET_KEEP`；用户清空并留空 = 删除该 key（体现在提交的 env/headers 完整 map 里：该 key 不出现）。

## 8. 内部模块导出契约（Host 侧并行部分）

以下签名是 Host 集成方（`index.js` / `lib/host-service.js`）与纯函数模块之间的**硬契约**；实现可以更丰富，但不得改变这些导出名与语义。

### 8.1 `lib/patch-doc.js` — YAML 文档编辑引擎（纯函数，零 DSH 依赖）

```js
/** 解析 patch 文本；解析失败抛 PatchParseError。 */
export function parsePatchText(text) // -> { rows: PatchRow[], hasJsExpressions: boolean }

/** PatchRow: { id, insertBlockIndex, rowIndex, moduleName, config, disabled, disabledIsExpression, editableLocation: 'insert' } */

/** 对文本执行一次编辑，返回新文本；未知操作/前置条件不满足抛 PatchEditError。 */
export function editPatchText(text, operation) // -> { text, id }
```

operation：

```js
{ op: 'upsert', originalId?: string, rowId: string, config: object, enabled: boolean }
{ op: 'remove', id: string }
{ op: 'toggle', id: string, enabled: boolean }
```

规则：

- `upsert`：`originalId` 命中已有行 → 只改差异字段（未变节点逐字节保留；新增字段按行内既有风格追加）；未命中 → 在**最后一个含 mcp-client 行的 `insert` 块**追加新行，没有则新建 `- insert:` 块（块前加一行注释 `# MCP servers managed by dsh-mcp`）。
- 标量表达式保真：`toolCallTimeoutMs` / `maxInstructionBytes` / `failOnStartupError` / `reconnect` 若原值是 `!!js` 表达式，而请求未提供该字段（Row 只能投影为 null），Host 保留原表达式节点；显式提供新值时按新值写入。
- 行内 `config` 与 `enabled` 同源：`enabled:false` 写 `disabled: true`（若该字段已是 `!!js` 表达式 → 抛 `UNSUPPORTED`）。
- `remove`：删除 insert 行（含其行前注释）+ 所有 `id` 命中的 override 行；`insert` 块变空则整块删除。
- 除被操作节点外，**其他所有节点与注释保持原样**。
- `PatchEditError.code` ∈ `PARSE | NOT_FOUND | UNSUPPORTED | DUPLICATE | INVALID_ARGUMENT`，并带 `message`（可含 `field`）。
- 不依赖 `@deepseek-ai/*`，只允许 `yaml`。

### 8.2 `lib/row-model.js` — 行模型 / 校验 / 掩码（纯函数，零 DSH 依赖）

```js
export const SECRET_KEEP = '__KEEP__'
export const MASK = '••••••'
export const EXPRESSION = '__EXPRESSION__'

/** 把 mcp-client config 转为对外 Row 部分字段（secret 掩码；!!js → EXPRESSION）。 */
export function maskConfig(config) // -> { transport, command, args, cwd, env, url, headers, toolCallTimeoutMs, maxInstructionBytes, failOnStartupError, reconnect }

/** 校验 upsert 输入（serverName/transport 互斥字段/数值范围）；失败抛 ValidationError{field,message}。 */
export function validateRowInput(input) // -> void

/** 把 UI 输入与既有 config 合并成写盘 config（解析 SECRET_KEEP、剔除 null、保证 transport 字段）。 */
export function buildConfig(input, existingConfig) // -> object

/** 由 serverName 生成唯一行 id。 */
export function nextRowId(serverName, takenIds) // -> string

/** 从运行时工具名里筛出某 server 的工具。 */
export function toolsForServer(serverName, toolNames) // -> string[]
```

规则：只依赖标准库；错误对象需带 `code`（`INVALID_ARGUMENT` 等）与 `field`（可空）。
