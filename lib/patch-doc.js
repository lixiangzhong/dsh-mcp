/**
 * Pure YAML document engine for DSH profile/bundle Loader patch files.
 *
 * Fidelity strategy: the document is parsed with `yaml` only to *locate* nodes
 * (absolute source ranges). Every edit is then a splice on the original text,
 * so bytes outside the edited node are never re-serialized and therefore never
 * change (comments, quoted styles, `!!js` tags, hand-formatted flow sequences,
 * multi-line plain scalars, blank lines, row order).
 *
 * Only `yaml` and the Node.js standard library are used; this module must stay
 * free of `@deepseek-ai/*` imports.
 *
 * Value convention for `!!js` expressions: a scalar with tag
 * `tag:yaml.org,2002:js` is exposed as `{ __jsExpr: '<source>' }` so that the
 * row model can mask it and round-trip it unchanged.
 *
 * @see docs/contracts/host-api.md section 8.1
 */
import { isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml'

/** Module specifier of the native MCP client rows this plugin manages. */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Tag shorthand `!!js` expands to this URI. */
const JS_EXPRESSION_TAG = 'tag:yaml.org,2002:js'

/** Comment inserted above an `insert:` block created by this plugin. */
const NEW_INSERT_BLOCK_COMMENT = '# MCP servers managed by dsh-mcp'

/** Key names used by the Loader patch dialect. */
const INSERT_KEY = 'insert'
const ID_KEY = 'id'
const NAME_KEY = 'name'
const CONFIG_KEY = 'config'
const DISABLED_KEY = 'disabled'

/** `editableLocation` value for rows defined inside an `insert:` list. */
const EDITABLE_LOCATION = 'insert'

/** YAML block indentation used by DSH patch files. */
const INDENT_WIDTH = 2

/** Canonical field order when rendering a brand-new MCP client config. */
const ROW_CONFIG_FIELD_ORDER = [
  'serverName',
  'transport',
  'command',
  'args',
  'cwd',
  'env',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'maxInstructionBytes',
  'failOnStartupError',
  'reconnect',
]

/** Plain scalar keys that must be quoted to keep their string value. */
const RESERVED_KEY_PATTERN = /^(?:true|false|null|yes|no|on|off|~)$/i

/** A mapping key that can be emitted as a plain YAML scalar. */
const PLAIN_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * Raised when a patch text cannot be parsed (contract code `PARSE`).
 */
export class PatchParseError extends Error {
  /**
   * @param {string} message Human readable diagnostic.
   */
  constructor(message) {
    super(message)
    this.name = 'PatchParseError'
    this.code = 'PARSE'
  }
}

/**
 * Raised when an edit cannot be applied. `code` is one of
 * `PARSE | NOT_FOUND | UNSUPPORTED | DUPLICATE | INVALID_ARGUMENT`.
 */
export class PatchEditError extends Error {
  /**
   * @param {'PARSE' | 'NOT_FOUND' | 'UNSUPPORTED' | 'DUPLICATE' | 'INVALID_ARGUMENT'} code Contract error code.
   * @param {string} message Human readable diagnostic.
   * @param {{ field?: string }} [options] Optional structured detail.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'PatchEditError'
    this.code = code
    if (options.field !== undefined) this.field = options.field
  }
}

/**
 * Whether a value is the lazy representation of a YAML `!!js` expression.
 * @param {unknown} value Candidate value.
 * @returns {boolean} True for `{ __jsExpr: string }`.
 */
export function isJsExpression(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === '__jsExpr' && typeof value.__jsExpr === 'string'
}

/**
 * Pick the managed MCP client rows out of `parsePatchText(...).rows`.
 * @param {Array<{ moduleName: string | null }>} rows Parsed insert rows.
 * @returns {Array<object>} Rows whose module is `@deepseek-ai/dsh-mcp-client`.
 */
export function findMcpRows(rows) {
  return rows.filter((row) => row.moduleName === MCP_CLIENT_MODULE)
}

/**
 * Parse a patch text into its managed-row projection.
 * @param {string} text Patch file contents.
 * @returns {{ rows: object[], hasJsExpressions: boolean }} Projection.
 * @throws {PatchParseError} When the text is not a Loader patch sequence.
 */
export function parsePatchText(text) {
  const document = loadPatchDocument(requirePatchText(text, 'parse'))
  const rows = []
  for (const block of document.blocks) {
    for (const row of block.rows) rows.push(row.patchRow)
  }
  return { rows, hasJsExpressions: document.hasJsExpressions }
}

/**
 * Apply exactly one edit operation to a patch text.
 *
 * Supported operations:
 * - `{ op: 'upsert', originalId?, rowId, config, enabled }`
 * - `{ op: 'remove', id }`
 * - `{ op: 'toggle', id, enabled }`
 *
 * @param {string} text Patch file contents.
 * @param {object} operation Operation descriptor.
 * @returns {{ text: string, id: string }} Edited text (byte-identical when the
 *   operation is a no-op) and the row id the operation was applied to.
 * @throws {PatchEditError} On parse or edit failures.
 */
export function editPatchText(text, operation) {
  const source = requirePatchText(text, 'edit')
  if (!isPlainObject(operation)) {
    throw new PatchEditError('INVALID_ARGUMENT', 'operation 必须是对象', { field: 'operation' })
  }
  const state = createEditState(source, loadPatchDocumentForEdit(source))
  switch (operation.op) {
    case 'upsert':
      return upsertOperation(state, operation)
    case 'remove':
      return removeOperation(state, operation)
    case 'toggle':
      return toggleOperation(state, operation)
    default:
      throw new PatchEditError('INVALID_ARGUMENT', `未知操作：${String(operation.op)}`, { field: 'op' })
  }
}

// ---------------------------------------------------------------------------
// Document loading
// ---------------------------------------------------------------------------

/**
 * Custom tag so `!!js` scalars parse without warnings and keep their source.
 * `resolve` returns the scalar text itself; the node tag marks it as an
 * expression, and the value is exposed as `{ __jsExpr }` by `nodeToValue`.
 */
const jsExpressionTag = {
  tag: JS_EXPRESSION_TAG,
  resolve: (source) => source,
}

/**
 * Turn a parsed document into the internal projection used by the editor.
 * @param {string} text Patch file contents.
 * @returns {object} Internal document description.
 * @throws {PatchParseError} On parse or structural errors.
 */
function loadPatchDocument(text) {
  let document
  try {
    document = parseDocument(text, { customTags: [jsExpressionTag], prettyErrors: false })
  } catch (error) {
    throw new PatchParseError(`patch YAML 解析失败：${errorMessage(error)}`)
  }
  if (document.errors.length > 0) {
    throw new PatchParseError(`patch YAML 解析失败：${document.errors[0].message}`)
  }
  const blocks = []
  const overrides = []
  const contents = document.contents
  if (contents !== null && contents !== undefined) {
    if (!isSeq(contents)) throw new PatchParseError('patch 顶层必须是 YAML 序列')
    contents.items.forEach((item, topIndex) => {
      if (!isMap(item)) throw new PatchParseError(`patch 顶层第 ${topIndex + 1} 项必须是映射`)
      const insertPair = findPair(item, INSERT_KEY)
      if (insertPair !== undefined) {
        const insertSeq = insertPair.value
        if (!isSeq(insertSeq)) {
          throw new PatchParseError(`patch 顶层第 ${topIndex + 1} 项的 insert 必须是序列`)
        }
        const block = { node: item, insertSeq, rows: [] }
        insertSeq.items.forEach((rowNode, rowIndex) => {
          if (!isMap(rowNode)) {
            throw new PatchParseError(`patch 顶层第 ${topIndex + 1} 项 insert 的第 ${rowIndex + 1} 行必须是映射`)
          }
          block.rows.push(describeRow(rowNode, topIndex, rowIndex))
        })
        blocks.push(block)
        return
      }
      const id = stringFieldValue(item, ID_KEY)
      if (id !== null) overrides.push({ node: item, id })
    })
  }
  return {
    topSeq: contents,
    blocks,
    overrides,
    hasJsExpressions: containsJsExpression(contents),
  }
}

/**
 * Load a document for editing, mapping parse failures to `PatchEditError`.
 * @param {string} text Patch file contents.
 * @returns {object} Internal document description.
 */
function loadPatchDocumentForEdit(text) {
  try {
    return loadPatchDocument(text)
  } catch (error) {
    if (error instanceof PatchParseError) throw new PatchEditError('PARSE', error.message)
    throw error
  }
}

/**
 * Describe one insert row (node reference + plain projection).
 * @param {import('yaml').YAMLMap} node Row mapping node.
 * @param {number} insertBlockIndex Top-level index of the owning `- insert:` item.
 * @param {number} rowIndex Index inside the insert sequence.
 * @returns {object} Internal row description.
 */
function describeRow(node, insertBlockIndex, rowIndex) {
  const id = stringFieldValue(node, ID_KEY)
  const moduleName = stringFieldValue(node, NAME_KEY)
  const configPair = findPair(node, CONFIG_KEY)
  const config = configPair === undefined ? null : nodeToValue(configPair.value)
  const disabledPair = findPair(node, DISABLED_KEY)
  let disabled = false
  let disabledIsExpression = false
  if (disabledPair !== undefined) {
    if (isJsExpressionNode(disabledPair.value)) {
      disabled = null
      disabledIsExpression = true
    } else {
      disabled = isScalar(disabledPair.value) && disabledPair.value.value === true
    }
  }
  return {
    node,
    id,
    moduleName,
    config,
    disabled,
    disabledIsExpression,
    patchRow: {
      id,
      insertBlockIndex,
      rowIndex,
      moduleName,
      config,
      disabled,
      disabledIsExpression,
      editableLocation: EDITABLE_LOCATION,
    },
  }
}

// ---------------------------------------------------------------------------
// YAML node helpers
// ---------------------------------------------------------------------------

/**
 * Find a mapping pair by (string) key.
 * @param {import('yaml').YAMLMap} map Mapping node.
 * @param {string} key Key to look up.
 * @returns {import('yaml').Pair | undefined} Matching pair.
 */
function findPair(map, key) {
  return map.items.find((pair) => isScalar(pair.key) && String(pair.key.value) === key)
}

/**
 * Read a scalar field as a string.
 * @param {import('yaml').YAMLMap} map Mapping node.
 * @param {string} key Key to look up.
 * @returns {string | null} Field value when it is a plain string, else null.
 */
function stringFieldValue(map, key) {
  const pair = findPair(map, key)
  if (pair === undefined || !isScalar(pair.value)) return null
  const value = pair.value.value
  return typeof value === 'string' ? value : null
}

/**
 * Whether a node is a `!!js` expression scalar.
 * @param {unknown} node YAML node.
 * @returns {boolean} True when the node carries the `!!js` tag.
 */
function isJsExpressionNode(node) {
  return isScalar(node) && node.tag === JS_EXPRESSION_TAG
}

/**
 * Convert a YAML node into plain JavaScript values (expressions stay lazy).
 * @param {unknown} node YAML node.
 * @returns {unknown} Plain value.
 */
function nodeToValue(node) {
  if (node === null || node === undefined) return null
  if (isScalar(node)) {
    if (node.tag === JS_EXPRESSION_TAG) return { __jsExpr: String(node.value ?? '') }
    return node.value ?? null
  }
  if (isSeq(node)) return node.items.map((item) => nodeToValue(item))
  if (isMap(node)) {
    const result = {}
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key)
      result[key] = nodeToValue(pair.value)
    }
    return result
  }
  return null
}

/**
 * Recursively look for any `!!js` scalar in a node tree.
 * @param {unknown} node YAML node.
 * @returns {boolean} True when an expression is present.
 */
function containsJsExpression(node) {
  if (node === null || node === undefined) return false
  if (isScalar(node)) return node.tag === JS_EXPRESSION_TAG
  if (isSeq(node)) return node.items.some((item) => containsJsExpression(item))
  if (isMap(node)) return node.items.some((pair) => containsJsExpression(pair.value))
  return false
}

// ---------------------------------------------------------------------------
// Edit state and text plumbing
// ---------------------------------------------------------------------------

/**
 * Create the mutable state of one edit pass.
 * @param {string} text Original patch text.
 * @param {object} documentDescription Parsed document projection.
 * @returns {object} Edit state.
 */
function createEditState(text, documentDescription) {
  return {
    text,
    document: documentDescription,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    edits: [],
    insertions: new Map(),
    editSeq: 0,
  }
}

/**
 * Register one replacement/removal splice.
 * @param {object} state Edit state.
 * @param {number} start Start offset in the original text.
 * @param {number} end End offset (exclusive).
 * @param {string} replacement Replacement text.
 */
function planEdit(state, start, end, replacement) {
  state.edits.push({ start, end, text: replacement, seq: state.editSeq++ })
}

/**
 * Register lines to insert at one offset. Several plans at the same offset are
 * merged so that only one splice (with one separator newline) is produced.
 * @param {object} state Edit state.
 * @param {number} offset Insertion offset.
 * @param {string[]} lines Lines without trailing newline.
 */
function planInsertedLines(state, offset, lines) {
  if (lines.length === 0) return
  const existing = state.insertions.get(offset)
  if (existing === undefined) state.insertions.set(offset, [...lines])
  else existing.push(...lines)
}

/**
 * Apply every planned edit and return the new text.
 * @param {object} state Edit state.
 * @returns {string} Edited text.
 */
function finalizeEdits(state) {
  const allEdits = [...state.edits]
  for (const [offset, lines] of state.insertions) {
    // A line separator is only needed when appending after non-empty text that
    // does not already end at a line boundary.
    const needsLeadingEol = offset > 0 && state.text[offset - 1] !== '\n'
    allEdits.push({
      start: offset,
      end: offset,
      text: (needsLeadingEol ? state.eol : '') + lines.join(state.eol) + state.eol,
      seq: Number.MAX_SAFE_INTEGER - offset,
    })
  }
  if (allEdits.length === 0) return state.text
  // Apply from the end so earlier offsets stay valid; equal offsets keep plan
  // order because they are applied in reverse registration order.
  allEdits.sort((left, right) => right.start - left.start || right.seq - left.seq)
  let cursor = Number.POSITIVE_INFINITY
  let next = state.text
  for (const edit of allEdits) {
    if (edit.end > cursor) {
      throw new Error('patch-doc: internal overlapping edit')
    }
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
    cursor = Math.min(cursor, edit.start)
  }
  return next
}

/**
 * Offset of the first character of the line containing `index`.
 * @param {string} text Source text.
 * @param {number} index Absolute offset.
 * @returns {number} Line start offset.
 */
function lineStartOf(text, index) {
  return text.lastIndexOf('\n', index - 1) + 1
}

/**
 * Column (0-based) of an absolute offset within its line.
 * @param {string} text Source text.
 * @param {number} index Absolute offset.
 * @returns {number} Column.
 */
function indentAt(text, index) {
  return index - lineStartOf(text, index)
}

/**
 * Indentation string for a column.
 * @param {number} column Column count.
 * @returns {string} Spaces.
 */
function spaces(column) {
  return ' '.repeat(Math.max(0, column))
}

/**
 * Walk the offset backwards over comment-only lines directly above `contentIndex`.
 * @param {string} text Source text.
 * @param {number} contentIndex Offset of the node's first content character.
 * @returns {number} Offset of the first comment line (or the content line).
 */
function lineStartWithComments(text, contentIndex) {
  let start = lineStartOf(text, contentIndex)
  while (start > 0) {
    const previousLineEnd = start - 1
    const previousLineStart = text.lastIndexOf('\n', previousLineEnd - 1) + 1
    const previousLine = text.slice(previousLineStart, previousLineEnd)
    if (!/^[ \t]*#/.test(previousLine)) break
    start = previousLineStart
  }
  return start
}

/**
 * Move an end offset back to a line boundary (keeps the line's newline).
 * @param {string} text Source text.
 * @param {number} end Offset to normalize.
 * @returns {number} Offset just past the newline (or end of text).
 */
function extendToLineEnd(text, end) {
  if (end === 0 || end >= text.length || text[end - 1] === '\n') return end
  const newline = text.indexOf('\n', end)
  return newline === -1 ? text.length : newline + 1
}

/**
 * Offset just after the `:` that introduces a mapping value.
 * @param {string} text Source text.
 * @param {import('yaml').Scalar} keyNode Mapping key node.
 * @returns {number} Offset after the colon (or after the key as a fallback).
 */
function colonEndOffset(text, keyNode) {
  let index = keyNode.range[1]
  while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1
  return text[index] === ':' ? index + 1 : keyNode.range[1]
}

/**
 * Whether a collection node starts its own line (block style value).
 * @param {string} text Source text.
 * @param {unknown} node YAML node.
 * @returns {boolean} True for block-style mappings/sequences.
 */
function startsBlockValue(text, node) {
  if (!isMap(node) && !isSeq(node)) return false
  if (node.flow) return false
  const start = node.range[0]
  return text.slice(lineStartOf(text, start), start).trim() === ''
}

/**
 * Whether a node's range already swallows a trailing newline.
 * @param {string} text Source text.
 * @param {unknown} node YAML node.
 * @returns {boolean} True when the byte before the value end is a newline.
 */
function valueEndsWithNewline(text, node) {
  const end = isScalar(node) ? node.range[1] : node.range[2]
  return end > 0 && text[end - 1] === '\n'
}

/**
 * Whether a scalar node has no source text of its own (`key:` with no value).
 * Such nodes have a zero-width range sitting after the colon (or before a
 * trailing comment), so replacements must remove the separating spaces first.
 * @param {string} text Source text.
 * @param {unknown} node YAML node.
 * @returns {boolean} True for empty values.
 */
function isEmptyValueNode(text, node) {
  if (!isScalar(node) || node.range === undefined) return false
  if (node.value !== null && node.value !== undefined) return false
  return text.slice(node.range[0], node.range[1]) === ''
}

/**
 * Replacement window for an empty (`key:`) value: drop the spaces after the
 * colon, and keep one separating space before a trailing comment.
 * @param {object} state Edit state.
 * @param {import('yaml').Scalar} keyNode Mapping key node.
 * @param {import('yaml').Scalar} node Empty value node.
 * @returns {{ start: number, end: number, trailingSpace: string }} Window.
 */
function emptyValueWindow(state, keyNode, node) {
  const start = colonEndOffset(state.text, keyNode)
  const end = node.range[0]
  return { start, end, trailingSpace: state.text[end] === '#' ? ' ' : '' }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Normalize one `upsert` operation and apply it.
 * @param {object} state Edit state.
 * @param {object} operation Raw operation.
 * @returns {{ text: string, id: string }} Result.
 */
function upsertOperation(state, operation) {
  const rowId = requireNonEmptyString(operation.rowId, 'rowId')
  const originalId = operation.originalId === undefined ? undefined : requireNonEmptyString(operation.originalId, 'originalId')
  if (typeof operation.enabled !== 'boolean') {
    throw new PatchEditError('INVALID_ARGUMENT', 'enabled 必须是布尔值', { field: 'enabled' })
  }
  const config = requireConfigObject(operation.config)
  validateConfigValue(config, 'config')
  if (originalId === undefined) insertNewRow(state, rowId, config, operation.enabled)
  else updateExistingRow(state, originalId, rowId, config, operation.enabled)
  return { text: finalizeEdits(state), id: rowId }
}

/**
 * Normalize one `remove` operation and apply it.
 * @param {object} state Edit state.
 * @param {object} operation Raw operation.
 * @returns {{ text: string, id: string }} Result.
 */
function removeOperation(state, operation) {
  const id = requireNonEmptyString(operation.id, 'id')
  const row = findSingleManagedRow(state.document, id)
  const block = state.document.blocks.find((candidate) => candidate.rows.includes(row))
  if (block.rows.length === 1) planRemoveTopItem(state, block.node, block.insertSeq.range[2])
  else planRemoveTopItem(state, row.node)
  for (const override of state.document.overrides) {
    if (override.id === id) planRemoveTopItem(state, override.node)
  }
  return { text: finalizeEdits(state), id }
}

/**
 * Normalize one `toggle` operation and apply it.
 * @param {object} state Edit state.
 * @param {object} operation Raw operation.
 * @returns {{ text: string, id: string }} Result.
 */
function toggleOperation(state, operation) {
  const id = requireNonEmptyString(operation.id, 'id')
  if (typeof operation.enabled !== 'boolean') {
    throw new PatchEditError('INVALID_ARGUMENT', 'enabled 必须是布尔值', { field: 'enabled' })
  }
  const row = findSingleManagedRow(state.document, id)
  planDisabledChange(state, row, operation.enabled)
  return { text: finalizeEdits(state), id }
}

/**
 * Append a new row to the last insert block that holds MCP client rows, or
 * create a fresh `- insert:` block when the document has none.
 * @param {object} state Edit state.
 * @param {string} rowId New Loader row id.
 * @param {object} config MCP client config.
 * @param {boolean} enabled Whether the row is enabled.
 */
function insertNewRow(state, rowId, config, enabled) {
  for (const block of state.document.blocks) {
    if (block.rows.some((row) => row.id === rowId)) {
      throw new PatchEditError('DUPLICATE', `行 id "${rowId}" 已存在`, { field: 'rowId' })
    }
  }
  const targetBlock = [...state.document.blocks]
    .reverse()
    .find((block) => block.rows.some((row) => row.moduleName === MCP_CLIENT_MODULE))
  if (targetBlock === undefined) {
    planNewInsertBlock(state, rowId, config, enabled)
    return
  }
  const lastRow = targetBlock.rows[targetBlock.rows.length - 1]
  const layout = measureRowLayout(state.text, lastRow.node)
  const lines = renderNewRowLines(state, rowId, config, enabled, layout)
  planInsertedLines(state, targetBlock.insertSeq.range[2], lines)
}

/**
 * Edit an existing managed row in place (config diff + id rename + disabled).
 * @param {object} state Edit state.
 * @param {string} originalId Id of the row being edited.
 * @param {string} rowId Target row id (equals `originalId` unless renaming).
 * @param {object} config Complete desired config.
 * @param {boolean} enabled Desired enabled state.
 */
function updateExistingRow(state, originalId, rowId, config, enabled) {
  const row = findSingleManagedRow(state.document, originalId)
  if (rowId !== originalId) {
    for (const block of state.document.blocks) {
      for (const candidate of block.rows) {
        if (candidate !== row && candidate.id === rowId) {
          throw new PatchEditError('DUPLICATE', `行 id "${rowId}" 已存在`, { field: 'rowId' })
        }
      }
    }
    const idPair = findPair(row.node, ID_KEY)
    if (idPair !== undefined) replaceScalarValue(state, idPair, rowId)
  }
  applyConfigDiff(state, row, config)
  planDisabledChange(state, row, enabled)
}

/**
 * Recursively edit a row's `config` mapping with a minimal diff.
 * @param {object} state Edit state.
 * @param {object} row Internal row description.
 * @param {object} config Complete desired config.
 */
function applyConfigDiff(state, row, config) {
  const pair = findPair(row.node, CONFIG_KEY)
  if (pair === undefined) {
    if (orderedConfigKeys(config).filter((key) => config[key] !== undefined).length === 0) return
    const entryIndent = indentAt(state.text, row.node.range[0])
    planInsertedLines(state, row.node.range[2], renderMapEntryLines(state, CONFIG_KEY, config, entryIndent))
    return
  }
  const context = { keyNode: pair.key, entryIndent: indentAt(state.text, pair.key.range[0]) }
  applyValueDiff(state, pair.value, config, context)
}

/**
 * Plan the `disabled` field change for a row.
 * @param {object} state Edit state.
 * @param {object} row Internal row description.
 * @param {boolean} enabled Desired enabled state.
 */
function planDisabledChange(state, row, enabled) {
  const pair = findPair(row.node, DISABLED_KEY)
  if (pair === undefined) {
    if (enabled) return
    const entryIndent = indentAt(state.text, row.node.range[0])
    planInsertedLines(state, row.node.range[2], [`${spaces(entryIndent)}${DISABLED_KEY}: true`])
    return
  }
  if (isJsExpressionNode(pair.value)) {
    throw new PatchEditError(
      'UNSUPPORTED',
      `行 "${row.id ?? ''}" 的 disabled 是 !!js 表达式，管理页无法安全改写，请手动编辑 patch`,
      { field: DISABLED_KEY },
    )
  }
  if (enabled) {
    planPairRemoval(state, pair)
    return
  }
  const alreadyDisabled = isScalar(pair.value) && pair.value.value === true
  if (!alreadyDisabled) replaceScalarValue(state, pair, true)
}

/**
 * Find the one managed row with the given id.
 * @param {object} documentDescription Parsed document projection.
 * @param {string} id Row id.
 * @returns {object} Internal row description.
 */
function findSingleManagedRow(documentDescription, id) {
  const matches = []
  for (const block of documentDescription.blocks) {
    for (const row of block.rows) {
      if (row.id === id) matches.push(row)
    }
  }
  if (matches.length === 0) throw new PatchEditError('NOT_FOUND', `行 "${id}" 不存在`)
  if (matches.length > 1) throw new PatchEditError('DUPLICATE', `行 id "${id}" 在 patch 中重复出现`)
  const row = matches[0]
  if (row.moduleName !== MCP_CLIENT_MODULE) {
    throw new PatchEditError('NOT_FOUND', `行 "${id}" 不是 ${MCP_CLIENT_MODULE} 行，不受本插件管理`)
  }
  return row
}

// ---------------------------------------------------------------------------
// Value diff planning
// ---------------------------------------------------------------------------

/**
 * Apply a minimal diff between a value node and its desired plain value.
 * @param {object} state Edit state.
 * @param {import('yaml').Node | null} node Current value node.
 * @param {unknown} desired Desired plain value.
 * @param {{ keyNode: import('yaml').Scalar, entryIndent: number }} context Value context.
 */
function applyValueDiff(state, node, desired, context) {
  if (valuesEqual(nodeToValue(node), desired)) return
  if (isPlainObject(desired) && isMap(node) && !node.flow && !isJsExpression(desired)) {
    const desiredKeys = orderedConfigKeys(desired).filter((key) => desired[key] !== undefined)
    if (desiredKeys.length === 0) {
      replaceValueWithInline(state, node, '{}', context)
      return
    }
    diffMapping(state, node, desired, context)
    return
  }
  replaceValue(state, node, desired, context)
}

/**
 * Minimal diff for a block mapping node against a desired plain object.
 * @param {object} state Edit state.
 * @param {import('yaml').YAMLMap} mapNode Current mapping node.
 * @param {object} desired Desired plain object.
 * @param {{ keyNode: import('yaml').Scalar, entryIndent: number }} context Value context.
 */
function diffMapping(state, mapNode, desired, context) {
  const entryIndent = indentAt(state.text, mapNode.range[0])
  const desiredKeys = orderedConfigKeys(desired).filter((key) => desired[key] !== undefined)
  const desiredSet = new Set(desiredKeys)
  for (const pair of mapNode.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined
    if (key !== undefined && !desiredSet.has(key)) planPairRemoval(state, pair)
  }
  for (const pair of mapNode.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined
    if (key === undefined || !desiredSet.has(key)) continue
    applyValueDiff(state, pair.value, desired[key], {
      keyNode: pair.key,
      entryIndent,
    })
  }
  const existingKeys = new Set(
    mapNode.items.filter((pair) => isScalar(pair.key)).map((pair) => String(pair.key.value)),
  )
  const newKeys = desiredKeys.filter((key) => !existingKeys.has(key))
  if (newKeys.length === 0) return
  const lines = []
  for (const key of newKeys) {
    lines.push(...renderMapEntryLines(state, key, desired[key], entryIndent))
  }
  planInsertedLines(state, mapNode.range[2], lines)
}

/**
 * Replace a value node with an inline scalar/flow rendering.
 * @param {object} state Edit state.
 * @param {import('yaml').Node} node Current value node.
 * @param {string} inlineText Inline YAML text.
 * @param {{ keyNode: import('yaml').Scalar }} context Value context.
 */
function replaceValueWithInline(state, node, inlineText, context) {
  const text = state.text
  if (startsBlockValue(text, node)) {
    const start = colonEndOffset(text, context.keyNode)
    const end = node.range[2]
    const trailingEol = end > 0 && text[end - 1] === '\n' ? state.eol : ''
    planEdit(state, start, end, ` ${inlineText}${trailingEol}`)
    return
  }
  if (isEmptyValueNode(text, node)) {
    const { start, end, trailingSpace } = emptyValueWindow(state, context.keyNode, node)
    planEdit(state, start, end, ` ${inlineText}${trailingSpace}`)
    return
  }
  if (valueEndsWithNewline(text, node)) {
    // Block scalar: the node range swallows the trailing newline.
    planEdit(state, node.range[0], node.range[2], `${inlineText}${state.eol}`)
    return
  }
  planEdit(state, node.range[0], node.range[1], inlineText)
}

/**
 * Replace a value node with a block rendering (`lines` already indented).
 * @param {object} state Edit state.
 * @param {import('yaml').Node} node Current value node.
 * @param {string[]} lines Indented block lines.
 * @param {{ keyNode: import('yaml').Scalar }} context Value context.
 */
function replaceValueWithBlock(state, node, lines, context) {
  const text = state.text
  if (startsBlockValue(text, node)) {
    planEdit(state, node.range[0], node.range[2], lines.join(state.eol) + state.eol)
    return
  }
  const start = colonEndOffset(text, context.keyNode)
  if (isEmptyValueNode(text, node)) {
    const { end, trailingSpace } = emptyValueWindow(state, context.keyNode, node)
    planEdit(state, start, end, state.eol + lines.join(state.eol) + trailingSpace)
    return
  }
  if (valueEndsWithNewline(text, node)) {
    planEdit(state, start, node.range[2], state.eol + lines.join(state.eol) + state.eol)
    return
  }
  planEdit(state, start, node.range[1], state.eol + lines.join(state.eol))
}

/**
 * Replace an existing value node with a fully serialized plain value.
 * @param {object} state Edit state.
 * @param {import('yaml').Node | null} node Current value node.
 * @param {unknown} desired Desired plain value.
 * @param {{ keyNode: import('yaml').Scalar, entryIndent: number }} context Value context.
 */
function replaceValue(state, node, desired, context) {
  if (isPlainObject(desired)) {
    const keys = orderedConfigKeys(desired).filter((key) => desired[key] !== undefined)
    if (keys.length === 0) {
      replaceValueWithInline(state, node, '{}', context)
      return
    }
    const baseIndent = startsBlockValue(state.text, node)
      ? indentAt(state.text, node.range[0])
      : context.entryIndent + INDENT_WIDTH
    replaceValueWithBlock(state, node, renderBlockMapLines(state, desired, baseIndent), context)
    return
  }
  if (Array.isArray(desired)) {
    if (desired.length === 0) {
      replaceValueWithInline(state, node, '[]', context)
      return
    }
    if (isSeq(node) && !node.flow) {
      const baseIndent = indentAt(state.text, node.range[0])
      replaceValueWithBlock(state, node, renderBlockSeqLines(state, desired, baseIndent), context)
      return
    }
    replaceValueWithInline(state, node, renderFlowValue(state, desired), context)
    return
  }
  if (isJsExpression(desired)) {
    replaceValueWithInline(state, node, renderJsExpression(state, desired.__jsExpr), context)
    return
  }
  replaceValueWithInline(state, node, renderScalar(state, desired, preferredScalarType(node, desired)), context)
}

/**
 * Replace one inline scalar value, keeping its quote style when possible.
 * @param {object} state Edit state.
 * @param {import('yaml').Pair} pair Mapping pair whose value is a scalar.
 * @param {unknown} value New scalar value.
 */
function replaceScalarValue(state, pair, value) {
  const node = pair.value
  if (!isScalar(node)) {
    throw new PatchEditError('UNSUPPORTED', '目标字段不是标量，无法按值替换')
  }
  if (isEmptyValueNode(state.text, node)) {
    const { start, end, trailingSpace } = emptyValueWindow(state, pair.key, node)
    planEdit(state, start, end, ` ${renderScalar(state, value, 'PLAIN')}${trailingSpace}`)
    return
  }
  const style = typeof value === 'string' ? node.type : 'PLAIN'
  planEdit(state, node.range[0], node.range[1], renderScalar(state, value, style))
}

/**
 * Plan the removal of one mapping entry (its whole line range).
 * @param {object} state Edit state.
 * @param {import('yaml').Pair} pair Mapping pair.
 */
function planPairRemoval(state, pair) {
  const keyStart = pair.key.range[0]
  const lineStart = lineStartOf(state.text, keyStart)
  const prefix = state.text.slice(lineStart, keyStart)
  if (prefix.trim() !== '') {
    throw new PatchEditError('UNSUPPORTED', '无法安全删除内联定位的映射字段')
  }
  const end = extendToLineEnd(state.text, pair.value.range[2] ?? pair.key.range[2])
  planEdit(state, lineStart, end, '')
}

/**
 * Plan the removal of a whole top-level item (optional explicit end offset).
 * @param {object} state Edit state.
 * @param {import('yaml').Node} node Top-level item node.
 * @param {number} [endOffset] Known end offset; defaults to the node end.
 */
function planRemoveTopItem(state, node, endOffset) {
  const start = lineStartWithComments(state.text, node.range[0])
  const end = extendToLineEnd(state.text, endOffset ?? node.range[2])
  planEdit(state, start, end, '')
}

// ---------------------------------------------------------------------------
// New row / new block rendering
// ---------------------------------------------------------------------------

/**
 * Measure the row layout (dash column and key column) of one insert row.
 * @param {string} text Source text.
 * @param {import('yaml').YAMLMap} rowNode Row mapping node.
 * @returns {{ dashIndent: number, contentIndent: number }} Layout.
 */
function measureRowLayout(text, rowNode) {
  const contentIndent = indentAt(text, rowNode.range[0])
  const lineStart = lineStartOf(text, rowNode.range[0])
  let dashIndex = lineStart
  while (dashIndex < text.length && (text[dashIndex] === ' ' || text[dashIndex] === '\t')) dashIndex += 1
  return { dashIndent: dashIndex - lineStart, contentIndent }
}

/**
 * Render one new insert row as block lines.
 * @param {object} state Edit state.
 * @param {string} rowId Row id.
 * @param {object} config MCP client config.
 * @param {boolean} enabled Whether the row is enabled.
 * @param {{ dashIndent: number, contentIndent: number }} layout Row layout.
 * @returns {string[]} Lines (no trailing newline).
 */
function renderNewRowLines(state, rowId, config, enabled, layout) {
  const lines = [
    `${spaces(layout.dashIndent)}- ${ID_KEY}: ${renderScalar(state, rowId, 'PLAIN')}`,
    `${spaces(layout.contentIndent)}${NAME_KEY}: ${renderScalar(state, MCP_CLIENT_MODULE, 'QUOTE_SINGLE')}`,
  ]
  const configKeys = orderedConfigKeys(config).filter((key) => config[key] !== undefined)
  if (configKeys.length === 0) {
    lines.push(`${spaces(layout.contentIndent)}${CONFIG_KEY}: {}`)
  } else {
    lines.push(`${spaces(layout.contentIndent)}${CONFIG_KEY}:`)
    lines.push(...renderBlockMapLines(state, config, layout.contentIndent + INDENT_WIDTH))
  }
  if (!enabled) lines.push(`${spaces(layout.contentIndent)}${DISABLED_KEY}: true`)
  return lines
}

/**
 * Create a brand-new `- insert:` block (with the managed-comment header).
 * @param {object} state Edit state.
 * @param {string} rowId Row id.
 * @param {object} config MCP client config.
 * @param {boolean} enabled Whether the row is enabled.
 */
function planNewInsertBlock(state, rowId, config, enabled) {
  const rowLayout = { dashIndent: INDENT_WIDTH * 2, contentIndent: INDENT_WIDTH * 3 }
  const lines = [
    NEW_INSERT_BLOCK_COMMENT,
    `- ${INSERT_KEY}:`,
    ...renderNewRowLines(state, rowId, config, enabled, rowLayout),
  ]
  const contents = state.document.topSeq
  if (contents === null || contents === undefined) {
    appendLinesAtEnd(state, lines)
    return
  }
  if (contents.items.length === 0) {
    if (contents.flow) {
      const start = contents.range[0]
      const end = contents.range[2]
      const text = state.text
      const needsBlankLine = start > 0 && !text.slice(0, start).endsWith(state.eol + state.eol)
      planEdit(state, start, end, (needsBlankLine ? state.eol : '') + lines.join(state.eol) + state.eol)
      return
    }
    appendLinesAtEnd(state, lines)
    return
  }
  if (contents.flow) {
    throw new PatchEditError('UNSUPPORTED', '暂不支持在 flow 风格的顶层 patch 序列中新增行')
  }
  appendLinesAtEnd(state, lines)
}

/**
 * Append lines at the end of the document, keeping a blank separator line.
 * @param {object} state Edit state.
 * @param {string[]} lines Lines to append.
 */
function appendLinesAtEnd(state, lines) {
  const text = state.text
  let prefix = ''
  if (text.length > 0) {
    if (!text.endsWith('\n')) prefix = state.eol
    else if (!text.endsWith(state.eol + state.eol)) prefix = state.eol
  }
  planEdit(state, text.length, text.length, prefix + lines.join(state.eol) + state.eol)
}

// ---------------------------------------------------------------------------
// YAML rendering helpers
// ---------------------------------------------------------------------------

/**
 * Render a mapping entry (key + value) as block lines at an indentation.
 * @param {object} state Edit state.
 * @param {string} key Mapping key.
 * @param {unknown} value Plain value.
 * @param {number} indent Key indentation.
 * @returns {string[]} Lines (no trailing newline).
 */
function renderMapEntryLines(state, key, value, indent) {
  const prefix = spaces(indent)
  const renderedKey = renderKey(state, key)
  if (isJsExpression(value)) {
    return [`${prefix}${renderedKey}: ${renderJsExpression(state, value.__jsExpr)}`]
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}${renderedKey}: []`]
    return [
      `${prefix}${renderedKey}:`,
      ...renderBlockSeqLines(state, value, indent + INDENT_WIDTH),
    ]
  }
  if (isPlainObject(value)) {
    const keys = orderedConfigKeys(value).filter((entry) => value[entry] !== undefined)
    if (keys.length === 0) return [`${prefix}${renderedKey}: {}`]
    return [
      `${prefix}${renderedKey}:`,
      ...renderBlockMapLines(state, value, indent + INDENT_WIDTH),
    ]
  }
  return [`${prefix}${renderedKey}: ${renderScalar(state, value, 'PLAIN')}`]
}

/**
 * Render a plain object as indented block mapping lines.
 * @param {object} state Edit state.
 * @param {object} object Plain object.
 * @param {number} indent Key indentation.
 * @returns {string[]} Lines (no trailing newline).
 */
function renderBlockMapLines(state, object, indent) {
  const lines = []
  for (const key of orderedConfigKeys(object)) {
    const value = object[key]
    if (value === undefined) continue
    lines.push(...renderMapEntryLines(state, key, value, indent))
  }
  return lines
}

/**
 * Render an array as indented block sequence lines.
 * @param {object} state Edit state.
 * @param {unknown[]} array Array value.
 * @param {number} indent Dash indentation.
 * @returns {string[]} Lines (no trailing newline).
 */
function renderBlockSeqLines(state, array, indent) {
  const lines = []
  const prefix = spaces(indent)
  for (const item of array) {
    if (isJsExpression(item)) {
      lines.push(`${prefix}- ${renderJsExpression(state, item.__jsExpr)}`)
      continue
    }
    if (Array.isArray(item)) {
      lines.push(`${prefix}- ${renderFlowValue(state, item)}`)
      continue
    }
    if (isPlainObject(item)) {
      const itemLines = renderBlockMapLines(state, item, indent + INDENT_WIDTH)
      if (itemLines.length === 0) {
        lines.push(`${prefix}- {}`)
        continue
      }
      itemLines[0] = `${prefix}- ${itemLines[0].slice(indent + INDENT_WIDTH)}`
      lines.push(...itemLines)
      continue
    }
    lines.push(`${prefix}- ${renderScalar(state, item, 'PLAIN')}`)
  }
  return lines
}

/**
 * Render a plain value as a single-line flow scalar/collection.
 * @param {object} state Edit state.
 * @param {unknown} value Plain value.
 * @returns {string} Single-line YAML text.
 */
function renderFlowValue(state, value) {
  if (isJsExpression(value)) return renderJsExpression(state, value.__jsExpr)
  if (Array.isArray(value)) return `[${value.map((item) => renderFlowValue(state, item)).join(', ')}]`
  if (isPlainObject(value)) {
    const parts = orderedConfigKeys(value)
      .filter((key) => value[key] !== undefined)
      .map((key) => `${renderKey(state, key)}: ${renderFlowValue(state, value[key])}`)
    return `{${parts.join(', ')}}`
  }
  return renderScalar(state, value, 'PLAIN')
}

/**
 * Render one scalar value, preferring the given YAML style.
 * @param {object} state Edit state.
 * @param {unknown} value Scalar value.
 * @param {'PLAIN' | 'QUOTE_SINGLE' | 'QUOTE_DOUBLE' | 'BLOCK_LITERAL' | 'BLOCK_FOLDED' | undefined} preferredType Style hint.
 * @returns {string} Inline YAML text.
 */
function renderScalar(state, value, preferredType) {
  // Multi-line strings cannot stay inline as plain scalars; force an escaped
  // double-quoted scalar so the replacement never spans a newline.
  if (typeof value === 'string' && value.includes('\n')) {
    return stringify(value, { defaultStringType: 'QUOTE_DOUBLE', lineWidth: 0 }).replace(/\r?\n$/, '')
  }
  const type = typeof value === 'string' && preferredType !== undefined ? preferredType : 'PLAIN'
  return stringify(value, { defaultStringType: type, lineWidth: 0 }).replace(/\r?\n$/, '')
}

/**
 * Render a mapping key, quoting it when a plain scalar would change its value.
 * @param {object} state Edit state.
 * @param {string} key Key text.
 * @returns {string} YAML key text.
 */
function renderKey(state, key) {
  const text = String(key)
  if (PLAIN_KEY_PATTERN.test(text) && !RESERVED_KEY_PATTERN.test(text)) return text
  return renderScalar(state, text, 'QUOTE_SINGLE')
}

/**
 * Render a `!!js` expression as a tagged scalar.
 * @param {object} state Edit state.
 * @param {string} source Expression source.
 * @returns {string} Tagged YAML text.
 */
function renderJsExpression(state, source) {
  const style = typeof source === 'string' && source.includes('\n') ? 'QUOTE_DOUBLE' : 'PLAIN'
  return `!!js ${renderScalar(state, source, style)}`
}

/**
 * Order config fields: canonical MCP fields first, then any extra keys.
 * @param {object} object Plain object.
 * @returns {string[]} Ordered keys.
 */
function orderedConfigKeys(object) {
  const remaining = new Set(Object.keys(object))
  const ordered = []
  for (const key of ROW_CONFIG_FIELD_ORDER) {
    if (!remaining.has(key)) continue
    ordered.push(key)
    remaining.delete(key)
  }
  for (const key of remaining) ordered.push(key)
  return ordered
}

/**
 * Pick the YAML style to keep when replacing a scalar.
 * @param {import('yaml').Node | null} node Current node.
 * @param {unknown} value New value.
 * @returns {string} Preferred scalar type.
 */
function preferredScalarType(node, value) {
  if (typeof value !== 'string') return 'PLAIN'
  if (!isScalar(node)) return 'PLAIN'
  if (node.type === 'QUOTE_SINGLE' || node.type === 'QUOTE_DOUBLE') return node.type
  if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') return 'QUOTE_DOUBLE'
  return 'PLAIN'
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a value is a non-empty string.
 * @param {unknown} value Candidate value.
 * @param {string} field Field name for the error.
 * @returns {string} The value.
 */
function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PatchEditError('INVALID_ARGUMENT', `${field} 必须是非空字符串`, { field })
  }
  return value
}

/**
 * Assert that a value is a plain object usable as a row config.
 * @param {unknown} value Candidate value.
 * @returns {object} The config object.
 */
function requireConfigObject(value) {
  if (!isPlainObject(value)) {
    throw new PatchEditError('INVALID_ARGUMENT', 'config 必须是对象', { field: 'config' })
  }
  return value
}

/**
 * Validate that a desired config value can be written to YAML.
 * @param {unknown} value Candidate value.
 * @param {string} path Diagnostic field path.
 */
function validateConfigValue(value, path) {
  if (value === undefined) {
    throw new PatchEditError('INVALID_ARGUMENT', `${path} 不能是 undefined`, { field: path })
  }
  if (value === null) return
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PatchEditError('INVALID_ARGUMENT', `${path} 必须是有限数字`, { field: path })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateConfigValue(item, `${path}[${index}]`))
    return
  }
  if (isJsExpression(value)) return
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) validateConfigValue(child, `${path}.${key}`)
    }
    return
  }
  throw new PatchEditError('INVALID_ARGUMENT', `${path} 包含无法写入 YAML 的值`, { field: path })
}

/**
 * Assert that a patch text argument is a string.
 * @param {unknown} text Candidate text.
 * @param {'parse' | 'edit'} entry Entry point the check is made from.
 * @returns {string} The text.
 */
function requirePatchText(text, entry) {
  if (typeof text === 'string') return text
  if (entry === 'edit') {
    throw new PatchEditError('INVALID_ARGUMENT', 'patch 文本必须是字符串', { field: 'text' })
  }
  throw new PatchParseError('patch 文本必须是字符串')
}

/**
 * Convert an arbitrary thrown value into a message.
 * @param {unknown} error Thrown value.
 * @returns {string} Message.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether a value is a plain object (not an array / node / expression).
 * @param {unknown} value Candidate value.
 * @returns {boolean} True for plain objects.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Deep-compare plain values, treating `{ __jsExpr }` as an opaque scalar.
 * @param {unknown} left Left value.
 * @param {unknown} right Right value.
 * @returns {boolean} True when the values are equal.
 */
function valuesEqual(left, right) {
  if (left === right) return true
  if (isJsExpression(left) || isJsExpression(right)) {
    return isJsExpression(left) && isJsExpression(right) && left.__jsExpr === right.__jsExpr
  }
  if (left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => valuesEqual(item, right[index]))
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && valuesEqual(left[key], right[key]),
    )
  }
  return false
}
