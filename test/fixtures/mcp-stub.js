/**
 * Fake `@deepseek-ai/dsh-mcp-client` used by `test/project-host.test.js`.
 *
 * The test harness (not this file) provides the fake Cordis plugin context:
 *  - `ctx.tools.register({ name })` → disposer that removes the tool name;
 *  - `ctx.effect(() => disposer)` → Cordis-like effect registration (throws
 *    when the fiber was already disposed, mirroring the real context).
 *
 * Behaviour is controlled per server through the mutable `controls` object so
 * one suite can simulate slow starts, failures, and tool registration without
 * spawning real MCP servers.
 */

/** Plugin name (does not matter for the fake harness). */
export const name = 'mcp-stub'

/** This stub needs no services. */
export const inject = []

/** Mutable behaviour controls; reset through `resetControls()` per harness. */
export const controls = {
  /** Delay applied to every server without a specific delay. */
  defaultDelayMs: 0,
  /** serverName → startup delay in milliseconds. */
  delayByServer: new Map(),
  /** serverName → failure message (startup rejection). */
  failByServer: new Map(),
  /** When set, every server fails with this message. */
  failAll: null,
  /** Every `apply` call, in invocation order: `{ serverName, config, at }`. */
  calls: [],
  /** Number of successful tool-effect teardowns (mount disposal observed). */
  disposed: 0,
}

/** Public tool name used by the stub for a server. */
export function toolNameFor(serverName) {
  return `mcp__${serverName}__ping`
}

/** Reset all behaviour controls and call records. */
export function resetControls() {
  controls.defaultDelayMs = 0
  controls.delayByServer.clear()
  controls.failByServer.clear()
  controls.failAll = null
  controls.calls.length = 0
  controls.disposed = 0
}

/** Calls recorded for one server name. */
export function callsFor(serverName) {
  return controls.calls.filter((call) => call.serverName === serverName)
}

/**
 * Cordis plugin body: record the call, wait, maybe fail, then publish one tool.
 * @param {object} ctx Fake Cordis plugin context.
 * @param {object} config mcp-client config built by project-host.
 */
export async function apply(ctx, config) {
  controls.calls.push({
    serverName: config.serverName,
    config: cloneConfig(config),
    at: Date.now(),
  })
  const delay = Math.max(0, controls.delayByServer.get(config.serverName) ?? controls.defaultDelayMs)
  if (delay > 0) await sleep(delay)
  const failure = controls.failByServer.get(config.serverName) ?? controls.failAll
  if (failure) {
    throw new Error(typeof failure === 'string' ? failure : `stub mcp-client failed for ${config.serverName}`)
  }
  ctx.effect(() => {
    const unregister = ctx.tools.register({ name: toolNameFor(config.serverName) })
    return () => {
      controls.disposed += 1
      unregister?.()
    }
  }, 'mcp-stub.tools')
}

/** Structured clone of a plain config object. */
function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config))
}

/** Promise-based sleep. */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
