/**
 * test/project-host.test.js — P1 项目级 MCP Host 生命周期测试
 *
 * 覆盖契约 docs/contracts/project-internals.md §2：
 * 信任过滤、per-server 开关、文件 enabled=false、并行挂载与 2s 预算（超时后
 * 后台继续）、启动失败不抛、cwd 跟随、agent/dispose 清理、trust.json 原子读写
 * 与损坏降级、绝不写项目文件。
 *
 * 运行：node --test test/project-host.test.js
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  applyProjectRuntime,
  ProjectRuntimeError,
  STARTUP_BUDGET_MS,
  TRUST_FILE_VERSION,
} from '../lib/project-host.js'
import * as mcpStub from './fixtures/mcp-stub.js'

/** Cordis fiber states (mirror of @deepseek-ai/cordis FiberState). */
const FIBER_STATE = Object.freeze({
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
})

/* ============================== 假 Cordis 运行时 ============================== */

/**
 * Minimal Cordis context + Agent/Session/tools/workingDirectory services and a
 * `ctx.plugin()` fake that mounts one plugin per call with a Fiber-like handle.
 */
function createMockContext() {
  const listeners = new Map()
  const toolNames = new Set()
  const agents = new Map()
  const sessions = new Map()
  const cwdBySession = new Map()
  const warnings = []
  const effects = []
  const schemasScopes = []

  const ctx = {
    logger: {
      warn(message) {
        warnings.push(String(message))
      },
    },
    tools: {
      schemas(scope) {
        schemasScopes.push(scope)
        return [...toolNames].map((name) => ({ name }))
      },
    },
    agents: {
      list() {
        return [...agents.values()]
      },
      get(id) {
        return agents.get(id)
      },
    },
    sessions: {
      get(id) {
        return sessions.get(id)
      },
    },
    workingDirectory: {
      defaultDirectory: join(tmpdir(), 'dsh-mcp-default-directory'),
      get(session) {
        return cwdBySession.get(session?.id) ?? session?.header?.cwd
      },
    },
    on(event, listener) {
      let set = listeners.get(event)
      if (set === undefined) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
        return true
      }
    },
    effect(execute) {
      const disposer = execute()
      effects.push(disposer)
      return async () => {
        if (typeof disposer === 'function') await disposer()
      }
    },
  }

  /** Mount one plugin through a fake agent context (Fiber-like handle). */
  function mountPlugin(plugin, config) {
    const disposers = []
    const fiber = {
      state: FIBER_STATE.PENDING,
      await: undefined,
      dispose: undefined,
    }
    const pluginCtx = {
      tools: {
        register(definition) {
          const toolName = typeof definition === 'string' ? definition : definition?.name
          toolNames.add(toolName)
          return () => toolNames.delete(toolName)
        },
      },
      effect(execute) {
        if (fiber.state === FIBER_STATE.DISPOSED) {
          throw new Error('cannot create effect on inactive context')
        }
        const disposer = execute()
        if (typeof disposer === 'function') disposers.push(disposer)
        return async () => {}
      },
      on() {
        return () => {}
      },
    }
    const startup = (async () => {
      fiber.state = FIBER_STATE.LOADING
      try {
        await plugin.apply(pluginCtx, config)
        if (fiber.state !== FIBER_STATE.DISPOSED) fiber.state = FIBER_STATE.ACTIVE
      } catch (error) {
        fiber.state = FIBER_STATE.FAILED
        throw error
      }
    })()
    // The real Cordis fiber is thenable and rejects on startup errors; consumers
    // await `fiber.await()`. Silence the mirrored rejection until then.
    startup.catch(() => {})
    fiber.await = () => startup
    fiber.dispose = async () => {
      if (fiber.state === FIBER_STATE.DISPOSED) return
      fiber.state = FIBER_STATE.DISPOSED
      for (const disposer of disposers.reverse()) {
        try {
          disposer()
        } catch {
          // Cleanup failures are irrelevant in the fake runtime.
        }
      }
    }
    return fiber
  }

  /** Register one live Agent plus its Session and current cwd. */
  function addAgent({ id, cwd }) {
    const agent = {
      id,
      session: { id, header: { cwd } },
      ctx: { plugin: (plugin, config) => mountPlugin(plugin, config) },
    }
    agents.set(id, agent)
    sessions.set(id, agent.session)
    cwdBySession.set(id, cwd)
    return agent
  }

  /** Register a Session without a live Agent (e.g. resumed/closed session). */
  function addSession({ id, cwd }) {
    const session = { id, header: { cwd } }
    sessions.set(id, session)
    cwdBySession.set(id, cwd)
    return session
  }

  /** Remove an Agent and its Session from the fake registries. */
  function removeSession(id) {
    agents.delete(id)
    sessions.delete(id)
    cwdBySession.delete(id)
  }

  /** Change the current working directory of a session. */
  function setCwd(id, cwd) {
    cwdBySession.set(id, cwd)
  }

  /** Serial dispatch (agent/created / agent/disposed). */
  async function emitSerial(event, payload) {
    const set = listeners.get(event)
    if (set === undefined) return
    for (const listener of [...set]) await listener(payload)
  }

  /** Waterfall dispatch (agent/pre-step), like Cordis should. */
  async function emitPreStep(agent) {
    const chain = [...(listeners.get('agent/pre-step') ?? [])]
    let index = -1
    const next = () => {
      index += 1
      if (index >= chain.length) return { kind: 'continue' }
      return chain[index]({ agent, messages: [], step: 1 }, next)
    }
    return await next()
  }

  return {
    ctx,
    addAgent,
    addSession,
    removeSession,
    setCwd,
    emitAgentCreated: (agent) => emitSerial('agent/created', { agent }),
    emitAgentDisposed: (agent) => emitSerial('agent/disposed', { agent }),
    emitPreStep,
    toolNames: () => [...toolNames],
    hasTool: (name) => toolNames.has(name),
    warnings,
    effects,
    schemasScopes,
  }
}

/* ============================== 临时目录 / 项目 fixture ============================== */

/** Build one harness: temp root + trust path + mock ctx + installed runtime. */
function createHarness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-project-host-'))
  const trustPath = join(root, 'home', 'dsh-mcp', 'trust.json')
  mcpStub.resetControls()
  const mock = createMockContext()
  const runtime = applyProjectRuntime(mock.ctx, {
    mcpClient: mcpStub,
    trustPath,
    env: {
      ...process.env,
      PROJECT_TOKEN: 'expanded-token',
      MCP_URL: 'http://127.0.0.1:5225',
      FIXTURE_ARG: 'from-env',
    },
    ...options,
  })
  return {
    root,
    trustPath,
    mock,
    runtime,
    async close() {
      try {
        await runtime.dispose()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

/** Run a test body against one harness and always clean up. */
async function withHarness(options, body) {
  const harness = createHarness(options)
  try {
    await body(harness)
  } finally {
    await harness.close()
  }
}

/** Create a project directory under the harness root. */
function projectDir(harness, name) {
  const dir = join(harness.root, 'projects', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Write a Claude-style `.mcp.json` declaration. */
function writeClaudeProject(dir, servers) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.mcp.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
}

/** Write a Codex-style `.codex/config.toml` declaration. */
function writeCodexProject(dir, text) {
  mkdirSync(join(dir, '.codex'), { recursive: true })
  writeFileSync(join(dir, '.codex', 'config.toml'), text)
}

/** Build a trust document. */
function trustDocument(projects) {
  return { version: TRUST_FILE_VERSION, projects }
}

/** Build one trusted-project entry. */
function trustEntry(servers = {}) {
  return { trustedAt: '2026-11-05T00:00:00.000Z', servers }
}

/** Write the trust file directly (simulates a previous trust decision). */
function writeTrustFile(trustPath, document) {
  mkdirSync(dirname(trustPath), { recursive: true })
  writeFileSync(trustPath, `${JSON.stringify(document, null, 2)}\n`)
}

/** Read and parse the trust file. */
function readTrustFile(trustPath) {
  return JSON.parse(readFileSync(trustPath, 'utf8'))
}

/** Mark one project trusted in the trust file. */
function trustProject(harness, dir, servers = {}) {
  writeTrustFile(harness.trustPath, trustDocument({ [dir]: trustEntry(servers) }))
}


/**
 * Turn the mock into a strict Cordis-like context: service properties throw
 * "cannot get property without inject" (real Cordis behavior for services not
 * declared in the plugin's inject list), while `ctx.get(name)` keeps working.
 */
function makeStrictContext(mock) {
  const services = {
    agents: mock.ctx.agents,
    sessions: mock.ctx.sessions,
    workingDirectory: mock.ctx.workingDirectory,
  }
  for (const name of Object.keys(services)) {
    Object.defineProperty(mock.ctx, name, {
      configurable: true,
      get() {
        throw new Error(`cannot get property "${name}" without inject`)
      },
    })
  }
  mock.ctx.get = (name) => services[name]
}

/** Wait until `predicate` is truthy (test-side polling). */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await sleep(5)
  }
}

/** Promise-based sleep. */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

// ---------------------------------------------------------------------------
// 信任过滤
// ---------------------------------------------------------------------------

test('未信任项目：agent/created 不启动任何 server，view 标记 untrusted', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'untrusted')
    writeClaudeProject(dir, {
      alpha: { command: 'node', args: ['alpha.js'] },
      beta: { command: 'node', args: ['beta.js'] },
    })
    const agent = harness.mock.addAgent({ id: 's-untrusted', cwd: dir })
    await harness.mock.emitAgentCreated(agent)

    assert.equal(mcpStub.controls.calls.length, 0, 'no server may start before trust')
    const view = await harness.runtime.view('s-untrusted')
    assert.equal(view.trusted, false)
    assert.equal(view.projectDir, dir)
    assert.equal(view.files.length, 1)
    assert.deepEqual(
      view.servers.map((server) => server.name),
      ['alpha', 'beta'],
    )
    for (const server of view.servers) {
      assert.equal(server.status, 'stopped')
      assert.equal(server.active, false)
      assert.equal(server.fileEnabled, true)
    }
    assert.deepEqual(await harness.runtime.badge('s-untrusted'), { relevant: true, badge: 'untrusted' })
    assert.equal(harness.mock.toolNames().length, 0)
  })
})

test('无项目声明：view 为空、badge 不相关', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'plain')
    const agent = harness.mock.addAgent({ id: 's-plain', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    const view = await harness.runtime.view('s-plain')
    assert.equal(view.projectDir, null)
    assert.deepEqual(view.files, [])
    assert.deepEqual(view.servers, [])
    assert.deepEqual(await harness.runtime.badge('s-plain'), { relevant: false, badge: null })
  })
})

test('已信任项目：并行挂载全部启用 server 并映射 mcp-client config', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'trusted')
    writeClaudeProject(dir, {
      alpha: {
        command: 'node',
        args: ['alpha.js'],
        env: { TOKEN: '${PROJECT_TOKEN}', MODE: 'test' },
      },
      beta: { command: 'node', args: ['${FIXTURE_ARG}.js'] },
    })
    trustProject(harness, dir)
    const agent = harness.mock.addAgent({ id: 's-trusted', cwd: dir })
    const startedAt = Date.now()
    await harness.mock.emitAgentCreated(agent)
    assert.ok(Date.now() - startedAt < STARTUP_BUDGET_MS + 500)

    assert.equal(mcpStub.controls.calls.length, 2, 'both servers start in parallel')
    assert.deepEqual(
      mcpStub.controls.calls.map((call) => call.serverName).sort(),
      ['alpha', 'beta'],
    )
    const alpha = mcpStub.callsFor('alpha')[0]
    assert.equal(alpha.config.serverName, 'alpha')
    assert.equal(alpha.config.transport, 'stdio')
    assert.equal(alpha.config.command, 'node')
    assert.deepEqual(alpha.config.args, ['alpha.js'])
    assert.equal(alpha.config.env.TOKEN, 'expanded-token')
    assert.equal(alpha.config.env.MODE, 'test')
    assert.equal(alpha.config.failOnStartupError, false)
    const beta = mcpStub.callsFor('beta')[0]
    assert.deepEqual(beta.config.args, ['from-env.js'])
    assert.equal(beta.config.failOnStartupError, false)

    const view = await harness.runtime.view('s-trusted')
    assert.equal(view.trusted, true)
    assert.equal(view.projectDir, dir)
    for (const server of view.servers) {
      assert.equal(server.status, 'connected')
      assert.equal(server.active, true)
      assert.equal(server.lastError, null)
    }
    assert.deepEqual(await harness.runtime.badge('s-trusted'), { relevant: true, badge: null })
    assert.deepEqual(
      harness.mock.toolNames().sort(),
      ['mcp__alpha__ping', 'mcp__beta__ping'],
    )
    // Status probing must query the tool registry through the Agent scope;
    // an unscoped call only sees the global plane.
    assert.ok(
      harness.mock.schemasScopes.some((scope) => scope?.id === 's-trusted'),
      'view must query tools with the live Agent as scope',
    )
  })
})

test('http 声明：transport/url/headers 语义映射与变量展开', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'http')
    writeClaudeProject(dir, {
      remote: {
        type: 'http',
        url: '${MCP_URL}/mcp',
        headers: { Authorization: 'Bearer ${PROJECT_TOKEN}' },
      },
    })
    trustProject(harness, dir)
    const agent = harness.mock.addAgent({ id: 's-http', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    const call = mcpStub.callsFor('remote')[0]
    assert.equal(call.config.transport, 'streamable-http')
    assert.equal(call.config.url, 'http://127.0.0.1:5225/mcp')
    assert.deepEqual(call.config.headers, { Authorization: 'Bearer expanded-token' })
    const view = await harness.runtime.view('s-http')
    assert.equal(view.servers[0].status, 'connected')
  })
})

test('文件 enabled=false（Codex）：不挂载但保留在视图里', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'codex-enabled')
    writeCodexProject(
      dir,
      [
        '[mcp_servers.disabled-one]',
        'command = "node"',
        'enabled = false',
        '',
        '[mcp_servers.enabled-one]',
        'command = "node"',
        'args = ["one.js"]',
        'tool_timeout_sec = 90',
        '',
      ].join('\n'),
    )
    trustProject(harness, dir)
    const agent = harness.mock.addAgent({ id: 's-codex', cwd: dir })
    await harness.mock.emitAgentCreated(agent)

    assert.deepEqual(
      mcpStub.controls.calls.map((call) => call.serverName),
      ['enabled-one'],
    )
    assert.equal(mcpStub.callsFor('enabled-one')[0].config.toolCallTimeoutMs, 90000)
    const view = await harness.runtime.view('s-codex')
    const disabled = view.servers.find((server) => server.name === 'disabled-one')
    const enabled = view.servers.find((server) => server.name === 'enabled-one')
    assert.equal(disabled.fileEnabled, false)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.status, 'stopped')
    assert.equal(enabled.fileEnabled, true)
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.status, 'connected')
  })
})

test('trust per-server=false：不挂载，toggle 后立即挂载/卸载并持久化', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'per-server')
    writeClaudeProject(dir, {
      alpha: { command: 'node', args: ['alpha.js'] },
      beta: { command: 'node', args: ['beta.js'] },
    })
    trustProject(harness, dir, { alpha: false })
    const agent = harness.mock.addAgent({ id: 's-toggle', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    assert.deepEqual(
      mcpStub.controls.calls.map((call) => call.serverName),
      ['beta'],
    )
    let view = await harness.runtime.view('s-toggle')
    let alpha = view.servers.find((server) => server.name === 'alpha')
    assert.equal(alpha.trustEnabled, false)
    assert.equal(alpha.enabled, false)
    assert.equal(alpha.status, 'stopped')

    await harness.runtime.toggle('s-toggle', 'alpha', true)
    assert.equal(mcpStub.callsFor('alpha').length, 1)
    assert.equal(harness.mock.hasTool('mcp__alpha__ping'), true)
    assert.equal(readTrustFile(harness.trustPath).projects[dir].servers.alpha, true)
    view = await harness.runtime.view('s-toggle')
    alpha = view.servers.find((server) => server.name === 'alpha')
    assert.equal(alpha.status, 'connected')
    assert.equal(alpha.active, true)

    await harness.runtime.toggle('s-toggle', 'alpha', false)
    assert.equal(harness.mock.hasTool('mcp__alpha__ping'), false)
    assert.equal(readTrustFile(harness.trustPath).projects[dir].servers.alpha, false)
    view = await harness.runtime.view('s-toggle')
    assert.equal(view.servers.find((server) => server.name === 'alpha').status, 'stopped')
  })
})

test('toggle 文件 enabled=false 的 server：只持久化意愿，不挂载', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'toggle-file-disabled')
    writeCodexProject(
      dir,
      ['[mcp_servers.off]', 'command = "node"', 'enabled = false', ''].join('\n'),
    )
    trustProject(harness, dir, { off: false })
    const agent = harness.mock.addAgent({ id: 's-off', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    await harness.runtime.toggle('s-off', 'off', true)
    assert.equal(mcpStub.callsFor('off').length, 0)
    assert.equal(readTrustFile(harness.trustPath).projects[dir].servers.off, true)
    const view = await harness.runtime.view('s-off')
    const off = view.servers.find((server) => server.name === 'off')
    assert.equal(off.trustEnabled, true)
    assert.equal(off.fileEnabled, false)
    assert.equal(off.status, 'stopped')
  })
})

// ---------------------------------------------------------------------------
// 启动预算 / 并行 / 失败降级
// ---------------------------------------------------------------------------

test('启动预算：超时先返回、挂载后台继续；默认预算常量 2000ms', async () => {
  assert.equal(STARTUP_BUDGET_MS, 2000)
  await withHarness({ budgetMs: 40 }, async (harness) => {
    const dir = projectDir(harness, 'budget')
    writeClaudeProject(dir, {
      slow: { command: 'node', args: ['slow.js'] },
    })
    trustProject(harness, dir)
    mcpStub.controls.delayByServer.set('slow', 120)
    const agent = harness.mock.addAgent({ id: 's-budget', cwd: dir })
    const startedAt = Date.now()
    await harness.mock.emitAgentCreated(agent)
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 115, `agent/created must respect the startup budget (took ${elapsed}ms)`)
    assert.equal(mcpStub.controls.calls.length, 1, 'the slow mount keeps running in background')
    let view = await harness.runtime.view('s-budget')
    assert.equal(view.servers[0].status, 'starting')
    await waitFor(async () => (await harness.runtime.view('s-budget')).servers[0].status === 'connected')
    view = await harness.runtime.view('s-budget')
    assert.equal(view.servers[0].status, 'connected')
    assert.deepEqual(await harness.runtime.badge('s-budget'), { relevant: true, badge: null })
  })
})

test('预算超时后的后台失败：随后投影为 failed 且 badge 变 failed', async () => {
  await withHarness({ budgetMs: 20 }, async (harness) => {
    const dir = projectDir(harness, 'budget-fail')
    writeClaudeProject(dir, { late: { command: 'node', args: ['late.js'] } })
    trustProject(harness, dir)
    mcpStub.controls.delayByServer.set('late', 60)
    mcpStub.controls.failByServer.set('late', 'late failure')
    const agent = harness.mock.addAgent({ id: 's-budget-fail', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    let view = await harness.runtime.view('s-budget-fail')
    assert.equal(view.servers[0].status, 'starting')
    await waitFor(async () => (await harness.runtime.view('s-budget-fail')).servers[0].status === 'failed')
    view = await harness.runtime.view('s-budget-fail')
    assert.equal(view.servers[0].lastError, 'late failure')
    assert.deepEqual(await harness.runtime.badge('s-budget-fail'), { relevant: true, badge: 'failed' })
  })
})

test('启动失败：不抛入 agent 生命周期，记录 failed/lastError，badge=failed', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'failing')
    writeClaudeProject(dir, {
      broken: { command: 'node', args: ['broken.js'] },
    })
    trustProject(harness, dir)
    mcpStub.controls.failByServer.set('broken', `boom ${'x'.repeat(500)}`)
    const agent = harness.mock.addAgent({ id: 's-fail', cwd: dir })
    await harness.mock.emitAgentCreated(agent)

    const view = await harness.runtime.view('s-fail')
    const server = view.servers[0]
    assert.equal(server.status, 'failed')
    assert.equal(server.active, false)
    assert.ok(server.lastError.startsWith('boom'), 'lastError should carry the rejection message')
    assert.ok(server.lastError.length <= 300, 'lastError must be truncated to 300 characters')
    assert.deepEqual(await harness.runtime.badge('s-fail'), { relevant: true, badge: 'failed' })
    assert.ok(harness.mock.warnings.some((line) => line.includes('failed to start')))
  })
})

test('坏 .mcp.json / 坏 TOML：不阻塞会话，warnings 呈现', async () => {
  await withHarness({}, async (harness) => {
    const jsonDir = projectDir(harness, 'broken-json')
    writeClaudeProject(jsonDir, {})
    writeFileSync(join(jsonDir, '.mcp.json'), '{ "mcpServers": { "oops": ')
    trustProject(harness, jsonDir)
    const jsonAgent = harness.mock.addAgent({ id: 's-broken-json', cwd: jsonDir })
    await harness.mock.emitAgentCreated(jsonAgent)
    const jsonView = await harness.runtime.view('s-broken-json')
    assert.deepEqual(jsonView.servers, [])
    assert.ok(jsonView.warnings.length > 0)
    assert.deepEqual(await harness.runtime.badge('s-broken-json'), { relevant: true, badge: null })

    const tomlDir = projectDir(harness, 'broken-toml')
    writeCodexProject(tomlDir, '[mcp_servers.oops\ncommand = ')
    trustProject(harness, tomlDir)
    const tomlAgent = harness.mock.addAgent({ id: 's-broken-toml', cwd: tomlDir })
    await harness.mock.emitAgentCreated(tomlAgent)
    const tomlView = await harness.runtime.view('s-broken-toml')
    assert.deepEqual(tomlView.servers, [])
    assert.ok(tomlView.warnings.length > 0)
  })
})

// ---------------------------------------------------------------------------
// cwd 跟随
// ---------------------------------------------------------------------------

test('cwd 切换：下一步前卸旧挂新；同目录 no-op；切回恢复', async () => {
  await withHarness({}, async (harness) => {
    const dirA = projectDir(harness, 'cwd-a')
    const dirB = projectDir(harness, 'cwd-b')
    writeClaudeProject(dirA, { alpha: { command: 'node', args: ['a.js'] } })
    writeClaudeProject(dirB, { beta: { command: 'node', args: ['b.js'] } })
    writeTrustFile(
      harness.trustPath,
      trustDocument({ [dirA]: trustEntry(), [dirB]: trustEntry() }),
    )
    const agent = harness.mock.addAgent({ id: 's-cwd', cwd: dirA })
    await harness.mock.emitAgentCreated(agent)
    assert.deepEqual(harness.mock.toolNames(), ['mcp__alpha__ping'])

    harness.mock.setCwd('s-cwd', dirB)
    await harness.mock.emitPreStep(agent)
    assert.deepEqual(harness.mock.toolNames(), ['mcp__beta__ping'])
    let view = await harness.runtime.view('s-cwd')
    assert.equal(view.cwd, dirB)
    assert.equal(view.projectDir, dirB)
    assert.equal(mcpStub.callsFor('beta').length, 1)
    assert.equal(mcpStub.callsFor('alpha').length, 1, 'old project server was not restarted')

    // Same directory again: no remount, no extra apply calls.
    await harness.mock.emitPreStep(agent)
    assert.equal(mcpStub.controls.calls.length, 2)

    // Switching back re-mounts A and unmounts B.
    harness.mock.setCwd('s-cwd', dirA)
    await harness.mock.emitPreStep(agent)
    assert.deepEqual(harness.mock.toolNames(), ['mcp__alpha__ping'])
    assert.equal(mcpStub.callsFor('alpha').length, 2)
    view = await harness.runtime.view('s-cwd')
    assert.equal(view.projectDir, dirA)
  })
})

test('cwd 切到未信任项目：卸载旧挂载且不启动新 server', async () => {
  await withHarness({}, async (harness) => {
    const dirA = projectDir(harness, 'cwd-trusted')
    const dirB = projectDir(harness, 'cwd-untrusted')
    writeClaudeProject(dirA, { alpha: { command: 'node', args: ['a.js'] } })
    writeClaudeProject(dirB, { beta: { command: 'node', args: ['b.js'] } })
    trustProject(harness, dirA)
    const agent = harness.mock.addAgent({ id: 's-cwd2', cwd: dirA })
    await harness.mock.emitAgentCreated(agent)
    assert.deepEqual(harness.mock.toolNames(), ['mcp__alpha__ping'])

    harness.mock.setCwd('s-cwd2', dirB)
    await harness.mock.emitPreStep(agent)
    assert.deepEqual(harness.mock.toolNames(), [])
    assert.equal(mcpStub.callsFor('beta').length, 0)
    const view = await harness.runtime.view('s-cwd2')
    assert.equal(view.trusted, false)
    assert.equal(view.servers[0].status, 'stopped')
  })
})

// ---------------------------------------------------------------------------
// dispose / 清理
// ---------------------------------------------------------------------------

test('agent/disposed：卸载该会话全部挂载并清理注册表', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'disposed')
    writeClaudeProject(dir, { alpha: { command: 'node', args: ['a.js'] } })
    trustProject(harness, dir)
    const agent = harness.mock.addAgent({ id: 's-disposed', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    assert.deepEqual(harness.mock.toolNames(), ['mcp__alpha__ping'])

    await harness.mock.emitAgentDisposed(agent)
    assert.deepEqual(harness.mock.toolNames(), [])
    assert.equal(mcpStub.controls.disposed, 1)
    // The session may still be listed (panel reads it read-only).
    const view = await harness.runtime.view('s-disposed')
    assert.equal(view.servers[0].status, 'stopped')
    harness.mock.removeSession('s-disposed')
    const error = await captureRejection(() => harness.runtime.view('s-disposed'))
    assert.equal(error?.code, 'NOT_FOUND')
  })
})

test('runtime.dispose：停止监听、卸载全部，之后写调用报 INVALID_ARGUMENT', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'runtime-dispose')
    writeClaudeProject(dir, { alpha: { command: 'node', args: ['a.js'] } })
    trustProject(harness, dir)
    const agent = harness.mock.addAgent({ id: 's-runtime-dispose', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    assert.equal(harness.mock.toolNames().length, 1)

    await harness.runtime.dispose()
    assert.deepEqual(harness.mock.toolNames(), [])
    assert.equal(harness.mock.effects.length, 1, 'cleanup effect was registered')

    const second = harness.mock.addAgent({ id: 's-after-dispose', cwd: dir })
    await harness.mock.emitAgentCreated(second)
    assert.equal(mcpStub.callsFor('alpha').length, 1, 'listener must be removed after dispose')

    const error = await captureRejection(() => harness.runtime.view('s-runtime-dispose'))
    assert.equal(error?.code, 'INVALID_ARGUMENT')
    await harness.runtime.dispose() // idempotent
  })
})

// ---------------------------------------------------------------------------
// trust store
// ---------------------------------------------------------------------------

test('trust：写入结构/权限正确，撤销删除条目，重新信任保留 per-server 意愿', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'trust-store')
    writeClaudeProject(dir, { alpha: { command: 'node', args: ['a.js'] } })
    await harness.runtime.trust(dir, true)
    const document = readTrustFile(harness.trustPath)
    assert.equal(document.version, TRUST_FILE_VERSION)
    assert.deepEqual(document.projects[dir].servers, {})
    assert.ok(!Number.isNaN(Date.parse(document.projects[dir].trustedAt)))
    assert.equal(statSync(harness.trustPath).mode & 0o777, 0o600)
    assert.equal(statSync(dirname(harness.trustPath)).mode & 0o777, 0o700)

    // Re-trusting preserves per-server preferences.
    writeTrustFile(harness.trustPath, trustDocument({ [dir]: trustEntry({ alpha: false }) }))
    await harness.runtime.trust(dir, true)
    assert.equal(readTrustFile(harness.trustPath).projects[dir].servers.alpha, false)

    await harness.runtime.trust(dir, false)
    assert.equal(readTrustFile(harness.trustPath).projects[dir], undefined)
  })
})

test('trust/撤销对当前会话立即生效', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'live-trust')
    writeClaudeProject(dir, { alpha: { command: 'node', args: ['a.js'] } })
    const agent = harness.mock.addAgent({ id: 's-live-trust', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    assert.equal(harness.mock.toolNames().length, 0)

    await harness.runtime.trust(dir, true)
    await waitFor(async () => (await harness.runtime.view('s-live-trust')).servers[0].status === 'connected')
    assert.deepEqual(harness.mock.toolNames(), ['mcp__alpha__ping'])

    await harness.runtime.trust(dir, false)
    assert.deepEqual(harness.mock.toolNames(), [])
    const view = await harness.runtime.view('s-live-trust')
    assert.equal(view.trusted, false)
    assert.equal(view.servers[0].status, 'stopped')
  })
})

test('trust 文件损坏：降级为未信任 + warning，trust() 可修复', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'corrupt-trust')
    writeClaudeProject(dir, { alpha: { command: 'node', args: ['a.js'] } })
    mkdirSync(dirname(harness.trustPath), { recursive: true })
    writeFileSync(harness.trustPath, '{ this is not json')
    const agent = harness.mock.addAgent({ id: 's-corrupt', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    assert.equal(mcpStub.controls.calls.length, 0)
    let view = await harness.runtime.view('s-corrupt')
    assert.equal(view.trusted, false)
    assert.ok(view.warnings.some((line) => line.includes('not valid JSON')))
    assert.deepEqual(await harness.runtime.badge('s-corrupt'), { relevant: true, badge: 'untrusted' })

    await harness.runtime.trust(dir, true)
    const repaired = readTrustFile(harness.trustPath)
    assert.equal(repaired.projects[dir] !== undefined, true)
    await waitFor(async () => (await harness.runtime.view('s-corrupt')).servers[0].status === 'connected')
    view = await harness.runtime.view('s-corrupt')
    assert.equal(view.trusted, true)
    assert.equal(view.warnings.some((line) => line.includes('not valid JSON')), false)
  })
})

test('trust 并发写入：文件锁串行化，结果完整可读', async () => {
  await withHarness({}, async (harness) => {
    const dirA = projectDir(harness, 'concurrent-a')
    const dirB = projectDir(harness, 'concurrent-b')
    await Promise.all([harness.runtime.trust(dirA, true), harness.runtime.trust(dirB, true)])
    const document = readTrustFile(harness.trustPath)
    assert.equal(document.projects[dirA] !== undefined, true)
    assert.equal(document.projects[dirB] !== undefined, true)
    assert.equal(document.version, TRUST_FILE_VERSION)
  })
})

test('trust 写入失败（目录不可写）映射为 WRITE_FAILED', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'write-fail')
    // Point the trust file below an existing regular file: mkdir cannot create it.
    const blocker = join(harness.root, 'blocker')
    writeFileSync(blocker, 'not a directory')
    await harness.runtime.dispose()
    const runtime = applyProjectRuntime(harness.mock.ctx, {
      mcpClient: mcpStub,
      trustPath: join(blocker, 'dsh-mcp', 'trust.json'),
    })
    try {
      const error = await captureRejection(() => runtime.trust(dir, true))
      assert.equal(error?.code, 'WRITE_FAILED')
    } finally {
      await runtime.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// reload / 只读边界 / overridesGlobal
// ---------------------------------------------------------------------------

test('reload：重新读取声明并重建挂载', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'reload')
    writeClaudeProject(dir, {
      alpha: { command: 'node', args: ['a.js'] },
      beta: { command: 'node', args: ['b.js'] },
    })
    trustProject(harness, dir)
    const agent = harness.mock.addAgent({ id: 's-reload', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    assert.deepEqual(harness.mock.toolNames().sort(), ['mcp__alpha__ping', 'mcp__beta__ping'])

    writeClaudeProject(dir, {
      beta: { command: 'node', args: ['b.js'] },
      gamma: { command: 'node', args: ['g.js'] },
    })
    const view = await harness.runtime.reload('s-reload')
    assert.deepEqual(
      view.servers.map((server) => server.name),
      ['beta', 'gamma'],
    )
    assert.deepEqual(harness.mock.toolNames().sort(), ['mcp__beta__ping', 'mcp__gamma__ping'])
    assert.equal(mcpStub.callsFor('alpha').length, 1, 'removed server is not restarted')
  })
})

test('reload 非活跃会话：NOT_FOUND', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'reload-dead')
    writeClaudeProject(dir, { alpha: { command: 'node', args: ['a.js'] } })
    harness.mock.addSession({ id: 's-dead', cwd: dir })
    const error = await captureRejection(() => harness.runtime.reload('s-dead'))
    assert.equal(error?.code, 'NOT_FOUND')
  })
})

test('绝不写项目文件：created/trust/toggle/reload 前后内容与 mtime 不变', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'read-only')
    writeClaudeProject(dir, {
      alpha: { command: 'node', args: ['a.js'] },
      beta: { command: 'node', args: ['b.js'] },
    })
    const claudePath = join(dir, '.mcp.json')
    const before = readFileSync(claudePath, 'utf8')
    const beforeStat = statSync(claudePath)
    trustProject(harness, dir)
    const agent = harness.mock.addAgent({ id: 's-read-only', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    await harness.runtime.toggle('s-read-only', 'alpha', false)
    await harness.runtime.toggle('s-read-only', 'alpha', true)
    await harness.runtime.reload('s-read-only')
    await harness.runtime.trust(dir, false)
    await harness.runtime.trust(dir, true)
    assert.equal(readFileSync(claudePath, 'utf8'), before)
    assert.equal(statSync(claudePath).mtimeMs, beforeStat.mtimeMs)
  })
})

test('overridesGlobal：由全局名单标记同名覆盖', async () => {
  await withHarness({ globalServerNames: ['alpha'] }, async (harness) => {
    const dir = projectDir(harness, 'override')
    writeClaudeProject(dir, {
      alpha: { command: 'node', args: ['a.js'] },
      beta: { command: 'node', args: ['b.js'] },
    })
    trustProject(harness, dir)
    const agent = harness.mock.addAgent({ id: 's-override', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    let view = await harness.runtime.view('s-override')
    assert.equal(view.servers.find((server) => server.name === 'alpha').overridesGlobal, true)
    assert.equal(view.servers.find((server) => server.name === 'beta').overridesGlobal, false)
    view = await harness.runtime.view('s-override', { globalServerNames: ['beta'] })
    assert.equal(view.servers.find((server) => server.name === 'alpha').overridesGlobal, false)
    assert.equal(view.servers.find((server) => server.name === 'beta').overridesGlobal, true)
  })
})

// ---------------------------------------------------------------------------
// 视图兜底 / 参数校验
// ---------------------------------------------------------------------------

test('view：没有注册表的会话（只看 sessions 服务）也能读到项目视图，不挂载', async () => {
  await withHarness({}, async (harness) => {
    const dir = projectDir(harness, 'view-only')
    writeClaudeProject(dir, { alpha: { command: 'node', args: ['a.js'] } })
    trustProject(harness, dir)
    harness.mock.addSession({ id: 's-view-only', cwd: dir })
    const view = await harness.runtime.view('s-view-only')
    assert.equal(view.projectDir, dir)
    assert.equal(view.trusted, true)
    assert.equal(view.servers[0].status, 'stopped')
    assert.equal(view.servers[0].active, false)
    assert.deepEqual(await harness.runtime.badge('s-view-only'), { relevant: true, badge: null })
    assert.equal(mcpStub.controls.calls.length, 0)
  })
})

test('未知会话 / 参数非法：返回契约错误码', async () => {
  await withHarness({}, async (harness) => {
    assertRuntimeError(await captureRejection(() => harness.runtime.view('missing-session')), 'NOT_FOUND')
    assertRuntimeError(await captureRejection(() => harness.runtime.badge('missing-session')), 'NOT_FOUND')
    assertRuntimeError(await captureRejection(() => harness.runtime.view('')), 'INVALID_ARGUMENT')

    const dir = projectDir(harness, 'args')
    writeClaudeProject(dir, { alpha: { command: 'node', args: ['a.js'] } })
    trustProject(harness, dir)
    const agent = harness.mock.addAgent({ id: 's-args', cwd: dir })
    await harness.mock.emitAgentCreated(agent)

    const badEnabled = assertRuntimeError(
      await captureRejection(() => harness.runtime.toggle('s-args', 'alpha', 'yes')),
      'INVALID_ARGUMENT',
    )
    assert.equal(badEnabled.field, 'enabled')
    assertRuntimeError(await captureRejection(() => harness.runtime.toggle('s-args', 'nope', true)), 'NOT_FOUND')
    assertRuntimeError(await captureRejection(() => harness.runtime.trust(dir, 'yes')), 'INVALID_ARGUMENT')
    assertRuntimeError(await captureRejection(() => harness.runtime.trust('', true)), 'INVALID_ARGUMENT')

    const untrustedDir = projectDir(harness, 'args-untrusted')
    writeClaudeProject(untrustedDir, { beta: { command: 'node', args: ['b.js'] } })
    const untrustedAgent = harness.mock.addAgent({ id: 's-args-untrusted', cwd: untrustedDir })
    await harness.mock.emitAgentCreated(untrustedAgent)
    const untrustedToggle = assertRuntimeError(
      await captureRejection(() => harness.runtime.toggle('s-args-untrusted', 'beta', true)),
      'INVALID_ARGUMENT',
    )
    assert.equal(untrustedToggle.field, 'trusted')
  })
})

test('插件安装时已存在的 agent 会被补挂载', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-project-host-'))
  const trustPath = join(root, 'home', 'dsh-mcp', 'trust.json')
  try {
    const dir = join(root, 'projects', 'preexisting')
    mkdirSync(dir, { recursive: true })
    writeClaudeProject(dir, { alpha: { command: 'node', args: ['a.js'] } })
    mcpStub.resetControls()
    const mock = createMockContext()
    const agent = mock.addAgent({ id: 's-preexisting', cwd: dir })
    writeTrustFile(trustPath, trustDocument({ [dir]: trustEntry() }))
    const runtime = applyProjectRuntime(mock.ctx, {
      mcpClient: mcpStub,
      trustPath,
      env: { ...process.env },
    })
    try {
      await waitFor(async () => (await runtime.view('s-preexisting')).servers[0]?.status === 'connected')
      assert.deepEqual(mock.toolNames(), ['mcp__alpha__ping'])
    } finally {
      await runtime.dispose()
    }
    assert.ok(agent !== undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('严格 Cordis 上下文：未 inject 的服务通过 ctx.get 读取仍能工作', async () => {
  await withHarness({}, async (harness) => {
    makeStrictContext(harness.mock)
    const dir = projectDir(harness, 'strict-services')
    writeClaudeProject(dir, { alpha: { command: 'node', args: ['a.js'] } })
    trustProject(harness, dir)
    const agent = harness.mock.addAgent({ id: 's-strict', cwd: dir })
    await harness.mock.emitAgentCreated(agent)
    assert.deepEqual(harness.mock.toolNames(), ['mcp__alpha__ping'])
    let view = await harness.runtime.view('s-strict')
    assert.equal(view.cwd, dir)
    assert.equal(view.servers[0].status, 'connected')
    assert.equal((await harness.runtime.badge('s-strict')).badge, null)

    // Read-only session resolution also goes through ctx.get (agents/sessions).
    await harness.mock.emitAgentDisposed(agent)
    harness.mock.removeSession('s-strict')
    const missing = await captureRejection(() => harness.runtime.view('s-strict'))
    assert.equal(missing?.code, 'NOT_FOUND')
  })
})

/**
 * Run a promise and return its rejection (or null).
 * @param {() => Promise<unknown>} operation Operation to run.
 * @returns {Promise<Error | null>} Rejection.
 */
async function captureRejection(operation) {
  try {
    await operation()
    return null
  } catch (error) {
    return error
  }
}

/** Assert that a rejection is a ProjectRuntimeError with the given code. */
function assertRuntimeError(error, code) {
  assert.ok(error instanceof ProjectRuntimeError, `expected ProjectRuntimeError, got ${error}`)
  assert.equal(error.code, code)
  return error
}
