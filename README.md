# @lixiangzhong/dsh-mcp

DSH（DeepSeek Harness）的 MCP 管理器，两个平面：

- **全局 MCP**：在 **设置 → MCP** 页面管理当前 profile `cordis.patch.yml` 里的原生 `@deepseek-ai/dsh-mcp-client` 行；
- **项目级 MCP**：识别项目里已有的 `.mcp.json`（Claude Code）与 `.codex/config.toml`（Codex），只在对应项目的会话里按会话隔离挂载；入口在**对话输入框权限控件旁的 MCP 图标**。

全局部分直接编辑原生行，因此：

- 生效路径与手写配置完全一致：写盘后由 HMR 热应用，Loader 负责挂载/卸载/重连；
- 现有手写行自动出现在列表里，无需迁移；
- 新增、编辑、启停、删除都在 UI 完成；
- 密钥值（`env` / `headers`）永远以掩码形式进入浏览器，编辑时留空表示保持不变。

项目级部分的设计与取舍见 [docs/specs/project-level-mcp-20261105.md](docs/specs/project-level-mcp-20261105.md)：默认不执行、信任后自动生效、每会话独立实例、纯路径信任（已知风险：`git pull` 引入的新命令会自动执行）。

## 安装

```bash
dsh plugin --profile <profile> add link:/path/to/dsh-mcp
```

或在 DSH 的 Plugins 页面安装本地目录。安装后刷新 Web GUI，打开 **设置 → MCP**。

## 能力

**全局（设置 → MCP）**

| 功能 | 说明 |
|---|---|
| 列表 | serverName / id / transport / 启用状态 / Loader phase / 已注册工具数 / 失败诊断 / 来源层 |
| 新增 | 表单按 transport 切换字段，保存后热生效 |
| 编辑 | 字段级最小 diff，未改动内容（注释、`!!js`、引号风格）原样保留 |
| 启停 | 行内 `disabled: true` / 删除该字段（列表里用 switch） |
| 删除 | 删除行与关联 override 行；空 `insert` 块一并清理 |
| 并发保护 | 写入使用 profile 写锁 + 内容哈希基线，外部改动会导致冲突拒绝而非覆盖 |

**项目级（对话输入框权限控件旁图标）**

| 功能 | 说明 |
|---|---|
| 声明识别 | 只读识别最近的 `.mcp.json` 与 `.codex/config.toml`；同名 Claude 优先 |
| 语义映射 | `${VAR}` 展开、Codex `env_vars` / `http_headers` / `env_http_headers` / `bearer_token_env_var`、`tool_timeout_sec` 映射（`startup_timeout_sec` 忽略 + warning） |
| 信任 | 默认不执行；面板里「信任并启用」一次后，该项目会话自动挂载（trust 列表在 `$DSH_HOME/dsh-mcp/trust.json`） |
| 会话隔离 | 每个会话独立挂载/卸载，不共享进程 |
| 面板 | 本项目 server 状态/开关/重新加载 + 全局只读列表（去设置管理） |
| 目录变化 | 会话切换工作目录后下一步按新项目重建 |

## 结构

```
index.js                 Host 入口（路由 + 写盘管线 + 项目运行时接线）
client.js                Client 半（设置页 + 会话内 MCP 面板，window.__ModuleLoader__ 模块）
lib/patch-doc.js         YAML 文档保真编辑（纯函数）
lib/row-model.js         行校验 / 掩码（纯函数）
lib/project-config.js    项目声明发现/解析/合并/映射（纯函数）
lib/project-host.js      项目级 MCP 生命周期（挂载/信任/cwd 跟随）
lib/host-service.js      Host 服务实现（全局写盘 + 项目 API）
docs/specs/              设计与验收文档
docs/contracts/          Host ↔ Client API 契约
fixtures/                验收用 stdio MCP server
test/                    node --test 单测
```

## 开发

```bash
npm install
npm run verify        # node --check + node --test
```

## 已知边界

- 只管理当前 profile 的 patch；home patch / bundle patch 中的同名行只读展示。
- 项目级声明文件只读：新增/删除/修改 server 需手改 `.mcp.json` / `.codex/config.toml`。
- 项目信任是**纯路径级**：已信任项目经 `git pull` 等引入的新命令会自动执行（无配置指纹校验）。
- 不做内置备份：写坏需外部（git/同步）恢复；写盘本身保证原子替换、冲突检测与回读校验。
- 不做「测试连接」与凭据模板（留待后续）。
- `toolCallTimeoutMs` / `maxInstructionBytes` / `failOnStartupError` / `reconnect` 为 `!!js` 表达式时，Row 只能展示为"未设置"；编辑时 Host 会保留原表达式节点（未显式提供新值时不会被删）。
- 安装后若 **设置** 中看不到 MCP 入口，刷新一次 GUI 页面。

## 验收状态

- 已通过：`npm run verify`（87/87）、真实 profile 的 新增/编辑/启停/删除、工具注册与消失、真实 patch 保真回环。
- 待目视/重启确认：见 [docs/verification-20261105.md](docs/verification-20261105.md)。

## License

MIT
