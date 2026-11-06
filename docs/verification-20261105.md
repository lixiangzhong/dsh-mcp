# 集成与验收记录（2026-11-05）

- **环境**：DeepSeek Harness Desktop `0.2.2-rc.1`，profile `desktop`，Web GUI `http://127.0.0.1:61082`
- **交付物**：`@lixiangzhong/dsh-mcp@0.1.0-dev.1`（仓库 `link:` 安装）
- **结论**：**MVP 已装载并在真实运行环境中完成端到端验收**（新增/编辑/启停/删除 + 工具注册与消失 + 真实 profile 保真回环）。视觉与重启项见"剩余项"。

## 1. 安装

`plugin_manager install_bundle`（target = 仓库绝对路径）返回：

```json
{"stage":"enable","target":"@lixiangzhong/dsh-mcp","enabled":true,"changed":true,"application":"applied","warnings":[]}
```

- profile `package.json`：`"@lixiangzhong/dsh-mcp": "link:~/gopath/src/github.com/lixiangzhong/dsh-mcp"`
- profile `dsh.profile.bundles` 已包含 `@lixiangzhong/dsh-mcp`
- `plugin_manager` 无 warnings；profile patch 未被修改（安装前后 sha256 一致：`cfffc149…b378`）

## 2. Host 半装载

- `cordis_inspect_query Config.listConfigs` 列出条目 `include:mcp-manager`（`name: @lixiangzhong/dsh-mcp`）
- 未鉴权 `POST /dsh-mcp/api/list` 返回本插件自己的 envelope：`{"ok":false,"error":{"code":"FORBIDDEN"}}` → 路由已注册、准入闸生效
- 使用桌面应用的真实签名 Cookie（本机 loopback）调用成功，`list` 返回 4 条原生行：`chrome-devtools / dbx / sshs / stitch`，含 phase、toolCount、掩码 headers

## 3. Client 半装载

- `cordis_inspect_query Slots.listSubTree(root: settings.section)`：occupants 含 `{ id: "mcp", order: 90, active: true }`
- GUI index 模块图包含 `@lixiangzhong/dsh-mcp/client.js&rev=bd66336ff457`（客户端包已被注入页面）
- 页面文案走 `ctx.locale.register('dsh-mcp')`（client.js 内联 zh/en 152 key）

## 4. 端到端验收（真实 profile，通过鉴权 API 驱动）

| 步骤 | 观察结果 |
|---|---|
| 新增 fixture（stdio: `node fixtures/stdio-mcp-server.js`） | `applied:true`，耗时 `2256ms`；轮询 `list`：`phase=active`，`toolCount=1`，`tools=["mcp__fixture__ping"]` |
| 工具对模型可见 | `cordis_inspect_query Tool.listTools` 输出包含 `mcp__fixture__ping` |
| 停用 | `disabled:true`，`phase:null`，`toolCount:0` |
| 启用 | `disabled:false`，`phase:"active"`，`toolCount:1` |
| 改 serverName `fixture → fixture2` | 工具变为 `mcp__fixture2__ping`，`phase=active` |
| 删除 | `removedId:"mcp-fixture"`；`list` 恢复为原始 4 行 |
| **保真回环** | 增→改→删 全流程后 `cordis.patch.yml` sha256 = `cfffc149c44cac25166c50036c4c87f91dd27623d675802c08d1f838f293b378`，与操作前基线**逐字节一致** |

## 5. 自动化测试

- `npm run verify`：`node --check` 全部通过；`node --test test/` → **74 tests / 74 pass / 0 fail**
  - `test/patch-doc.test.js` 43（golden 文本保真、双 insert 块、`!!js`、override、空块清理、错误码）
  - `test/row-model.test.js` 21（掩码、SECRET_KEEP、transport 互斥、fixture 管道；导入导出测试已随功能移除）
  - `test/host-service.test.js` 10（真实写盘管线：锁、revision 冲突、reload 等待、非托管行拒绝、表达式保真）

## 6. 剩余项（不属于本轮验收闭环）

1. **视觉验收**：设置页已注册且在页面模块图中，但本会话无法在已鉴权的桌面渲染器内截图核对排版/动画；建议用户打开 设置 → MCP 目视确认（若未出现，刷新 GUI 页面一次）。
2. **重启持久化**：写盘内容已验证（Loader 启动即读同一 patch）；完整"重启 DSH 后仍在"需用户重启一次确认。
3. **项目级 MCP**：下一里程碑（spec 已声明范围外）。

---

# 项目级 MCP 验证记录（2026-11-05 追加）

- **环境**：同上（Desktop `0.2.2-rc.1`，profile `desktop`）
- **代码**：`lib/project-config.js`（P0）、`lib/project-host.js`（P1）、`client.js` 会话内入口（P2）、`lib/host-service.js` 项目 API（P3）
- **结论**：**项目级 MCP 在真实 DSH 中完成端到端验收**；发现并修复一个 link 安装的模块解析问题（见"关键修复"）。

## 1. 自动化测试

- `npm run verify` → **143 tests / 143 pass / 0 fail**
  - `test/patch-doc.test.js` 43、`test/row-model.test.js` 21、`test/host-service.test.js` 15、`test/project-config.test.js` 36、`test/project-host.test.js` 27、其余为 fixture/辅助

## 2. 真实端到端（当前工作区会话，通过鉴权 API 驱动）

临时项目 `/tmp/dsh-mcp-proj-e2e` 写入 `.mcp.json`（stdio fixture + 一个死端口 HTTP + 明文 env/url-token，用于掩码检查）：

| 步骤 | 观察结果 |
|---|---|
| 会话 cwd 切到临时项目（`working_directory`） | 下一步 `project/session` 的 `cwd` 跟随后生效；`projectDir`、`files` 正确 |
| 未信任 badge | `{relevant:true, badge:"untrusted"}` |
| 视图掩码 | `envKeys:["E2E_API_KEY"]`（无值）；HTTP url 的 `?token=••••••`；`headerKeys:["Authorization"]` |
| 信任 | `project/trust` → `trusted:true`；live 会话即时挂载 |
| 挂载状态 | `e2e: connected/active`（死端口 http 服务保持 `starting`，符合 rc.1 无状态 API 的已知限制） |
| 工具对模型可见 | `Tool.listTools` 出现 `mcp__e2e__ping` |
| 逐 server 开关 | off → `stopped/active:false`；on → `connected/active:true`；意愿持久化到 trust.json |
| 重新加载 | `project/reload` 重建挂载并保持 connected |
| 撤销信任 | 两个 server 均 `stopped`；`trust.json` 的 `projects` 清空；badge 回到 `untrusted` |
| 多会话/全局隔离 | 全局面板 `list` 仍返回 4 行且可写；项目工具只出现在该会话 |

## 3. 客户端装载

- `cordis_inspect_query Slots.listSubTree(root: conversation.input.left)`：occupants 含 `{id:"mcp-project", order:-10, active:true}`
- GUI index 模块图包含更新后的 `@lixiangzhong/dsh-mcp/client.js`

## 4. 关键修复（集成期发现）

**link 安装的 bundle 默认无法解析随 DSH 发行的 `@deepseek-ai/dsh-mcp-client`**：动态 import 报 `Cannot find package ... imported from <repo>/lib/project-host.js`。原因是 linked 目录不在 `$DSH_HOME/profiles/node_modules` 的祖先链上，运行时解析要求**peer 声明**才会做 peer-aware 查找。
修复：在 `package.json` 增加 `"peerDependencies": { "@deepseek-ai/dsh-mcp-client": ">=0.2.1-rc.1 <0.3.0" }`，重新组合后挂载成功。
→ 该约束已写入 spec 与内部契约；发布/迁移时不要删除该 peer。

## 5. 剩余项

1. **目视验收**：composer 图标/角标/面板的视觉效果需刷新 GUI 后由用户确认（本会话无已鉴权浏览器截图能力）。
2. **重启持久化**：trust.json 与项目声明均为磁盘事实，重启后仍生效；完整重启验证待用户执行。
3. **文件变更不自动重载**：项目声明手改后需面板「重新加载项目 MCP」或切换目录。

---

# softui 视觉重做记录（2026-11-05 追加）

- **背景**：用户反馈项目 MCP 面板"配色布局太丑"，要求按 `/uistyle` 的 softui 变体重做。
- **决策**：softui 本身是浅色规范，GUI 是深色；选定**双主题适配（跟随宿主明/暗）**：颜色由宿主主题 token 映射，softui 提供结构纪律（面差分层不靠描边、透明度文字阶梯、唯一渐变强调、三档柔阴影、大圆角、外松内紧）。
- **落地**：
  - 面板 380 宽 / radius 20 / padding 20 / max-height min(64vh,680px)；内层项目卡 16、服务器行 12、控件 12、药丸与开关 999；border 分层全部移除。
  - 暗色面板 = `--dsw-alias-bg-layer-2`（rgb(44,44,46)）；内层卡 = 白色 6% 叠加（rgb(57,57,59)）；hover 10%；遮罩 rgba(0,0,0,.55)+blur8；面板阴影 `0 24px 64px .55 + 0 2px 8px .4 + inset 1px 白 .06`。
  - 唯一渐变仅未信任 CTA（`#38bdf8→#3b82f6` + 30% glow）；switch-on 纯 `#3b82f6`；状态点低饱和语义色。
  - 警告收进项目卡「配置提示」；「文件内禁用」pill 中性化；空态去重。
- **验证**：`node --check` / `npm run verify` **143 tests 全绿**；离线自检 2029 断言；computed style：暗色 panel/card/server borderWidth=0、radius 20/16/12、唯一渐变数 1（trusted 页 0）、暗色对比 title 13.34 / 描述 5.61、无横向溢出；预览 12 页（6 状态 × 明/暗）在 `/tmp/preview-v2`（临时）。
- **服务端**：模块 rev 已更新（b7a1046f8da6），刷新 GUI 即加载新样式。
- **未验证**：真实宿主明暗主题下的计算值（可能与安装包提取主题略有差异）、Electron 中 backdrop-filter 表现、真实 composer 布局遮挡。

---

# 修复：Codex HTTP 鉴权字段未映射（2026-11-05 追加）

- **现象**：项目 `.codex/config.toml` 里 `[mcp_servers.stitch] http_headers = {...}` 被面板提示 `"http_headers" is not supported`。
- **原因**：P0 首版把 Codex 的 `http_headers` / `env_http_headers` / `bearer_token_env_var` 列为 MVP 范围外，只检测并 warning（非技术限制；`dsh-mcp-client` 支持 headers）。
- **修复**（`lib/project-config.js` + 8 个测试，现 44 tests）：
  - `http_headers` → `ProjectServer.headers`（静态，支持 `${VAR}` 展开）
  - `env_http_headers` → `envHeaderVars`，挂载时从注入 env 解析；未设置则跳过 + warning
  - `bearer_token_env_var` → `bearerTokenEnvVar`，无显式 `Authorization` 时补 `Bearer <env 值>`；未设置/冲突 warning
  - `maskServerForPanel.headerKeys` 覆盖三类来源（大小写不敏感去重，绝不返回值）
  - `auth`（OAuth）/ `enabled_tools` / `disabled_tools` 仍在范围外，保留 warning
- **验证**：
  - `npm run verify` → **151 tests / 151 pass / 0 fail**
  - 真实项目 fixture（`.codex/config.toml`：http_headers + env_http_headers + bearer + tool_timeout_sec）经鉴权 API 的 `project/session`：`warnings: []`、无 `not supported`、headerKeys 为 `["X-Goog-Api-Key","X-Custom","X-Env-Header","Authorization"]`、显式 Authorization 行正确去重、payload 中无任何 header 明文值
  - 插件已重载，临时 fixture 与 trust 状态已清理
