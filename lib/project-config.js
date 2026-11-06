/**
 * lib/project-config.js — 项目级 MCP 声明解析层（P0）
 *
 * 纯函数模块：只依赖 Node 标准库 + `smol-toml`，禁止 import `@deepseek-ai/*`。
 * 契约真相源：docs/contracts/project-internals.md §1（导出签名/返回形状冻结）。
 * 设计真相源：docs/specs/project-level-mcp-20261105.md §4.1。
 *
 * 支持两种项目声明（**只读**，插件永不写项目文件）：
 *   - Claude Code：最近的祖先目录下的 `.mcp.json`
 *   - Codex：最近的祖先目录下的 `.codex/config.toml`
 *
 * 阶段约定：
 *   - 解析阶段（parseClaudeConfig / parseCodexConfig）保留 `${VAR}` / `${VAR:-default}`
 *     原文与相对 cwd，不做环境求值；
 *   - 映射阶段（toClientConfig）用调用方注入的 env 展开变量、透传 env_vars、绝对化 cwd，
 *     产出可直接交给 dsh-mcp-client 的 config。
 *
 * 降级原则：坏文件 / 非法条目只写 warnings 并跳过，不向调用方抛异常；
 * 仅参数类型非法时抛 TypeError。
 */
import { readFileSync as fsReadFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'

/* ============================== 常量 ============================== */

const SOURCE_CLAUDE = 'claude'
const SOURCE_CODEX = 'codex'

const TRANSPORT_STDIO = 'stdio'
const TRANSPORT_HTTP = 'streamable-http'

/** 发现用的相对路径（各自独立向上查找）。 */
const CLAUDE_RELATIVE_PATH = '.mcp.json'
const CODEX_RELATIVE_PATH = '.codex/config.toml'
const CODEX_DIR_NAME = '.codex'

/** serverName 与 mcp-client 一致：1~32 位字母数字下划线连字符。 */
const SERVER_NAME_MAX_LENGTH = 32
const SERVER_NAME_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${SERVER_NAME_MAX_LENGTH}}$`)

/** Claude `.mcp.json` 中可归一化为 streamable-http 的 type 值。 */
const CLAUDE_HTTP_TYPES = Object.freeze(new Set(['http', 'sse']))

/** `${VAR}` / `${VAR:-default}`（VAR 仅字母数字下划线，default 不含嵌套）。 */
const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

const MS_PER_SECOND = 1000
const EMPTY_STRING = ''

/**
 * 面板展示用的 secret 掩码，与 docs/contracts/host-api.md §2 的 MASK 保持一致。
 * 不 import row-model.js：本模块契约要求只依赖 Node 标准库 + smol-toml。
 */
const MASK = '••••••'

/**
 * args 中"疑似密钥"的 flag/key 名启发式（宁可多掩，不可漏掩）。
 * 覆盖 --api-key / --figma-api-key / --token / --secret / --password / -pwd /
 * --authorization / --credential / --bearer 等常见命名。
 */
const SENSITIVE_ARG_NAME_PATTERN =
  /(api[-_]?key|token|secret|password|passwd|pwd|auth|credential|bearer)/i

/** `--flag=VALUE` 形态（flag 可含字母数字 `_` `-` `.`）。 */
const ARG_FLAG_ASSIGNMENT_PATTERN = /^(-{1,2}[A-Za-z0-9][\w.-]*)=([\s\S]*)$/

/** 纯 flag 形态（值可能在下一个 token）。 */
const ARG_FLAG_PATTERN = /^-{1,2}[A-Za-z0-9][\w.-]*$/

/** `KEY=VALUE` 形态（无前导连字符，如 API_KEY=xxx）。 */
const ARG_ENV_ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/

/** URL 查询串参数分隔符。 */
const QUERY_PAIR_SEPARATOR = '&'

/** Codex 中本模块仍无法映射的字段（显式告警避免静默失真）。 */
const CODEX_UNSUPPORTED_FIELDS = Object.freeze(['auth', 'enabled_tools', 'disabled_tools'])

/** HTTP 鉴权头名：比较大小写不敏感，写入时统一用官方大小写。 */
const AUTHORIZATION_HEADER = 'Authorization'

/** Codex 中仅 streamable-http 有意义的 HTTP 鉴权字段（stdio 上出现则忽略并告警）。 */
const CODEX_HTTP_ONLY_FIELDS = Object.freeze([
  'http_headers',
  'env_http_headers',
  'bearer_token_env_var',
])

/* ============================== 发现 ============================== */

/**
 * 从 startDir 向上找最近的文件（相对路径）。返回绝对路径或 null。
 * 从文件系统根继续向上没有意义，因此到根目录即停止。
 *
 * @param {string} startDir 起始目录（会话 cwd）
 * @param {string} relativePath 相对路径，如 '.mcp.json' / '.codex/config.toml'
 * @returns {string|null}
 */
export function findNearestFile(startDir, relativePath) {
  if (typeof startDir !== 'string' || startDir === EMPTY_STRING) {
    throw new TypeError('findNearestFile(startDir, relativePath): startDir must be a non-empty string')
  }
  if (typeof relativePath !== 'string' || relativePath === EMPTY_STRING) {
    throw new TypeError('findNearestFile(startDir, relativePath): relativePath must be a non-empty string')
  }
  let directory = resolve(startDir)
  for (;;) {
    const candidate = resolve(directory, relativePath)
    if (isFile(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/**
 * 项目身份键：取两个声明文件中更深（路径更长）的那个所在目录；无文件返回 null。
 *
 * 实现口径（契约措辞的落地解释）：
 *   - `.mcp.json` 的"所在目录" = 文件父目录（即项目根）；
 *   - `.codex/config.toml` 的"所在目录" = 去掉 `.codex` 层后的项目根，
 *     这样同一项目只有 Codex 声明时 trust 键与有 Claude 声明时一致。
 *
 * @param {string} cwd 会话目录（用于解析相对 found 路径）
 * @param {{ claudePath?: string|null, codexPath?: string|null, files?: Array<{path:string, format:string}> }} found
 * @returns {string|null}
 */
export function resolveProjectDir(cwd, found) {
  if (typeof cwd !== 'string' || cwd === EMPTY_STRING) {
    throw new TypeError('resolveProjectDir(cwd, found): cwd must be a non-empty string')
  }
  if (!isRecord(found)) return null
  const candidates = collectDeclarationFiles(cwd, found)
  if (candidates.length === 0) return null

  // 项目根更深（声明更靠近会话）者优先；同深度按声明路径长度、再 Claude 优先。
  let chosen = candidates[0]
  for (const candidate of candidates.slice(1)) {
    if (compareDeclarationDepth(candidate, chosen) > 0) chosen = candidate
  }
  return chosen.projectDir
}

/* ============================== Claude 解析 ============================== */

/**
 * 解析 `.mcp.json` 文本（Claude Code 格式）。
 *
 * 支持：`mcpServers` 对象；stdio（command/args/env/cwd）与
 * http（type:"http"|"sse" 或 url/headers）两种形态。
 * `${VAR}`/`${VAR:-default}` 在本阶段**保留原文**，由 toClientConfig 展开。
 * 坏 JSON → warnings 记录并返回空 servers，不抛异常。
 *
 * @param {string} text 文件全文
 * @returns {{ servers: import('./project-config.js').ProjectServer[], warnings: string[] }}
 */
export function parseClaudeConfig(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseClaudeConfig(text): text must be a string')
  }
  const warnings = []
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    warnings.push(`invalid Claude config JSON: ${errorText(error)}`)
    return { servers: [], warnings }
  }
  if (!isRecord(document)) {
    warnings.push('Claude config root must be a JSON object')
    return { servers: [], warnings }
  }
  const rawServers = document.mcpServers
  if (!isRecord(rawServers)) {
    warnings.push('Claude config has no "mcpServers" object')
    return { servers: [], warnings }
  }
  const servers = []
  for (const [name, rawEntry] of Object.entries(rawServers)) {
    const server = parseClaudeServer(name, rawEntry, warnings)
    if (server !== undefined) servers.push(server)
  }
  return { servers, warnings }
}

/** 解析单个 Claude server 条目；非法条目写 warning 并返回 undefined。 */
function parseClaudeServer(name, rawEntry, warnings) {
  const label = `claude server "${name}"`
  if (!SERVER_NAME_PATTERN.test(name)) {
    warnings.push(`${label}: invalid serverName; skipped`)
    return undefined
  }
  if (!isRecord(rawEntry)) {
    warnings.push(`${label}: config must be an object; skipped`)
    return undefined
  }
  const declaredType = readDeclaredType(rawEntry.type, label, CLAUDE_HTTP_TYPES, warnings)
  if (declaredType === 'invalid') return undefined

  const endpoint = resolveTransport(rawEntry, declaredType, label, warnings)
  if (endpoint === undefined) return undefined

  const server = {
    name,
    source: SOURCE_CLAUDE,
    transport: endpoint,
    // Claude `.mcp.json` 没有 enabled 语义：声明即启用。
    enabled: true,
  }
  if (endpoint === TRANSPORT_STDIO) {
    server.command = rawEntry.command
    const args = collectStringArray(rawEntry.args, `${label} args`, warnings)
    if (args !== undefined) server.args = args
    const env = collectStringRecord(rawEntry.env, `${label} env`, warnings)
    if (env !== undefined) server.env = env
    if (isNonEmptyString(rawEntry.cwd)) server.cwd = rawEntry.cwd
  } else {
    server.url = rawEntry.url
    const headers = collectStringRecord(rawEntry.headers, `${label} headers`, warnings)
    if (headers !== undefined) server.headers = headers
  }
  return server
}

/* ============================== Codex 解析 ============================== */

/**
 * 解析 `.codex/config.toml` 文本。
 *
 * 支持：`[mcp_servers.<name>]` 的 command/args/env(嵌套表)/env_vars(透传名单)/
 * cwd/url/enabled/tool_timeout_sec；streamable-http 的 HTTP 鉴权三件套
 * `http_headers` / `env_http_headers` / `bearer_token_env_var` 在此保存为原始数据，
 * 环境变量求值留到 toClientConfig；`startup_timeout_sec` 忽略并写 warning。
 * cwd 在此阶段保持原文（相对路径由 buildProjectServers 按配置文件目录解析）。
 * 坏 TOML → warnings 记录并返回空 servers，不抛异常。
 *
 * @param {string} text 文件全文
 * @returns {{ servers: import('./project-config.js').ProjectServer[], warnings: string[] }}
 */
export function parseCodexConfig(text) {
  if (typeof text !== 'string') {
    throw new TypeError('parseCodexConfig(text): text must be a string')
  }
  const warnings = []
  let document
  try {
    document = parseToml(text)
  } catch (error) {
    warnings.push(`invalid Codex config TOML: ${errorText(error)}`)
    return { servers: [], warnings }
  }
  if (!isRecord(document)) {
    warnings.push('Codex config root must be a table')
    return { servers: [], warnings }
  }
  const rawServers = document.mcp_servers
  if (rawServers === undefined) {
    warnings.push('Codex config has no [mcp_servers] table')
    return { servers: [], warnings }
  }
  if (!isRecord(rawServers)) {
    warnings.push('Codex config "mcp_servers" must be a table')
    return { servers: [], warnings }
  }
  const servers = []
  for (const [name, rawEntry] of Object.entries(rawServers)) {
    const server = parseCodexServer(name, rawEntry, warnings)
    if (server !== undefined) servers.push(server)
  }
  return { servers, warnings }
}

/** 解析单个 Codex server 条目；非法条目写 warning 并返回 undefined。 */
function parseCodexServer(name, rawEntry, warnings) {
  const label = `codex server "${name}"`
  if (!SERVER_NAME_PATTERN.test(name)) {
    warnings.push(`${label}: invalid serverName; skipped`)
    return undefined
  }
  if (!isRecord(rawEntry)) {
    warnings.push(`${label}: config must be a table; skipped`)
    return undefined
  }

  // Codex 用 command / url 区分传输形态，没有 type 字段。
  const endpoint = resolveTransport(rawEntry, null, label, warnings)
  if (endpoint === undefined) return undefined

  const server = {
    name,
    source: SOURCE_CODEX,
    transport: endpoint,
    enabled: readCodexEnabled(rawEntry.enabled, label, warnings),
  }
  if (endpoint === TRANSPORT_STDIO) {
    server.command = rawEntry.command
    const args = collectStringArray(rawEntry.args, `${label} args`, warnings)
    if (args !== undefined) server.args = args
    const env = collectStringRecord(rawEntry.env, `${label} env`, warnings)
    if (env !== undefined) server.env = env
    const envVars = collectStringArray(rawEntry.env_vars, `${label} env_vars`, warnings)
    if (envVars !== undefined) server.envVars = envVars
    if (isNonEmptyString(rawEntry.cwd)) server.cwd = rawEntry.cwd
    warnHttpOnlyFields(rawEntry, label, warnings)
  } else {
    server.url = rawEntry.url
    const headers = collectStringRecord(rawEntry.http_headers, `${label} http_headers`, warnings)
    if (headers !== undefined) server.headers = headers
    const envHeaderVars = collectStringRecord(
      rawEntry.env_http_headers,
      `${label} env_http_headers`,
      warnings,
    )
    if (envHeaderVars !== undefined) server.envHeaderVars = envHeaderVars
    const bearerTokenEnvVar = readOptionalEnvVarName(
      rawEntry.bearer_token_env_var,
      `${label} bearer_token_env_var`,
      warnings,
    )
    if (bearerTokenEnvVar !== undefined) server.bearerTokenEnvVar = bearerTokenEnvVar
  }

  applyCodexTimeouts(server, rawEntry, label, warnings)
  warnCodexUnsupportedFields(rawEntry, label, warnings)
  return server
}

/** Codex enabled：缺省 true；非布尔值告警后按缺省处理。 */
function readCodexEnabled(value, label, warnings) {
  if (value === undefined) return true
  if (typeof value === 'boolean') return value
  warnings.push(`${label}: "enabled" must be a boolean; assuming true`)
  return true
}

/** Codex 超时：tool_timeout_sec → toolCallTimeoutMs；startup_timeout_sec 忽略并告警。 */
function applyCodexTimeouts(server, rawEntry, label, warnings) {
  if (rawEntry.startup_timeout_sec !== undefined) {
    warnings.push(
      `${label}: "startup_timeout_sec" is ignored (rc.1 mcp-client has no startup timeout)`,
    )
  }
  const timeoutSeconds = rawEntry.tool_timeout_sec
  if (timeoutSeconds === undefined) return
  if (
    typeof timeoutSeconds !== 'number' ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    warnings.push(`${label}: invalid "tool_timeout_sec" ignored`)
    return
  }
  server.toolCallTimeoutMs = Math.round(timeoutSeconds * MS_PER_SECOND)
}

/** Codex 中本模块仍不支持的字段（如 OAuth `auth`、工具过滤名单）：显式告警。 */
function warnCodexUnsupportedFields(rawEntry, label, warnings) {
  for (const field of CODEX_UNSUPPORTED_FIELDS) {
    if (rawEntry[field] !== undefined) {
      warnings.push(`${label}: "${field}" is not supported; ignored`)
    }
  }
}

/** stdio server 上出现 HTTP-only 鉴权字段：忽略并告警，避免误以为已生效。 */
function warnHttpOnlyFields(rawEntry, label, warnings) {
  for (const field of CODEX_HTTP_ONLY_FIELDS) {
    if (rawEntry[field] !== undefined) {
      warnings.push(`${label}: "${field}" is only valid for streamable-http; ignored`)
    }
  }
}

/** 读取一个"环境变量名"字段：非空字符串合法；其他类型/空串告警后忽略。 */
function readOptionalEnvVarName(value, context, warnings) {
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.trim() !== EMPTY_STRING) return value
  warnings.push(`${context}: env var name must be a non-empty string; ignored`)
  return undefined
}

/* ============================== 合并 ============================== */

/**
 * 合并两份声明（各自已由 findNearestFile 定位），同名时 Claude 优先。
 *
 * - files：实际参与解析的文件（path + format），供面板展示来源；
 * - codex 的相对 cwd 在此按**配置文件所在目录**（即 `<project>/.codex/`）绝对化；
 * - claude 的相对 cwd 按 `.mcp.json` 所在目录绝对化；
 * - 解析错误只累积到 warnings，不抛。
 *
 * @param {{
 *   claudePath?: string|null, claudeText?: string,
 *   codexPath?: string|null, codexText?: string,
 * }} input
 * @returns {{
 *   servers: import('./project-config.js').ProjectServer[],
 *   files: Array<{ path: string, format: 'claude'|'codex' }>,
 *   warnings: string[],
 * }}
 */
export function buildProjectServers(input) {
  if (!isRecord(input)) {
    throw new TypeError('buildProjectServers(input): input must be an object')
  }
  const warnings = []
  const files = []
  const claudeServers = collectSourceServers(
    { format: SOURCE_CLAUDE, path: input.claudePath, text: input.claudeText },
    files,
    warnings,
  )
  const codexServers = collectSourceServers(
    { format: SOURCE_CODEX, path: input.codexPath, text: input.codexText },
    files,
    warnings,
  )

  const merged = new Map()
  for (const server of claudeServers) merged.set(server.name, server)
  for (const server of codexServers) {
    if (merged.has(server.name)) {
      warnings.push(`claude overrides codex:${server.name}`)
      continue
    }
    merged.set(server.name, server)
  }
  return { servers: [...merged.values()], files, warnings }
}

/**
 * 解析单来源声明并登记 file、绝对化相对 cwd。
 * @returns {import('./project-config.js').ProjectServer[]}
 */
function collectSourceServers({ format, path: filePath, text }, files, warnings) {
  const hasPath = isNonEmptyString(filePath)
  const hasText = typeof text === 'string'
  if (!hasPath && !hasText) return []
  if (!hasPath) {
    warnings.push(`${format} config text provided without a path; cwd stays relative`)
  } else if (!hasText) {
    warnings.push(`${format} config text not provided for ${filePath}`)
    return []
  }

  const absolutePath = hasPath ? resolve(filePath) : null
  if (absolutePath !== null) files.push({ path: absolutePath, format })

  const parsed = format === SOURCE_CLAUDE ? parseClaudeConfig(text) : parseCodexConfig(text)
  warnings.push(...parsed.warnings)
  if (absolutePath === null) return parsed.servers
  return absolutizeCwds(parsed.servers, dirname(absolutePath))
}

/** 把声明中的相对 cwd 按声明文件所在目录绝对化；含 `${` 占位符的留给展开阶段。 */
function absolutizeCwds(servers, baseDir) {
  return servers.map((server) => {
    if (server.cwd === undefined || isAbsolute(server.cwd) || server.cwd.includes('${')) {
      return server
    }
    return { ...server, cwd: resolve(baseDir, server.cwd) }
  })
}

/* ============================== 语义映射 ============================== */

/**
 * 语义映射到 mcp-client config：
 *   - `${VAR}` / `${VAR:-default}` 用注入 env 展开；
 *   - Codex `env_vars` 名单从注入 env 透传（显式 env 表优先）；
 *   - 剔除 undefined/空可选字段；cwd 绝对化。
 *
 * enabled 不写进 config（由 Host 决定是否挂载）；failOnStartupError 由 Host 挂载时决定。
 *
 * @param {import('./project-config.js').ProjectServer} server
 * @param {{ env?: Record<string, string|undefined>, projectDir?: string }} [options]
 * @returns {{ config: object, warnings: string[] }}
 */
export function toClientConfig(server, options = {}) {
  if (!isRecord(server)) {
    throw new TypeError('toClientConfig(server, options): server must be an object')
  }
  const envOptions = isRecord(options.env) ? options.env : {}
  const projectDir = isNonEmptyString(options.projectDir) ? options.projectDir : undefined
  const warnings = []
  const expand = (value, field) => expandVariables(value, envOptions, field, warnings)

  if (server.transport === TRANSPORT_STDIO) {
    const command = typeof server.command === 'string' ? expand(server.command, 'command') : ''
    const config = {
      serverName: server.name,
      transport: TRANSPORT_STDIO,
      command,
    }
    if (Array.isArray(server.args)) {
      config.args = server.args.map((arg, index) => expand(arg, `args[${index}]`))
    }
    const clientEnv = buildClientEnv(server, envOptions, expand, warnings)
    if (clientEnv !== undefined) config.env = clientEnv
    const cwd = resolveClientCwd(server.cwd, projectDir, expand, warnings)
    if (cwd !== undefined) config.cwd = cwd
    applyClientTimeout(config, server.toolCallTimeoutMs, warnings)
    if (command === EMPTY_STRING) {
      warnings.push('stdio command is missing or empty after variable expansion')
    }
    return { config, warnings }
  }

  const url = typeof server.url === 'string' ? expand(server.url, 'url') : ''
  const config = {
    serverName: server.name,
    transport: TRANSPORT_HTTP,
    url,
  }
  const headers = buildClientHeaders(server, envOptions, expand, warnings)
  if (headers !== undefined) config.headers = headers
  applyClientTimeout(config, server.toolCallTimeoutMs, warnings)
  if (url === EMPTY_STRING) {
    warnings.push('http url is missing or empty after variable expansion')
  }
  return { config, warnings }
}

/** 组装 mcp-client env：env_vars 名单透传 + 显式 env 表（后者优先，值做变量展开）。 */
function buildClientEnv(server, envOptions, expand, warnings) {
  const result = {}
  if (Array.isArray(server.envVars)) {
    for (const name of server.envVars) {
      const value = hasOwn(envOptions, name) ? envOptions[name] : undefined
      if (typeof value === 'string') {
        result[name] = value
      } else {
        warnings.push(`env_vars entry "${name}" is not set; skipped`)
      }
    }
  }
  if (isRecord(server.env)) {
    for (const [key, value] of Object.entries(server.env)) {
      result[key] = expand(value, `env.${key}`)
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 组装 http 请求头（三来源，按优先级）：
 *   1. 静态 headers（Codex `http_headers` / Claude `headers`；值做 `${VAR}` 展开）；
 *   2. `env_http_headers`：header 名 → 环境变量名，从注入 env 取值；未设置跳过并 warning；
 *   3. `bearer_token_env_var`：无显式 Authorization 时补 `Authorization: Bearer <value>`。
 * 显式 Authorization（含 env_http_headers 中声明但环境变量未设置的情况）优先于 bearer，
 * 冲突时 warning 且保留显式来源。
 * @returns {Record<string,string>|undefined}
 */
function buildClientHeaders(server, envOptions, expand, warnings) {
  const headers = {}
  if (isRecord(server.headers)) {
    for (const [key, value] of Object.entries(server.headers)) {
      headers[key] = expand(value, `headers.${key}`)
    }
  }
  if (isRecord(server.envHeaderVars)) {
    for (const [headerName, envName] of Object.entries(server.envHeaderVars)) {
      const value = hasOwn(envOptions, envName) ? envOptions[envName] : undefined
      if (typeof value === 'string') {
        headers[headerName] = value
      } else {
        warnings.push(
          `env_http_headers.${headerName}: environment variable "${envName}" is not set; skipped`,
        )
      }
    }
  }
  if (isNonEmptyString(server.bearerTokenEnvVar)) {
    const declaredAuthorization =
      findHeaderKey(headers, AUTHORIZATION_HEADER) !== undefined ||
      (isRecord(server.envHeaderVars) &&
        findHeaderKey(server.envHeaderVars, AUTHORIZATION_HEADER) !== undefined)
    if (declaredAuthorization) {
      warnings.push(
        `bearer_token_env_var: explicit ${AUTHORIZATION_HEADER} header takes precedence; "${server.bearerTokenEnvVar}" ignored`,
      )
    } else {
      const token = hasOwn(envOptions, server.bearerTokenEnvVar)
        ? envOptions[server.bearerTokenEnvVar]
        : undefined
      if (typeof token === 'string' && token !== EMPTY_STRING) {
        headers[AUTHORIZATION_HEADER] = `Bearer ${token}`
      } else {
        warnings.push(
          `bearer_token_env_var: environment variable "${server.bearerTokenEnvVar}" is not set; skipped`,
        )
      }
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

/** 在 header map 中按名大小写不敏感查找，返回实际 key（找不到 → undefined）。 */
function findHeaderKey(record, headerName) {
  if (!isRecord(record)) return undefined
  const target = headerName.toLowerCase()
  return Object.keys(record).find((key) => key.toLowerCase() === target)
}

/** cwd 绝对化：先展开变量，再按 projectDir 解析相对路径；无法解析时告警并省略。 */
function resolveClientCwd(rawCwd, projectDir, expand, warnings) {
  if (!isNonEmptyString(rawCwd)) return undefined
  const expanded = expand(rawCwd, 'cwd')
  if (expanded === EMPTY_STRING) return undefined
  if (isAbsolute(expanded)) return normalize(expanded)
  if (projectDir !== undefined) return resolve(projectDir, expanded)
  warnings.push(`relative cwd "${expanded}" has no projectDir to resolve against; omitted`)
  return undefined
}

/** toolCallTimeoutMs：只接受有限正数；非法值告警后省略（用 mcp-client 默认值）。 */
function applyClientTimeout(config, timeoutMs, warnings) {
  if (timeoutMs === undefined) return
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    warnings.push('toolCallTimeoutMs is not a positive number; omitted')
    return
  }
  config.toolCallTimeoutMs = timeoutMs
}

/** 字符串展开：${VAR} 取注入 env；${VAR:-default} 在未设置或空串时取 default。 */
function expandVariables(value, envOptions, field, warnings) {
  if (typeof value !== 'string' || !value.includes('${')) return value
  return value.replace(VARIABLE_PATTERN, (match, name, fallback) => {
    const envValue = hasOwn(envOptions, name) ? envOptions[name] : undefined
    if (typeof envValue === 'string' && envValue !== EMPTY_STRING) return envValue
    if (fallback !== undefined) return fallback
    warnings.push(`unset variable "${name}" in ${field}`)
    return EMPTY_STRING
  })
}

/* ============================== 面板掩码 ============================== */

/**
 * 面板展示用（掩码）：绝不返回 env/headers 的任何值，只返回 key 列表；
 * command/cwd/url 原样展示（面板允许看命令行），args 做保守脱敏：
 *   - `--flag=VALUE` / `--flag VALUE`，flag 名匹配敏感模式 → VALUE 替换为 MASK；
 *   - `KEY=VALUE`（KEY 匹配敏感模式）→ VALUE 替换为 MASK；
 *   - URL 查询串中敏感参数的值 → MASK；
 *   - 其余 args 原样保留可读性。
 * 脱敏是启发式，无法覆盖所有自定义传参格式（见 README/汇报的已知限制）。
 *
 * @param {import('./project-config.js').ProjectServer} server
 * @returns {{
 *   name: string, source: string, transport: string, enabled: boolean,
 *   command?: string, args?: string[], cwd?: string, url?: string,
 *   envKeys: string[], headerKeys: string[],
 * }}
 */
export function maskServerForPanel(server) {
  if (!isRecord(server)) {
    throw new TypeError('maskServerForPanel(server): server must be an object')
  }
  const masked = {
    name: server.name,
    source: server.source,
    transport: server.transport,
    enabled: server.enabled !== false,
  }
  if (typeof server.command === 'string') masked.command = server.command
  if (Array.isArray(server.args)) masked.args = redactServerArgs(server.args)
  if (typeof server.cwd === 'string') masked.cwd = server.cwd
  // url 字段展示前也做查询串脱敏（如 https://x/mcp?token=...）。
  if (typeof server.url === 'string') masked.url = redactUrlQueryValues(server.url)
  masked.envKeys = sortedKeys(server.env)
  masked.headerKeys = collectPanelHeaderKeys(server)
  return masked
}

/**
 * 面板 header key 列表（顺序稳定、绝不包含值）：
 * 静态 headers 原顺序 → env_http_headers 的 header 名 → bearer_token_env_var 补的 Authorization。
 * 大小写不敏感去重（同一 header 只出现一次，保留首次出现的写法）。
 */
function collectPanelHeaderKeys(server) {
  const keys = []
  const seen = new Set()
  const add = (key) => {
    const normalizedKey = key.toLowerCase()
    if (seen.has(normalizedKey)) return
    seen.add(normalizedKey)
    keys.push(key)
  }
  if (isRecord(server.headers)) {
    for (const key of Object.keys(server.headers)) add(key)
  }
  if (isRecord(server.envHeaderVars)) {
    for (const key of Object.keys(server.envHeaderVars)) add(key)
  }
  if (isNonEmptyString(server.bearerTokenEnvVar)) add(AUTHORIZATION_HEADER)
  return keys
}

/* ============================== args 脱敏（启发式） ============================== */

/** 按 token 逐个脱敏 args；返回新数组，不修改入参。 */
function redactServerArgs(args) {
  const redacted = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (typeof arg !== 'string') {
      redacted.push(arg)
      continue
    }

    const flagAssignment = ARG_FLAG_ASSIGNMENT_PATTERN.exec(arg)
    if (flagAssignment !== null) {
      const [, flag, value] = flagAssignment
      const maskedValue = SENSITIVE_ARG_NAME_PATTERN.test(flag)
        ? MASK
        : redactUrlQueryValues(value)
      redacted.push(`${flag}=${maskedValue}`)
      continue
    }

    if (ARG_FLAG_PATTERN.test(arg) && SENSITIVE_ARG_NAME_PATTERN.test(arg)) {
      redacted.push(arg)
      const nextArg = args[index + 1]
      // 值在下一个 token 时脱敏；下一个 token 若是另一个 flag 则说明本 flag 无值。
      if (typeof nextArg === 'string' && nextArg !== EMPTY_STRING && !nextArg.startsWith('-')) {
        redacted.push(MASK)
        index += 1
      }
      continue
    }

    const envAssignment = ARG_ENV_ASSIGNMENT_PATTERN.exec(arg)
    if (envAssignment !== null && SENSITIVE_ARG_NAME_PATTERN.test(envAssignment[1])) {
      redacted.push(`${envAssignment[1]}=${MASK}`)
      continue
    }

    redacted.push(redactUrlQueryValues(arg))
  }
  return redacted
}

/** 脱敏 URL 查询串中敏感参数的值，保留其余参数与 fragment。 */
function redactUrlQueryValues(value) {
  const queryStart = value.indexOf('?')
  if (queryStart === -1) return value
  const base = value.slice(0, queryStart + 1)
  const remainder = value.slice(queryStart + 1)
  const fragmentStart = remainder.indexOf('#')
  const fragment = fragmentStart === -1 ? EMPTY_STRING : remainder.slice(fragmentStart)
  const query = fragmentStart === -1 ? remainder : remainder.slice(0, fragmentStart)
  if (query === EMPTY_STRING) return value
  const redactedQuery = query
    .split(QUERY_PAIR_SEPARATOR)
    .map((pair) => redactQueryPair(pair))
    .join(QUERY_PAIR_SEPARATOR)
  return `${base}${redactedQuery}${fragment}`
}

/** 单个 `key=value` 查询参数：敏感 key 且值非空 → 值替换为 MASK。 */
function redactQueryPair(pair) {
  const equalsIndex = pair.indexOf('=')
  if (equalsIndex <= 0) return pair
  const key = pair.slice(0, equalsIndex)
  const paramValue = pair.slice(equalsIndex + 1)
  if (paramValue === EMPTY_STRING || !SENSITIVE_ARG_NAME_PATTERN.test(key)) return pair
  return `${key}=${MASK}`
}

/* ============================== 发现（组合） ============================== */

/**
 * 从 cwd 发现项目声明：向上找两份声明 → 读文件 → 解析 → 合并。
 * 无声明文件时返回空结果且不报错；读失败降级为 warning。
 *
 * 按 spec §2.1：`~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）是 Codex 全局配置，
 * 不属于项目层，命中时忽略并写 warning（避免与 DSH 全局 MCP 平面重复）。
 *
 * @param {string} cwd 会话目录
 * @param {(path: string, encoding?: string) => string} [readFileSync] 便于单测注入
 * @param {{ homeDir?: string }} [options] 可选；homeDir 便于单测覆盖全局 Codex 路径
 * @returns {{
 *   projectDir: string|null,
 *   files: Array<{ path: string, format: 'claude'|'codex' }>,
 *   servers: import('./project-config.js').ProjectServer[],
 *   warnings: string[],
 * }}
 */
export function discoverProject(cwd, readFileSync, options = {}) {
  if (typeof cwd !== 'string' || cwd === EMPTY_STRING) {
    throw new TypeError('discoverProject(cwd, readFileSync): cwd must be a non-empty string')
  }
  const reader = typeof readFileSync === 'function' ? readFileSync : fsReadFileSync
  const warnings = []

  const claudePath = findNearestFile(cwd, CLAUDE_RELATIVE_PATH)
  const nearestCodexPath = findNearestFile(cwd, CODEX_RELATIVE_PATH)
  const codexPath = dropGlobalCodexConfig(nearestCodexPath, options.homeDir, warnings)

  const claudeText = readDeclaration(claudePath, reader, warnings)
  const codexText = readDeclaration(codexPath, reader, warnings)

  const built = buildProjectServers({ claudePath, claudeText, codexPath, codexText })
  const projectDir = resolveProjectDir(cwd, { claudePath, codexPath })
  return {
    projectDir,
    files: built.files,
    servers: built.servers,
    warnings: [...warnings, ...built.warnings],
  }
}

/** 过滤 Codex 全局配置路径（`<home>/.codex/config.toml`、`$CODEX_HOME/config.toml`）。 */
function dropGlobalCodexConfig(codexPath, homeDirOverride, warnings) {
  if (codexPath === null) return null
  const excluded = globalCodexConfigPaths(homeDirOverride)
  const absolutePath = resolve(codexPath)
  if (!excluded.has(absolutePath)) return absolutePath
  warnings.push(
    `ignored global Codex config ${absolutePath} (project-level declarations only)`,
  )
  return null
}

function globalCodexConfigPaths(homeDirOverride) {
  const paths = new Set()
  const home = isNonEmptyString(homeDirOverride) ? homeDirOverride : safeHomedir()
  if (home !== undefined) paths.add(resolve(home, '.codex', 'config.toml'))
  const codexHome = process.env.CODEX_HOME
  if (isNonEmptyString(codexHome)) paths.add(resolve(codexHome, 'config.toml'))
  return paths
}

function safeHomedir() {
  try {
    return homedir()
  } catch {
    return undefined
  }
}

/* ============================== 通用辅助 ============================== */

/** 同步读取声明文件；失败只记录 warning 并返回 undefined（不抛）。 */
function readDeclaration(filePath, reader, warnings) {
  if (filePath === null) return undefined
  try {
    const text = reader(filePath, 'utf8')
    if (typeof text === 'string') return text
    if (text !== null && typeof text === 'object' && typeof text.toString === 'function') {
      return text.toString()
    }
    warnings.push(`failed to read ${filePath}: reader returned non-string content`)
    return undefined
  } catch (error) {
    warnings.push(`failed to read ${filePath}: ${errorText(error)}`)
    return undefined
  }
}

/** 由 found 收集声明文件候选（容忍 {claudePath,codexPath} 与 files 两种传入形态）。 */
function collectDeclarationFiles(cwd, found) {
  const byPath = new Map()
  const add = (rawPath, format) => {
    if (!isNonEmptyString(rawPath)) return
    const absolutePath = isAbsolute(rawPath) ? normalize(rawPath) : resolve(cwd, rawPath)
    if (byPath.has(absolutePath)) return
    byPath.set(absolutePath, {
      path: absolutePath,
      format,
      projectDir: format === SOURCE_CLAUDE ? dirname(absolutePath) : codexProjectDir(absolutePath),
    })
  }
  add(found.claudePath, SOURCE_CLAUDE)
  add(found.codexPath, SOURCE_CODEX)
  if (Array.isArray(found.files)) {
    for (const file of found.files) {
      if (!isRecord(file)) continue
      const format = file.format === SOURCE_CODEX ? SOURCE_CODEX : SOURCE_CLAUDE
      add(file.path, format)
    }
  }
  return [...byPath.values()]
}

/** `.codex/config.toml` 的项目根 = 去掉 `.codex` 层后的目录。 */
function codexProjectDir(codexPath) {
  const configDir = dirname(codexPath)
  return basename(configDir) === CODEX_DIR_NAME ? dirname(configDir) : configDir
}

/** 声明优先级比较：项目根更深 > 声明路径更长 > Claude 优先。返回 >0 表示 left 更优。 */
function compareDeclarationDepth(left, right) {
  const leftDepth = countSegments(left.projectDir)
  const rightDepth = countSegments(right.projectDir)
  if (leftDepth !== rightDepth) return leftDepth - rightDepth
  if (left.path.length !== right.path.length) return left.path.length - right.path.length
  return (left.format === SOURCE_CLAUDE ? 1 : 0) - (right.format === SOURCE_CLAUDE ? 1 : 0)
}

function countSegments(filePath) {
  return filePath.split(sep).filter((part) => part !== EMPTY_STRING).length
}

/** 统一解析 type 声明：null=未声明，string=归一化后的 transport，'invalid'=非法。 */
function readDeclaredType(rawType, label, httpTypes, warnings) {
  if (rawType === undefined) return null
  if (typeof rawType !== 'string') {
    warnings.push(`${label}: "type" must be a string; skipped`)
    return 'invalid'
  }
  const normalized = rawType.toLowerCase()
  if (normalized === TRANSPORT_STDIO) return TRANSPORT_STDIO
  if (httpTypes.has(normalized)) return TRANSPORT_HTTP
  warnings.push(`${label}: unsupported type "${rawType}"; skipped`)
  return 'invalid'
}

/**
 * 由端点字段与（可选）显式 type 决定 transport。
 * @returns {'stdio'|'streamable-http'|undefined} undefined 表示非法/缺端点（已写 warning）
 */
function resolveTransport(rawEntry, declaredType, label, warnings) {
  const hasCommand = isNonEmptyString(rawEntry.command)
  const hasUrl = isNonEmptyString(rawEntry.url)
  if (declaredType === TRANSPORT_STDIO) {
    if (!hasCommand) {
      warnings.push(`${label}: type "stdio" requires command; skipped`)
      return undefined
    }
    return TRANSPORT_STDIO
  }
  if (declaredType === TRANSPORT_HTTP) {
    if (!hasUrl) {
      warnings.push(`${label}: http type requires url; skipped`)
      return undefined
    }
    return TRANSPORT_HTTP
  }
  if (hasCommand && hasUrl) {
    warnings.push(`${label}: both command and url present without explicit type; skipped`)
    return undefined
  }
  if (hasCommand) return TRANSPORT_STDIO
  if (hasUrl) return TRANSPORT_HTTP
  warnings.push(`${label}: missing command or url; skipped`)
  return undefined
}

/** 收集字符串数组；非数组返回 undefined 并告警，非字符串元素丢弃并告警。 */
function collectStringArray(value, context, warnings) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    warnings.push(`${context}: must be an array; ignored`)
    return undefined
  }
  const items = []
  for (const item of value) {
    if (typeof item === 'string') items.push(item)
    else warnings.push(`${context}: non-string item ignored`)
  }
  return items.length > 0 ? items : undefined
}

/** 收集字符串 map（env/headers）；跳过非字符串值并告警。 */
function collectStringRecord(value, context, warnings) {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    warnings.push(`${context}: must be an object; ignored`)
    return undefined
  }
  const record = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') record[key] = item
    else warnings.push(`${context}.${key}: non-string value ignored`)
  }
  return Object.keys(record).length > 0 ? record : undefined
}

function sortedKeys(value) {
  if (!isRecord(value)) return []
  return Object.keys(value).sort()
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== EMPTY_STRING
}

/** 错误信息取首行，避免 TOML 报错的多行摘录污染 warnings。 */
function errorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n')[0]
  return firstLine === undefined ? message : firstLine
}

/**
 * @typedef {object} ProjectServer
 * @property {string} name
 * @property {'claude'|'codex'} source
 * @property {'stdio'|'streamable-http'} transport
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {Record<string,string>} [env] 原始值（可能含 `${VAR}`，未展开）
 * @property {string[]} [envVars] Codex `env_vars` 透传名单（toClientConfig 展开阶段使用）
 * @property {string} [cwd] 解析阶段为原文；buildProjectServers 后通常已绝对化
 * @property {string} [url]
 * @property {Record<string,string>} [headers] 静态 header（Codex `http_headers` / Claude `headers`）
 * @property {Record<string,string>} [envHeaderVars] Codex `env_http_headers`：header 名 → 环境变量名
 * @property {string} [bearerTokenEnvVar] Codex `bearer_token_env_var`：环境变量名
 * @property {boolean} enabled
 * @property {number} [toolCallTimeoutMs]
 */
