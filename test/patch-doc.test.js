/**
 * Golden-text tests for the YAML patch editing engine (contract §8.1).
 *
 * Every test that changes a document compares the *whole* resulting text with
 * a hand-written expected fixture, which is the fidelity assertion: any byte
 * change outside the edited node makes the comparison fail.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  editPatchText,
  findMcpRows,
  isJsExpression,
  MCP_CLIENT_MODULE,
  parsePatchText,
  PatchEditError,
  PatchParseError,
} from '../lib/patch-doc.js'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** Read one fixture (input or `expected/...`) as UTF-8 text. */
function fixture(name) {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
}

/** Run `fn` and return the thrown error (or null). */
function captureError(fn) {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}

/** Assert that `fn` throws a `PatchEditError` (or subclass) with `code`. */
function expectPatchError(fn, code) {
  const error = captureError(fn)
  assert.ok(error instanceof Error, `expected an error with code ${code}`)
  assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`)
  return error
}

/** The four MCP rows of the baseline profile fixture. */
function baselineMcpRows() {
  return findMcpRows(parsePatchText(fixture('profile.patch.yml')).rows)
}

// ---------------------------------------------------------------------------
// parsePatchText
// ---------------------------------------------------------------------------

test('parse: baseline profile has two insert blocks with the four MCP rows', () => {
  const { rows, hasJsExpressions } = parsePatchText(fixture('profile.patch.yml'))
  const mcpRows = findMcpRows(rows)
  assert.equal(rows.length, 4)
  assert.deepEqual(
    mcpRows.map((row) => row.id),
    ['mcp-sshs', 'mcp-stitch', 'mcp-dbx', 'mcp-chrome-devtools'],
  )
  assert.deepEqual(
    mcpRows.map((row) => row.moduleName),
    new Array(4).fill(MCP_CLIENT_MODULE),
  )
  assert.deepEqual(
    mcpRows.map((row) => row.rowIndex),
    [0, 1, 2, 0],
  )
  assert.equal(mcpRows[0].insertBlockIndex, mcpRows[1].insertBlockIndex)
  assert.equal(mcpRows[1].insertBlockIndex, mcpRows[2].insertBlockIndex)
  assert.notEqual(mcpRows[2].insertBlockIndex, mcpRows[3].insertBlockIndex)
  assert.equal(hasJsExpressions, true)
  for (const row of mcpRows) assert.equal(row.editableLocation, 'insert')
  for (const row of mcpRows) assert.equal(row.disabled, false)
  assert.equal(hasJsExpressions, true)
})

test('parse: config values and hand-written styles are projected faithfully', () => {
  const [sshs, stitch, dbx, chrome] = baselineMcpRows()
  assert.equal(sshs.config.serverName, 'sshs')
  assert.equal(sshs.config.transport, 'streamable-http')
  assert.deepEqual(sshs.config.toolCallTimeoutMs, { __jsExpr: '60000 * 2' })
  assert.equal(isJsExpression(sshs.config.toolCallTimeoutMs), true)
  assert.equal(stitch.config.toolCallTimeoutMs, 300000)
  assert.deepEqual(dbx.config.headers, { Authorization: 'Bearer fake-dbx-bearer-token' })
  assert.deepEqual(chrome.config.args, ['-y', 'chrome-devtools-mcp@latest', '--headless'])
  assert.equal(chrome.config.command, '/opt/homebrew/bin/npx')
})

test('parse: rows of other modules are returned and findMcpRows filters them', () => {
  const text = [
    '- insert:',
    '    - id: mcp-manager',
    "      name: '@lixiangzhong/dsh-mcp'",
    '    - id: mcp-sshs',
    `      name: '${MCP_CLIENT_MODULE}'`,
    '      config:',
    '        serverName: sshs',
    '        transport: streamable-http',
    '        url: http://127.0.0.1:7333/mcp',
    '',
  ].join('\n')
  const { rows } = parsePatchText(text)
  assert.equal(rows.length, 2)
  assert.deepEqual(
    findMcpRows(rows).map((row) => row.id),
    ['mcp-sshs'],
  )
  // Writes may only target managed rows.
  expectPatchError(() => editPatchText(text, { op: 'toggle', id: 'mcp-manager', enabled: false }), 'NOT_FOUND')
})

test('parse: empty patch documents produce zero rows', () => {
  for (const text of ['', '\n', '# only a comment\n', '[]\n', '[ ]\n']) {
    const parsed = parsePatchText(text)
    assert.deepEqual(parsed.rows, [])
    assert.equal(parsed.hasJsExpressions, false)
  }
})

test('parse: broken or non-sequence YAML raises PARSE', () => {
  for (const name of ['broken.patch.yml', 'top-level-map.patch.yml']) {
    const error = expectPatchError(() => parsePatchText(fixture(name)), 'PARSE')
    assert.ok(error instanceof PatchParseError)
    assert.match(error.message, /解析失败|顶层/)
  }
})

test('parse: disabled expressions are flagged instead of evaluated', () => {
  const row = findMcpRows(parsePatchText(fixture('disabled-expr.patch.yml')).rows)[0]
  assert.equal(row.id, 'mcp-guarded')
  assert.equal(row.disabled, null)
  assert.equal(row.disabledIsExpression, true)
})

// ---------------------------------------------------------------------------
// upsert — create
// ---------------------------------------------------------------------------

test('upsert create: appends to the last MCP insert block, everything else byte-identical', () => {
  const input = fixture('profile.patch.yml')
  const { text, id } = editPatchText(input, {
    op: 'upsert',
    rowId: 'mcp-fixture',
    config: {
      serverName: 'fixture',
      transport: 'stdio',
      command: 'node',
      args: ['/abs/fixtures/stdio-mcp-server.js'],
      toolCallTimeoutMs: 60000,
    },
    enabled: true,
  })
  assert.equal(id, 'mcp-fixture')
  assert.equal(text, fixture('expected/upsert-add.yml'))
  const inserted = [
    '    - id: mcp-fixture',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: fixture',
    '        transport: stdio',
    '        command: node',
    '        args:',
    '          - /abs/fixtures/stdio-mcp-server.js',
    '        toolCallTimeoutMs: 60000',
    '',
  ].join('\n')
  // Removing exactly the inserted lines restores the original document.
  assert.equal(text.replace(inserted, ''), input)
  const mcpRows = findMcpRows(parsePatchText(text).rows)
  assert.equal(mcpRows.length, 5)
  assert.equal(mcpRows.at(-1).id, 'mcp-fixture')
  assert.equal(mcpRows[0].config.toolCallTimeoutMs.__jsExpr, '60000 * 2')
})

test('upsert create: writes row-level disabled for a disabled new row', () => {
  const input = fixture('profile.patch.yml')
  const { text } = editPatchText(input, {
    op: 'upsert',
    rowId: 'mcp-off',
    config: { serverName: 'off', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' },
    enabled: false,
  })
  const inserted = [
    '    - id: mcp-off',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: off',
    '        transport: streamable-http',
    '        url: http://127.0.0.1:1/mcp',
    '      disabled: true',
    '',
  ].join('\n')
  // The new row is the only difference: removing it restores the input bytes.
  assert.equal(text.replace(inserted, ''), input)
  const row = findMcpRows(parsePatchText(text).rows).at(-1)
  assert.equal(row.id, 'mcp-off')
  assert.equal(row.disabled, true)
})

test('upsert create: duplicate row id raises DUPLICATE', () => {
  const input = fixture('profile.patch.yml')
  expectPatchError(
    () =>
      editPatchText(input, {
        op: 'upsert',
        rowId: 'mcp-sshs',
        config: { serverName: 'dup', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' },
        enabled: true,
      }),
    'DUPLICATE',
  )
})

// ---------------------------------------------------------------------------
// upsert — edit
// ---------------------------------------------------------------------------

test('upsert edit: only the differing scalar changes, comments/styles/!!js kept', () => {
  const input = fixture('profile.patch.yml')
  const stitch = baselineMcpRows()[1]
  const config = structuredClone(stitch.config)
  config.headers['X-Goog-Api-Key'] = 'rotated-stitch-api-key'
  const { text, id } = editPatchText(input, {
    op: 'upsert',
    originalId: 'mcp-stitch',
    rowId: 'mcp-stitch',
    config,
    enabled: true,
  })
  assert.equal(id, 'mcp-stitch')
  assert.equal(text, fixture('expected/upsert-edit-header.yml'))
  // Replacing the new secret with the old one restores the original text.
  assert.equal(text.replace('rotated-stitch-api-key', 'fake-stitch-api-key'), input)
})

test('upsert edit: adding a nested field appends it inside the existing mapping', () => {
  const input = fixture('profile.patch.yml')
  const stitch = baselineMcpRows()[1]
  const config = structuredClone(stitch.config)
  config.headers['X-Goog-Project-Id'] = 'demo-project'
  const { text } = editPatchText(input, {
    op: 'upsert',
    originalId: 'mcp-stitch',
    rowId: 'mcp-stitch',
    config,
    enabled: true,
  })
  assert.equal(text, fixture('expected/upsert-edit-header-add.yml'))
  const row = findMcpRows(parsePatchText(text).rows).find((candidate) => candidate.id === 'mcp-stitch')
  assert.deepEqual(row.config.headers, {
    'X-Goog-Api-Key': 'fake-stitch-api-key',
    'X-Goog-Project-Id': 'demo-project',
  })
})

test('upsert edit: transport switch removes cross-transport fields', () => {
  const input = fixture('stdio.patch.yml')
  const { text } = editPatchText(input, {
    op: 'upsert',
    originalId: 'mcp-local',
    rowId: 'mcp-local',
    config: {
      serverName: 'local',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:5225/mcp',
      headers: { Authorization: 'Bearer test-token' },
      toolCallTimeoutMs: 60000,
    },
    enabled: true,
  })
  assert.equal(text, fixture('expected/stdio-to-http.yml'))
  const row = findMcpRows(parsePatchText(text).rows)[0]
  assert.equal(row.config.transport, 'streamable-http')
  assert.deepEqual(row.config, {
    serverName: 'local',
    transport: 'streamable-http',
    toolCallTimeoutMs: 60000,
    url: 'http://127.0.0.1:5225/mcp',
    headers: { Authorization: 'Bearer test-token' },
  })
  for (const gone of ['command:', 'args:', 'cwd:']) assert.ok(!text.includes(gone))
})

test('upsert edit: renaming the row id touches only the id value', () => {
  const input = fixture('profile.patch.yml')
  const stitch = baselineMcpRows()[1]
  const { text, id } = editPatchText(input, {
    op: 'upsert',
    originalId: 'mcp-stitch',
    rowId: 'mcp-stitch-renamed',
    config: stitch.config,
    enabled: true,
  })
  assert.equal(id, 'mcp-stitch-renamed')
  assert.equal(text.replace('    - id: mcp-stitch-renamed', '    - id: mcp-stitch'), input)
  assert.deepEqual(
    findMcpRows(parsePatchText(text).rows).map((row) => row.id),
    ['mcp-sshs', 'mcp-stitch-renamed', 'mcp-dbx', 'mcp-chrome-devtools'],
  )
})

test('upsert edit: identical values are a true no-op (idempotency)', () => {
  const input = fixture('profile.patch.yml')
  for (const row of baselineMcpRows()) {
    const result = editPatchText(input, {
      op: 'upsert',
      originalId: row.id,
      rowId: row.id,
      config: row.config,
      enabled: row.disabled !== true,
    })
    assert.equal(result.text, input, `no-op upsert changed bytes for ${row.id}`)
  }
  // Running the same edit twice is also stable.
  const stitch = baselineMcpRows()[1]
  const config = structuredClone(stitch.config)
  config.toolCallTimeoutMs = 900000
  const once = editPatchText(input, { op: 'upsert', originalId: 'mcp-stitch', rowId: 'mcp-stitch', config, enabled: true }).text
  const twice = editPatchText(once, { op: 'upsert', originalId: 'mcp-stitch', rowId: 'mcp-stitch', config, enabled: true }).text
  assert.equal(twice, once)
})

test('upsert edit: unknown originalId raises NOT_FOUND', () => {
  expectPatchError(
    () =>
      editPatchText(fixture('profile.patch.yml'), {
        op: 'upsert',
        originalId: 'mcp-missing',
        rowId: 'mcp-missing',
        config: { serverName: 'missing', transport: 'stdio', command: 'node' },
        enabled: true,
      }),
    'NOT_FOUND',
  )
})

// ---------------------------------------------------------------------------
// toggle
// ---------------------------------------------------------------------------

test('toggle: disable writes row-level disabled: true', () => {
  const input = fixture('profile.patch.yml')
  const { text, id } = editPatchText(input, { op: 'toggle', id: 'mcp-chrome-devtools', enabled: false })
  assert.equal(id, 'mcp-chrome-devtools')
  assert.equal(text, fixture('expected/toggle-disabled.yml'))
  const row = findMcpRows(parsePatchText(text).rows).at(-1)
  assert.equal(row.disabled, true)
  // Removing the added line restores the original bytes.
  assert.equal(text.replace('      disabled: true\n', ''), input)
})

test('toggle: enable removes the disabled field, disable is idempotent', () => {
  const input = fixture('profile.patch.yml')
  const disabled = editPatchText(input, { op: 'toggle', id: 'mcp-chrome-devtools', enabled: false }).text
  // Enabling again returns exactly the input, and enabling an enabled row is a no-op.
  assert.equal(editPatchText(disabled, { op: 'toggle', id: 'mcp-chrome-devtools', enabled: true }).text, input)
  assert.equal(editPatchText(input, { op: 'toggle', id: 'mcp-chrome-devtools', enabled: true }).text, input)
  // Disabling twice does not append a second field.
  assert.equal(editPatchText(disabled, { op: 'toggle', id: 'mcp-chrome-devtools', enabled: false }).text, disabled)
  assert.equal(findMcpRows(parsePatchText(disabled).rows).at(-1).disabled, true)
})

test('toggle: a !!js disabled expression raises UNSUPPORTED in both directions', () => {
  const input = fixture('disabled-expr.patch.yml')
  for (const enabled of [false, true]) {
    const error = expectPatchError(() => editPatchText(input, { op: 'toggle', id: 'mcp-guarded', enabled }), 'UNSUPPORTED')
    assert.equal(error.field, 'disabled')
  }
  // The expression is still a valid input for parsing.
  assert.equal(findMcpRows(parsePatchText(input).rows)[0].disabledIsExpression, true)
})

test('toggle: unknown row raises NOT_FOUND', () => {
  expectPatchError(
    () => editPatchText(fixture('profile.patch.yml'), { op: 'toggle', id: 'mcp-missing', enabled: false }),
    'NOT_FOUND',
  )
})

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

test('remove: deletes the row and its preceding comment', () => {
  const input = fixture('profile.patch.yml')
  const { text, id } = editPatchText(input, { op: 'remove', id: 'mcp-dbx' })
  assert.equal(id, 'mcp-dbx')
  assert.equal(text, fixture('expected/remove-dbx.yml'))
  assert.ok(!text.includes('mcp-dbx'))
  assert.ok(!text.includes('DBX：'))
  assert.deepEqual(
    findMcpRows(parsePatchText(text).rows).map((row) => row.id),
    ['mcp-sshs', 'mcp-stitch', 'mcp-chrome-devtools'],
  )
})

test('remove: the last row of an insert block removes the whole block', () => {
  const input = fixture('profile.patch.yml')
  const { text } = editPatchText(input, { op: 'remove', id: 'mcp-chrome-devtools' })
  assert.equal(text, fixture('expected/remove-chrome-block.yml'))
  assert.ok(!text.includes('chrome-devtools-mcp'))
  assert.ok(!text.includes('# 用 npx 拉起'))
  assert.equal(findMcpRows(parsePatchText(text).rows).length, 3)
})

test('remove: id-targeted override rows are deleted too, other rows untouched', () => {
  const input = fixture('override.patch.yml')
  const { text } = editPatchText(input, { op: 'remove', id: 'mcp-x' })
  assert.equal(text, fixture('expected/remove-with-override.yml'))
  assert.ok(!text.includes('mcp-x'))
  assert.ok(text.includes('- id: ui-theme'))
  const parsed = parsePatchText(text)
  assert.deepEqual(
    findMcpRows(parsed.rows).map((row) => row.id),
    ['mcp-y'],
  )
  assert.ok(text.includes('        transport: stdio'))
})

test('remove: removing every MCP row leaves a valid patch without MCP rows', () => {
  let text = fixture('profile.patch.yml')
  for (const id of ['mcp-sshs', 'mcp-stitch', 'mcp-dbx', 'mcp-chrome-devtools']) {
    text = editPatchText(text, { op: 'remove', id }).text
  }
  const parsed = parsePatchText(text)
  assert.deepEqual(findMcpRows(parsed.rows), [])
  assert.ok(!text.includes(MCP_CLIENT_MODULE))
  assert.ok(text.includes('agent-default-model'))
  assert.ok(text.includes('ui-theme-extra'))
})

test('remove: unknown or non-managed ids raise NOT_FOUND', () => {
  const input = fixture('profile.patch.yml')
  expectPatchError(() => editPatchText(input, { op: 'remove', id: 'mcp-missing' }), 'NOT_FOUND')
  // A row that exists but belongs to another module is not managed by this plugin.
  expectPatchError(() => editPatchText(input, { op: 'remove', id: 'ui-theme-extra' }), 'NOT_FOUND')
})

// ---------------------------------------------------------------------------
// new insert block creation
// ---------------------------------------------------------------------------

test('create: appends a comment-annotated insert block when none exists', () => {
  const { text } = editPatchText(fixture('no-mcp.patch.yml'), {
    op: 'upsert',
    rowId: 'mcp-fixture',
    config: { serverName: 'fixture', transport: 'stdio', command: 'node', args: ['/abs/fixtures/stdio-mcp-server.js'] },
    enabled: true,
  })
  assert.equal(text, fixture('expected/no-mcp-add.yml'))
  assert.deepEqual(
    findMcpRows(parsePatchText(text).rows).map((row) => row.id),
    ['mcp-fixture'],
  )
})

test('create: empty patch documents get the managed insert block', () => {
  const config = { serverName: 'first', transport: 'streamable-http', url: 'http://127.0.0.1:7333/mcp' }
  for (const empty of ['', '[]\n', '[]']) {
    const { text } = editPatchText(empty, { op: 'upsert', rowId: 'mcp-first', config, enabled: true })
    assert.equal(text, fixture('expected/empty-add.yml'))
    assert.deepEqual(
      findMcpRows(parsePatchText(text).rows).map((row) => row.id),
      ['mcp-first'],
    )
  }
})

// ---------------------------------------------------------------------------
// formatting edge cases
// ---------------------------------------------------------------------------

test('edge: empty scalar values are filled with exactly one separator space', () => {
  const variants = [
    '        command:\n',
    '        command: \n',
    '        command: # todo\n',
    '        command: null\n',
  ]
  for (const commandLine of variants) {
    const input = [
      '- insert:',
      '    - id: mcp-null',
      `      name: '${MCP_CLIENT_MODULE}'`,
      '      config:',
      '        serverName: nul',
      '        transport: stdio',
      commandLine.trimEnd(),
      '',
    ].join('\n')
    const { text } = editPatchText(input, {
      op: 'upsert',
      originalId: 'mcp-null',
      rowId: 'mcp-null',
      config: { serverName: 'nul', transport: 'stdio', command: 'node' },
      enabled: true,
    })
    assert.match(text, /^        command: node( # todo)?$/m)
    const row = findMcpRows(parsePatchText(text).rows)[0]
    assert.equal(row.config.command, 'node')
    if (commandLine.includes('# todo')) assert.ok(text.includes('command: node # todo'))
  }
})

test('edge: a row without config gains one when edited', () => {
  const input = ['- insert:', '    - id: mcp-nc', `      name: '${MCP_CLIENT_MODULE}'`, ''].join('\n')
  const { text } = editPatchText(input, {
    op: 'upsert',
    originalId: 'mcp-nc',
    rowId: 'mcp-nc',
    config: { serverName: 'nc', transport: 'stdio', command: 'node' },
    enabled: true,
  })
  assert.equal(
    text,
    [
      '- insert:',
      '    - id: mcp-nc',
      `      name: '${MCP_CLIENT_MODULE}'`,
      '      config:',
      '        serverName: nc',
      '        transport: stdio',
      '        command: node',
      '',
    ].join('\n'),
  )
  assert.deepEqual(findMcpRows(parsePatchText(text).rows)[0].config, {
    serverName: 'nc',
    transport: 'stdio',
    command: 'node',
  })
})

test('edge: quoted scalar styles are preserved when a value changes', () => {
  const input = [
    '- insert:',
    '    - id: mcp-q',
    `      name: '${MCP_CLIENT_MODULE}'`,
    '      config:',
    '        serverName: q',
    '        transport: streamable-http',
    "        url: 'http://old/mcp'",
    '        headers:',
    '          A: "v1"',
    '',
  ].join('\n')
  const { text } = editPatchText(input, {
    op: 'upsert',
    originalId: 'mcp-q',
    rowId: 'mcp-q',
    config: {
      serverName: 'q',
      transport: 'streamable-http',
      url: 'http://new/mcp',
      headers: { A: 'v2' },
    },
    enabled: true,
  })
  assert.ok(text.includes("url: 'http://new/mcp'"))
  assert.ok(text.includes('A: "v2"'))
  assert.deepEqual(findMcpRows(parsePatchText(text).rows)[0].config.headers, { A: 'v2' })
})

test('edge: a flow-style config mapping is rewritten to block style when edited', () => {
  const input = [
    '- insert:',
    '    - id: mcp-flow',
    `      name: '${MCP_CLIENT_MODULE}'`,
    '      config: {serverName: flow, transport: stdio, command: node}',
    '',
  ].join('\n')
  const { text } = editPatchText(input, {
    op: 'upsert',
    originalId: 'mcp-flow',
    rowId: 'mcp-flow',
    config: { serverName: 'flow', transport: 'stdio', command: 'node', args: ['-y', 'x'] },
    enabled: true,
  })
  assert.deepEqual(findMcpRows(parsePatchText(text).rows)[0].config, {
    serverName: 'flow',
    transport: 'stdio',
    command: 'node',
    args: ['-y', 'x'],
  })
  assert.ok(text.includes('      config:\n        serverName: flow'))
})

test('edge: comments separated from the row by a blank line are not deleted', () => {
  const input = [
    '- insert:',
    '    - id: mcp-a',
    `      name: '${MCP_CLIENT_MODULE}'`,
    '      config:',
    '        serverName: a',
    '        transport: stdio',
    '        command: node',
    '    # kept note',
    '',
    '    - id: mcp-b',
    `      name: '${MCP_CLIENT_MODULE}'`,
    '      config:',
    '        serverName: b',
    '        transport: stdio',
    '        command: node',
    '',
  ].join('\n')
  const { text } = editPatchText(input, { op: 'remove', id: 'mcp-b' })
  assert.ok(text.includes('    # kept note'))
  assert.ok(!text.includes('mcp-b'))
  assert.deepEqual(
    findMcpRows(parsePatchText(text).rows).map((row) => row.id),
    ['mcp-a'],
  )
})

test('edge: an override row placed before the insert block is removed with the row', () => {
  const input = [
    '- id: mcp-a',
    '  disabled: true',
    '# 块注释',
    '- insert:',
    '    - id: mcp-a',
    `      name: '${MCP_CLIENT_MODULE}'`,
    '      config:',
    '        serverName: a',
    '        transport: stdio',
    '        command: node',
    '    - id: mcp-b',
    `      name: '${MCP_CLIENT_MODULE}'`,
    '      config:',
    '        serverName: b',
    '        transport: stdio',
    '        command: node',
    '',
  ].join('\n')
  const { text } = editPatchText(input, { op: 'remove', id: 'mcp-a' })
  assert.ok(!text.includes('- id: mcp-a'))
  assert.ok(text.includes('# 块注释'))
  assert.ok(text.includes('- id: mcp-b'))
  assert.deepEqual(
    findMcpRows(parsePatchText(text).rows).map((row) => row.id),
    ['mcp-b'],
  )
})

test('edge: CRLF documents keep CRLF line endings for inserted lines', () => {
  const lf = fixture('profile.patch.yml')
  const crlf = lf.replace(/\n/g, '\r\n')
  const added = editPatchText(crlf, {
    op: 'upsert',
    rowId: 'mcp-crlf',
    config: { serverName: 'crlf', transport: 'stdio', command: 'node' },
    enabled: true,
  }).text
  assert.ok(!/(?<!\r)\n/.test(added), 'found a bare LF in a CRLF document')
  assert.equal(findMcpRows(parsePatchText(added).rows).length, 5)
  const toggled = editPatchText(added, { op: 'toggle', id: 'mcp-crlf', enabled: false }).text
  assert.ok(toggled.includes(`\r\n      disabled: true\r\n`))
  assert.equal(findMcpRows(parsePatchText(toggled).rows).find((row) => row.id === 'mcp-crlf').disabled, true)
})

test('edge: documents without a trailing newline are still edited safely', () => {
  const input = [
    '- insert:',
    '    - id: mcp-a',
    `      name: '${MCP_CLIENT_MODULE}'`,
    '      config:',
    '        serverName: a',
    '        transport: stdio',
    '        command: node',
  ].join('\n')
  const { text } = editPatchText(input, {
    op: 'upsert',
    rowId: 'mcp-b',
    config: { serverName: 'b', transport: 'stdio', command: 'node' },
    enabled: true,
  })
  assert.deepEqual(
    findMcpRows(parsePatchText(text).rows).map((row) => row.id),
    ['mcp-a', 'mcp-b'],
  )
  assert.ok(text.endsWith('\n'))
})

test('edge: malformed patch structures raise PARSE', () => {
  const malformed = [
    '- just-a-string\n',
    '- insert:\n    key: value\n',
    '- insert:\n    - just-a-row\n',
    '- insert:\n',
  ]
  for (const text of malformed) expectPatchError(() => parsePatchText(text), 'PARSE')
})

test('edge: a non-empty flow top-level sequence cannot receive an insert block', () => {
  expectPatchError(
    () =>
      editPatchText('[{id: x, name: foo}]\n', {
        op: 'upsert',
        rowId: 'mcp-a',
        config: { serverName: 'a', transport: 'stdio', command: 'node' },
        enabled: true,
      }),
    'UNSUPPORTED',
  )
})

test('edge: edit + revert on the baseline profile restores bytes exactly', () => {
  const input = fixture('profile.patch.yml')
  const row = findMcpRows(parsePatchText(input).rows).find((candidate) => candidate.id === 'mcp-dbx')
  const changed = structuredClone(row.config)
  changed.toolCallTimeoutMs = 60000
  const edited = editPatchText(input, {
    op: 'upsert',
    originalId: 'mcp-dbx',
    rowId: 'mcp-dbx',
    config: changed,
    enabled: true,
  }).text
  const revertedConfig = structuredClone(changed)
  revertedConfig.toolCallTimeoutMs = 120000
  const reverted = editPatchText(edited, {
    op: 'upsert',
    originalId: 'mcp-dbx',
    rowId: 'mcp-dbx',
    config: revertedConfig,
    enabled: true,
  }).text
  assert.equal(reverted, input)
})

// ---------------------------------------------------------------------------
// validation and error mapping
// ---------------------------------------------------------------------------

test('edit: invalid argument shapes raise INVALID_ARGUMENT with a field', () => {
  const input = fixture('profile.patch.yml')
  const cases = [
    () => editPatchText(input, { op: 'nope' }),
    () => editPatchText(input, { op: 'remove' }),
    () => editPatchText(input, { op: 'toggle', id: 'mcp-sshs', enabled: 'yes' }),
    () => editPatchText(input, { op: 'upsert', rowId: 'mcp-new', config: null, enabled: true }),
    () => editPatchText(input, { op: 'upsert', rowId: '', config: {}, enabled: true }),
    () =>
      editPatchText(input, {
        op: 'upsert',
        rowId: 'mcp-new',
        config: { serverName: 'new', transport: 'stdio', command: Number.NaN },
        enabled: true,
      }),
    () =>
      editPatchText(input, {
        op: 'upsert',
        rowId: 'mcp-new',
        config: { serverName: 'new', transport: 'stdio', command: 'node', args: [undefined] },
        enabled: true,
      }),
  ]
  for (const run of cases) {
    const error = expectPatchError(run, 'INVALID_ARGUMENT')
    assert.equal(typeof error.field, 'string')
  }
})

test('edit: broken patch text raises PARSE through the edit entry point', () => {
  const error = expectPatchError(
    () => editPatchText(fixture('broken.patch.yml'), { op: 'toggle', id: 'mcp-sshs', enabled: false }),
    'PARSE',
  )
  assert.ok(error instanceof PatchEditError)
})

test('edit: duplicate row ids in the document raise DUPLICATE on lookup', () => {
  const duplicateText = [
    '- insert:',
    '    - id: mcp-dupe',
    `      name: '${MCP_CLIENT_MODULE}'`,
    '      config:',
    '        serverName: dupe',
    '        transport: stdio',
    '        command: node',
    '    - id: mcp-dupe',
    `      name: '${MCP_CLIENT_MODULE}'`,
    '      config:',
    '        serverName: dupe2',
    '        transport: stdio',
    '        command: node',
    '',
  ].join('\n')
  for (const operation of [
    { op: 'toggle', id: 'mcp-dupe', enabled: false },
    { op: 'remove', id: 'mcp-dupe' },
    { op: 'upsert', originalId: 'mcp-dupe', rowId: 'mcp-dupe', config: { serverName: 'dupe', transport: 'stdio', command: 'node' }, enabled: true },
  ]) {
    expectPatchError(() => editPatchText(duplicateText, operation), 'DUPLICATE')
  }
})

test('edit: non-string input text is rejected', () => {
  expectPatchError(() => editPatchText(null, { op: 'remove', id: 'x' }), 'INVALID_ARGUMENT')
  expectPatchError(() => parsePatchText(42), 'PARSE')
})

// ---------------------------------------------------------------------------
// cross-cutting fidelity
// ---------------------------------------------------------------------------

test('fidelity: every golden expected output parses back to the intended rows', () => {
  const expectedIds = {
    'upsert-add.yml': ['mcp-sshs', 'mcp-stitch', 'mcp-dbx', 'mcp-chrome-devtools', 'mcp-fixture'],
    'upsert-edit-header.yml': ['mcp-sshs', 'mcp-stitch', 'mcp-dbx', 'mcp-chrome-devtools'],
    'upsert-edit-header-add.yml': ['mcp-sshs', 'mcp-stitch', 'mcp-dbx', 'mcp-chrome-devtools'],
    'toggle-disabled.yml': ['mcp-sshs', 'mcp-stitch', 'mcp-dbx', 'mcp-chrome-devtools'],
    'remove-dbx.yml': ['mcp-sshs', 'mcp-stitch', 'mcp-chrome-devtools'],
    'remove-chrome-block.yml': ['mcp-sshs', 'mcp-stitch', 'mcp-dbx'],
    'remove-with-override.yml': ['mcp-y'],
    'stdio-to-http.yml': ['mcp-local'],
    'no-mcp-add.yml': ['mcp-fixture'],
    'empty-add.yml': ['mcp-first'],
  }
  for (const [name, ids] of Object.entries(expectedIds)) {
    const parsed = parsePatchText(fixture(`expected/${name}`))
    assert.deepEqual(
      findMcpRows(parsed.rows).map((row) => row.id),
      ids,
      `unexpected rows in expected/${name}`,
    )
  }
})

test('fidelity: operations never re-serialize untouched insert blocks', () => {
  const input = fixture('profile.patch.yml')
  const [sshs, stitch, dbx, chrome] = baselineMcpRows()
  const config = structuredClone(stitch.config)
  config.serverName = 'stitch-renamed'
  const { text } = editPatchText(input, {
    op: 'upsert',
    originalId: 'mcp-stitch',
    rowId: 'mcp-stitch',
    config,
    enabled: true,
  })
  // The sshs row (including its hand-written `!!js` value) is untouched.
  assert.ok(text.includes('        toolCallTimeoutMs: !!js 60000 * 2'))
  // The multi-line plain scalar of the dbx row is untouched.
  assert.ok(text.includes('          Authorization: Bearer\n            fake-dbx-bearer-token'))
  // The hand-formatted flow sequence of the chrome row is untouched.
  assert.ok(text.includes("            '-y',\n            'chrome-devtools-mcp@latest',\n            '--headless'"))
  for (const untouched of ['mcp-dbx', 'mcp-chrome-devtools']) {
    assert.ok(text.includes(`- id: ${untouched}`))
  }
  assert.equal(text.includes('mcp-stitch-renamed'), false)
  assert.ok(text.includes('serverName: stitch-renamed'))
  assert.equal(sshs.config.serverName, 'sshs')
  assert.equal(dbx.config.toolCallTimeoutMs, 120000)
  assert.equal(chrome.config.toolCallTimeoutMs, 180000)
})
