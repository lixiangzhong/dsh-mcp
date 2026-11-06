/**
 * test/project-config.test.js — P0 项目声明解析层黑盒单测
 *
 * 契约：docs/contracts/project-internals.md §1
 * 运行：node --test test/project-config.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildProjectServers,
  discoverProject,
  findNearestFile,
  maskServerForPanel,
  parseClaudeConfig,
  parseCodexConfig,
  resolveProjectDir,
  toClientConfig,
} from '../lib/project-config.js'

const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/project/', import.meta.url))

function fixturePath(...parts) {
  return join(FIXTURE_ROOT, ...parts)
}

function readFixture(...parts) {
  return readFileSync(fixturePath(...parts), 'utf8')
}

function findServer(servers, name) {
  const server = servers.find((item) => item.name === name)
  assert.ok(server !== undefined, `server "${name}" not found in ${servers.map((s) => s.name)}`)
  return server
}

const CLAUDE_PROJECT_DIR = fixturePath('claude', 'project')
const CLAUDE_CONFIG_PATH = join(CLAUDE_PROJECT_DIR, '.mcp.json')
const CODEX_PROJECT_DIR = fixturePath('codex', 'project')
const CODEX_CONFIG_PATH = join(CODEX_PROJECT_DIR, '.codex', 'config.toml')
const MERGE_DIR = fixturePath('merge')
const MERGE_CLAUDE_PATH = join(MERGE_DIR, '.mcp.json')
const MERGE_CODEX_PATH = join(MERGE_DIR, '.codex', 'config.toml')

/* ============================== findNearestFile ============================== */

test('findNearestFile：从深层目录向上找最近声明文件，返回绝对路径', () => {
  const deep = fixturePath('tree', 'sub', 'deep')
  assert.equal(findNearestFile(deep, '.mcp.json'), resolve(fixturePath('tree', 'sub', '.mcp.json')))
  assert.equal(
    findNearestFile(deep, '.codex/config.toml'),
    resolve(fixturePath('tree', 'sub', '.codex', 'config.toml')),
  )
  assert.equal(
    findNearestFile(fixturePath('tree'), '.mcp.json'),
    resolve(fixturePath('tree', '.mcp.json')),
  )
})

test('findNearestFile：找不到返回 null；参数非法抛 TypeError', () => {
  assert.equal(findNearestFile(fixturePath('empty'), '.dsh-mcp-no-such-declaration'), null)
  assert.throws(() => findNearestFile('', '.mcp.json'), TypeError)
  assert.throws(() => findNearestFile(fixturePath('empty'), ''), TypeError)
})

/* ============================== resolveProjectDir ============================== */

test('resolveProjectDir：单声明回落到项目根（codex 去掉 .codex 层）', () => {
  assert.equal(
    resolveProjectDir(CLAUDE_PROJECT_DIR, { claudePath: CLAUDE_CONFIG_PATH }),
    resolve(CLAUDE_PROJECT_DIR),
  )
  assert.equal(
    resolveProjectDir(CODEX_PROJECT_DIR, { codexPath: CODEX_CONFIG_PATH }),
    resolve(CODEX_PROJECT_DIR),
  )
  assert.equal(
    resolveProjectDir(MERGE_DIR, { claudePath: MERGE_CLAUDE_PATH, codexPath: MERGE_CODEX_PATH }),
    resolve(MERGE_DIR),
  )
  assert.equal(resolveProjectDir(MERGE_DIR, {}), null)
})

test('resolveProjectDir：项目根更深者胜，同深度 Claude 优先', () => {
  // Claude 声明在更深的项目目录 → 取 Claude 侧项目根。
  assert.equal(
    resolveProjectDir('/tmp', {
      claudePath: '/tmp/a/b/.mcp.json',
      codexPath: '/tmp/a/.codex/config.toml',
    }),
    resolve('/tmp/a/b'),
  )
  // Codex 声明在更深的项目目录 → 取 Codex 侧项目根。
  assert.equal(
    resolveProjectDir('/tmp', {
      claudePath: '/tmp/a/.mcp.json',
      codexPath: '/tmp/a/pkg/.codex/config.toml',
    }),
    resolve('/tmp/a/pkg'),
  )
  // 同项目根：Claude 优先与 Codex 一致（两者都回落到同一项目根）。
  assert.equal(
    resolveProjectDir('/tmp/a', {
      claudePath: '/tmp/a/.mcp.json',
      codexPath: '/tmp/a/.codex/config.toml',
    }),
    resolve('/tmp/a'),
  )
})

/* ============================== parseClaudeConfig ============================== */

test('parseClaudeConfig：stdio/http/sse 形态齐全，变量保留原文', () => {
  const { servers, warnings } = parseClaudeConfig(readFixture('claude', 'project', '.mcp.json'))

  assert.deepEqual(warnings, [])
  assert.equal(servers.length, 3)

  const stdio = findServer(servers, 'fixture-stdio')
  assert.equal(stdio.source, 'claude')
  assert.equal(stdio.transport, 'stdio')
  assert.equal(stdio.enabled, true)
  assert.equal(stdio.command, 'node')
  assert.deepEqual(stdio.args, ['${FIXTURE_SERVER_PATH:-./fixtures/stdio-mcp-server.js}'])
  assert.deepEqual(stdio.env, { TOKEN: '${PROJECT_TOKEN}', MODE: 'test' })
  assert.equal(stdio.cwd, './work')

  const http = findServer(servers, 'remote-http')
  assert.equal(http.transport, 'streamable-http')
  assert.equal(http.url, '${HTTP_MCP_URL:-http://127.0.0.1:7333}/mcp')
  assert.deepEqual(http.headers, { Authorization: 'Bearer ${PROJECT_TOKEN}' })

  const sse = findServer(servers, 'legacy-sse')
  assert.equal(sse.transport, 'streamable-http')
  assert.equal(sse.url, 'https://example.com/sse')
})

test('parseClaudeConfig：坏 JSON 降级为 warnings + 空 servers，不抛', () => {
  const { servers, warnings } = parseClaudeConfig(readFixture('broken', '.mcp.json'))
  assert.deepEqual(servers, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /invalid Claude config JSON/)
})

test('parseClaudeConfig：缺 mcpServers / 根非对象 → 告警且空结果', () => {
  assert.match(parseClaudeConfig('{}').warnings[0], /no "mcpServers"/)
  assert.match(parseClaudeConfig('[]').warnings[0], /root must be a JSON object/)
  const empty = parseClaudeConfig('{"mcpServers":{}}')
  assert.deepEqual(empty, { servers: [], warnings: [] })
})

test('parseClaudeConfig：非法条目跳过并逐条告警', () => {
  const text = JSON.stringify({
    mcpServers: {
      'bad name': { command: 'node' },
      'not-object': 'nope',
      'stdio-without-command': { type: 'stdio' },
      ambiguous: { command: 'node', url: 'http://a/mcp' },
      'unknown-type': { type: 'websocket', url: 'ws://a' },
      'bad-values': { command: 'node', args: ['ok', 42], env: { GOOD: 'x', BAD: 1 } },
    },
  })
  const { servers, warnings } = parseClaudeConfig(text)
  assert.deepEqual(servers.map((server) => server.name), ['bad-values'])
  const joined = warnings.join('\n')
  assert.match(joined, /invalid serverName/)
  assert.match(joined, /must be an object/)
  assert.match(joined, /type "stdio" requires command/)
  assert.match(joined, /both command and url/)
  assert.match(joined, /unsupported type "websocket"/)
  assert.match(joined, /args: non-string item ignored/)
  assert.match(joined, /env\.BAD: non-string value ignored/)
  const badValues = findServer(servers, 'bad-values')
  assert.deepEqual(badValues.args, ['ok'])
  assert.deepEqual(badValues.env, { GOOD: 'x' })
})

/* ============================== parseCodexConfig ============================== */

test('parseCodexConfig：嵌套 env 表 / env_vars / enabled / tool_timeout_sec 映射', () => {
  const { servers, warnings } = parseCodexConfig(
    readFixture('codex', 'project', '.codex', 'config.toml'),
  )

  assert.equal(servers.length, 3)
  const computerUse = findServer(servers, 'computer-use')
  assert.equal(computerUse.source, 'codex')
  assert.equal(computerUse.transport, 'stdio')
  assert.equal(computerUse.enabled, false)
  assert.equal(computerUse.cwd, '.')
  assert.deepEqual(computerUse.args, ['mcp'])

  const nodeRepl = findServer(servers, 'node_repl')
  assert.equal(nodeRepl.transport, 'stdio')
  assert.equal(nodeRepl.enabled, true)
  assert.deepEqual(nodeRepl.envVars, [
    'BROWSER_USE_ACCESS_PIPE_PATH',
    'BROWSER_USE_MISSING_VAR',
  ])
  assert.deepEqual(nodeRepl.env, {
    NODE_REPL_NODE_PATH: '/opt/cua_node/bin/node',
    NODE_REPL_TIMEOUT_MS: '1000',
  })
  assert.equal(nodeRepl.args, undefined)
  assert.equal(nodeRepl.toolCallTimeoutMs, 90000)

  const sshs = findServer(servers, 'sshs')
  assert.equal(sshs.transport, 'streamable-http')
  assert.equal(sshs.url, 'http://127.0.0.1:7333/mcp')

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /startup_timeout_sec/)
})

test('parseCodexConfig：坏 TOML 降级为 warnings + 空 servers，不抛', () => {
  const { servers, warnings } = parseCodexConfig(
    readFixture('broken', '.codex', 'config.toml'),
  )
  assert.deepEqual(servers, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /invalid Codex config TOML/)
})

test('parseCodexConfig：缺 mcp_servers → 告警且空结果', () => {
  const parsed = parseCodexConfig('model = "x"\n')
  assert.deepEqual(parsed.servers, [])
  assert.match(parsed.warnings[0], /no \[mcp_servers\] table/)
})

test('parseCodexConfig：非法条目 / 非法 timeout / 不支持字段逐条告警', () => {
  const text = [
    '[mcp_servers."bad name"]',
    'command = "node"',
    '',
    '[mcp_servers.no-endpoint]',
    'tool_timeout_sec = 5',
    '',
    '[mcp_servers.ambiguous]',
    'command = "node"',
    'url = "http://a/mcp"',
    '',
    '[mcp_servers.bad-timeout]',
    'command = "node"',
    'tool_timeout_sec = -3',
    '',
    '[mcp_servers.bad-env-vars]',
    'command = "node"',
    'env_vars = ["OK_VAR", 3]',
    '',
    '[mcp_servers.http-auth]',
    'url = "https://example.com/mcp"',
    'bearer_token_env_var = "MCP_TOKEN"',
    '',
    '[mcp_servers.unsupported]',
    'command = "node"',
    'auth = "oauth"',
    'enabled_tools = ["a"]',
    'disabled_tools = ["b"]',
  ].join('\n')

  const { servers, warnings } = parseCodexConfig(text)
  assert.deepEqual(
    servers.map((server) => server.name).sort(),
    ['bad-env-vars', 'bad-timeout', 'http-auth', 'unsupported'],
  )
  assert.deepEqual(findServer(servers, 'bad-env-vars').envVars, ['OK_VAR'])
  assert.equal(findServer(servers, 'bad-timeout').toolCallTimeoutMs, undefined)
  assert.equal(findServer(servers, 'http-auth').transport, 'streamable-http')
  assert.equal(findServer(servers, 'http-auth').bearerTokenEnvVar, 'MCP_TOKEN')

  const joined = warnings.join('\n')
  assert.match(joined, /invalid serverName/)
  assert.match(joined, /missing command or url/)
  assert.match(joined, /both command and url/)
  assert.match(joined, /invalid "tool_timeout_sec"/)
  assert.match(joined, /env_vars: non-string item ignored/)
  assert.match(joined, /"auth" is not supported/)
  assert.match(joined, /"enabled_tools" is not supported/)
  assert.match(joined, /"disabled_tools" is not supported/)
  // HTTP 鉴权三件套已支持，不再打 not supported。
  assert.equal(/"bearer_token_env_var" is not supported/.test(joined), false)
})

test('parseCodexConfig：HTTP 鉴权三件套保存为原始数据（不再 not supported）', () => {
  const text = [
    '[mcp_servers.stitch]',
    'url = "https://stitch.googleapis.com/mcp"',
    'bearer_token_env_var = "STITCH_TOKEN"',
    '',
    '[mcp_servers.stitch.http_headers]',
    'X-Goog-Api-Key = "static-header-key"',
    'X-Trace = "trace-1"',
    '',
    '[mcp_servers.stitch.env_http_headers]',
    'Authorization = "STITCH_AUTH_TOKEN"',
  ].join('\n')

  const { servers, warnings } = parseCodexConfig(text)
  assert.deepEqual(warnings, [])
  const stitch = findServer(servers, 'stitch')
  assert.equal(stitch.transport, 'streamable-http')
  assert.deepEqual(stitch.headers, {
    'X-Goog-Api-Key': 'static-header-key',
    'X-Trace': 'trace-1',
  })
  assert.deepEqual(stitch.envHeaderVars, { Authorization: 'STITCH_AUTH_TOKEN' })
  assert.equal(stitch.bearerTokenEnvVar, 'STITCH_TOKEN')
})

test('parseCodexConfig：HTTP 鉴权字段非法值降级；stdio 上 HTTP-only 字段忽略', () => {
  const text = [
    '[mcp_servers.http-bad]',
    'url = "https://example.com/mcp"',
    'http_headers = { Good = "x", Bad = 1 }',
    'env_http_headers = { N = 2 }',
    'bearer_token_env_var = ""',
    '',
    '[mcp_servers.stdio-with-http]',
    'command = "node"',
    'http_headers = { A = "b" }',
    'env_http_headers = { X = "ENV_X" }',
    'bearer_token_env_var = "TOKEN_ENV"',
  ].join('\n')

  const { servers, warnings } = parseCodexConfig(text)
  const httpBad = findServer(servers, 'http-bad')
  assert.deepEqual(httpBad.headers, { Good: 'x' })
  assert.equal(httpBad.envHeaderVars, undefined)
  assert.equal(httpBad.bearerTokenEnvVar, undefined)

  const stdioWithHttp = findServer(servers, 'stdio-with-http')
  assert.equal(stdioWithHttp.transport, 'stdio')
  assert.equal(stdioWithHttp.headers, undefined)
  assert.equal(stdioWithHttp.envHeaderVars, undefined)
  assert.equal(stdioWithHttp.bearerTokenEnvVar, undefined)

  const joined = warnings.join('\n')
  assert.match(joined, /http_headers\.Bad: non-string value ignored/)
  assert.match(joined, /env_http_headers\.N: non-string value ignored/)
  assert.match(joined, /bearer_token_env_var: env var name must be a non-empty string/)
  assert.match(joined, /"http_headers" is only valid for streamable-http/)
  assert.match(joined, /"env_http_headers" is only valid for streamable-http/)
  assert.match(joined, /"bearer_token_env_var" is only valid for streamable-http/)
})

/* ============================== buildProjectServers ============================== */

test('buildProjectServers：同名 Claude 优先，files/cwd 正确', () => {
  const built = buildProjectServers({
    claudePath: MERGE_CLAUDE_PATH,
    claudeText: readFixture('merge', '.mcp.json'),
    codexPath: MERGE_CODEX_PATH,
    codexText: readFixture('merge', '.codex', 'config.toml'),
  })

  assert.deepEqual(built.files, [
    { path: resolve(MERGE_CLAUDE_PATH), format: 'claude' },
    { path: resolve(MERGE_CODEX_PATH), format: 'codex' },
  ])
  assert.deepEqual(
    built.servers.map((server) => server.name),
    ['shared', 'claude-only', 'codex-only'],
  )

  const shared = findServer(built.servers, 'shared')
  assert.equal(shared.source, 'claude')
  assert.deepEqual(shared.args, ['claude-shared.js'])
  assert.equal(shared.cwd, resolve(MERGE_DIR, 'claude-work'))

  const codexOnly = findServer(built.servers, 'codex-only')
  assert.equal(codexOnly.source, 'codex')
  // Codex 相对 cwd 按配置文件目录（<project>/.codex/）解析。
  assert.equal(codexOnly.cwd, resolve(MERGE_DIR, '.codex', 'codex-work'))

  assert.deepEqual(built.warnings, ['claude overrides codex:shared'])
})

test('buildProjectServers：缺 text / 缺 path / 空输入降级', () => {
  const textOnly = buildProjectServers({
    claudeText: JSON.stringify({ mcpServers: { lone: { command: 'node' } } }),
  })
  assert.deepEqual(textOnly.files, [])
  assert.equal(textOnly.servers.length, 1)
  assert.match(textOnly.warnings.join('\n'), /without a path/)

  const pathOnly = buildProjectServers({ claudePath: MERGE_CLAUDE_PATH })
  assert.deepEqual(pathOnly.files, [])
  assert.deepEqual(pathOnly.servers, [])
  assert.match(pathOnly.warnings.join('\n'), /text not provided/)

  assert.deepEqual(buildProjectServers({}), { servers: [], files: [], warnings: [] })
})

test('buildProjectServers：解析失败仍登记 files 并保留 warnings', () => {
  const built = buildProjectServers({
    claudePath: fixturePath('broken', '.mcp.json'),
    claudeText: readFixture('broken', '.mcp.json'),
    codexPath: fixturePath('broken', '.codex', 'config.toml'),
    codexText: readFixture('broken', '.codex', 'config.toml'),
  })
  assert.equal(built.files.length, 2)
  assert.deepEqual(built.servers, [])
  assert.equal(built.warnings.length, 2)
})

/* ============================== toClientConfig ============================== */

test('toClientConfig：stdio 变量展开 / env / cwd 绝对化', () => {
  const { servers } = parseClaudeConfig(readFixture('claude', 'project', '.mcp.json'))
  const stdio = findServer(servers, 'fixture-stdio')
  const { config, warnings } = toClientConfig(stdio, {
    env: {
      FIXTURE_SERVER_PATH: '/abs/fixtures/stdio-mcp-server.js',
      PROJECT_TOKEN: 'tok-1',
    },
    projectDir: CLAUDE_PROJECT_DIR,
  })

  assert.deepEqual(warnings, [])
  assert.deepEqual(config, {
    serverName: 'fixture-stdio',
    transport: 'stdio',
    command: 'node',
    args: ['/abs/fixtures/stdio-mcp-server.js'],
    env: { TOKEN: 'tok-1', MODE: 'test' },
    cwd: resolve(CLAUDE_PROJECT_DIR, 'work'),
  })
})

test('toClientConfig：http 默认值兜底 + headers 展开', () => {
  const { servers } = parseClaudeConfig(readFixture('claude', 'project', '.mcp.json'))
  const remote = findServer(servers, 'remote-http')
  const { config, warnings } = toClientConfig(remote, {
    env: { PROJECT_TOKEN: 'tok-1' },
    projectDir: CLAUDE_PROJECT_DIR,
  })

  assert.deepEqual(warnings, [])
  assert.deepEqual(config, {
    serverName: 'remote-http',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:7333/mcp',
    headers: { Authorization: 'Bearer tok-1' },
  })
})

test('toClientConfig：未设置变量 → warning + 空值；${VAR:-default} 空串也取默认', () => {
  const base = {
    name: 'x',
    source: 'claude',
    transport: 'stdio',
    enabled: true,
    command: '${MISSING_CMD}',
  }
  const unset = toClientConfig(base, { env: {} })
  assert.equal(unset.config.command, '')
  assert.match(unset.warnings.join('\n'), /unset variable "MISSING_CMD" in command/)

  const withDefault = toClientConfig(
    { ...base, command: '${HTTP_URL:-http://fallback}/mcp' },
    { env: { HTTP_URL: '' } },
  )
  assert.equal(withDefault.config.command, 'http://fallback/mcp')
  assert.deepEqual(withDefault.warnings, [])
})

test('toClientConfig：env_vars 透传，未设置告警，显式 env 优先', () => {
  const server = {
    name: 'node_repl',
    source: 'codex',
    transport: 'stdio',
    enabled: true,
    command: '/opt/node_repl',
    env: { NODE_REPL_TIMEOUT_MS: '1000', SHARED: 'explicit' },
    envVars: ['BROWSER_USE_ACCESS_PIPE_PATH', 'BROWSER_USE_MISSING_VAR', 'SHARED'],
  }
  const { config, warnings } = toClientConfig(server, {
    env: { BROWSER_USE_ACCESS_PIPE_PATH: '/tmp/pipe', SHARED: 'from-env-vars' },
  })

  assert.deepEqual(config.env, {
    BROWSER_USE_ACCESS_PIPE_PATH: '/tmp/pipe',
    SHARED: 'explicit',
    NODE_REPL_TIMEOUT_MS: '1000',
  })
  assert.match(warnings.join('\n'), /env_vars entry "BROWSER_USE_MISSING_VAR" is not set/)
})

test('toClientConfig：绝对 cwd 保留；相对 cwd 无 projectDir 时省略并告警', () => {
  const absolute = toClientConfig(
    { name: 'x', source: 'claude', transport: 'stdio', enabled: true, command: 'node', cwd: '/tmp/work' },
    {},
  )
  assert.equal(absolute.config.cwd, normalize('/tmp/work'))

  const relative = toClientConfig(
    { name: 'x', source: 'claude', transport: 'stdio', enabled: true, command: 'node', cwd: './work' },
    {},
  )
  assert.equal(relative.config.cwd, undefined)
  assert.match(relative.warnings.join('\n'), /no projectDir to resolve against/)
})

test('toClientConfig：缺少 command/url 的非法 server 也降级为 warning', () => {
  const stdio = toClientConfig(
    { name: 'x', source: 'claude', transport: 'stdio', enabled: true },
    {},
  )
  assert.equal(stdio.config.command, '')
  assert.match(stdio.warnings.join('\n'), /stdio command is missing or empty/)

  const http = toClientConfig(
    { name: 'y', source: 'claude', transport: 'streamable-http', enabled: true },
    {},
  )
  assert.equal(http.config.url, '')
  assert.match(http.warnings.join('\n'), /http url is missing or empty/)
})

test('toClientConfig：非法 timeout 省略；enabled/source 不进入 config', () => {
  const { config, warnings } = toClientConfig(
    {
      name: 'x',
      source: 'codex',
      transport: 'stdio',
      enabled: false,
      command: 'node',
      toolCallTimeoutMs: 0,
    },
    {},
  )
  assert.equal(config.toolCallTimeoutMs, undefined)
  assert.match(warnings.join('\n'), /toolCallTimeoutMs is not a positive number/)
  assert.equal('enabled' in config, false)
  assert.equal('source' in config, false)
})

test('toClientConfig：Codex http_headers 映射进 config.headers（值展开变量）', () => {
  const { config, warnings } = toClientConfig(
    {
      name: 'stitch',
      source: 'codex',
      transport: 'streamable-http',
      enabled: true,
      url: 'https://stitch.googleapis.com/mcp',
      headers: { 'X-Goog-Api-Key': 'static-key', 'X-Project': '${PROJECT_ID}' },
    },
    { env: { PROJECT_ID: 'p-1' } },
  )
  assert.deepEqual(warnings, [])
  assert.deepEqual(config.headers, {
    'X-Goog-Api-Key': 'static-key',
    'X-Project': 'p-1',
  })
})

test('toClientConfig：env_http_headers 从注入 env 解析，未设置跳过并 warning', () => {
  const { config, warnings } = toClientConfig(
    {
      name: 'stitch',
      source: 'codex',
      transport: 'streamable-http',
      enabled: true,
      url: 'https://stitch.googleapis.com/mcp',
      envHeaderVars: { Authorization: 'STITCH_AUTH_TOKEN', 'X-Project': 'MISSING_PROJECT' },
    },
    { env: { STITCH_AUTH_TOKEN: 'Bearer env-token' } },
  )
  assert.deepEqual(config.headers, { Authorization: 'Bearer env-token' })
  assert.match(
    warnings.join('\n'),
    /env_http_headers\.X-Project: environment variable "MISSING_PROJECT" is not set; skipped/,
  )
})

test('toClientConfig：bearer_token_env_var 补 Authorization；未设置不伪造空 token', () => {
  const base = {
    name: 'stitch',
    source: 'codex',
    transport: 'streamable-http',
    enabled: true,
    url: 'https://stitch.googleapis.com/mcp',
    bearerTokenEnvVar: 'STITCH_TOKEN',
  }

  const withToken = toClientConfig(base, { env: { STITCH_TOKEN: 'tok-1' } })
  assert.deepEqual(withToken.config.headers, { Authorization: 'Bearer tok-1' })
  assert.deepEqual(withToken.warnings, [])

  const unset = toClientConfig(base, { env: {} })
  assert.equal(unset.config.headers, undefined)
  assert.match(
    unset.warnings.join('\n'),
    /bearer_token_env_var: environment variable "STITCH_TOKEN" is not set; skipped/,
  )

  const emptyToken = toClientConfig(base, { env: { STITCH_TOKEN: '' } })
  assert.equal(emptyToken.config.headers, undefined)
})

test('toClientConfig：显式 Authorization 优先于 bearer（大小写不敏感）并 warning', () => {
  const base = {
    name: 'stitch',
    source: 'codex',
    transport: 'streamable-http',
    enabled: true,
    url: 'https://example.com/mcp',
    bearerTokenEnvVar: 'STITCH_TOKEN',
  }
  const env = { STITCH_TOKEN: 'bearer-token', AUTH_ENV: 'env-auth' }

  // 静态 http_headers 里的小写 authorization 也算显式来源。
  const staticAuth = toClientConfig(
    { ...base, headers: { authorization: 'Bearer explicit' } },
    { env },
  )
  assert.deepEqual(staticAuth.config.headers, { authorization: 'Bearer explicit' })
  assert.equal('Authorization' in staticAuth.config.headers, false)
  assert.match(staticAuth.warnings.join('\n'), /explicit Authorization header takes precedence/)

  // env_http_headers 提供 Authorization：同样优先。
  const envAuth = toClientConfig({ ...base, envHeaderVars: { Authorization: 'AUTH_ENV' } }, { env })
  assert.deepEqual(envAuth.config.headers, { Authorization: 'env-auth' })
  assert.match(envAuth.warnings.join('\n'), /explicit Authorization header takes precedence/)

  // env_http_headers 声明了 Authorization 但环境变量未设置：bearer 也不补（显式来源优先）。
  const declaredOnly = toClientConfig(
    { ...base, envHeaderVars: { Authorization: 'MISSING_AUTH' } },
    { env },
  )
  assert.equal(declaredOnly.config.headers, undefined)
  const joined = declaredOnly.warnings.join('\n')
  assert.match(joined, /env_http_headers\.Authorization: environment variable "MISSING_AUTH" is not set/)
  assert.match(joined, /explicit Authorization header takes precedence/)
})

/* ============================== maskServerForPanel ============================== */

test('maskServerForPanel：绝不返回 env/headers 值，只给 key 列表', () => {
  const masked = maskServerForPanel({
    name: 'figma',
    source: 'claude',
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', 'figma-developer-mcp', '--figma-api-key=secret-arg'],
    env: { TOKEN: 'super-secret', OTHER: 'x' },
    cwd: '/tmp/project',
  })

  assert.equal(masked.name, 'figma')
  assert.equal(masked.source, 'claude')
  assert.equal(masked.transport, 'stdio')
  assert.equal(masked.enabled, true)
  assert.equal(masked.command, 'npx')
  assert.deepEqual(masked.args, ['-y', 'figma-developer-mcp', '--figma-api-key=••••••'])
  assert.equal(masked.cwd, '/tmp/project')
  assert.deepEqual(masked.envKeys, ['OTHER', 'TOKEN'])
  assert.deepEqual(masked.headerKeys, [])
  assert.equal('env' in masked, false)
  assert.equal('headers' in masked, false)
  assert.equal(JSON.stringify(masked).includes('super-secret'), false)
  assert.equal(JSON.stringify(masked).includes('secret-arg'), false)
})

test('maskServerForPanel：args 保守脱敏（4 种形态）且保留命令可读性', () => {
  const masked = maskServerForPanel({
    name: 'multi',
    source: 'claude',
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: [
      '-y',
      'some-mcp',
      '--figma-api-key=figd_abcdef',
      '--token',
      'tok-123',
      'API_KEY=plain-secret',
      'https://example.com/mcp?api_key=query-secret&page=2',
      '--url=https://example.com/mcp?token=url-secret',
      '--headless',
      '--name=readable',
    ],
  })

  assert.deepEqual(masked.args, [
    '-y',
    'some-mcp',
    '--figma-api-key=••••••',
    '--token',
    '••••••',
    'API_KEY=••••••',
    'https://example.com/mcp?api_key=••••••&page=2',
    '--url=https://example.com/mcp?token=••••••',
    '--headless',
    '--name=readable',
  ])

  const serialized = JSON.stringify(masked)
  for (const secret of ['figd_abcdef', 'tok-123', 'plain-secret', 'query-secret', 'url-secret']) {
    assert.equal(serialized.includes(secret), false, `secret "${secret}" leaked to panel data`)
  }
  // 非敏感参数保持可读。
  assert.equal(serialized.includes('some-mcp'), true)
  assert.equal(serialized.includes('page=2'), true)
  assert.equal(serialized.includes('--headless'), true)
  assert.equal(serialized.includes('--name=readable'), true)
})

test('maskServerForPanel：HTTP server 的 url 查询串同样脱敏', () => {
  const masked = maskServerForPanel({
    name: 'remote',
    source: 'claude',
    transport: 'streamable-http',
    enabled: true,
    url: 'https://example.com/mcp?token=url-token&page=2',
  })
  assert.equal(masked.url, 'https://example.com/mcp?token=••••••&page=2')
  assert.equal(JSON.stringify(masked).includes('url-token'), false)

  const plain = maskServerForPanel({
    name: 'plain',
    source: 'claude',
    transport: 'streamable-http',
    enabled: true,
    url: 'https://example.com/mcp',
  })
  assert.equal(plain.url, 'https://example.com/mcp')
})

test('maskServerForPanel：正常参数不误伤；无值的敏感 flag 不吞下一个 flag', () => {
  const normalArgs = [
    '-y',
    'chrome-devtools-mcp@latest',
    '--headless',
    '--no-usage-statistics',
    '--port=9222',
    '--name=my-server',
    '-v',
  ]
  assert.deepEqual(
    maskServerForPanel({ name: 'n', source: 'claude', transport: 'stdio', enabled: true, args: normalArgs })
      .args,
    normalArgs,
  )

  const flagOnly = maskServerForPanel({
    name: 'n',
    source: 'claude',
    transport: 'stdio',
    enabled: true,
    args: ['--token', '--headless', '--password=hunter2'],
  })
  assert.deepEqual(flagOnly.args, ['--token', '--headless', '--password=••••••'])
})

test('maskServerForPanel：http 只给 header keys，缺失可选字段不出现', () => {
  const masked = maskServerForPanel({
    name: 'remote',
    source: 'claude',
    transport: 'streamable-http',
    enabled: false,
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer real-token' },
  })

  assert.deepEqual(masked.headerKeys, ['Authorization'])
  assert.deepEqual(masked.envKeys, [])
  assert.equal(masked.url, 'https://example.com/mcp')
  assert.equal(masked.enabled, false)
  assert.equal('headers' in masked, false)
  assert.equal(JSON.stringify(masked).includes('real-token'), false)
  for (const field of ['command', 'args', 'cwd']) {
    assert.equal(field in masked, false)
  }
})

test('maskServerForPanel：headerKeys 覆盖三类来源、顺序稳定、绝不返回值', () => {
  const masked = maskServerForPanel({
    name: 'stitch',
    source: 'codex',
    transport: 'streamable-http',
    enabled: true,
    url: 'https://stitch.googleapis.com/mcp',
    headers: { 'X-Goog-Api-Key': 'static-secret', 'X-Trace': 'trace' },
    envHeaderVars: { 'X-Project': 'PROJECT_ID' },
    bearerTokenEnvVar: 'STITCH_TOKEN',
  })
  assert.deepEqual(masked.headerKeys, [
    'X-Goog-Api-Key',
    'X-Trace',
    'X-Project',
    'Authorization',
  ])
  const serialized = JSON.stringify(masked)
  assert.equal(serialized.includes('static-secret'), false)
  assert.equal(serialized.includes('PROJECT_ID'), false)
  assert.equal(serialized.includes('STITCH_TOKEN'), false)
  assert.equal('headers' in masked, false)

  // 已存在 authorization（任意大小写）时不再重复追加 Authorization。
  const deduped = maskServerForPanel({
    name: 'x',
    source: 'codex',
    transport: 'streamable-http',
    enabled: true,
    url: 'https://example.com/mcp',
    headers: { authorization: 'v' },
    bearerTokenEnvVar: 'TOKEN_ENV',
  })
  assert.deepEqual(deduped.headerKeys, ['authorization'])

  const bearerOnly = maskServerForPanel({
    name: 'y',
    source: 'codex',
    transport: 'streamable-http',
    enabled: true,
    url: 'https://example.com/mcp',
    bearerTokenEnvVar: 'TOKEN_ENV',
  })
  assert.deepEqual(bearerOnly.headerKeys, ['Authorization'])
})

/* ============================== discoverProject ============================== */

test('discoverProject：多层目录取最近声明，projectDir 为深层声明项目', () => {
  const discovered = discoverProject(fixturePath('tree', 'sub', 'deep'), readFileSync)

  assert.equal(discovered.projectDir, resolve(fixturePath('tree', 'sub')))
  assert.deepEqual(discovered.files, [
    { path: resolve(fixturePath('tree', 'sub', '.mcp.json')), format: 'claude' },
    {
      path: resolve(fixturePath('tree', 'sub', '.codex', 'config.toml')),
      format: 'codex',
    },
  ])
  assert.deepEqual(
    discovered.servers.map((server) => server.name).sort(),
    ['sub-codex', 'sub-server'],
  )
  assert.deepEqual(discovered.warnings, [])
})

test('discoverProject：项目根发现根层声明', () => {
  const discovered = discoverProject(fixturePath('tree'), readFileSync)
  assert.equal(discovered.projectDir, resolve(fixturePath('tree')))
  assert.deepEqual(
    discovered.servers.map((server) => server.name).sort(),
    ['root-codex', 'root-server'],
  )
})

test('discoverProject：合并同名 + 覆盖 warning', () => {
  const discovered = discoverProject(MERGE_DIR, readFileSync)
  assert.equal(discovered.projectDir, resolve(MERGE_DIR))
  assert.deepEqual(
    discovered.servers.map((server) => server.name),
    ['shared', 'claude-only', 'codex-only'],
  )
  assert.deepEqual(discovered.warnings, ['claude overrides codex:shared'])
})

test('discoverProject：坏文件降级不抛，files 仍登记', () => {
  const brokenDir = fixturePath('broken')
  const discovered = discoverProject(brokenDir, readFileSync)

  assert.deepEqual(discovered.servers, [])
  assert.equal(discovered.files.length, 2)
  assert.equal(discovered.projectDir, resolve(brokenDir))
  const joined = discovered.warnings.join('\n')
  assert.match(joined, /invalid Claude config JSON/)
  assert.match(joined, /invalid Codex config TOML/)
})

test('discoverProject：无声明文件返回空结果', (t) => {
  // 用系统临时目录构造"向上无任何声明"的场景（fixture 目录在 $HOME 之下，
  // 会被本机 ~/.codex/config.toml 命中，不适合此用例）。
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-empty-'))
  t.after(() => rmSync(tempDir, { recursive: true, force: true }))
  if (findNearestFile(tempDir, '.mcp.json') !== null || findNearestFile(tempDir, '.codex/config.toml') !== null) {
    t.skip('environment has ancestor MCP declarations above the temp directory')
    return
  }

  assert.deepEqual(discoverProject(tempDir, readFileSync), {
    projectDir: null,
    files: [],
    servers: [],
    warnings: [],
  })
})

test('discoverProject：忽略全局 Codex 配置（spec §2.1 只读项目层声明）', (t) => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-mcp-home-'))
  t.after(() => rmSync(fakeHome, { recursive: true, force: true }))
  const globalCodexDir = join(fakeHome, '.codex')
  mkdirSync(globalCodexDir, { recursive: true })
  writeFileSync(
    join(globalCodexDir, 'config.toml'),
    '[mcp_servers.global-only]\ncommand = "node"\n',
  )
  const projectDir = join(fakeHome, 'workspace')
  mkdirSync(projectDir, { recursive: true })

  // 只有全局 Codex 配置 → 视为无项目声明，且给出忽略说明。
  const globalOnly = discoverProject(projectDir, readFileSync, { homeDir: fakeHome })
  assert.deepEqual(globalOnly.servers, [])
  assert.deepEqual(globalOnly.files, [])
  assert.equal(globalOnly.projectDir, null)
  assert.match(globalOnly.warnings.join('\n'), /ignored global Codex config/)

  // 项目层 `.codex/config.toml` 仍然生效。
  const projectCodexDir = join(projectDir, '.codex')
  mkdirSync(projectCodexDir, { recursive: true })
  writeFileSync(
    join(projectCodexDir, 'config.toml'),
    '[mcp_servers.project-only]\ncommand = "node"\n',
  )
  const withProject = discoverProject(projectDir, readFileSync, { homeDir: fakeHome })
  assert.deepEqual(withProject.servers.map((server) => server.name), ['project-only'])
  assert.equal(withProject.projectDir, projectDir)
})

test('discoverProject：注入 reader 读失败降级，另一份声明照常解析', () => {
  const reader = (filePath, encoding) => {
    if (filePath.endsWith('.mcp.json')) throw new Error('EACCES: permission denied')
    return readFileSync(filePath, encoding)
  }
  const discovered = discoverProject(MERGE_DIR, reader)

  // Claude 声明不可读 → 只剩 Codex 侧（shared 不再被 Claude 覆盖）。
  assert.deepEqual(
    discovered.servers.map((server) => server.name),
    ['shared', 'codex-only'],
  )
  assert.equal(findServer(discovered.servers, 'shared').source, 'codex')
  const joined = discovered.warnings.join('\n')
  assert.match(joined, /failed to read/)
  assert.match(joined, /EACCES/)
  assert.equal(discovered.projectDir, resolve(MERGE_DIR))
})

/* ============================== 管线联调 ============================== */

test('管线：discoverProject → toClientConfig 产出可挂载 config（Claude）', () => {
  const discovered = discoverProject(CLAUDE_PROJECT_DIR, readFileSync)
  const env = { PROJECT_TOKEN: 'tok-1' }

  const stdioServer = findServer(discovered.servers, 'fixture-stdio')
  const stdio = toClientConfig(stdioServer, { env, projectDir: discovered.projectDir })
  assert.deepEqual(stdio.warnings, [])
  assert.equal(stdio.config.serverName, 'fixture-stdio')
  assert.equal(stdio.config.command, 'node')
  assert.deepEqual(stdio.config.args, ['./fixtures/stdio-mcp-server.js'])
  assert.deepEqual(stdio.config.env, { TOKEN: 'tok-1', MODE: 'test' })
  assert.equal(stdio.config.cwd, resolve(CLAUDE_PROJECT_DIR, 'work'))

  const httpServer = findServer(discovered.servers, 'remote-http')
  const http = toClientConfig(httpServer, { env, projectDir: discovered.projectDir })
  assert.equal(http.config.url, 'http://127.0.0.1:7333/mcp')
  assert.deepEqual(http.config.headers, { Authorization: 'Bearer tok-1' })
})

test('管线：discoverProject → toClientConfig 产出可挂载 config（Codex）', () => {
  const discovered = discoverProject(CODEX_PROJECT_DIR, readFileSync)
  const nodeRepl = findServer(discovered.servers, 'node_repl')
  const { config, warnings } = toClientConfig(nodeRepl, {
    env: { BROWSER_USE_ACCESS_PIPE_PATH: '/tmp/pipe' },
  })

  assert.equal(config.serverName, 'node_repl')
  assert.equal(config.transport, 'stdio')
  assert.equal(config.toolCallTimeoutMs, 90000)
  assert.equal(config.env.BROWSER_USE_ACCESS_PIPE_PATH, '/tmp/pipe')
  assert.equal(config.env.NODE_REPL_TIMEOUT_MS, '1000')
  assert.match(warnings.join('\n'), /BROWSER_USE_MISSING_VAR/)

  const computerUse = findServer(discovered.servers, 'computer-use')
  assert.equal(computerUse.enabled, false)
  assert.equal(
    toClientConfig(computerUse, {}).config.cwd,
    resolve(CODEX_PROJECT_DIR, '.codex'),
  )
})

test('管线：Codex HTTP 鉴权三件套 parse → toClientConfig → mask 全链路', () => {
  const text = [
    '[mcp_servers.stitch]',
    'url = "https://stitch.googleapis.com/mcp"',
    'bearer_token_env_var = "STITCH_TOKEN"',
    'tool_timeout_sec = 300',
    '',
    '[mcp_servers.stitch.http_headers]',
    'X-Goog-Api-Key = "header-secret"',
    '',
    '[mcp_servers.stitch.env_http_headers]',
    'X-Project = "STITCH_PROJECT"',
  ].join('\n')

  const { servers, warnings: parseWarnings } = parseCodexConfig(text)
  assert.deepEqual(parseWarnings, [])
  const server = findServer(servers, 'stitch')

  const { config, warnings } = toClientConfig(server, {
    env: { STITCH_TOKEN: 'tok-1', STITCH_PROJECT: 'p-1' },
  })
  assert.deepEqual(warnings, [])
  assert.equal(config.url, 'https://stitch.googleapis.com/mcp')
  assert.equal(config.toolCallTimeoutMs, 300000)
  assert.deepEqual(config.headers, {
    'X-Goog-Api-Key': 'header-secret',
    'X-Project': 'p-1',
    Authorization: 'Bearer tok-1',
  })

  const masked = maskServerForPanel(server)
  assert.deepEqual(masked.headerKeys, ['X-Goog-Api-Key', 'X-Project', 'Authorization'])
  const serialized = JSON.stringify(masked)
  assert.equal(serialized.includes('header-secret'), false)
  assert.equal(serialized.includes('tok-1'), false)
  assert.equal(serialized.includes('p-1'), false)
})
