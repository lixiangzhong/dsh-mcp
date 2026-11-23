/**
 * Host-side integration tests for lib/host-service.js.
 *
 * The tests run the real write pipeline against a throwaway profile directory:
 * a mock Cordis context provides the Loader/projection seams, while the YAML
 * editing, file locking, atomic write and reload handshake are the real ones.
 * Nothing under the user's own `~/.dsh` is touched.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyMcpManager } from '../lib/host-service.js'
import { EXPRESSION } from '../lib/row-model.js'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FIXTURE_SERVER = join(REPO_ROOT, 'fixtures', 'stdio-mcp-server.js')

/** Patch sample with comments, a `!!js` header, non-MCP rows, two insert blocks and an override. */
const SAMPLE_PATCH = `# profile patch sample
- id: ui-theme
  name: '@deepseek-ai/dsh-client-ui-theme'
  config:
    preference: dark

# 以下为 MCP
- insert:
    # sshs：本地 SSH 会话 MCP
    - id: mcp-sshs
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: sshs
        transport: streamable-http
        url: http://127.0.0.1:7333/mcp
        headers:
          Authorization: !!js '\`Bearer \${process.env.SSH_TOKEN}\`'
    - id: mcp-dbx
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: dbx
        transport: streamable-http
        url: http://127.0.0.1:5225/mcp
        toolCallTimeoutMs: 120000

- insert:
    - id: other-plugin-row
      name: '@deepseek-ai/dsh-some-other-plugin'

- insert:
    - id: mcp-chrome
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome-devtools
        transport: stdio
        command: /opt/homebrew/bin/npx
        args: ['-y', 'chrome-devtools-mcp@latest']
        toolCallTimeoutMs: 180000

- id: mcp-dbx
  disabled: true
`

/** Tool schemas the mocked tools registry reports. */
const TOOL_SCHEMAS = [
  { name: 'mcp__sshs__ssh_exec' },
  { name: 'mcp__sshs__ssh_list' },
  { name: 'mcp__chrome-devtools__navigate_page' },
  { name: 'bash' },
]

/**
 * Slice one row's text block (insert rows are indented, top-level rows are not).
 * @param {string} text Patch text.
 * @param {string} id Row id.
 * @returns {string} The row block.
 */
function rowBlock(text, id) {
  const marker = `- id: ${id}`
  const start = text.indexOf(marker)
  assert.ok(start >= 0, `row ${id} not found`)
  const rest = text.slice(start + marker.length)
  const next = rest.search(/\n {0,4}- id: /)
  return next === -1 ? text.slice(start) : text.slice(start, start + marker.length + next)
}

/**
 * Build one mock host context plus a captured API handler.
 * @param {{ text?: string, entries?: object[] }} options Harness options.
 * @returns {Promise<object>} Harness with `call`, `emitReload`, `readPatch`, `patchPath`, `dispose`.
 */
async function makeHarness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-host-'))
  const patchPath = join(dir, 'cordis.patch.yml')
  await writeFile(patchPath, options.text ?? SAMPLE_PATCH, 'utf8')
  const routes = []
  const listeners = new Map()
  const entries = options.entries ?? []
  const ctx = {
    profileContext: { dir, patchPath },
    loader: { entries: () => entries },
    tools: { schemas: () => TOOL_SCHEMAS },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    effect: (factory) => {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: (name, listener) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    logger: { warn: () => {} },
    get: () => undefined,
  }
  applyMcpManager(ctx, undefined, options.projectRuntime)
  assert.equal(routes.length, 1, 'the plugin registers exactly one API route')
  const route = routes[0]
  const handler = route.handler

  return {
    dir,
    patchPath,
    route,
    /**
     * Invoke one API action and resolve its JSON payload.
     * @param {string} action Action name.
     * @param {object} [body] JSON body.
     * @param {{ anchor?: number, peer?: object | undefined }} [opts] Options.
     * @returns {Promise<object>} Parsed response envelope.
     */
    async call(action, body = {}, opts = {}) {
      const text = JSON.stringify(body)
      const req = Readable.from([Buffer.from(text, 'utf8')])
      req.method = 'POST'
      req.url = `/dsh-mcp/api/${action}`
      req.headers = { 'content-type': 'application/json' }
      const anchor = opts.anchor ?? 1
      return new Promise((resolve, reject) => {
        const chunks = []
        const res = {
          statusCode: 0,
          headers: {},
          writeHead(status, headers) {
            this.statusCode = status
            this.headers = headers ?? {}
          },
          end(chunk) {
            if (chunk !== undefined) chunks.push(Buffer.from(chunk))
            clearInterval(reloadPoll)
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            } catch (error) {
              reject(error)
            }
          },
        }
        // Emulate repeated HMR reload notifications; the write lands asynchronously,
        // so a single fixed-delay event can arrive before the waiter exists.
        let reloadPoll
        if (action !== 'list' && action !== 'export') {
          reloadPoll = setInterval(() => {
            listeners.get('app-boot/config-reload')?.()
          }, anchor)
          reloadPoll.unref?.()
        }
        // WebServer passes the admitted Peer; tests may withhold it to prove the
        // handler refuses an unauthenticated caller on its own.
        handler(req, res, 'peer' in opts ? opts.peer : { id: 'test-peer' })
      })
    },
    readPatch() {
      return readFile(patchPath, 'utf8')
    },
    dispose() {
      return rm(dir, { recursive: true, force: true })
    },
  }
}

test('API route is admitted by the WebServer auth policy, not by the Connection service', async () => {
  const harness = await makeHarness()
  try {
    assert.equal(harness.route.kind, 'prefix')
    assert.equal(harness.route.path, '/dsh-mcp/api')
    assert.equal(harness.route.auth, 'required', 'the route must require an authenticated Peer')
    const admitted = await harness.call('list')
    assert.equal(admitted.ok, true)
    const refused = await harness.call('list', {}, { peer: undefined })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'FORBIDDEN')
  } finally {
    await harness.dispose()
  }
})

test('list projects managed rows, masks secrets and reports the revision', async () => {
  const liveEntry = (id, config) => ({
    options: { id, name: '@deepseek-ai/dsh-mcp-client', config },
    disabled: false,
    fiber: { state: 2 },
  })
  const harness = await makeHarness({
    entries: [
      liveEntry('mcp-sshs', {
        serverName: 'sshs',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:7333/mcp',
        headers: { Authorization: { __jsExpr: '`Bearer ${process.env.SSH_TOKEN}`' } },
      }),
      liveEntry('mcp-dbx', { serverName: 'dbx', transport: 'streamable-http', url: 'http://127.0.0.1:5225/mcp' }),
      liveEntry('mcp-chrome', { serverName: 'chrome-devtools', transport: 'stdio', command: 'npx' }),
    ],
  })
  try {
    const response = await harness.call('list')
    assert.equal(response.ok, true)
    const { rows, revision, profile } = response.data
    assert.match(revision, /^sha256:[0-9a-f]{64}$/)
    assert.equal(profile.patchPath, harness.patchPath)
    assert.deepEqual(
      rows.map((row) => row.serverName),
      ['chrome-devtools', 'dbx', 'sshs'],
    )
    const sshs = rows.find((row) => row.serverName === 'sshs')
    assert.equal(sshs.editable, true)
    assert.equal(sshs.source, 'profile')
    assert.equal(sshs.transport, 'streamable-http')
    assert.equal(sshs.phase, 'active')
    assert.deepEqual(sshs.headers, { Authorization: EXPRESSION })
    assert.equal(sshs.toolCount, 2)
    assert.deepEqual(sshs.tools, ['mcp__sshs__ssh_exec', 'mcp__sshs__ssh_list'])
    assert.equal(rows.find((row) => row.serverName === 'chrome-devtools').toolCount, 1)
    assert.equal(rows.find((row) => row.serverName === 'dbx').editable, true)
  } finally {
    await harness.dispose()
  }
})

test('up to date revisions are required for writes', async () => {
  const harness = await makeHarness()
  try {
    const list = await harness.call('list')
    const stale = { ...list.data, revision: 'sha256:deadbeef' }
    const response = await harness.call('upsert', {
      baseRevision: stale.revision,
      row: { serverName: 'fixture', transport: 'stdio', command: 'node', args: [FIXTURE_SERVER] },
    })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'CONFLICT')
    assert.match(response.error.details.currentRevision, /^sha256:/)
  } finally {
    await harness.dispose()
  }
})

test('upsert appends a row to the last MCP insert block and waits for the reload', async () => {
  const harness = await makeHarness()
  try {
    const before = await harness.readPatch()
    const list = await harness.call('list')
    const response = await harness.call('upsert', {
      baseRevision: list.data.revision,
      row: {
        serverName: 'fixture',
        transport: 'stdio',
        command: 'node',
        args: [FIXTURE_SERVER],
        enabled: true,
      },
    })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    assert.equal(response.data.applied, true)
    assert.equal(response.data.timedOut, false)
    assert.equal(response.data.row.serverName, 'fixture')
    assert.equal(response.data.row.editable, true)
    assert.equal(response.data.row.id, 'mcp-fixture')

    const after = await harness.readPatch()
    // The original document survives verbatim; only the new row was appended.
    for (const marker of ['# profile patch sample', '# 以下为 MCP', '# sshs：本地 SSH 会话 MCP', '!!js \'`Bearer ${process.env.SSH_TOKEN}`\'' ]) {
      assert.ok(after.includes(marker), `marker lost: ${marker}`)
    }
    assert.ok(after.includes('- id: mcp-fixture'), 'the new row is missing')
    assert.ok(after.includes('serverName: fixture'), 'the new row lost its config')
    assert.ok(after.length > before.length, 'the new row did not grow the document')
    const relisted = await harness.call('list')
    assert.equal(relisted.data.rows.length, 4)
    assert.ok(relisted.data.rows.some((row) => row.serverName === 'fixture'))
  } finally {
    await harness.dispose()
  }
})

test('editing one field and reverting it restores the document byte for byte', async () => {
  const harness = await makeHarness()
  try {
    const before = await harness.readPatch()
    let list = await harness.call('list')
    const dbx = list.data.rows.find((row) => row.serverName === 'dbx')
    const changed = await harness.call('upsert', {
      baseRevision: list.data.revision,
      originalId: dbx.id,
      row: {
        serverName: 'dbx',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:5225/mcp',
        toolCallTimeoutMs: 60000,
        enabled: true,
      },
    })
    assert.equal(changed.ok, true, JSON.stringify(changed.error))
    const edited = await harness.readPatch()
    assert.match(rowBlock(edited, dbx.id), /toolCallTimeoutMs: 60000/)
    assert.doesNotMatch(rowBlock(edited, dbx.id), /120000/)

    list = await harness.call('list')
    const reverted = await harness.call('upsert', {
      baseRevision: list.data.revision,
      originalId: dbx.id,
      row: {
        serverName: 'dbx',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:5225/mcp',
        toolCallTimeoutMs: 120000,
        enabled: true,
      },
    })
    assert.equal(reverted.ok, true, JSON.stringify(reverted.error))
    const restored = await harness.readPatch()
    assert.equal(restored, before, 'reverting the field must restore the original bytes')
  } finally {
    await harness.dispose()
  }
})

test('保存时不删除面板未建模的 config 字段（上游新增键）', async () => {
  const text = `- insert:
    - id: mcp-oauth
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: oauthsrv
        transport: streamable-http
        url: http://127.0.0.1:9000/mcp
        oauth:
          credentialKey: mcp-client/oauthsrv
          scope: mcp:read
        toolLoading: on-demand
`
  const harness = await makeHarness({ text })
  try {
    let list = await harness.call('list')
    const row = list.data.rows[0]
    const edited = await harness.call('upsert', {
      baseRevision: list.data.revision,
      originalId: row.id,
      row: { serverName: 'oauthsrv', transport: 'streamable-http', url: 'http://127.0.0.1:9100/mcp', enabled: true },
    })
    assert.equal(edited.ok, true, JSON.stringify(edited.error))
    const after = rowBlock(await harness.readPatch(), row.id)
    assert.match(after, /url: http:\/\/127\.0\.0\.1:9100\/mcp/)
    assert.match(after, /credentialKey: mcp-client\/oauthsrv/)
    assert.match(after, /scope: mcp:read/)
    assert.match(after, /toolLoading: on-demand/)

    list = await harness.call('list')
    const switched = await harness.call('upsert', {
      baseRevision: list.data.revision,
      originalId: row.id,
      row: { serverName: 'oauthsrv', transport: 'stdio', command: 'node', enabled: true },
    })
    assert.equal(switched.ok, true, JSON.stringify(switched.error))
    const switchedText = rowBlock(await harness.readPatch(), row.id)
    assert.doesNotMatch(switchedText, /oauth:/, 'transport 变更时按既有语义丢弃未建模字段')
    assert.doesNotMatch(switchedText, /toolLoading/)
  } finally {
    await harness.dispose()
  }
})

test('toggle writes and removes the inline disabled field', async () => {
  const harness = await makeHarness()
  try {
    let list = await harness.call('list')
    const sshs = list.data.rows.find((row) => row.serverName === 'sshs')
    const disabled = await harness.call('toggle', {
      baseRevision: list.data.revision,
      id: sshs.id,
      enabled: false,
    })
    assert.equal(disabled.ok, true, JSON.stringify(disabled.error))
    assert.equal(disabled.data.row.disabled, true)
    let text = await harness.readPatch()
    assert.match(rowBlock(text, 'mcp-sshs'), /disabled: true/)

    list = await harness.call('list')
    const enabled = await harness.call('toggle', {
      baseRevision: list.data.revision,
      id: sshs.id,
      enabled: true,
    })
    assert.equal(enabled.ok, true, JSON.stringify(enabled.error))
    assert.equal(enabled.data.row.disabled, false)
    text = await harness.readPatch()
    assert.doesNotMatch(rowBlock(text, 'mcp-sshs'), /disabled:/)
  } finally {
    await harness.dispose()
  }
})

test('remove deletes the row, its override and leaves other bytes untouched', async () => {
  const harness = await makeHarness()
  try {
    const before = await harness.readPatch()
    const list = await harness.call('list')
    const dbx = list.data.rows.find((row) => row.serverName === 'dbx')
    const response = await harness.call('remove', { baseRevision: list.data.revision, id: dbx.id })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    assert.equal(response.data.removedId, 'mcp-dbx')
    const after = await harness.readPatch()
    assert.doesNotMatch(after, /serverName: dbx/)
    assert.doesNotMatch(after, /- id: mcp-dbx/)
    assert.match(after, /- id: ui-theme/)
    assert.match(after, /- id: mcp-chrome/)
    // Other rows survive byte-identically.
    for (const marker of ['- id: ui-theme', '- id: mcp-sshs', '- id: mcp-chrome', '- id: other-plugin-row']) {
      assert.ok(before.includes(marker) && after.includes(marker), `marker lost: ${marker}`)
    }
    const relisted = await harness.call('list')
    assert.equal(relisted.data.rows.length, 2)
  } finally {
    await harness.dispose()
  }
})

test('non-editable rows are refused and remote rows are listed read-only', async () => {
  const bundleEntry = {
    options: {
      id: 'bundle-mcp-row',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'bundled', transport: 'stdio', command: 'node' },
    },
    disabled: false,
    fiber: undefined,
  }
  const harness = await makeHarness({ entries: [bundleEntry] })
  try {
    const list = await harness.call('list')
    const remote = list.data.rows.find((row) => row.serverName === 'bundled')
    assert.equal(remote.editable, false)
    assert.equal(remote.source, 'bundle')
    const response = await harness.call('remove', { baseRevision: list.data.revision, id: 'bundle-mcp-row' })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'NOT_EDITABLE')
  } finally {
    await harness.dispose()
  }
})

test('editing a row keeps untouched scalar !!js expressions', async () => {
  const text = `- insert:
    - id: mcp-x
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: x
        transport: streamable-http
        url: http://a/mcp
        failOnStartupError: !!js process.env.STRICT
`
  const harness = await makeHarness({ text })
  try {
    const list = await harness.call('list')
    const row = list.data.rows.find((candidate) => candidate.serverName === 'x')
    assert.equal(row.failOnStartupError, null, 'an expression scalar projects as null on the wire')
    const response = await harness.call('upsert', {
      baseRevision: list.data.revision,
      originalId: row.id,
      row: {
        serverName: 'x',
        transport: 'streamable-http',
        url: 'http://a/mcp',
        failOnStartupError: null,
        enabled: true,
      },
    })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    const after = await harness.readPatch()
    const { parsePatchText } = await import('../lib/patch-doc.js')
    const reparsed = parsePatchText(after)
    assert.equal(reparsed.rows[0].config.failOnStartupError.__jsExpr, 'process.env.STRICT')
  } finally {
    await harness.dispose()
  }
})

test('editable rows prefer the patch text over an evaluated runtime config', async () => {
  const text = `- insert:
    - id: mcp-x
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: x
        transport: streamable-http
        url: http://a/mcp
        headers:
          Authorization: !!js process.env.TOKEN
        failOnStartupError: !!js process.env.STRICT
`
  const evaluatedEntry = {
    options: {
      id: 'mcp-x',
      name: '@deepseek-ai/dsh-mcp-client',
      // A Loader that evaluated `!!js` would expose plain values here.
      config: {
        serverName: 'x',
        transport: 'streamable-http',
        url: 'http://a/mcp',
        headers: { Authorization: 'Bearer evaluated-secret' },
        failOnStartupError: true,
      },
    },
    disabled: false,
    fiber: { state: 2 },
  }
  const harness = await makeHarness({ text, entries: [evaluatedEntry] })
  try {
    const list = await harness.call('list')
    const row = list.data.rows.find((candidate) => candidate.serverName === 'x')
    assert.equal(row.phase, 'active')
    assert.deepEqual(row.headers, { Authorization: EXPRESSION }, 'expressions must not be frozen from runtime values')
    assert.equal(row.failOnStartupError, null)
    const response = await harness.call('upsert', {
      baseRevision: list.data.revision,
      originalId: row.id,
      row: {
        serverName: 'x',
        transport: 'streamable-http',
        url: 'http://a/mcp',
        headers: { Authorization: EXPRESSION },
        toolCallTimeoutMs: 5000,
        enabled: true,
      },
    })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    const { parsePatchText } = await import('../lib/patch-doc.js')
    const reparsed = parsePatchText(await harness.readPatch()).rows[0]
    assert.equal(reparsed.config.headers.Authorization.__jsExpr, 'process.env.TOKEN')
    assert.equal(reparsed.config.failOnStartupError.__jsExpr, 'process.env.STRICT')
    assert.equal(reparsed.config.toolCallTimeoutMs, 5000)
  } finally {
    await harness.dispose()
  }
})

test('invalid input is rejected with a field', async () => {
  const harness = await makeHarness()
  try {
    const list = await harness.call('list')
    const response = await harness.call('upsert', {
      baseRevision: list.data.revision,
      row: { serverName: 'bad name!', transport: 'stdio', command: 'node', enabled: true },
    })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'INVALID_ARGUMENT')
    assert.equal(response.error.field, 'serverName')
  } finally {
    await harness.dispose()
  }
})

/** Fake project runtime recording calls for the project-scoped action tests. */
function makeFakeProjectRuntime() {
  const calls = []
  const view = {
    cwd: '/projects/alpha',
    projectDir: '/projects/alpha',
    files: [{ path: '/projects/alpha/.mcp.json', format: 'claude' }],
    trusted: false,
    servers: [
      {
        name: 'proj-alpha',
        source: 'claude',
        transport: 'stdio',
        enabled: true,
        status: 'stopped',
        active: false,
        overridesGlobal: false,
        envKeys: [],
        headerKeys: [],
      },
    ],
    warnings: [],
  }
  return {
    calls,
    async view(sessionId) {
      calls.push(['view', sessionId])
      return structuredClone(view)
    },
    async badge(sessionId) {
      calls.push(['badge', sessionId])
      return { relevant: true, badge: 'untrusted' }
    },
    async trust(dir, trusted) {
      calls.push(['trust', dir, trusted])
      return { dir, trusted }
    },
    async toggle(sessionId, serverName, enabled) {
      calls.push(['toggle', sessionId, serverName, enabled])
    },
    async reload(sessionId) {
      calls.push(['reload', sessionId])
    },
    async dispose() {},
  }
}

test('project actions delegate to the runtime and merge the global summary', async () => {
  const runtime = makeFakeProjectRuntime()
  const harness = await makeHarness({ projectRuntime: runtime })
  try {
    const session = await harness.call('project/session', { sessionId: 's1' })
    assert.equal(session.ok, true, JSON.stringify(session.error))
    assert.equal(session.data.servers.length, 1)
    assert.equal(session.data.servers[0].name, 'proj-alpha')
    assert.equal(session.data.files[0].format, 'claude')
    assert.deepEqual(
      session.data.global.map((row) => row.name),
      ['chrome-devtools', 'dbx', 'sshs'],
    )
    assert.equal(typeof session.data.global[0].toolCount, 'number')

    const badge = await harness.call('project/badge', { sessionId: 's1' })
    assert.deepEqual(badge.data, { relevant: true, badge: 'untrusted' })

    const trust = await harness.call('project/trust', { dir: '/projects/alpha', trusted: true })
    assert.equal(trust.ok, true)
    assert.deepEqual(runtime.calls.at(-1), ['trust', '/projects/alpha', true])

    const toggle = await harness.call('project/toggle', {
      sessionId: 's1',
      serverName: 'proj-alpha',
      enabled: false,
    })
    assert.equal(toggle.ok, true)
    assert.deepEqual(runtime.calls.at(-1), ['toggle', 's1', 'proj-alpha', false])

    const reload = await harness.call('project/reload', { sessionId: 's1' })
    assert.equal(reload.ok, true)
    assert.deepEqual(runtime.calls.at(-2), ['reload', 's1'])
    assert.deepEqual(runtime.calls.at(-1), ['view', 's1'])
  } finally {
    await harness.dispose()
  }
})

test('project actions validate their input', async () => {
  const runtime = makeFakeProjectRuntime()
  const harness = await makeHarness({ projectRuntime: runtime })
  try {
    const missingSession = await harness.call('project/session', {})
    assert.equal(missingSession.ok, false)
    assert.equal(missingSession.error.code, 'INVALID_ARGUMENT')
    assert.equal(missingSession.error.field, 'sessionId')

    const relativeDir = await harness.call('project/trust', { dir: 'relative/path', trusted: true })
    assert.equal(relativeDir.ok, false)
    assert.equal(relativeDir.error.code, 'INVALID_ARGUMENT')
    assert.equal(relativeDir.error.field, 'dir')

    const badTrusted = await harness.call('project/trust', { dir: '/tmp/x', trusted: 'yes' })
    assert.equal(badTrusted.ok, false)
    assert.equal(badTrusted.error.field, 'trusted')

    const badToggle = await harness.call('project/toggle', { sessionId: 's1', serverName: 'x' })
    assert.equal(badToggle.ok, false)
    assert.equal(badToggle.error.field, 'enabled')
  } finally {
    await harness.dispose()
  }
})

test('project actions report an unavailable runtime', async () => {
  const harness = await makeHarness()
  try {
    const response = await harness.call('project/session', { sessionId: 's1' })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'INTERNAL')
  } finally {
    await harness.dispose()
  }
})

test('project badge is relevant when only the global plane has MCP rows', async () => {
  const runtime = makeFakeProjectRuntime()
  runtime.badge = async () => ({ relevant: false, badge: null })
  const harness = await makeHarness({ projectRuntime: runtime })
  try {
    const badge = await harness.call('project/badge', { sessionId: 's1' })
    assert.equal(badge.ok, true, JSON.stringify(badge.error))
    assert.equal(badge.data.relevant, true)
    assert.equal(badge.data.badge, null)
  } finally {
    await harness.dispose()
  }
})

test('project badge stays irrelevant when neither plane has content', async () => {
  const runtime = makeFakeProjectRuntime()
  runtime.badge = async () => ({ relevant: false, badge: null })
  const harness = await makeHarness({ projectRuntime: runtime, text: '[]\n' })
  try {
    const badge = await harness.call('project/badge', { sessionId: 's1' })
    assert.equal(badge.ok, true, JSON.stringify(badge.error))
    assert.deepEqual(badge.data, { relevant: false, badge: null })
  } finally {
    await harness.dispose()
  }
})
