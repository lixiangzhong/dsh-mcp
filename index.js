/**
 * Host half of @lixiangzhong/dsh-mcp.
 *
 * The Host owns the only write path to the active profile's `cordis.patch.yml`
 * and projects MCP row status for the Settings page. It also hosts the
 * project-scoped MCP runtime (per-session mounts of project declarations).
 * The browser half only renders; every mutation goes through the routes
 * registered by the Host service.
 */
import { applyMcpManager } from './lib/host-service.js'
import { applyProjectRuntime } from './lib/project-host.js'

export const inject = ['loader', 'profileContext', 'tools', 'webServer', 'connection']

/**
 * Resolve the shipped MCP client module for project-scoped mounts. A failure
 * stays local: the project runtime reports it per mount while the global part
 * of the plugin keeps working.
 * @param {object} ctx Cordis context.
 * @returns {Promise<object | undefined>} Plugin namespace, or undefined.
 */
async function loadMcpClient(ctx) {
  try {
    return await import('@deepseek-ai/dsh-mcp-client')
  } catch (error) {
    ctx.logger?.warn?.(`dsh-mcp: @deepseek-ai/dsh-mcp-client is unavailable: ${String(error)}`)
    return undefined
  }
}

export async function apply(ctx, config) {
  const mcpClient = await loadMcpClient(ctx)
  const projectRuntime = applyProjectRuntime(ctx, mcpClient === undefined ? {} : { mcpClient })
  ctx.effect(() => () => projectRuntime.dispose(), 'dsh-mcp: project runtime')
  applyMcpManager(ctx, config, projectRuntime)
}
