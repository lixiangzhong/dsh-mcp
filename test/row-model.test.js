/**
 * test/row-model.test.js — lib/row-model.js 黑盒单测 + stdio MCP fixture 管道联调
 *
 * 契约真相源：docs/contracts/host-api.md §2/§3/§4.5/§4.6/§8.2。
 * 运行：node --test test/row-model.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  SECRET_KEEP,
  MASK,
  EXPRESSION,
  ValidationError,
  maskConfig,
  validateRowInput,
  buildConfig,
  nextRowId,
  toolsForServer,
} from '../lib/row-model.js'

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/stdio-mcp-server.js', import.meta.url))

/** 构造 Host 内部使用的 YAML `!!js` 表达式节点。 */
function expr(code) {
  return { __jsExpr: code }
}

/** 断言 fn 抛 ValidationError，并校验 code / field。 */
function expectValidationError(fn, field) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ValidationError, `expected ValidationError, got ${error.name}`)
    assert.equal(error.code, 'INVALID_ARGUMENT')
    assert.equal(error.field, field ?? null)
    return true
  })
}

/* ============================== 常量 ============================== */

test('契约常量：SECRET_KEEP / MASK / EXPRESSION', () => {
  assert.equal(SECRET_KEEP, '__KEEP__')
  assert.equal(MASK, '••••••')
  assert.equal(EXPRESSION, '__EXPRESSION__')
})

/* ============================== maskConfig ============================== */

test('maskConfig：http 行 secret 掩码为 MASK、表达式为 EXPRESSION', () => {
  const masked = maskConfig({
    serverName: 'stitch',
    transport: 'streamable-http',
    url: 'https://stitch.googleapis.com/mcp',
    headers: {
      'X-Goog-Api-Key': 'AQ.real-key',
      'X-From-Env': expr('process.env.STITCH_KEY'),
    },
    toolCallTimeoutMs: 300000,
    failOnStartupError: true,
    reconnect: { maxAttempts: 3 },
  })

  assert.deepEqual(masked, {
    transport: 'streamable-http',
    command: null,
    args: null,
    cwd: null,
    env: null,
    url: 'https://stitch.googleapis.com/mcp',
    headers: { 'X-Goog-Api-Key': MASK, 'X-From-Env': EXPRESSION },
    toolCallTimeoutMs: 300000,
    maxInstructionBytes: null,
    failOnStartupError: true,
    reconnect: { maxAttempts: 3 },
  })
  // reconnect 返回深拷贝，不暴露内部引用。
  assert.notEqual(masked.reconnect, undefined)
})

test('maskConfig：stdio 行 args 元素表达式、env 掩码、空对象归一为 null', () => {
  const masked = maskConfig({
    transport: 'stdio',
    command: 'node',
    args: ['fixtures/stdio-mcp-server.js', expr('process.env.ARGS')],
    cwd: '/tmp/work',
    env: { TOKEN: 'secret', FROM_ENV: expr('process.env.TOKEN') },
    headers: {},
    maxInstructionBytes: 4096,
  })

  assert.deepEqual(masked, {
    transport: 'stdio',
    command: 'node',
    args: ['fixtures/stdio-mcp-server.js', EXPRESSION],
    cwd: '/tmp/work',
    env: { TOKEN: MASK, FROM_ENV: EXPRESSION },
    url: null,
    headers: null,
    toolCallTimeoutMs: null,
    maxInstructionBytes: 4096,
    failOnStartupError: null,
    reconnect: null,
  })
})

test('maskConfig：缺失/非法 config 不死锁，返回全 null 骨架', () => {
  const emptyShape = {
    transport: null,
    command: null,
    args: null,
    cwd: null,
    env: null,
    url: null,
    headers: null,
    toolCallTimeoutMs: null,
    maxInstructionBytes: null,
    failOnStartupError: null,
    reconnect: null,
  }
  assert.deepEqual(maskConfig(undefined), emptyShape)
  assert.deepEqual(maskConfig(null), emptyShape)
  assert.deepEqual(maskConfig('broken'), emptyShape)

  // 契约 Row 类型限制：数值/布尔字段的 !!js 无法表达，归一为 null（已知限制）。
  const masked = maskConfig({
    transport: 'streamable-http',
    url: 'http://127.0.0.1:7333/mcp',
    toolCallTimeoutMs: expr('process.env.TIMEOUT'),
    maxInstructionBytes: expr('process.env.BYTES'),
    failOnStartupError: expr('true'),
  })
  assert.equal(masked.transport, 'streamable-http')
  assert.equal(masked.toolCallTimeoutMs, null)
  assert.equal(masked.maxInstructionBytes, null)
  assert.equal(masked.failOnStartupError, null)

  // 兼容手写 config 的 http/sse transport 别名。
  assert.equal(maskConfig({ transport: 'http', url: 'http://a' }).transport, 'streamable-http')
  assert.equal(maskConfig({ transport: 'sse', url: 'http://a' }).transport, 'streamable-http')
})

test('maskConfig：reconnect 深拷贝，不与原 config 共享引用', () => {
  const reconnect = { maxAttempts: 3 }
  const masked = maskConfig({ transport: 'streamable-http', url: 'http://a', reconnect })
  masked.reconnect.maxAttempts = 9
  assert.equal(reconnect.maxAttempts, 3)
})

/* ============================== validateRowInput ============================== */

test('validateRowInput：合法 stdio / http 输入通过', () => {
  validateRowInput({
    serverName: 'fixture',
    transport: 'stdio',
    command: 'node',
    args: ['fixtures/stdio-mcp-server.js'],
    cwd: '/tmp',
    env: { TOKEN: 'x' },
    enabled: true,
  })
  validateRowInput({
    serverName: 'sshs',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:7333/mcp',
    headers: { Authorization: 'Bearer x' },
    toolCallTimeoutMs: 60000,
    maxInstructionBytes: 1024,
    failOnStartupError: false,
  })
})

test('validateRowInput：serverName 形态校验', () => {
  expectValidationError(() => validateRowInput(null), null)
  for (const serverName of ['', 'bad name', '名字', '-'.repeat(33), 'a'.repeat(33)]) {
    expectValidationError(
      () => validateRowInput({ serverName, transport: 'stdio', command: 'node' }),
      'serverName',
    )
  }
  // 32 位上限与下划线/连字符合法。
  validateRowInput({ serverName: 'a'.repeat(32), transport: 'stdio', command: 'node' })
  validateRowInput({ serverName: 'My_Server-1', transport: 'stdio', command: 'node' })
})

test('validateRowInput：transport 与互斥字段', () => {
  expectValidationError(
    () => validateRowInput({ serverName: 'x', transport: 'sse', command: 'node' }),
    'transport',
  )
  // stdio 禁止 url/headers。
  expectValidationError(
    () => validateRowInput({ serverName: 'x', transport: 'stdio', command: 'node', url: 'http://a' }),
    'url',
  )
  expectValidationError(
    () =>
      validateRowInput({
        serverName: 'x',
        transport: 'stdio',
        command: 'node',
        headers: { Authorization: 'x' },
      }),
    'headers',
  )
  // stdio 必须有 command。
  expectValidationError(
    () => validateRowInput({ serverName: 'x', transport: 'stdio' }),
    'command',
  )
  // http 禁止 command/args/env/cwd，必须有 url。
  expectValidationError(
    () => validateRowInput({ serverName: 'x', transport: 'streamable-http', url: 'http://a', command: 'node' }),
    'command',
  )
  expectValidationError(
    () => validateRowInput({ serverName: 'x', transport: 'streamable-http', url: 'http://a', env: { A: 'b' } }),
    'env',
  )
  expectValidationError(
    () => validateRowInput({ serverName: 'x', transport: 'streamable-http' }),
    'url',
  )
})

test('validateRowInput：数值范围与布尔字段', () => {
  const stdioRow = (extra) => ({ serverName: 'x', transport: 'stdio', command: 'node', ...extra })
  for (const timeout of [0, -1, '60000', Number.NaN, Number.POSITIVE_INFINITY]) {
    expectValidationError(
      () => validateRowInput(stdioRow({ toolCallTimeoutMs: timeout })),
      'toolCallTimeoutMs',
    )
  }
  for (const bytes of [0, -1, '1024', Number.NaN]) {
    expectValidationError(
      () => validateRowInput(stdioRow({ maxInstructionBytes: bytes })),
      'maxInstructionBytes',
    )
  }
  validateRowInput(stdioRow({ toolCallTimeoutMs: 1, maxInstructionBytes: 1 }))
  expectValidationError(
    () => validateRowInput(stdioRow({ failOnStartupError: 'yes' })),
    'failOnStartupError',
  )
  expectValidationError(() => validateRowInput(stdioRow({ enabled: 1 })), 'enabled')
  expectValidationError(() => validateRowInput(stdioRow({ reconnect: 'x' })), 'reconnect')
})

test('validateRowInput：args 与 env/headers 值形态', () => {
  const stdioRow = (extra) => ({ serverName: 'x', transport: 'stdio', command: 'node', ...extra })
  expectValidationError(() => validateRowInput(stdioRow({ args: 'a' })), 'args')
  expectValidationError(() => validateRowInput(stdioRow({ args: [1] })), 'args.0')
  expectValidationError(() => validateRowInput(stdioRow({ env: { A: 1 } })), 'env.A')
  expectValidationError(
    () => validateRowInput({ serverName: 'x', transport: 'streamable-http', url: 'http://a', headers: { A: null } }),
    'headers.A',
  )
  // 表达式对象在 env 中合法（导入/原始 config 场景）。
  validateRowInput(stdioRow({ env: { A: expr('process.env.A') } }))
})

/* ============================== buildConfig ============================== */

test('buildConfig：新增 stdio 行剔除 null / 不适用字段，忽略 enabled', () => {
  const config = buildConfig(
    {
      serverName: 'fixture',
      transport: 'stdio',
      command: 'node',
      args: ['/abs/fixtures/stdio-mcp-server.js'],
      cwd: '',
      env: {},
      url: null,
      headers: null,
      toolCallTimeoutMs: null,
      maxInstructionBytes: null,
      failOnStartupError: false,
      reconnect: null,
      enabled: true,
    },
    null,
  )

  assert.deepEqual(config, {
    serverName: 'fixture',
    transport: 'stdio',
    command: 'node',
    args: ['/abs/fixtures/stdio-mcp-server.js'],
    failOnStartupError: false,
  })
  assert.equal('enabled' in config, false)
  assert.equal('cwd' in config, false)
  assert.equal('env' in config, false)
  assert.equal('url' in config, false)
})

test('buildConfig：编辑时 SECRET_KEEP 沿用原值（含 !!js 表达式对象）', () => {
  const existingConfig = {
    serverName: 'stitch',
    transport: 'streamable-http',
    url: 'https://stitch.googleapis.com/mcp',
    headers: {
      'X-Goog-Api-Key': expr('process.env.STITCH_KEY'),
      Authorization: 'Bearer old',
    },
    toolCallTimeoutMs: 300000,
  }
  const config = buildConfig(
    {
      serverName: 'stitch',
      transport: 'streamable-http',
      url: 'https://stitch.googleapis.com/mcp',
      headers: {
        'X-Goog-Api-Key': SECRET_KEEP,
        Authorization: 'Bearer new',
        'X-Added': 'added',
      },
      toolCallTimeoutMs: 300000,
    },
    existingConfig,
  )

  assert.deepEqual(config, {
    serverName: 'stitch',
    transport: 'streamable-http',
    url: 'https://stitch.googleapis.com/mcp',
    headers: {
      'X-Goog-Api-Key': expr('process.env.STITCH_KEY'),
      Authorization: 'Bearer new',
      'X-Added': 'added',
    },
    toolCallTimeoutMs: 300000,
  })
  assert.equal('enabled' in config, false)
})

test('buildConfig：新增行出现 SECRET_KEEP → INVALID_ARGUMENT', () => {
  expectValidationError(
    () =>
      buildConfig(
        {
          serverName: 'fixture',
          transport: 'stdio',
          command: 'node',
          env: { TOKEN: SECRET_KEEP },
        },
        null,
      ),
    'env.TOKEN',
  )
})

test('buildConfig：EXPRESSION 标记（UI 未编辑的 !!js 行）沿用原值；新增行报错', () => {
  const existingConfig = {
    serverName: 'fixture',
    transport: 'stdio',
    command: expr('process.env.MCP_COMMAND'),
    args: ['fixtures/stdio-mcp-server.js', expr('process.env.MCP_ARG')],
    env: { TOKEN: expr('process.env.TOKEN') },
    toolCallTimeoutMs: expr('process.env.TIMEOUT'),
    maxInstructionBytes: expr('process.env.BYTES'),
    failOnStartupError: expr('process.env.FAIL_ON_START'),
    reconnect: { maxAttempts: 2 },
  }
  const config = buildConfig(
    {
      serverName: 'fixture',
      transport: 'stdio',
      command: EXPRESSION,
      args: ['fixtures/stdio-mcp-server.js', EXPRESSION],
      env: { TOKEN: EXPRESSION },
      toolCallTimeoutMs: EXPRESSION,
      maxInstructionBytes: EXPRESSION,
      failOnStartupError: EXPRESSION,
      reconnect: EXPRESSION,
    },
    existingConfig,
  )

  assert.deepEqual(config, {
    serverName: 'fixture',
    transport: 'stdio',
    command: expr('process.env.MCP_COMMAND'),
    args: ['fixtures/stdio-mcp-server.js', expr('process.env.MCP_ARG')],
    env: { TOKEN: expr('process.env.TOKEN') },
    toolCallTimeoutMs: expr('process.env.TIMEOUT'),
    maxInstructionBytes: expr('process.env.BYTES'),
    failOnStartupError: expr('process.env.FAIL_ON_START'),
    reconnect: { maxAttempts: 2 },
  })

  expectValidationError(
    () =>
      buildConfig(
        { serverName: 'new', transport: 'stdio', command: EXPRESSION },
        null,
      ),
    'command',
  )
})

test('buildConfig：MASK 回写被拒绝（只接受 SECRET_KEEP）', () => {
  const existingConfig = {
    serverName: 'x',
    transport: 'streamable-http',
    url: 'http://a/mcp',
    headers: { Authorization: 'Bearer real' },
  }
  expectValidationError(
    () =>
      buildConfig(
        { serverName: 'x', transport: 'streamable-http', url: 'http://a/mcp', headers: { Authorization: MASK } },
        existingConfig,
      ),
    'headers.Authorization',
  )
})

test('buildConfig：transport 切换剔除不适用字段', () => {
  const existingStdio = {
    serverName: 'x',
    transport: 'stdio',
    command: 'node',
    args: ['a.js'],
    env: { TOKEN: 't' },
  }
  const toHttp = buildConfig(
    {
      serverName: 'x',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:7333/mcp',
      headers: { Authorization: 'Bearer t' },
    },
    existingStdio,
  )
  assert.deepEqual(toHttp, {
    serverName: 'x',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:7333/mcp',
    headers: { Authorization: 'Bearer t' },
  })

  const existingHttp = {
    serverName: 'x',
    transport: 'streamable-http',
    url: 'http://127.0.0.1:7333/mcp',
    headers: { Authorization: 'Bearer t' },
  }
  const toStdio = buildConfig(
    {
      serverName: 'x',
      transport: 'stdio',
      command: 'node',
      args: ['a.js'],
      env: { TOKEN: 't' },
    },
    existingHttp,
  )
  assert.deepEqual(toStdio, {
    serverName: 'x',
    transport: 'stdio',
    command: 'node',
    args: ['a.js'],
    env: { TOKEN: 't' },
  })
})

test('buildConfig：env 里的 !!js 对象原样透传；空串 secret = 删除 key', () => {
  const config = buildConfig(
    {
      serverName: 'x',
      transport: 'stdio',
      command: 'node',
      env: { KEEP_AS_EXPR: expr('process.env.K'), REMOVE_ME: '' },
    },
    null,
  )
  assert.deepEqual(config, {
    serverName: 'x',
    transport: 'stdio',
    command: 'node',
    env: { KEEP_AS_EXPR: expr('process.env.K') },
  })
  // 原始 !!js 对象不是 UI 输入形态：标量端点必须是字符串（或 EXPRESSION 标记）。
  expectValidationError(
    () => buildConfig({ serverName: 'x', transport: 'stdio', command: expr('process.env.CMD') }, null),
    'command',
  )
})

/* ============================== nextRowId ============================== */

test('nextRowId：slug 规则与冲突后缀', () => {
  assert.equal(nextRowId('sshs', []), 'mcp-sshs')
  assert.equal(nextRowId('Chrome-DevTools', []), 'mcp-chrome-devtools')
  assert.equal(nextRowId('My Server_1', []), 'mcp-my-server-1')
  assert.equal(nextRowId('__', []), 'mcp-server')
  assert.equal(nextRowId('sshs', undefined), 'mcp-sshs')
  assert.equal(nextRowId('sshs', new Set(['mcp-sshs'])), 'mcp-sshs-2')
  assert.equal(nextRowId('sshs', ['mcp-sshs', 'mcp-sshs-2']), 'mcp-sshs-3')
  // 只占用子后缀时仍用基础 id。
  assert.equal(nextRowId('sshs', ['mcp-sshs-2']), 'mcp-sshs')
})

/* ============================== toolsForServer ============================== */

test('toolsForServer：按 mcp__<serverName>__ 前缀筛，哈希后缀不影响匹配', () => {
  const toolNames = [
    'mcp__fixture__ping',
    'mcp__fixture__ping_ab12cd34ef56',
    'mcp__fixture2__ping',
    'mcp__fixtur__ping',
    'mcp__fixture',
    'other__tool',
  ]
  assert.deepEqual(toolsForServer('fixture', toolNames), [
    'mcp__fixture__ping',
    'mcp__fixture__ping_ab12cd34ef56',
  ])
  assert.deepEqual(toolsForServer('fixture2', toolNames), ['mcp__fixture2__ping'])
  assert.deepEqual(toolsForServer('missing', toolNames), [])
  assert.deepEqual(toolsForServer('', toolNames), [])
  assert.deepEqual(toolsForServer('fixture', null), [])
})

/* ============================== fixture 管道联调 ============================== */

/** 以子进程方式拉起 fixture，并提供逐条消息读写。 */
function startFixtureProcess() {
  const child = spawn(process.execPath, [FIXTURE_PATH], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const received = []
  let pendingResolve = null

  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      message = { parseError: line }
    }
    if (pendingResolve !== null) {
      const resolve = pendingResolve
      pendingResolve = null
      resolve(message)
      return
    }
    received.push(message)
  })

  child.stderr.on('data', () => {})

  const nextMessage = (timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      if (received.length > 0) {
        resolve(received.shift())
        return
      }
      const timer = setTimeout(() => {
        pendingResolve = null
        reject(new Error('timeout waiting for fixture response'))
      }, timeoutMs)
      pendingResolve = (message) => {
        clearTimeout(timer)
        resolve(message)
      }
    })

  const send = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const stop = async () => {
    child.stdin.end()
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
  }

  return { child, send, nextMessage, stop }
}

test('fixture 管道：initialize → notifications/initialized → tools/list → tools/call → 未知方法', async () => {
  const fixture = startFixtureProcess()
  try {
    fixture.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-test', version: '1.0.0' },
      },
    })
    const initResponse = await fixture.nextMessage()
    assert.equal(initResponse.id, 1)
    assert.equal(initResponse.result.protocolVersion, '2024-11-05')
    assert.equal(initResponse.result.serverInfo.name, 'dsh-mcp-fixture')
    assert.deepEqual(initResponse.result.capabilities, { tools: { listChanged: false } })

    // 通知（initialized / 未知通知）必须无响应：紧随的工具列表响应 id 必须是 2。
    fixture.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    fixture.send({ jsonrpc: '2.0', method: 'notifications/some-unknown-event' })
    fixture.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    const listResponse = await fixture.nextMessage()
    assert.equal(listResponse.id, 2)
    assert.equal(listResponse.result.tools.length, 1)
    assert.equal(listResponse.result.tools[0].name, 'ping')
    assert.deepEqual(listResponse.result.tools[0].inputSchema, {
      type: 'object',
      properties: {},
    })

    fixture.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ping', arguments: {} },
    })
    const callResponse = await fixture.nextMessage()
    assert.equal(callResponse.id, 3)
    assert.deepEqual(callResponse.result, {
      content: [{ type: 'text', text: 'pong' }],
    })

    fixture.send({ jsonrpc: '2.0', id: 4, method: 'resources/list' })
    const unknownResponse = await fixture.nextMessage()
    assert.equal(unknownResponse.id, 4)
    assert.equal(unknownResponse.error.code, -32601)

    // initialize 回显客户端要求的协议版本（兼容性）。
    fixture.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })
    const secondInit = await fixture.nextMessage()
    assert.equal(secondInit.result.protocolVersion, '2025-06-18')

    // MCP 标准 ping 工具方法。
    fixture.send({ jsonrpc: '2.0', id: 6, method: 'ping' })
    const pingResponse = await fixture.nextMessage()
    assert.equal(pingResponse.id, 6)
    assert.deepEqual(pingResponse.result, {})
  } finally {
    await fixture.stop()
  }
})

test('fixture 管道：非法 JSON 返回 -32700 且进程继续服务', async () => {
  const fixture = startFixtureProcess()
  try {
    fixture.child.stdin.write('this-is-not-json\n')
    const parseError = await fixture.nextMessage()
    assert.equal(parseError.error.code, -32700)

    fixture.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const listResponse = await fixture.nextMessage()
    assert.equal(listResponse.id, 1)
    assert.equal(listResponse.result.tools[0].name, 'ping')
  } finally {
    await fixture.stop()
  }
})
