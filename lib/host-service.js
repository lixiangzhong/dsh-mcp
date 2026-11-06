/**
 * Host half runtime for @lixiangzhong/dsh-mcp.
 *
 * Responsibilities:
 *  - serve the browser half over `/dsh-mcp/api` (same-origin POST + JSON),
 *  - project MCP rows from the active profile patch file and live Loader state,
 *  - own the only write path: revise the profile `cordis.patch.yml` in place
 *    under the shared profile write lock, then report whether HMR applied it.
 *
 * The pure YAML editing lives in `./patch-doc.js`; row validation and masking
 * live in `./row-model.js`. See docs/contracts/host-api.md.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { editPatchText, parsePatchText } from './patch-doc.js'
import {
  buildConfig,
  maskConfig,
  nextRowId,
  toolsForServer,
  validateRowInput,
} from './row-model.js'

/** The module specifier of every MCP client row this plugin manages. */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
/** Route prefix owned by this plugin; the Client half posts actions below it. */
const API_PREFIX = '/dsh-mcp/api'
/** Request bodies are small JSON documents; anything larger is refused. */
const MAX_BODY_BYTES = 1024 * 1024
/** How long a write waits for `app-boot/config-reload` before reporting "pending". */
const RELOAD_TIMEOUT_MS = 10_000
/** Permission bits for the profile patch, matching the file the app creates. */
const PROFILE_PATCH_MODE = 0o600
/** Tools listed per row in the projection are capped to bound the response. */
const MAX_TOOLS_PER_ROW = 50
/** Empty patch file body used when the profile has no patch yet. */
const EMPTY_PATCH_TEXT = '[]\n'
/** Profile write lock target shared with config-editor and plugin-manager. */
const PROFILE_LOCK_FILE = 'package.json'

/** Runtime mirror of the Loader `FiberState` const enum. */
const FIBER_STATE_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

/** Actions the Client half may call. */
const ACTIONS = new Set([
  'list',
  'upsert',
  'remove',
  'toggle',
  'project/session',
  'project/trust',
  'project/toggle',
  'project/reload',
  'project/badge',
])

/** Application-level failure rendered as `{ ok:false, error }`. */
class ApiError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.field = options.field
    this.details = options.details
  }
}

/** Protocol-level failure rendered with an HTTP status. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/**
 * Mount the Host half: one API route, a reload-event fan-out, and the
 * project runtime the project-scoped actions delegate to.
 * @param {object} ctx Cordis context of this plugin row.
 * @param {object} [projectRuntime] Project-scoped runtime from `./project-host.js`.
 */
export function applyMcpManager(ctx, config, projectRuntime) {
  const state = { waiters: new Set(), projectRuntime }
  ctx.effect(() => () => state.waiters.clear(), 'dsh-mcp: reload waiters')
  ctx.on('app-boot/config-reload', () => {
    for (const notify of [...state.waiters]) notify()
  })
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) => {
          handleHttp(ctx, state, req, res).catch((error) => {
            ctx.logger?.warn?.(`dsh-mcp: API handler failed: ${String(error)}`)
            sendJson(res, 500, {
              ok: false,
              error: { code: 'INTERNAL', message: 'internal error' },
            })
          })
        },
      }),
    'dsh-mcp: api route',
  )
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Admit, parse and dispatch one API request.
 * @param {object} ctx Cordis context.
 * @param {{ waiters: Set<() => void> }} state Per-mount routing state.
 * @param {import('node:http').IncomingMessage} req Request.
 * @param {import('node:http').ServerResponse} res Response.
 */
async function handleHttp(ctx, state, req, res) {
  try {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'BAD_REQUEST', 'only POST is accepted')
    }
    if (ctx.connection.requestRejection(req) !== undefined) {
      throw new HttpError(403, 'FORBIDDEN', 'request is not admitted')
    }
    const action = actionOf(req.url)
    if (!ACTIONS.has(action)) {
      throw new HttpError(404, 'BAD_REQUEST', `unknown action "${action}"`)
    }
    const body = await readJsonBody(req)
    const data = await runAction(ctx, state, action, body)
    sendJson(res, 200, { ok: true, data })
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
      return
    }
    if (error instanceof ApiError) {
      sendJson(res, 200, { ok: false, error: errorEnvelope(error) })
      return
    }
    if (isDomainError(error)) {
      sendJson(res, 200, { ok: false, error: domainErrorEnvelope(error) })
      return
    }
    ctx.logger?.warn?.(`dsh-mcp: unexpected failure: ${String(error)}`)
    sendJson(res, 200, { ok: false, error: { code: 'INTERNAL', message: 'unexpected failure' } })
  }
}

/**
 * Extract the action segment from a request URL.
 * @param {string | undefined} url Request URL.
 * @returns {string} Action name (`''` when the prefix itself was requested).
 */
function actionOf(url) {
  const path = new URL(url ?? '/', 'http://dsh.invalid').pathname
  if (!path.startsWith(`${API_PREFIX}/`)) return ''
  return path.slice(API_PREFIX.length + 1).replace(/\/+$/, '')
}

/**
 * Read and parse a JSON request body under the size limit.
 * @param {import('node:http').IncomingMessage} req Request.
 * @returns {Promise<object>} Parsed body (an empty object for an empty body).
 */
async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(400, 'BAD_REQUEST', 'content-type must be application/json')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(400, 'BAD_REQUEST', 'request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object')
    }
    return parsed
  } catch (error) {
    throw new HttpError(400, 'BAD_REQUEST', `invalid JSON body: ${String(error.message ?? error)}`)
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res Response.
 * @param {number} status HTTP status.
 * @param {object} payload JSON payload.
 */
function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Render an application error for the wire.
 * @param {ApiError} error Error to render.
 * @returns {object} Error envelope.
 */
function errorEnvelope(error) {
  const envelope = { code: error.code, message: error.message }
  if (error.field !== undefined) envelope.field = error.field
  if (error.details !== undefined) envelope.details = error.details
  return envelope
}

/** Error codes the pure modules (`patch-doc`, `row-model`) may raise. */
const DOMAIN_CODES = new Set([
  'PARSE',
  'NOT_FOUND',
  'NOT_EDITABLE',
  'INVALID_ARGUMENT',
  'CONFLICT',
  'UNSUPPORTED',
  'DUPLICATE',
  'WRITE_FAILED',
])

/** Domain codes that the wire contract spells differently. */
const DOMAIN_CODE_MAP = { PARSE: 'WRITE_FAILED', DUPLICATE: 'INVALID_ARGUMENT' }

/**
 * Detect an error raised by one of the pure editing/validation modules.
 * @param {unknown} error Candidate error.
 * @returns {boolean} Whether the error carries a known domain code.
 */
function isDomainError(error) {
  return error instanceof Error && typeof error.code === 'string' && DOMAIN_CODES.has(error.code)
}

/**
 * Translate a domain error into the wire error contract.
 * @param {Error & { code: string, field?: string }} error Domain error.
 * @returns {object} Error envelope.
 */
function domainErrorEnvelope(error) {
  const envelope = { code: DOMAIN_CODE_MAP[error.code] ?? error.code, message: error.message }
  if (error.field !== undefined) envelope.field = error.field
  return envelope
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch one action against the profile.
 * @param {object} ctx Cordis context.
 * @param {{ waiters: Set<() => void> }} state Per-mount routing state.
 * @param {string} action Action name.
 * @param {object} body Parsed body.
 * @returns {Promise<object>} Action payload.
 */
function runAction(ctx, state, action, body) {
  switch (action) {
    case 'list':
      return listAction(ctx)
    case 'upsert':
      return upsertAction(ctx, state, body)
    case 'remove':
      return removeAction(ctx, state, body)
    case 'toggle':
      return toggleAction(ctx, state, body)
    case 'project/session':
      return projectSessionAction(ctx, state, body)
    case 'project/trust':
      return projectTrustAction(state, body)
    case 'project/toggle':
      return projectToggleAction(state, body)
    case 'project/reload':
      return projectReloadAction(ctx, state, body)
    case 'project/badge':
      return projectBadgeAction(ctx, state, body)
    default:
      throw new ApiError('INVALID_ARGUMENT', `unknown action "${action}"`)
  }
}

/**
 * Read-only projection of every MCP row plus the write baseline.
 * @param {object} ctx Cordis context.
 * @returns {Promise<object>} `{ rows, profile, revision, generatedAt }`.
 */
async function listAction(ctx) {
  const paths = profilePaths(ctx)
  const text = await readPatchText(paths.patchPath)
  const projection = await buildProjection(ctx, text, paths)
  return {
    rows: projection.rows,
    profile: { dir: paths.dir, patchPath: paths.patchPath },
    revision: revisionOf(text),
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Create or edit one managed row.
 * @param {object} ctx Cordis context.
 * @param {{ waiters: Set<() => void> }} state Per-mount routing state.
 * @param {object} body Request body.
 * @returns {Promise<object>} Action payload.
 */
async function upsertAction(ctx, state, body) {
  const baseRevision = requireString(body.baseRevision, 'baseRevision')
  const input = requireObject(body.row, 'row')
  const originalId = body.originalId === undefined ? undefined : requireString(body.originalId, 'originalId')
  validateRowInput(input)
  const enabled = input.enabled !== false
  const paths = profilePaths(ctx)

  const outcome = await withPatchWriteLock(ctx, state, paths, baseRevision, async (fresh) => {
    const parsed = parsePatchText(fresh.text)
    const runtime = await runtimeProjection(ctx)
    const editable = new Map(mcpRowsOf(parsed).map((row) => [row.id, row]))
    if (originalId !== undefined) {
      if (!editable.has(originalId)) {
        throw runtime.has(originalId)
          ? new ApiError('NOT_EDITABLE', `row "${originalId}" is not defined in the profile patch`)
          : new ApiError('NOT_FOUND', `row "${originalId}" does not exist`)
      }
      assertServerNameFree(mcpRowsOf(parsed), runtime, input.serverName, originalId)
      const existingConfig = existingConfigOf(originalId, runtime, parsed)
      const config = preserveExpressionFields(buildConfig(input, existingConfig), existingConfig)
      const result = editPatchText(fresh.text, { op: 'upsert', originalId, rowId: originalId, config, enabled })
      return { text: result.text, rowId: originalId, created: false }
    }

    assertServerNameFree(mcpRowsOf(parsed), runtime, input.serverName)
    const takenIds = new Set([
      ...runtime.keys(),
      ...mcpRowsOf(parsed).map((row) => row.id),
      ...loaderEntryIds(ctx),
    ])
    const rowId = nextRowId(input.serverName, takenIds)
    const config = buildConfig(input, undefined)
    const result = editPatchText(fresh.text, { op: 'upsert', rowId, config, enabled })
    return { text: result.text, rowId, created: true }
  })

  const summary = { revision: revisionOf(outcome.text), ...outcome.reload }
  return {
    ...summary,
    row: await projectSingleRow(ctx, outcome.text, outcome.rowId),
  }
}

/**
 * Remove one managed row and its id-targeted overrides.
 * @param {object} ctx Cordis context.
 * @param {{ waiters: Set<() => void> }} state Per-mount routing state.
 * @param {object} body Request body.
 * @returns {Promise<object>} Action payload.
 */
async function removeAction(ctx, state, body) {
  const baseRevision = requireString(body.baseRevision, 'baseRevision')
  const id = requireString(body.id, 'id')
  const paths = profilePaths(ctx)

  const outcome = await withPatchWriteLock(ctx, state, paths, baseRevision, async (fresh) => {
    const parsed = parsePatchText(fresh.text)
    const runtime = await runtimeProjection(ctx)
    if (!mcpRowsOf(parsed).some((row) => row.id === id)) {
      throw runtime.has(id)
        ? new ApiError('NOT_EDITABLE', `row "${id}" is not defined in the profile patch`)
        : new ApiError('NOT_FOUND', `row "${id}" does not exist`)
    }
    const result = editPatchText(fresh.text, { op: 'remove', id })
    return { text: result.text, rowId: id, created: false }
  })

  return {
    revision: revisionOf(outcome.text),
    removedId: outcome.rowId,
    ...outcome.reload,
  }
}

/**
 * Flip one managed row's inline `disabled` field.
 * @param {object} ctx Cordis context.
 * @param {{ waiters: Set<() => void> }} state Per-mount routing state.
 * @param {object} body Request body.
 * @returns {Promise<object>} Action payload.
 */
async function toggleAction(ctx, state, body) {
  const baseRevision = requireString(body.baseRevision, 'baseRevision')
  const id = requireString(body.id, 'id')
  if (typeof body.enabled !== 'boolean') {
    throw new ApiError('INVALID_ARGUMENT', 'enabled must be a boolean', { field: 'enabled' })
  }
  const paths = profilePaths(ctx)

  const outcome = await withPatchWriteLock(ctx, state, paths, baseRevision, async (fresh) => {
    const parsed = parsePatchText(fresh.text)
    const runtime = await runtimeProjection(ctx)
    if (!mcpRowsOf(parsed).some((row) => row.id === id)) {
      throw runtime.has(id)
        ? new ApiError('NOT_EDITABLE', `row "${id}" is not defined in the profile patch`)
        : new ApiError('NOT_FOUND', `row "${id}" does not exist`)
    }
    const result = editPatchText(fresh.text, { op: 'toggle', id, enabled: body.enabled })
    return { text: result.text, rowId: id, created: false }
  })

  return {
    revision: revisionOf(outcome.text),
    ...outcome.reload,
    row: await projectSingleRow(ctx, outcome.text, id),
  }
}

// ---------------------------------------------------------------------------
// Project-scoped MCP actions
// ---------------------------------------------------------------------------

/**
 * Read the project runtime or fail loudly when the deployment did not mount it.
 * @param {{ projectRuntime?: object }} state Per-mount routing state.
 * @returns {object} Project runtime.
 */
function requireProjectRuntime(state) {
  if (state.projectRuntime === undefined) {
    throw new ApiError('INTERNAL', 'the project-scoped MCP runtime is not available')
  }
  return state.projectRuntime
}

/**
 * Read one session's project view and merge the read-only global MCP summary.
 * @param {object} ctx Cordis context.
 * @param {{ projectRuntime?: object }} state Per-mount routing state.
 * @param {object} body Request body.
 * @returns {Promise<object>} Project view plus `global`.
 */
async function projectSessionAction(ctx, state, body) {
  const runtime = requireProjectRuntime(state)
  const sessionId = requireString(body.sessionId, 'sessionId')
  const paths = profilePaths(ctx)
  const text = await readPatchText(paths.patchPath)
  const projection = await buildProjection(ctx, text, paths)
  const global = projection.rows.map((row) => ({
    name: row.serverName,
    id: row.id,
    phase: row.phase,
    toolCount: row.toolCount,
    enabled: row.disabled !== true,
  }))
  const view = await runtime.view(sessionId, { globalServerNames: global.map((row) => row.name) })
  return { ...view, global }
}

/**
 * Trust or untrust one project directory.
 * @param {{ projectRuntime?: object }} state Per-mount routing state.
 * @param {object} body Request body.
 * @returns {Promise<{ dir: string, trusted: boolean }>} Saved trust state.
 */
async function projectTrustAction(state, body) {
  const runtime = requireProjectRuntime(state)
  const dir = requireString(body.dir, 'dir')
  if (!isAbsolute(dir)) {
    throw new ApiError('INVALID_ARGUMENT', 'dir must be an absolute path', { field: 'dir' })
  }
  if (typeof body.trusted !== 'boolean') {
    throw new ApiError('INVALID_ARGUMENT', 'trusted must be a boolean', { field: 'trusted' })
  }
  await runtime.trust(dir, body.trusted)
  return { dir, trusted: body.trusted }
}

/**
 * Toggle one project server's durable user intent.
 * @param {{ projectRuntime?: object }} state Per-mount routing state.
 * @param {object} body Request body.
 * @returns {Promise<{ serverName: string, enabled: boolean }>} Saved intent.
 */
async function projectToggleAction(state, body) {
  const runtime = requireProjectRuntime(state)
  const sessionId = requireString(body.sessionId, 'sessionId')
  const serverName = requireString(body.serverName, 'serverName')
  if (typeof body.enabled !== 'boolean') {
    throw new ApiError('INVALID_ARGUMENT', 'enabled must be a boolean', { field: 'enabled' })
  }
  await runtime.toggle(sessionId, serverName, body.enabled)
  return { serverName, enabled: body.enabled }
}

/**
 * Re-read the project declarations and rebuild one session's mounts.
 * @param {object} ctx Cordis context.
 * @param {{ projectRuntime?: object }} state Per-mount routing state.
 * @param {object} body Request body.
 * @returns {Promise<object>} Fresh project view.
 */
async function projectReloadAction(ctx, state, body) {
  const runtime = requireProjectRuntime(state)
  const sessionId = requireString(body.sessionId, 'sessionId')
  await runtime.reload(sessionId)
  return projectSessionAction(ctx, state, { sessionId })
}

/**
 * Lightweight badge data for the composer button.
 * @param {{ projectRuntime?: object }} state Per-mount routing state.
 * @param {object} body Request body.
 * @returns {Promise<{ relevant: boolean, badge: string | null }>} Badge state.
 */
async function projectBadgeAction(ctx, state, body) {
  const runtime = requireProjectRuntime(state)
  const sessionId = requireString(body.sessionId, 'sessionId')
  const badge = await runtime.badge(sessionId)
  // The composer entry also represents the global plane: show it when either
  // side has something to report, even in a directory with no declaration.
  let globalCount = 0
  try {
    const paths = profilePaths(ctx)
    const text = await readPatchText(paths.patchPath)
    globalCount = mcpRowsOf(parsePatchText(text)).length
  } catch {
    globalCount = 0
  }
  return { ...badge, relevant: badge?.relevant === true || globalCount > 0 }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Build the full row projection for one patch text.
 * @param {object} ctx Cordis context.
 * @param {string} text Patch text.
 * @param {{ dir: string, patchPath: string }} paths Profile locations.
 * @returns {Promise<{ rows: object[] }>} Projection.
 */
async function buildProjection(ctx, text, paths) {
  const parsed = parsePatchText(text)
  const runtime = await runtimeProjection(ctx, paths)
  const rows = []
  const seen = new Set()
  for (const patchRow of mcpRowsOf(parsed)) {
    const live = runtime.get(patchRow.id)
    rows.push(projectRow({ patchRow, live, source: 'profile', editable: true }))
    seen.add(patchRow.id)
  }
  for (const [id, live] of runtime) {
    if (seen.has(id)) continue
    rows.push(projectRow({ patchRow: undefined, live, source: live.source, editable: false }))
  }
  rows.sort((left, right) => left.serverName.localeCompare(right.serverName))
  return { rows }
}

/**
 * Project one managed row by id, after a write.
 * @param {object} ctx Cordis context.
 * @param {string} text Patch text.
 * @param {string} rowId Row id.
 * @returns {Promise<object | undefined>} Projected row.
 */
async function projectSingleRow(ctx, text, rowId) {
  const paths = profilePaths(ctx)
  const projection = await buildProjection(ctx, text, paths)
  return projection.rows.find((row) => row.id === rowId)
}

/**
 * Merge one patch row or one live entry into the wire Row shape.
 * @param {{ patchRow?: object, live?: object, source: string, editable: boolean }} input Parts.
 * @returns {object} Wire row.
 */
function projectRow({ patchRow, live, source, editable }) {
  // Editable rows project the file's raw config so `!!js` expressions stay
  // expressions; runtime config is the only source for rows outside the patch.
  const config = editable && patchRow !== undefined && patchRow.config !== null
    ? patchRow.config
    : live?.config ?? patchRow?.config ?? {}
  const masked = maskConfig(config)
  const serverName = serverNameOf(config, live?.id ?? patchRow?.id ?? '')
  return {
    id: live?.id ?? patchRow?.id,
    serverName,
    source,
    editable,
    disabled: live === undefined ? patchRow?.disabled === true : live.disabled,
    transport: masked.transport ?? null,
    command: masked.command ?? null,
    args: masked.args ?? null,
    cwd: masked.cwd ?? null,
    env: masked.env ?? null,
    url: masked.url ?? null,
    headers: masked.headers ?? null,
    toolCallTimeoutMs: masked.toolCallTimeoutMs ?? null,
    maxInstructionBytes: masked.maxInstructionBytes ?? null,
    failOnStartupError: masked.failOnStartupError ?? null,
    reconnect: masked.reconnect ?? null,
    phase: live?.phase ?? null,
    diagnostic: live?.diagnostic ?? null,
    toolCount: live?.tools?.length ?? 0,
    tools: (live?.tools ?? []).slice(0, MAX_TOOLS_PER_ROW),
  }
}

/**
 * Read every live MCP client entry into a map keyed by Loader entry id.
 * @param {object} ctx Cordis context.
 * @param {{ dir: string, patchPath: string }} [paths] Profile locations (for source tagging).
 * @returns {Promise<Map<string, object>>} Live entries.
 */
async function runtimeProjection(ctx, paths = profilePaths(ctx)) {
  const toolNames = safeToolNames(ctx)
  const homeRowIds = await readHomeRowIds(paths)
  const result = new Map()
  for (const entry of ctx.loader.entries()) {
    if (entry.options?.name !== MCP_CLIENT_MODULE) continue
    const id = entry.options.id
    if (typeof id !== 'string') continue
    const fiber = entry.fiber
    const phase = fiber === undefined ? null : (FIBER_STATE_PHASE[fiber.state] ?? null)
    let diagnostic = null
    if (phase === 'failed' && fiber !== undefined) {
      try {
        await fiber.await()
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : String(error)
      }
    }
    const config = entry.options.config ?? {}
    const serverName = serverNameOf(config, id)
    result.set(id, {
      id,
      serverName,
      config,
      disabled: entry.disabled === true,
      phase,
      diagnostic,
      tools: toolsForServer(serverName, toolNames),
      source: homeRowIds.has(id) ? 'home' : 'bundle',
    })
  }
  return result
}

/**
 * Read the home patch's MCP row ids, so rows can be labelled by their layer.
 * @param {{ dir: string, patchPath: string }} paths Profile locations.
 * @returns {Promise<Set<string>>} Home-layer row ids.
 */
async function readHomeRowIds(paths) {
  const homeDir = process.env.DSH_HOME
  if (homeDir === undefined || homeDir === '') return new Set()
  const homePatch = join(homeDir, 'cordis.patch.yml')
  if (homePatch === paths.patchPath) return new Set()
  try {
    const text = await readFile(homePatch, 'utf8')
    return new Set(parsePatchText(text).rows.map((row) => row.id))
  } catch {
    return new Set()
  }
}

/**
 * Collect every Loader entry id, used to keep generated row ids unique.
 * @param {object} ctx Cordis context.
 * @returns {string[]} Entry ids.
 */
function loaderEntryIds(ctx) {
  const ids = []
  for (const entry of ctx.loader.entries()) {
    if (typeof entry.options?.id === 'string') ids.push(entry.options.id)
  }
  return ids
}

/**
 * Read the currently visible tool names without letting a registry failure break the page.
 * @param {object} ctx Cordis context.
 * @returns {string[]} Visible tool names.
 */
function safeToolNames(ctx) {
  try {
    return ctx.tools
      .schemas()
      .map((schema) => schema?.name)
      .filter((name) => typeof name === 'string')
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Write pipeline
// ---------------------------------------------------------------------------

/**
 * Resolve the active profile locations.
 * @param {object} ctx Cordis context.
 * @returns {{ dir: string, patchPath: string }} Profile locations.
 */
function profilePaths(ctx) {
  const profile = ctx.profileContext
  if (profile === undefined || typeof profile.dir !== 'string') {
    throw new ApiError('INTERNAL', 'the active profile is not available in this deployment')
  }
  return {
    dir: profile.dir,
    patchPath: typeof profile.patchPath === 'string' ? profile.patchPath : join(profile.dir, 'cordis.patch.yml'),
  }
}

/**
 * Read the profile patch text, tolerating a missing file.
 * @param {string} patchPath Patch path.
 * @returns {Promise<string>} Patch text.
 */
async function readPatchText(patchPath) {
  try {
    return await readFile(patchPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return EMPTY_PATCH_TEXT
    throw error
  }
}

/**
 * Hash patch text for optimistic concurrency.
 * @param {string} text Patch text.
 * @returns {string} `sha256:<hex>`.
 */
function revisionOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * Run one mutating patch edit under the shared profile write lock, persist it and
 * wait for the Loader to report the reload.
 * @param {object} ctx Cordis context.
 * @param {{ waiters: Set<() => void> }} state Per-mount routing state.
 * @param {{ dir: string, patchPath: string }} paths Profile locations.
 * @param {string} baseRevision Client-observed revision.
 * @param {(fresh: { text: string }) => Promise<object>} edit Calls `editPatchText` and returns extra result fields.
 * @returns {Promise<{ text: string, reload: object } & object>} New text and reload outcome.
 */
async function withPatchWriteLock(ctx, state, paths, baseRevision, edit) {
  const lockPath = join(paths.dir, PROFILE_LOCK_FILE)
  let watcher = null
  let result
  try {
    result = await withFileLock(lockPath, async () => {
      const freshText = await readPatchText(paths.patchPath)
      const freshRevision = revisionOf(freshText)
      if (freshRevision !== baseRevision) {
        throw new ApiError('CONFLICT', 'the profile patch changed since it was read', {
          details: { currentRevision: freshRevision },
        })
      }
      const outcome = await edit({ text: freshText })
      const nextText = outcome.text
      if (typeof nextText !== 'string') {
        throw new ApiError('WRITE_FAILED', 'the patch editor produced no document')
      }
      // Sanity check before committing: the edited document must parse as a patch list.
      parsePatchText(nextText)
      if (nextText === freshText) return { ...outcome, changed: false }
      // Register the reload waiter before the write reaches the watcher.
      watcher = createReloadWatcher(state)
      try {
        await writeFileAtomic(paths.patchPath, nextText, { mode: PROFILE_PATCH_MODE })
      } catch (error) {
        watcher.cancel()
        watcher = null
        throw new ApiError('WRITE_FAILED', `writing the profile patch failed: ${String(error?.message ?? error)}`, {
          details: { reason: String(error?.code ?? 'unknown') },
        })
      }
      const persisted = await readPatchText(paths.patchPath)
      if (persisted !== nextText) {
        throw new ApiError('WRITE_FAILED', 'the profile patch did not persist the expected content', {
          details: { reason: 'readback-mismatch' },
        })
      }
      return { ...outcome, changed: true }
    })
  } catch (error) {
    watcher?.cancel()
    throw error
  }

  if (!result.changed) {
    return { ...result, reload: { applied: true, timedOut: false, tookMs: 0 } }
  }
  const startedAt = Date.now()
  const reload = await watcher.promise
  return { ...result, reload: { ...reload, tookMs: Date.now() - startedAt } }
}

/**
 * Config keys whose masked Row projection cannot express a `!!js` marker, so an
 * untouched expression must survive an edit even though the request omits it.
 */
const EXPRESSION_ONLY_KEYS = ['toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError', 'reconnect']

/**
 * Detect an inert YAML `!!js` marker object.
 * @param {unknown} value Candidate value.
 * @returns {boolean} Whether the value is an expression marker.
 */
function isExpressionLike(value) {
  return value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string'
}

/**
 * Re-attach pre-existing `!!js` expressions for scalar fields that the wire Row
 * can only project as `null`; an explicit value from the client still wins.
 * @param {object} config Config derived from the request.
 * @param {object | undefined} existingConfig Current row config.
 * @returns {object} Config with untouched expressions preserved.
 */
function preserveExpressionFields(config, existingConfig) {
  if (existingConfig === undefined || existingConfig === null || typeof existingConfig !== 'object') {
    return config
  }
  for (const key of EXPRESSION_ONLY_KEYS) {
    if (config[key] !== undefined) continue
    if (isExpressionLike(existingConfig[key])) config[key] = existingConfig[key]
  }
  return config
}

/**
 * Ensure a serverName is not already used by another managed row.
 * @param {object[]} rows MCP insert rows of the profile patch.
 * @param {Map<string, object>} runtime Live entries.
 * @param {string} serverName Candidate server name.
 * @param {string} [excludeId] Row being edited, excluded from the check.
 */
function assertServerNameFree(rows, runtime, serverName, excludeId) {
  for (const row of rows) {
    if (row.id === excludeId) continue
    if (serverNameOf(row.config, row.id) === serverName) {
      throw new ApiError('INVALID_ARGUMENT', `server name "${serverName}" is already used by row "${row.id}"`, {
        field: 'serverName',
      })
    }
  }
  for (const [id, live] of runtime) {
    if (id === excludeId) continue
    if (live.serverName === serverName) {
      throw new ApiError('INVALID_ARGUMENT', `server name "${serverName}" is already used by row "${id}"`, {
        field: 'serverName',
      })
    }
  }
}

/**
 * Resolve the config a row currently has (runtime value wins over the file).
 * @param {string} id Row id.
 * @param {Map<string, object>} runtime Live entries.
 * @param {{ rows: object[] }} parsed Parsed profile patch.
 * @returns {object} Current config.
 */
function existingConfigOf(id, runtime, parsed) {
  // The patch text keeps `!!js` expressions inert; the Loader may hand back an
  // already-evaluated runtime config, which must not be frozen into the file.
  const patchRow = mcpRowsOf(parsed).find((row) => row.id === id)
  if (patchRow !== undefined && patchRow.config !== null && patchRow.config !== undefined) return patchRow.config
  return runtime.get(id)?.config ?? {}
}

/**
 * Read a non-empty string field from a request.
 * @param {unknown} value Candidate value.
 * @param {string} field Field name for the error.
 * @returns {string} The string.
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError('INVALID_ARGUMENT', `${field} must be a non-empty string`, { field })
  }
  return value
}

/**
 * Read an object field from a request.
 * @param {unknown} value Candidate value.
 * @param {string} field Field name for the error.
 * @returns {object} The object.
 */
function requireObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('INVALID_ARGUMENT', `${field} must be an object`, { field })
  }
  return value
}

/**
 * Keep only the rows that describe an MCP client instance.
 * @param {{ rows: object[] }} parsed Parsed profile patch.
 * @returns {object[]} MCP insert rows in document order.
 */
function mcpRowsOf(parsed) {
  return parsed.rows.filter((row) => row.moduleName === MCP_CLIENT_MODULE)
}

/**
 * Resolve a row's server name, falling back to its id.
 * @param {object} config Row config.
 * @param {string} fallback Fallback id.
 * @returns {string} Server name.
 */
function serverNameOf(config, fallback) {
  if (config !== null && typeof config === 'object' && typeof config.serverName === 'string' && config.serverName !== '') {
    return config.serverName
  }
  return fallback
}

/**
 * Watch one `app-boot/config-reload` event with a timeout. The notification
 * fan-out lives in `applyMcpManager`; this helper owns one waiter promise.
 * @param {{ waiters: Set<() => void> }} state Per-mount routing state.
 * @returns {{ promise: Promise<{ applied: boolean, timedOut: boolean }>, cancel: () => void }} Waiter.
 */
function createReloadWatcher(state) {
  let settle
  const promise = new Promise((resolve) => {
    settle = resolve
  })
  let settled = false
  const finish = (result) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    state.waiters.delete(notify)
    settle(result)
  }
  const notify = () => finish({ applied: true, timedOut: false })
  const timer = setTimeout(() => finish({ applied: false, timedOut: true }), RELOAD_TIMEOUT_MS)
  timer.unref?.()
  state.waiters.add(notify)
  return { promise, cancel: () => finish({ applied: false, timedOut: true }) }
}
