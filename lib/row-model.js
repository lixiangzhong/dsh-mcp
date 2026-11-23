/**
 * lib/row-model.js — MCP 行模型：校验 / 掩码 / 写盘 config 合并
 *
 * 纯函数模块：零 DSH 依赖，只用语言内建能力（无 import）。
 * 契约真相源：docs/contracts/host-api.md
 *   - §2 常量（SECRET_KEEP / MASK / EXPRESSION）
 *   - §3 对外 Row 字段
 *   - §8.2 本模块导出清单（导出名与语义是硬契约）
 *
 * 导入/导出已按产品决定移除，本模块只负责行 ↔ 写盘 config 的校验与掩码。
 *
 * 数据约定：
 *   - mcp-client 原始 config 中的 YAML `!!js` 表达式，在 Host 内部以
 *     `{ __jsExpr: '<code>' }` 形式表示（由 lib/patch-doc.js 解析产出）。
 *     对外 Row 无法表达表达式求值结果，统一暴露 EXPRESSION 标记。
 *   - secret 值（env/headers 的值）对外一律 MASK。
 *   - 本模块不回读磁盘、不持有状态，输入输出均为普通对象。
 */

/* ============================== 契约常量 ============================== */

/** 写请求中 env/headers 的值等于它 = 保留原值（仅编辑时合法）。 */
export const SECRET_KEEP = '__KEEP__'

/** list 中 secret 值（或表达式）的掩码。 */
export const MASK = '••••••'

/** 该值为 YAML `!!js` 表达式（不可编辑其求值结果，只能整体替换）。 */
export const EXPRESSION = '__EXPRESSION__'

/* ============================== 内部常量 ============================== */

const TRANSPORT_STDIO = 'stdio'
const TRANSPORT_HTTP = 'streamable-http'
const TRANSPORT_VALUES = Object.freeze([TRANSPORT_STDIO, TRANSPORT_HTTP])

/** 手写 config 中可归一化为 streamable-http 的 transport 别名（大小写不敏感）。 */
const TRANSPORT_HTTP_ALIASES = Object.freeze(new Set(['http', 'sse', 'streamable-http']))

/** 允许的 serverName 形态：1~32 位字母数字下划线连字符（契约 §4.2）。 */
const SERVER_NAME_MAX_LENGTH = 32
const SERVER_NAME_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${SERVER_NAME_MAX_LENGTH}}$`)

/** 各 transport 可写的 config 字段（其余字段写入前必须剔除）。 */
const STDIO_CONFIG_FIELDS = Object.freeze(['command', 'args', 'env', 'cwd'])
const HTTP_CONFIG_FIELDS = Object.freeze(['url', 'headers'])
const SECRET_FIELDS = Object.freeze(['env', 'headers'])
const OPTIONAL_CONFIG_FIELDS = Object.freeze([
  'toolCallTimeoutMs',
  'maxInstructionBytes',
  'failOnStartupError',
  'reconnect',
])

/**
 * 面板建模的 config 字段。不在此集合里的键（上游新增字段，如 0.2.3 的
 * `oauth`/`startupTimeoutMs`/`closeTimeoutMs`/`expandTemplates`/`toolLoading`）
 * 在保存时原样透传，否则 patch-doc 的最小 diff 会把它们当成"要删除的键"。
 */
const MODELLED_CONFIG_FIELDS = Object.freeze(
  new Set([
    'serverName',
    'transport',
    ...STDIO_CONFIG_FIELDS,
    ...HTTP_CONFIG_FIELDS,
    ...OPTIONAL_CONFIG_FIELDS,
  ]),
)

// 数值范围（契约 §4.2：toolCallTimeoutMs > 0 为下界，maxInstructionBytes >= 1）。
const MIN_MAX_INSTRUCTION_BYTES = 1

const ROW_ID_PREFIX = 'mcp-'
const ROW_ID_FALLBACK_SLUG = 'server'
const ROW_ID_COLLISION_START = 2

/* ============================== 错误类型 ============================== */

/**
 * 行模型校验错误。
 * 契约要求：错误对象带 code（INVALID_ARGUMENT）与 field（可空），便于 Host 透传。
 */
export class ValidationError extends Error {
  /**
   * @param {string|null} field 出错字段路径；整体入参非法时为 null
   * @param {string} message 人类可读说明
   */
  constructor(field, message) {
    super(message)
    this.name = 'ValidationError'
    this.code = 'INVALID_ARGUMENT'
    this.field = field ?? null
  }
}

/* ============================== 公共函数 ============================== */

/**
 * 把 mcp-client config 转为对外 Row 的 config 部分（契约 §8.2 maskConfig）。
 * secret 值 → MASK；`!!js` 表达式 → EXPRESSION；空对象/缺失 → null。
 *
 * @param {object|null|undefined} config 原始 mcp-client config
 * @returns {{
 *   transport: string|null, command: string|null, args: string[]|null, cwd: string|null,
 *   env: Record<string,string>|null, url: string|null, headers: Record<string,string>|null,
 *   toolCallTimeoutMs: number|null, maxInstructionBytes: number|null,
 *   failOnStartupError: boolean|null, reconnect: object|null,
 * }}
 */
export function maskConfig(config) {
  const source = isPlainObject(config) ? config : {}
  return {
    transport: normalizeTransport(source.transport),
    command: maskScalar(source.command),
    args: maskArgs(source.args),
    cwd: maskScalar(source.cwd),
    env: maskSecretRecord(source.env),
    url: maskScalar(source.url),
    headers: maskSecretRecord(source.headers),
    toolCallTimeoutMs: maskNumber(source.toolCallTimeoutMs),
    maxInstructionBytes: maskNumber(source.maxInstructionBytes),
    failOnStartupError:
      typeof source.failOnStartupError === 'boolean' ? source.failOnStartupError : null,
    // reconnect 是结构化配置而非 secret；表达式对象原样透出（只读展示）。
    reconnect: isPlainObject(source.reconnect) ? cloneValue(source.reconnect) : null,
  }
}

/**
 * 校验 upsert 输入（契约 §8.2 validateRowInput）。
 * 校验 serverName、transport 及互斥字段、secret 记录形态、数值范围、布尔字段。
 *
 * @param {object} input UI 提交的 row（契约 §4.2 请求体 row）
 * @throws {ValidationError} 带 code=INVALID_ARGUMENT 与 field
 */
export function validateRowInput(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError(null, 'row input must be an object')
  }

  if (typeof input.serverName !== 'string' || !SERVER_NAME_PATTERN.test(input.serverName)) {
    throw new ValidationError(
      'serverName',
      `serverName must be 1-${SERVER_NAME_MAX_LENGTH} characters matching ${SERVER_NAME_PATTERN}`,
    )
  }
  if (!TRANSPORT_VALUES.includes(input.transport)) {
    throw new ValidationError(
      'transport',
      `transport must be one of: ${TRANSPORT_VALUES.join(', ')}`,
    )
  }

  if (input.transport === TRANSPORT_STDIO) {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      throw new ValidationError('command', 'stdio transport requires a non-empty command')
    }
    rejectPresentFields(input, ['url', 'headers'])
  } else {
    if (typeof input.url !== 'string' || input.url.trim() === '') {
      throw new ValidationError('url', 'streamable-http transport requires a non-empty url')
    }
    rejectPresentFields(input, ['command', 'args', 'env', 'cwd'])
  }

  validateArgsField(input.args)
  validateOptionalStringField(input.cwd, 'cwd')
  validateSecretRecordField(input.env, 'env')
  validateSecretRecordField(input.headers, 'headers')
  if (!isAbsent(input.toolCallTimeoutMs) && input.toolCallTimeoutMs !== EXPRESSION) {
    const value = input.toolCallTimeoutMs
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new ValidationError(
        'toolCallTimeoutMs',
        'toolCallTimeoutMs must be a finite number > 0',
      )
    }
  }
  if (!isAbsent(input.maxInstructionBytes) && input.maxInstructionBytes !== EXPRESSION) {
    const value = input.maxInstructionBytes
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < MIN_MAX_INSTRUCTION_BYTES
    ) {
      throw new ValidationError(
        'maxInstructionBytes',
        `maxInstructionBytes must be a finite number >= ${MIN_MAX_INSTRUCTION_BYTES}`,
      )
    }
  }
  validateOptionalBooleanField(input.failOnStartupError, 'failOnStartupError')
  validateOptionalBooleanField(input.enabled, 'enabled')
  if (
    !isAbsent(input.reconnect) &&
    input.reconnect !== EXPRESSION &&
    !isPlainObject(input.reconnect)
  ) {
    throw new ValidationError('reconnect', 'reconnect must be an object')
  }
}

/**
 * 把 UI 输入与既有 config 合并成写盘 config（契约 §8.2 buildConfig）。
 *
 * - 忽略 `enabled`（由 patch-doc 的 upsert/toggle 写为行内 disabled）；
 * - 只输出 mcp-client Config 里面板建模的字段；
 * - null/undefined 的可选字段不输出（使用默认值）；
 * - 剔除当前 transport 不适用的字段；
 * - env/headers 值为 SECRET_KEEP 时沿用 existingConfig 同 key 原值（`!!js` 对象原样保留）；
 * - UI 回传 EXPRESSION 标记（未编辑的表达式行）同样沿用 existingConfig 原值；
 * - 新增行出现 SECRET_KEEP / EXPRESSION，或任何位置出现 MASK → INVALID_ARGUMENT；
 * - 未建模字段（上游新增键）在 transport 未变更时原样透传。
 *
 * @param {object} input UI 提交的 row
 * @param {object|null|undefined} existingConfig 编辑目标的原始 config；新增行为 null
 * @returns {object} 可直接交给 patch-doc upsert 的 mcp-client config
 * @throws {ValidationError}
 */
export function buildConfig(input, existingConfig) {
  validateRowInput(input)
  const existing = isPlainObject(existingConfig) ? existingConfig : null
  const transport = input.transport
  const config = { serverName: input.serverName, transport }

  const applicableFields = transport === TRANSPORT_STDIO ? STDIO_CONFIG_FIELDS : HTTP_CONFIG_FIELDS
  for (const field of applicableFields) {
    const value = input[field]
    let resolved
    if (SECRET_FIELDS.includes(field)) {
      resolved = resolveSecretRecord(value, existing, field)
    } else if (field === 'args') {
      resolved = resolveArgs(value, existing)
    } else {
      resolved = resolveScalar(value, existing, field)
    }
    if (resolved !== undefined) config[field] = resolved
  }

  for (const field of OPTIONAL_CONFIG_FIELDS) {
    const resolved = resolveOptionalField(input[field], existing, field)
    if (resolved !== undefined) config[field] = resolved
  }

  // 未建模键原样透传：面板读不到它们，回写时也不该删掉。transport 变更等同于
  // 重写该行，按既有"剔除不适用字段"语义丢弃，避免把 http 专属键带进 stdio 分支。
  if (existing !== null && effectiveTransportOf(existing) === transport) {
    for (const [key, value] of Object.entries(existing)) {
      if (MODELLED_CONFIG_FIELDS.has(key) || value === undefined) continue
      config[key] = cloneValue(value)
    }
  }

  return config
}

/**
 * 由 serverName 生成唯一行 id（契约 §4.2 / §8.2 nextRowId）。
 * slug 规则：小写，保留 [a-z0-9-]，其余转 '-' 并折叠；冲突追加 -2、-3…
 *
 * @param {string} serverName 已校验的 serverName
 * @param {Iterable<string>|null|undefined} takenIds 已被占用的行 id
 * @returns {string} 形如 mcp-<slug>[-n]
 */
export function nextRowId(serverName, takenIds) {
  const taken = toSet(takenIds)
  const baseId = `${ROW_ID_PREFIX}${slugifyServerName(serverName)}`
  if (!taken.has(baseId)) return baseId
  let suffix = ROW_ID_COLLISION_START
  while (taken.has(`${baseId}-${suffix}`)) suffix += 1
  return `${baseId}-${suffix}`
}

/**
 * 从运行时工具名里筛出某个 MCP server 的工具（契约 §8.2 toolsForServer）。
 * 工具名统一归一化为 `mcp__<serverName>__<tool>`；超长工具名追加的哈希后缀
 * 位于末尾，不影响前缀匹配。
 *
 * @param {string} serverName
 * @param {string[]|null|undefined} toolNames
 * @returns {string[]}
 */
export function toolsForServer(serverName, toolNames) {
  if (typeof serverName !== 'string' || serverName === '') return []
  const names = Array.isArray(toolNames) ? toolNames : []
  const prefix = `mcp__${serverName}__`
  return names.filter((name) => typeof name === 'string' && name.startsWith(prefix))
}

/* ============================== maskConfig 辅助 ============================== */

/**
 * 原始 transport → 契约枚举；兼容手写 config 的 http/sse 别名。
 * @param {unknown} value
 * @returns {'stdio'|'streamable-http'|null}
 */
function normalizeTransport(value) {
  if (value === TRANSPORT_STDIO || value === TRANSPORT_HTTP) return value
  if (typeof value === 'string' && TRANSPORT_HTTP_ALIASES.has(value.toLowerCase())) {
    return TRANSPORT_HTTP
  }
  return null
}

/**
 * 既有 config 的有效 transport：显式声明优先（含 http/sse 别名），否则按
 * mcp-client 串联分支的必填字段推断。
 * @param {object} config 既有 config（纯对象）
 * @returns {'stdio'|'streamable-http'|null} 有效 transport，无法判定时为 null
 */
function effectiveTransportOf(config) {
  const declared = normalizeTransport(config.transport)
  if (declared !== null) return declared
  if (typeof config.url === 'string') return TRANSPORT_HTTP
  if (typeof config.command === 'string') return TRANSPORT_STDIO
  return null
}

/** 标量字段掩码：表达式 → EXPRESSION，字符串原样，其余 → null。 */
function maskScalar(value) {
  if (isExpressionValue(value)) return EXPRESSION
  return typeof value === 'string' ? value : null
}

/** args 数组掩码：元素规则同 maskScalar，非字符串元素丢弃；空数组 → null。 */
function maskArgs(value) {
  if (!Array.isArray(value)) return null
  const masked = value.map(maskScalar).filter((item) => item !== null)
  return masked.length > 0 ? masked : null
}

/** secret 记录掩码：每个值 → EXPRESSION（表达式）或 MASK；空/缺失 → null。 */
function maskSecretRecord(record) {
  if (!isPlainObject(record)) return null
  const keys = Object.keys(record)
  if (keys.length === 0) return null
  const masked = {}
  for (const key of keys) {
    masked[key] = isExpressionValue(record[key]) ? EXPRESSION : MASK
  }
  return masked
}

/** 数值字段：有限数字原样，表达式/其他 → null（Row 类型只允许 number|null）。 */
function maskNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/* ============================== validateRowInput 辅助 ============================== */

/** 指定字段必须缺失（transport 互斥校验）。 */
function rejectPresentFields(input, fields) {
  for (const field of fields) {
    if (!isAbsent(input[field])) {
      throw new ValidationError(
        field,
        `${field} is not allowed for transport ${String(input.transport)}`,
      )
    }
  }
}

function validateArgsField(args) {
  if (isAbsent(args)) return
  if (!Array.isArray(args)) {
    throw new ValidationError('args', 'args must be an array of strings')
  }
  args.forEach((item, index) => {
    if (typeof item !== 'string') {
      throw new ValidationError(`args.${index}`, 'args items must be strings')
    }
  })
}

function validateOptionalStringField(value, field) {
  if (isAbsent(value)) return
  if (typeof value !== 'string') {
    throw new ValidationError(field, `${field} must be a string`)
  }
}

function validateSecretRecordField(record, field) {
  if (isAbsent(record)) return
  if (!isPlainObject(record)) {
    throw new ValidationError(field, `${field} must be an object of string values`)
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string' && !isExpressionValue(value)) {
      throw new ValidationError(`${field}.${key}`, `${field} values must be strings`)
    }
  }
}

function validateOptionalBooleanField(value, field) {
  if (isAbsent(value) || value === EXPRESSION) return
  if (typeof value !== 'boolean') {
    throw new ValidationError(field, `${field} must be a boolean`)
  }
}

/* ============================== buildConfig 辅助 ============================== */

/**
 * 标量字段解析：SECRET_KEEP/EXPRESSION → 沿用 existingConfig 原值；
 * 表达式对象原样透传；空 cwd 视为未设置；MASK 拒绝（只读值不得回写）。
 */
function resolveScalar(value, existing, field) {
  if (isAbsent(value)) return undefined
  if (field === 'cwd' && value === '') return undefined
  return resolveReplaceableValue(value, existing, field)
}

function resolveArgs(value, existing) {
  if (isAbsent(value)) return undefined
  const existingArgs = Array.isArray(existing?.args) ? existing.args : []
  const resolved = value.map((item, index) => {
    if (item === EXPRESSION) {
      if (index < existingArgs.length) return cloneValue(existingArgs[index])
      throw new ValidationError(`args.${index}`, 'EXPRESSION requires an existing args element')
    }
    if (item === SECRET_KEEP) {
      throw new ValidationError(`args.${index}`, 'SECRET_KEEP is only valid for env/headers values')
    }
    if (item === MASK) {
      throw new ValidationError(`args.${index}`, 'MASK is read-only; resend the original args')
    }
    return item
  })
  return resolved.length > 0 ? resolved : undefined
}

/**
 * env/headers 解析：逐 key 处理 SECRET_KEEP / EXPRESSION / 空串。
 * 空串 = 用户清空该 key（契约 §7）；全空则整体省略。
 */
function resolveSecretRecord(record, existing, field) {
  if (isAbsent(record)) return undefined
  const resolved = {}
  const existingRecord = existing && isPlainObject(existing[field]) ? existing[field] : null
  for (const [key, value] of Object.entries(record)) {
    if (value === SECRET_KEEP || value === EXPRESSION) {
      const marker = value
      if (existingRecord === null || !hasOwn(existingRecord, key)) {
        throw new ValidationError(`${field}.${key}`, `${marker} requires an existing value`)
      }
      resolved[key] = cloneValue(existingRecord[key])
      continue
    }
    if (value === MASK) {
      throw new ValidationError(
        `${field}.${key}`,
        'MASK is read-only; send SECRET_KEEP to keep the existing secret',
      )
    }
    if (isExpressionValue(value)) {
      resolved[key] = cloneValue(value)
      continue
    }
    if (value === '') continue // 清空 = 删除该 key
    resolved[key] = value
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined
}

/** 可选字段（超时/字节上限/失败标记/reconnect）解析：表达式标记沿用原值。 */
function resolveOptionalField(value, existing, field) {
  if (isAbsent(value)) return undefined
  return resolveReplaceableValue(value, existing, field)
}

function resolveReplaceableValue(value, existing, field) {
  if (value === SECRET_KEEP) {
    throw new ValidationError(field, 'SECRET_KEEP is only valid for env/headers values')
  }
  if (value === MASK) {
    throw new ValidationError(
      field,
      'MASK is read-only; send SECRET_KEEP to keep the existing value',
    )
  }
  if (value === EXPRESSION) {
    if (existing !== null && hasOwn(existing, field) && !isAbsent(existing[field])) {
      return cloneValue(existing[field])
    }
    throw new ValidationError(field, 'EXPRESSION requires an existing config value')
  }
  // 结构化值（如 reconnect）可能含原始 !!js 对象（{__jsExpr}）；原样交给 patch-doc 序列化。
  return value
}

/* ============================== 通用辅助 ============================== */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

/** YAML `!!js` 表达式节点在 Host 内部的表示。 */
function isExpressionValue(value) {
  return isPlainObject(value) && typeof value.__jsExpr === 'string'
}

function isAbsent(value) {
  return value === undefined || value === null
}

/** 深拷贝纯数据值（表达式节点/数组/普通对象）；不引入外部依赖。 */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, nested] of Object.entries(value)) out[key] = cloneValue(nested)
    return out
  }
  return value
}

/** 生成行 id 用的 slug：小写，保留 [a-z0-9-]，其余转 '-' 并折叠首尾/重复。 */
function slugifyServerName(serverName) {
  const raw = typeof serverName === 'string' ? serverName : ''
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? ROW_ID_FALLBACK_SLUG : slug
}

/** takenIds 归一化为 Set；非可迭代输入视为空集合。 */
function toSet(value) {
  if (value instanceof Set) return value
  if (Array.isArray(value)) return new Set(value)
  if (value !== null && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') {
    return new Set(value)
  }
  return new Set()
}
