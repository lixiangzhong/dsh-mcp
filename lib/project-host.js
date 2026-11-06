/**
 * Project-scoped MCP host lifecycle.
 *
 * Listens to Agent lifecycle events, discovers the project declarations of the
 * session's *current* working directory, and mounts one `dsh-mcp-client`
 * instance per enabled + trusted project server on that Agent's own Cordis
 * scope, so instances stay isolated per session and follow `cd` changes.
 *
 * Scope of this module:
 *  - read-only with respect to project files (never writes `.mcp.json` or
 *    `.codex/config.toml`); the only file it writes is the plugin's own
 *    home-level trust store;
 *  - all operational failures (broken declarations, startup failures, missing
 *    runtime dependency) are recorded/logged, never thrown into the Agent
 *    lifecycle; only caller-contract violations raise `ProjectRuntimeError`.
 *
 * Contracts: docs/contracts/project-internals.md §1 (P0 imports) and §2
 * (`applyProjectRuntime` / `ProjectRuntime` shape).
 */
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { discoverProject, maskServerForPanel, toClientConfig } from './project-config.js'

/** Startup wait budget for one session's mounts; slower servers continue in background. */
export const STARTUP_BUDGET_MS = 2000

/** Trust document format version (spec §2.3). */
export const TRUST_FILE_VERSION = 1

/** Cordis fiber states (kept local so this module imports no extra package). */
const FIBER_STATE = Object.freeze({
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
})

/** mcp-client namespaces its public tools as `mcp__<serverName>__<tool>`. */
const MCP_TOOL_PREFIX = 'mcp__'

/** Trust file location relative to the DSH home directory. */
const TRUST_RELATIVE_PATH = join('dsh-mcp', 'trust.json')

/** Permission bits for the trust file and its directory (user-private data). */
const TRUST_FILE_MODE = 0o600
const TRUST_DIR_MODE = 0o700

/** Default bound for waiting on the cross-process trust-file writer lock. */
const DEFAULT_LOCK_WAIT_MS = 5000

/** Contract error codes surfaced to the Host API layer. */
const ERROR_CODE = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  WRITE_FAILED: 'WRITE_FAILED',
})

/** Wire status vocabulary for one project server (contract §2). */
const SERVER_STATUS = Object.freeze({
  STARTING: 'starting',
  CONNECTED: 'connected',
  FAILED: 'failed',
  STOPPED: 'stopped',
})

/** Badge values (contract §2). */
const BADGE = Object.freeze({ UNTRUSTED: 'untrusted', FAILED: 'failed' })

/**
 * Caller-contract failure with a Host API error code.
 * Operational (mount/parse/trust-read) failures never use this class.
 */
export class ProjectRuntimeError extends Error {
  /**
   * @param {'INVALID_ARGUMENT' | 'NOT_FOUND' | 'WRITE_FAILED'} code Host API error code.
   * @param {string} message Human readable diagnostic.
   * @param {{ field?: string }} [options] Optional structured detail.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ProjectRuntimeError'
    this.code = code
    if (options.field !== undefined) this.field = options.field
  }
}

/**
 * Install the project-level runtime on a profile-scoped Cordis context.
 *
 * Every method on the returned object is safe to call from the Host API layer:
 * operational failures are reported through the view (`warnings`/`lastError`)
 * instead of throwing, and the Agent lifecycle listeners never reject.
 *
 * @param {object} ctx Cordis context of the profile plugin (needs `on`, `effect`
 *   and, at runtime, the `agents`/`sessions`/`workingDirectory`/`tools` services).
 * @param {{
 *   mcpClient?: object,
 *   env?: Record<string, string | undefined>,
 *   trustPath?: string,
 *   budgetMs?: number,
 *   lockWaitMs?: number,
 *   globalServerNames?: string[] | Set<string> | (() => string[] | Set<string> | Promise<string[] | Set<string>>),
 * }} [options]
 *   `mcpClient` injects a plugin (tests); otherwise `@deepseek-ai/dsh-mcp-client`
 *   is loaded lazily. Extra options (`budgetMs`, `lockWaitMs`,
 *   `globalServerNames`) are additive conveniences for tests/host wiring.
 * @returns {object} ProjectRuntime
 */
export function applyProjectRuntime(ctx, options = {}) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
    throw new TypeError('applyProjectRuntime(ctx): ctx must be a Cordis context')
  }
  const state = createRuntimeState(ctx, options)
  const runtime = {
    view: (sessionId, extra) => viewSession(state, sessionId, extra),
    badge: (sessionId) => badgeSession(state, sessionId),
    trust: (projectDir, trusted) => setProjectTrust(state, projectDir, trusted),
    toggle: (sessionId, serverName, enabled) => toggleServer(state, sessionId, serverName, enabled),
    reload: (sessionId) => reloadSession(state, sessionId),
    dispose: () => disposeRuntime(state),
  }
  installRuntime(state)
  return runtime
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/**
 * Build the mutable runtime state shared by every method and listener.
 * @param {object} ctx Profile Cordis context.
 * @param {object} options Runtime options.
 * @returns {object} Runtime state.
 */
function createRuntimeState(ctx, options) {
  const resolvedOptions = isRecord(options) ? options : {}
  const env = isRecord(resolvedOptions.env) ? resolvedOptions.env : process.env
  const budgetMs =
    typeof resolvedOptions.budgetMs === 'number' && Number.isFinite(resolvedOptions.budgetMs) && resolvedOptions.budgetMs >= 0
      ? resolvedOptions.budgetMs
      : STARTUP_BUDGET_MS
  const lockWaitMs =
    typeof resolvedOptions.lockWaitMs === 'number' && Number.isFinite(resolvedOptions.lockWaitMs) && resolvedOptions.lockWaitMs > 0
      ? resolvedOptions.lockWaitMs
      : DEFAULT_LOCK_WAIT_MS
  return {
    ctx,
    options: resolvedOptions,
    env,
    budgetMs,
    lockWaitMs,
    trustPath: resolveTrustPath(resolvedOptions, env),
    sessions: new Map(),
    listeners: [],
    disposed: false,
    clientPromise: resolvedOptions.mcpClient === undefined ? null : Promise.resolve(resolvedOptions.mcpClient),
  }
}

/**
 * Resolve the trust store location.
 * @param {object} options Runtime options.
 * @param {Record<string, string | undefined>} env Effective environment.
 * @returns {string} Absolute trust file path.
 */
function resolveTrustPath(options, env) {
  if (isNonEmptyString(options.trustPath)) return resolve(options.trustPath)
  const configuredHome = isNonEmptyString(env.DSH_HOME) ? env.DSH_HOME : process.env.DSH_HOME
  const home = isNonEmptyString(configuredHome) ? configuredHome : join(homedir(), '.dsh')
  return join(home, TRUST_RELATIVE_PATH)
}

/**
 * Register lifecycle listeners and clean up through the owning fiber.
 * @param {object} state Runtime state.
 */
function installRuntime(state) {
  subscribe(state, 'agent/created', (payload) => handleAgentCreated(state, payload))
  subscribe(state, 'agent/disposed', (payload) => handleAgentDisposed(state, payload))
  subscribe(state, 'agent/pre-step', (payload, next) => handleAgentPreStep(state, payload, next))
  if (typeof state.ctx.effect === 'function') {
    state.ctx.effect(() => () => disposeRuntime(state), 'dsh-mcp: project-runtime')
  }
  scanExistingAgents(state)
}

/**
 * Subscribe one listener and remember its disposer.
 * @param {object} state Runtime state.
 * @param {string} event Event name.
 * @param {Function} listener Listener callback.
 */
function subscribe(state, event, listener) {
  const dispose = state.ctx.on(event, listener)
  if (typeof dispose === 'function') state.listeners.push(dispose)
}

/**
 * Mount already-published agents when the plugin is installed into a live app
 * (covers plugin reload / profile HMR). Failures stay in the background.
 * @param {object} state Runtime state.
 */
function scanExistingAgents(state) {
  let agents
  try {
    agents = serviceOf(state, 'agents')?.list?.()
  } catch (error) {
    logWarn(state, `project-runtime: cannot list existing agents: ${errorText(error)}`)
    return
  }
  if (!Array.isArray(agents)) return
  for (const agent of agents) {
    void attachAgent(state, agent).catch((error) => {
      logWarn(state, `project-runtime: initial agent attach failed: ${errorText(error)}`)
    })
  }
}

// ---------------------------------------------------------------------------
// Agent lifecycle listeners
// ---------------------------------------------------------------------------

/**
 * `agent/created`: discover the session project and mount trusted servers.
 * The serial event waits at most one startup budget; never rejects.
 * @param {object} state Runtime state.
 * @param {{ agent?: object }} payload Event payload.
 */
async function handleAgentCreated(state, payload) {
  if (state.disposed) return
  try {
    const agent = payload?.agent
    if (agent === undefined || agent === null) return
    await attachAgent(state, agent)
  } catch (error) {
    logWarn(state, `project-runtime: agent/created failed: ${errorText(error)}`)
  }
}

/**
 * `agent/disposed`: unmount every instance owned by that session.
 * @param {object} state Runtime state.
 * @param {{ agent?: object }} payload Event payload.
 */
async function handleAgentDisposed(state, payload) {
  try {
    const sessionId = sessionIdOf(payload?.agent)
    if (!sessionId) return
    const entry = state.sessions.get(sessionId)
    state.sessions.delete(sessionId)
    if (entry !== undefined) await unmountEntry(state, entry, state.budgetMs)
  } catch (error) {
    logWarn(state, `project-runtime: agent/disposed failed: ${errorText(error)}`)
  }
}

/**
 * `agent/pre-step`: follow the session's current working directory before the
 * step runs. Same directory is a no-op. Never blocks longer than the budget.
 * @param {object} state Runtime state.
 * @param {{ agent?: object }} payload Waterfall payload.
 * @param {Function} [next] Waterfall continuation.
 * @returns {unknown} Downstream waterfall result.
 */
async function handleAgentPreStep(state, payload, next) {
  try {
    const agent = payload?.agent
    if (!state.disposed && agent !== undefined && agent !== null) {
      await followWorkingDirectory(state, agent)
    }
  } catch (error) {
    logWarn(state, `project-runtime: agent/pre-step failed: ${errorText(error)}`)
  }
  return typeof next === 'function' ? next() : undefined
}

// ---------------------------------------------------------------------------
// Session registry and discovery
// ---------------------------------------------------------------------------

/**
 * Create the registry record of one session.
 * @param {string} sessionId Session id.
 * @param {object} agent Live Agent.
 * @returns {object} Session entry.
 */
function createSessionEntry(sessionId, agent) {
  return {
    sessionId,
    agent,
    cwd: undefined,
    project: emptyProject(),
    trust: emptyTrustRead(),
    trusted: false,
    mounts: new Map(),
  }
}

/**
 * Attach one Agent: create/refresh its entry, then reconcile mounts.
 * @param {object} state Runtime state.
 * @param {object} agent Live Agent.
 */
async function attachAgent(state, agent) {
  if (state.disposed) return
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return
  const entry = await ensureSessionEntry(state, sessionId, agent)
  await refreshSessionEntry(state, entry)
  await reconcileMounts(state, entry)
}

/**
 * Get or create the registry entry for one live Agent.
 * @param {object} state Runtime state.
 * @param {string} sessionId Session id.
 * @param {object} agent Live Agent.
 * @returns {Promise<object>} Session entry.
 */
async function ensureSessionEntry(state, sessionId, agent) {
  let entry = state.sessions.get(sessionId)
  if (entry === undefined) {
    entry = createSessionEntry(sessionId, agent)
    state.sessions.set(sessionId, entry)
    return entry
  }
  if (entry.agent !== agent && agent !== undefined) entry.agent = agent
  return entry
}

/**
 * Re-resolve the session working directory, project declarations and trust.
 * @param {object} state Runtime state.
 * @param {object} entry Session entry.
 */
async function refreshSessionEntry(state, entry) {
  entry.cwd = sessionCwdOf(state, entry.agent) ?? entry.cwd
  entry.project = discoverProjectFor(state, entry.cwd)
  for (const warning of entry.project.warnings) {
    logWarn(state, `project-runtime: ${entry.project.projectDir ?? entry.cwd ?? 'unknown'}: ${warning}`)
  }
  entry.trust = await readTrustDocument(state)
  entry.trusted = isProjectTrusted(entry.trust.document, entry.project.projectDir)
}

/**
 * Discover project declarations for one directory, degrading every failure to
 * warnings (a broken project must never break the session).
 * @param {object} state Runtime state.
 * @param {string | undefined} cwd Session directory.
 * @returns {{ projectDir: string | null, files: object[], servers: object[], warnings: string[] }} Project.
 */
function discoverProjectFor(state, cwd) {
  if (!isNonEmptyString(cwd)) return emptyProject()
  try {
    const found = discoverProject(cwd)
    return {
      projectDir: isNonEmptyString(found.projectDir) ? found.projectDir : null,
      files: Array.isArray(found.files) ? found.files : [],
      servers: Array.isArray(found.servers) ? found.servers : [],
      warnings: Array.isArray(found.warnings) ? found.warnings : [],
    }
  } catch (error) {
    const message = `failed to discover project at ${cwd}: ${errorText(error)}`
    logWarn(state, `project-runtime: ${message}`)
    return { projectDir: null, files: [], servers: [], warnings: [message] }
  }
}

/**
 * Empty project projection.
 * @returns {{ projectDir: null, files: object[], servers: object[], warnings: string[] }} Empty project.
 */
function emptyProject() {
  return { projectDir: null, files: [], servers: [], warnings: [] }
}

// ---------------------------------------------------------------------------
// Mount reconciliation
// ---------------------------------------------------------------------------

/**
 * Bring one session's mounts in line with its trusted + enabled project servers.
 * @param {object} state Runtime state.
 * @param {object} entry Session entry.
 * @returns {Promise<void>} Resolves once the startup budget elapsed.
 */
async function reconcileMounts(state, entry, budgetMs = state.budgetMs) {
  const startedAt = Date.now()
  if (state.disposed || entry.agent === undefined) {
    await unmountAll(state, entry, budgetMs)
    return
  }
  if (!entry.trusted || entry.project.projectDir === null) {
    await unmountAll(state, entry, budgetMs)
    return
  }
  const mountable = mountableServers(entry)
  const mountableNames = new Set(mountable.map((server) => server.name))
  for (const serverName of [...entry.mounts.keys()]) {
    if (mountableNames.has(serverName)) continue
    await unmountServer(state, entry, serverName, remainingBudget(startedAt, budgetMs))
  }
  const startups = []
  for (const server of mountable) {
    if (entry.mounts.has(server.name)) continue
    startups.push(startMount(state, entry, server))
  }
  if (startups.length === 0) return
  await settleWithinBudget(startups, remainingBudget(startedAt, budgetMs))
}

/**
 * Project servers this session may mount: enabled in the file and not disabled
 * in the trust store.
 * @param {object} entry Session entry.
 * @returns {object[]} Mountable project servers.
 */
function mountableServers(entry) {
  const projectDir = entry.project.projectDir
  if (projectDir === null) return []
  return entry.project.servers.filter(
    (server) => server.enabled !== false && isServerTrustEnabled(entry.trust.document, projectDir, server.name),
  )
}

/**
 * Start one mcp-client instance on the session's Agent scope.
 * Returns a promise that settles when the plugin finishes starting; the caller
 * races it against the budget and leaves slow startups running in background.
 * @param {object} state Runtime state.
 * @param {object} entry Session entry.
 * @param {object} server Project server.
 * @returns {Promise<void>} Startup settlement (never rejects).
 */
function startMount(state, entry, server) {
  const mount = {
    serverName: server.name,
    fiber: null,
    error: null,
    warnings: [],
    startup: null,
    cancelled: false,
  }
  entry.mounts.set(server.name, mount)
  mount.startup = (async () => {
    try {
      const client = await resolveMcpClient(state)
      const mapped = toClientConfig(server, {
        env: state.env,
        projectDir: entry.project.projectDir ?? undefined,
      })
      mount.warnings = Array.isArray(mapped.warnings) ? [...mapped.warnings] : []
      for (const warning of mount.warnings) {
        logWarn(state, `project-runtime: ${server.name}: ${warning}`)
      }
      const config = { ...mapped.config, failOnStartupError: false }
      const fiber = entry.agent.ctx.plugin(client, config)
      if (fiber === undefined || fiber === null) {
        throw new Error('plugin mount did not return a fiber')
      }
      mount.fiber = fiber
      if (mount.cancelled || state.disposed) {
        // The session switched directories / disposed while the plugin was
        // starting; make sure this late fiber cannot leak on the agent scope.
        mount.fiber = null
        await disposeFiberQuietly(state, fiber, server.name)
        return
      }
      if (typeof fiber.await === 'function') await fiber.await()
      if (fiber.state === FIBER_STATE.FAILED) {
        throw new Error(`mcp-client fiber failed to start (fiber state ${fiber.state})`)
      }
      mount.error = null
    } catch (error) {
      mount.error = truncateError(error)
      logWarn(state, `project-runtime: server "${server.name}" failed to start: ${mount.error}`)
    }
  })()
  return mount.startup
}

/**
 * Stop and forget one mount (bounded so a hung startup cannot block teardown).
 * @param {object} state Runtime state.
 * @param {object} entry Session entry.
 * @param {string} serverName Server name.
 * @param {number} budgetMs Wait budget for fiber disposal.
 * @returns {Promise<void>} Resolves once disposal settled or the budget elapsed.
 */
async function unmountServer(state, entry, serverName, budgetMs) {
  const mount = entry.mounts.get(serverName)
  if (mount === undefined) return
  mount.cancelled = true
  entry.mounts.delete(serverName)
  const fiber = mount.fiber
  mount.fiber = null
  if (fiber === undefined || fiber === null) return
  const disposing = disposeFiberQuietly(state, fiber, serverName)
  await settleWithinBudget([disposing], budgetMs)
}

/**
 * Dispose one fiber, containing failures (fiber may already be gone).
 * @param {object} state Runtime state.
 * @param {object} fiber Cordis fiber.
 * @param {string} serverName Server name for diagnostics.
 * @returns {Promise<void>} Disposal settlement.
 */
async function disposeFiberQuietly(state, fiber, serverName) {
  if (typeof fiber.dispose !== 'function') return
  try {
    await fiber.dispose()
  } catch (error) {
    logWarn(state, `project-runtime: disposing "${serverName}" failed: ${errorText(error)}`)
  }
}

/**
 * Unmount every instance of one session.
 * @param {object} state Runtime state.
 * @param {object} entry Session entry.
 * @param {number} budgetMs Total wait budget.
 * @returns {Promise<void>} Resolves once all disposals settled or the budget elapsed.
 */
async function unmountEntry(state, entry, budgetMs) {
  await unmountAll(state, entry, budgetMs)
}

/**
 * Unmount all mounts of one entry in parallel.
 * @param {object} state Runtime state.
 * @param {object} entry Session entry.
 * @param {number} budgetMs Total wait budget.
 * @returns {Promise<void>} Resolves once all disposals settled or the budget elapsed.
 */
async function unmountAll(state, entry, budgetMs) {
  const startedAt = Date.now()
  const serverNames = [...entry.mounts.keys()]
  await Promise.allSettled(
    serverNames.map((serverName) => unmountServer(state, entry, serverName, remainingBudget(startedAt, budgetMs))),
  )
}

/**
 * Resolve the injected mcp-client plugin, or load the real package lazily.
 * Lazy loading keeps this module importable in environments without DSH
 * packages (unit tests inject `options.mcpClient`).
 * @param {object} state Runtime state.
 * @returns {Promise<object>} Plugin module namespace.
 */
async function resolveMcpClient(state) {
  if (state.clientPromise === null) {
    state.clientPromise = import('@deepseek-ai/dsh-mcp-client').catch((error) => {
      throw new Error(
        `cannot load @deepseek-ai/dsh-mcp-client (${errorText(error)}); inject options.mcpClient when embedding the runtime outside DSH`,
      )
    })
  }
  return await state.clientPromise
}

// ---------------------------------------------------------------------------
// Working-directory following
// ---------------------------------------------------------------------------

/**
 * `agent/pre-step` worker: rebuild mounts when the session directory changed.
 * @param {object} state Runtime state.
 * @param {object} agent Live Agent.
 */
async function followWorkingDirectory(state, agent) {
  const sessionId = sessionIdOf(agent)
  if (!sessionId) return
  const cwd = sessionCwdOf(state, agent)
  const entry = state.sessions.get(sessionId)
  if (entry === undefined) {
    await attachAgent(state, agent)
    return
  }
  if (!isNonEmptyString(cwd) || cwd === entry.cwd) return
  const startedAt = Date.now()
  entry.cwd = cwd
  entry.agent = agent
  await unmountAll(state, entry, remainingBudget(startedAt, state.budgetMs))
  await refreshSessionEntry(state, entry)
  await reconcileMounts(state, entry, remainingBudget(startedAt, state.budgetMs))
}

/**
 * Read the session's current working directory without filesystem I/O.
 * Prefers the working-directory service projection, falls back to the Session
 * header's creation cwd.
 * @param {object} state Runtime state.
 * @param {object} agent Live Agent.
 * @returns {string | undefined} Absolute directory, when known.
 */
function sessionCwdOf(state, agent) {
  return sessionCwdOfSession(state, agent?.session)
}

/**
 * Read a working directory for one Session object.
 * @param {object} state Runtime state.
 * @param {object | undefined} session Session object.
 * @returns {string | undefined} Absolute directory, when known.
 */
function sessionCwdOfSession(state, session) {
  if (session === undefined || session === null) return undefined
  const workingDirectory = serviceOf(state, 'workingDirectory')
  if (workingDirectory !== undefined && typeof workingDirectory.get === 'function') {
    try {
      const cwd = workingDirectory.get(session)
      if (isNonEmptyString(cwd)) return cwd
    } catch {
      // Fall through to the session header.
    }
  }
  const headerCwd = session.header?.cwd
  if (isNonEmptyString(headerCwd)) return headerCwd
  return undefined
}

// ---------------------------------------------------------------------------
// ProjectRuntime.view / badge
// ---------------------------------------------------------------------------

/**
 * Read one session's project projection without modifying anything.
 * @param {object} state Runtime state.
 * @param {string} sessionId Session id.
 * @param {{ globalServerNames?: string[] | Set<string> | (() => unknown) }} [extra]
 *   Optional global-server names used to flag `overridesGlobal` (the Host layer
 *   owns the global plane and passes its names here).
 * @returns {Promise<object>} Project view.
 */
async function viewSession(state, sessionId, extra = {}) {
  ensureRuntimeActive(state, 'view')
  const resolved = await resolveSession(state, sessionId)
  const entry = resolved.entry
  const project = entry?.project ?? discoverProjectFor(state, resolved.cwd)
  const trust = await readTrustDocument(state)
  const projectDir = project.projectDir
  const trusted = isProjectTrusted(trust.document, projectDir)
  if (entry !== undefined) {
    entry.trust = trust
    entry.trusted = trusted
  }
  const toolNames = toolNamesOf(state.ctx, resolved.agent ?? entry?.agent)
  const globalNames = await resolveGlobalNames(state, extra.globalServerNames)
  const servers = project.servers.map((server) =>
    projectServerView(entry, server, projectDir, trust.document, toolNames, globalNames),
  )
  const warnings = [...project.warnings, ...trust.warnings]
  if (entry !== undefined) {
    for (const mount of entry.mounts.values()) warnings.push(...mount.warnings)
  }
  return {
    cwd: resolved.cwd,
    projectDir,
    files: project.files,
    trusted,
    servers,
    warnings: uniqueMessages(warnings),
  }
}

/**
 * Project one server into the wire view: masked declaration plus session state.
 * @param {object | undefined} entry Session entry (absent = not mounted yet).
 * @param {object} server Project server.
 * @param {string | null} projectDir Project identity directory.
 * @param {object} trustDocument Trust document.
 * @param {string[]} toolNames Registered tool names.
 * @param {Set<string>} globalNames Global server names.
 * @returns {object} Server view.
 */
function projectServerView(entry, server, projectDir, trustDocument, toolNames, globalNames) {
  const masked = maskServerForPanel(server)
  const mount = entry?.mounts.get(server.name)
  const fileEnabled = server.enabled !== false
  const trustEnabled =
    projectDir === null ? true : isServerTrustEnabled(trustDocument, projectDir, server.name)
  return {
    ...masked,
    enabled: fileEnabled && trustEnabled,
    fileEnabled,
    trustEnabled,
    active: mount !== undefined && mount.error === null,
    status: mountStatus(mount, server.name, toolNames),
    lastError: mount?.error ?? null,
    overridesGlobal: globalNames.has(server.name),
  }
}

/**
 * Approximate one mount's connection status (rc.1 mcp-client has no status API).
 * @param {object | undefined} mount Mount record.
 * @param {string} serverName Server name.
 * @param {string[]} toolNames Registered tool names.
 * @returns {'starting' | 'connected' | 'failed' | 'stopped'} Status.
 */
function mountStatus(mount, serverName, toolNames) {
  if (mount === undefined) return SERVER_STATUS.STOPPED
  if (mount.error !== null) return SERVER_STATUS.FAILED
  const fiber = mount.fiber
  if (fiber !== null && fiber !== undefined) {
    if (fiber.state === FIBER_STATE.FAILED) return SERVER_STATUS.FAILED
    if (fiber.state === FIBER_STATE.DISPOSED) return SERVER_STATUS.STOPPED
  }
  if (toolNames.some((name) => name.startsWith(`${MCP_TOOL_PREFIX}${serverName}__`))) {
    return SERVER_STATUS.CONNECTED
  }
  return SERVER_STATUS.STARTING
}

/**
 * Lightweight badge projection used by the composer icon.
 * @param {object} state Runtime state.
 * @param {string} sessionId Session id.
 * @returns {Promise<{ relevant: boolean, badge: 'untrusted' | 'failed' | null }>} Badge.
 */
async function badgeSession(state, sessionId) {
  ensureRuntimeActive(state, 'badge')
  const resolved = await resolveSession(state, sessionId)
  const entry = resolved.entry
  const project = entry?.project ?? discoverProjectFor(state, resolved.cwd)
  const trust = await readTrustDocument(state)
  const projectDir = project.projectDir
  const hasDeclaration = project.files.length > 0 || project.servers.length > 0
  if (!hasDeclaration) return { relevant: false, badge: null }
  const trusted = isProjectTrusted(trust.document, projectDir)
  if (project.servers.length > 0 && !trusted) return { relevant: true, badge: BADGE.UNTRUSTED }
  const failed = entry !== undefined && [...entry.mounts.values()].some((mount) => mount.error !== null)
  return { relevant: true, badge: failed ? BADGE.FAILED : null }
}

/**
 * Resolve the Session/Agent/entry/cwd quadruple behind one session id.
 * @param {object} state Runtime state.
 * @param {unknown} sessionId Session id from the Host API.
 * @returns {Promise<{ entry?: object, agent?: object, session?: object, cwd: string }>} Resolved session.
 */
async function resolveSession(state, sessionId) {
  const id = requireNonEmptyString(sessionId, 'sessionId')
  const entry = state.sessions.get(id)
  let agent = entry?.agent
  if (agent === undefined) {
    try {
      agent = serviceOf(state, 'agents')?.get?.(id)
    } catch {
      agent = undefined
    }
  }
  let session = agent?.session
  if (session === undefined) {
    try {
      session = serviceOf(state, 'sessions')?.get?.(id)
    } catch {
      session = undefined
    }
  }
  const entryCwd = entry?.cwd
  const cwd = isNonEmptyString(entryCwd) ? entryCwd : sessionCwdOfSession(state, session ?? agent?.session)
  if (!isNonEmptyString(cwd)) {
    throw new ProjectRuntimeError(ERROR_CODE.NOT_FOUND, `session "${id}" has no discoverable working directory`)
  }
  return { entry, agent, session, cwd }
}

// ---------------------------------------------------------------------------
// ProjectRuntime.trust / toggle / reload
// ---------------------------------------------------------------------------

/**
 * Trust or untrust one project directory, then reconcile every live session of
 * that project.
 * @param {object} state Runtime state.
 * @param {unknown} projectDir Project directory.
 * @param {unknown} trusted Whether the project is trusted.
 * @returns {Promise<{ dir: string, trusted: boolean }>} Stored state.
 */
async function setProjectTrust(state, projectDir, trusted) {
  ensureRuntimeActive(state, 'trust')
  const dir = resolve(requireNonEmptyString(projectDir, 'dir'))
  if (typeof trusted !== 'boolean') {
    throw new ProjectRuntimeError(ERROR_CODE.INVALID_ARGUMENT, 'trusted must be a boolean', { field: 'trusted' })
  }
  try {
    await mutateTrustDocument(state, (document) => {
      if (trusted) {
        const existing = document.projects[dir]
        document.projects[dir] = {
          trustedAt: new Date().toISOString(),
          servers: isRecord(existing?.servers) ? { ...existing.servers } : {},
        }
      } else {
        delete document.projects[dir]
      }
      return document
    })
  } catch (error) {
    throw toWriteError(error)
  }
  const entries = [...state.sessions.values()].filter((entry) => entry.project.projectDir === dir)
  await Promise.allSettled(
    entries.map(async (entry) => {
      entry.trust = await readTrustDocument(state)
      entry.trusted = isProjectTrusted(entry.trust.document, dir)
      await reconcileMounts(state, entry)
    }),
  )
  return { dir, trusted }
}

/**
 * Persist one project server's enable intent and apply it to the session.
 * @param {object} state Runtime state.
 * @param {unknown} sessionId Session id.
 * @param {unknown} serverName Project server name.
 * @param {unknown} enabled Desired enabled state.
 * @returns {Promise<{ serverName: string, enabled: boolean }>} Stored state.
 */
async function toggleServer(state, sessionId, serverName, enabled) {
  ensureRuntimeActive(state, 'toggle')
  if (typeof enabled !== 'boolean') {
    throw new ProjectRuntimeError(ERROR_CODE.INVALID_ARGUMENT, 'enabled must be a boolean', { field: 'enabled' })
  }
  const name = requireNonEmptyString(serverName, 'serverName')
  const resolved = await resolveSession(state, sessionId)
  const entry = resolved.entry
  const project = entry?.project ?? discoverProjectFor(state, resolved.cwd)
  const projectDir = project.projectDir
  if (projectDir === null) {
    throw new ProjectRuntimeError(ERROR_CODE.NOT_FOUND, `session "${resolved.cwd}" has no project declarations`)
  }
  if (!project.servers.some((server) => server.name === name)) {
    throw new ProjectRuntimeError(
      ERROR_CODE.NOT_FOUND,
      `server "${name}" is not declared by project "${projectDir}"`,
      { field: 'serverName' },
    )
  }
  const currentTrust = await readTrustDocument(state)
  if (!isProjectTrusted(currentTrust.document, projectDir)) {
    throw new ProjectRuntimeError(
      ERROR_CODE.INVALID_ARGUMENT,
      `project "${projectDir}" is not trusted; trust it before toggling servers`,
      { field: 'trusted' },
    )
  }
  try {
    await mutateTrustDocument(state, (document) => {
      const projectEntry = document.projects[projectDir]
      if (projectEntry !== undefined) projectEntry.servers[name] = enabled
      return document
    })
  } catch (error) {
    throw toWriteError(error)
  }
  if (entry !== undefined) {
    entry.trust = await readTrustDocument(state)
    entry.trusted = true
    await reconcileMounts(state, entry)
  } else if (resolved.agent !== undefined) {
    const liveEntry = await ensureSessionEntry(state, sessionIdOf(resolved.agent), resolved.agent)
    await refreshSessionEntry(state, liveEntry)
    await reconcileMounts(state, liveEntry)
  }
  return { serverName: name, enabled }
}

/**
 * Re-read declarations and rebuild the session's mounts.
 * @param {object} state Runtime state.
 * @param {unknown} sessionId Session id.
 * @returns {Promise<object>} Fresh project view.
 */
async function reloadSession(state, sessionId) {
  ensureRuntimeActive(state, 'reload')
  const id = requireNonEmptyString(sessionId, 'sessionId')
  const resolved = await resolveSession(state, id)
  if (resolved.agent === undefined) {
    throw new ProjectRuntimeError(ERROR_CODE.NOT_FOUND, `session "${id}" is not live`)
  }
  const entry = await ensureSessionEntry(state, id, resolved.agent)
  await unmountAll(state, entry, state.budgetMs)
  await refreshSessionEntry(state, entry)
  await reconcileMounts(state, entry)
  return await viewSession(state, id)
}

// ---------------------------------------------------------------------------
// ProjectRuntime.dispose
// ---------------------------------------------------------------------------

/**
 * Stop listening, unmount every session instance, and mark the runtime closed.
 * Idempotent; the owning fiber also calls it on unload.
 * @param {object} state Runtime state.
 * @returns {Promise<void>} Resolves once teardown settled or the budget elapsed.
 */
async function disposeRuntime(state) {
  if (state.disposed) return
  state.disposed = true
  for (const disposeListener of state.listeners.splice(0)) {
    try {
      disposeListener()
    } catch (error) {
      logWarn(state, `project-runtime: listener cleanup failed: ${errorText(error)}`)
    }
  }
  const entries = [...state.sessions.values()]
  state.sessions.clear()
  const startedAt = Date.now()
  await Promise.allSettled(
    entries.map((entry) => unmountEntry(state, entry, remainingBudget(startedAt, state.budgetMs))),
  )
}

/**
 * Reject calls made after `dispose()`.
 * @param {object} state Runtime state.
 * @param {string} operation Operation name for the diagnostic.
 */
function ensureRuntimeActive(state, operation) {
  if (state.disposed) {
    throw new ProjectRuntimeError(ERROR_CODE.INVALID_ARGUMENT, `project runtime is disposed (${operation})`)
  }
}

// ---------------------------------------------------------------------------
// Trust store
// ---------------------------------------------------------------------------

/**
 * Empty trust document.
 * @returns {{ version: number, projects: Record<string, object> }} Trust document.
 */
function emptyTrustDocument() {
  return { version: TRUST_FILE_VERSION, projects: {} }
}

/**
 * Empty trust read result.
 * @returns {{ document: object, warnings: string[] }} Read result.
 */
function emptyTrustRead() {
  return { document: emptyTrustDocument(), warnings: [] }
}

/**
 * Read and normalize the trust file. A missing file is an empty store; a
 * corrupt file degrades to empty with a warning (never throws).
 * @param {object} state Runtime state.
 * @returns {Promise<{ document: object, warnings: string[] }>} Trust document + warnings.
 */
async function readTrustDocument(state) {
  let text
  try {
    text = await readFile(state.trustPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyTrustRead()
    return {
      document: emptyTrustDocument(),
      warnings: [`failed to read trust file ${state.trustPath}: ${errorText(error)}`],
    }
  }
  return parseTrustDocument(text)
}

/**
 * Parse one trust file body, tolerating unknown versions and malformed entries.
 * @param {string} text Raw JSON text.
 * @returns {{ document: object, warnings: string[] }} Trust document + warnings.
 */
function parseTrustDocument(text) {
  const warnings = []
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return {
      document: emptyTrustDocument(),
      warnings: [`trust file is not valid JSON (${errorText(error)}); treating every project as untrusted`],
    }
  }
  if (!isRecord(raw)) {
    return {
      document: emptyTrustDocument(),
      warnings: ['trust file root is not an object; treating every project as untrusted'],
    }
  }
  if (raw.version !== TRUST_FILE_VERSION) {
    warnings.push(`trust file version ${JSON.stringify(raw.version)} is not ${TRUST_FILE_VERSION}; reading known fields only`)
  }
  const projects = {}
  if (isRecord(raw.projects)) {
    for (const [dir, value] of Object.entries(raw.projects)) {
      if (!isNonEmptyString(dir) || !isRecord(value)) {
        warnings.push(`ignoring malformed trust entry for ${JSON.stringify(dir)}`)
        continue
      }
      const servers = {}
      if (isRecord(value.servers)) {
        for (const [name, enabled] of Object.entries(value.servers)) {
          if (typeof enabled === 'boolean') servers[name] = enabled
        }
      }
      projects[dir] = {
        trustedAt: typeof value.trustedAt === 'string' ? value.trustedAt : null,
        servers,
      }
    }
  } else if (raw.projects !== undefined) {
    warnings.push('trust file "projects" is not an object; treating every project as untrusted')
  }
  return { document: { version: TRUST_FILE_VERSION, projects }, warnings }
}

/**
 * Apply one mutation to the trust document under the cross-process writer lock.
 * @param {object} state Runtime state.
 * @param {(document: object) => object | undefined} mutator Document mutation.
 * @returns {Promise<object>} Written document.
 */
async function mutateTrustDocument(state, mutator) {
  await mkdir(dirname(state.trustPath), { recursive: true, mode: TRUST_DIR_MODE })
  return await withFileLock(
    state.trustPath,
    async () => {
      const current = await readTrustDocument(state)
      const document = cloneTrustDocument(current.document)
      const next = mutator(document) ?? document
      const text = `${JSON.stringify(next, null, 2)}\n`
      await writeFileAtomic(state.trustPath, text, { mode: TRUST_FILE_MODE, dirMode: TRUST_DIR_MODE })
      return next
    },
    { waitMs: state.lockWaitMs },
  )
}

/**
 * Deep-enough copy of a trust document for safe mutation.
 * @param {object} document Trust document.
 * @returns {object} Copied document.
 */
function cloneTrustDocument(document) {
  const projects = {}
  for (const [dir, entry] of Object.entries(document.projects)) {
    projects[dir] = { trustedAt: entry.trustedAt ?? null, servers: { ...entry.servers } }
  }
  return { version: TRUST_FILE_VERSION, projects }
}

/**
 * Normalize one project directory for trust lookups/storage.
 * @param {string | null} projectDir Project directory.
 * @returns {string | null} Resolved key, or null.
 */
function trustKeyOf(projectDir) {
  return isNonEmptyString(projectDir) ? resolve(projectDir) : null
}

/**
 * Whether one project directory is trusted.
 * @param {object} document Trust document.
 * @param {string | null} projectDir Project directory.
 * @returns {boolean} Trust state.
 */
function isProjectTrusted(document, projectDir) {
  const key = trustKeyOf(projectDir)
  if (key === null) return false
  return Object.prototype.hasOwnProperty.call(document.projects, key)
}

/**
 * Whether one server is enabled in the trust store (absent = enabled).
 * @param {object} document Trust document.
 * @param {string | null} projectDir Project directory.
 * @param {string} serverName Server name.
 * @returns {boolean} Per-server enable intent.
 */
function isServerTrustEnabled(document, projectDir, serverName) {
  const key = trustKeyOf(projectDir)
  if (key === null) return true
  const entry = document.projects[key]
  if (entry === undefined) return true
  return entry.servers[serverName] !== false
}

/**
 * Convert a trust-store write failure into the Host API `WRITE_FAILED` code.
 * @param {unknown} error Thrown value.
 * @returns {ProjectRuntimeError} Wire error.
 */
function toWriteError(error) {
  if (error instanceof ProjectRuntimeError) return error
  return new ProjectRuntimeError(ERROR_CODE.WRITE_FAILED, `failed to write trust file: ${errorText(error)}`)
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/**
 * Read the tool registry's schemas defensively.
 *
 * Project mounts register on the Agent scope, so the page-visible tool list is
 * `ctx.tools.schemas(agent)`; an unscoped call would only see the global plane.
 * The Agent is omitted for read-only sessions without a live agent.
 * @param {object} ctx Profile Cordis context.
 * @param {object} [agent] Viewing Agent (tool scope).
 * @returns {string[]} Registered tool names.
 */
function toolNamesOf(ctx, agent) {
  let schemas
  try {
    schemas = agent !== undefined && agent !== null ? ctx.tools?.schemas?.(agent) : ctx.tools?.schemas?.()
  } catch {
    return []
  }
  if (!Array.isArray(schemas)) return []
  const names = []
  for (const schema of schemas) {
    if (typeof schema === 'string') names.push(schema)
    else if (isRecord(schema) && typeof schema.name === 'string') names.push(schema.name)
  }
  return names
}

/**
 * Resolve the global server names used for the `overridesGlobal` flag.
 * @param {object} state Runtime state.
 * @param {unknown} extraValue Per-call override.
 * @returns {Promise<Set<string>>} Global server names.
 */
async function resolveGlobalNames(state, extraValue) {
  const source = extraValue !== undefined ? extraValue : state.options.globalServerNames
  try {
    const value = typeof source === 'function' ? await source() : source
    return normalizeNameSet(value)
  } catch (error) {
    logWarn(state, `project-runtime: could not resolve global server names: ${errorText(error)}`)
    return new Set()
  }
}

/**
 * Normalize a name collection into a Set.
 * @param {unknown} value Names.
 * @returns {Set<string>} Normalized names.
 */
function normalizeNameSet(value) {
  const names = new Set()
  if (value === undefined || value === null) return names
  const iterate = value instanceof Set ? [...value] : Array.isArray(value) ? value : [value]
  for (const name of iterate) {
    if (isNonEmptyString(name)) names.add(name)
  }
  return names
}

// ---------------------------------------------------------------------------
// Scheduling helpers
// ---------------------------------------------------------------------------

/**
 * Wait for tasks to settle, but never longer than `budgetMs`.
 * @param {Array<Promise<unknown>>} tasks Tasks (their rejections are handled by allSettled).
 * @param {number} budgetMs Maximum wait.
 * @returns {Promise<boolean>} True when everything settled in time.
 */
async function settleWithinBudget(tasks, budgetMs) {
  if (tasks.length === 0) return true
  const settled = Promise.allSettled(tasks).then(() => true)
  const timeoutMs = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0
  let timer
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([settled, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Remaining slice of a total budget.
 * @param {number} startedAt Date.now() at the start of the operation.
 * @param {number} totalBudget Total budget in milliseconds.
 * @returns {number} Remaining budget (never negative).
 */
function remainingBudget(startedAt, totalBudget) {
  return Math.max(0, totalBudget - (Date.now() - startedAt))
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/**
 * Read one optional Cordis service.
 *
 * `ctx.get(name)` resolves a provisioned service without requiring it in the
 * plugin's `inject` list (a plain `ctx.<name>` property read would throw
 * "cannot get property without inject" inside a plugin fiber). The property
 * fallback keeps plain test contexts working.
 * @param {object} state Runtime state.
 * @param {string} name Service name.
 * @returns {unknown} Service instance, or undefined.
 */
function serviceOf(state, name) {
  const ctx = state.ctx
  if (typeof ctx.get === 'function') {
    try {
      const service = ctx.get(name)
      if (service !== undefined && service !== null) return service
    } catch {
      // Fall through to property access.
    }
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * Session id of one Agent (Agent id and Session id are the same contract).
 * @param {object | undefined} agent Agent.
 * @returns {string} Session id, or '' when unavailable.
 */
function sessionIdOf(agent) {
  if (agent === undefined || agent === null) return ''
  if (typeof agent.id === 'string' && agent.id.length > 0) return agent.id
  const sessionId = agent.session?.id
  return typeof sessionId === 'string' ? sessionId : ''
}

/**
 * Validate a non-empty string argument.
 * @param {unknown} value Candidate value.
 * @param {string} field Field name for the error.
 * @returns {string} The value.
 */
function requireNonEmptyString(value, field) {
  if (!isNonEmptyString(value)) {
    throw new ProjectRuntimeError(ERROR_CODE.INVALID_ARGUMENT, `${field} must be a non-empty string`, { field })
  }
  return value
}

/**
 * Whether a value is a non-empty string.
 * @param {unknown} value Candidate value.
 * @returns {boolean} True for non-empty strings.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * Whether a value is a plain record.
 * @param {unknown} value Candidate value.
 * @returns {boolean} True for non-array objects.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Format arbitrary thrown values for logs.
 * @param {unknown} error Thrown value.
 * @returns {string} Message.
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Truncate an error message to the wire limit (300 characters).
 * @param {unknown} error Thrown value.
 * @returns {string} Truncated message.
 */
function truncateError(error) {
  const message = errorText(error)
  return message.length > 300 ? `${message.slice(0, 297)}...` : message
}

/**
 * Deduplicate warning strings while keeping their first-seen order.
 * @param {string[]} messages Warnings.
 * @returns {string[]} Deduplicated warnings.
 */
function uniqueMessages(messages) {
  const seen = new Set()
  const unique = []
  for (const message of messages) {
    if (typeof message !== 'string' || seen.has(message)) continue
    seen.add(message)
    unique.push(message)
  }
  return unique
}

/**
 * Warn through the Cordis logger without letting a logger failure break the runtime.
 * @param {object} state Runtime state.
 * @param {string} message Warning text.
 */
function logWarn(state, message) {
  try {
    state.ctx.logger?.warn?.(message)
  } catch {
    // Logging must never break the lifecycle.
  }
}
