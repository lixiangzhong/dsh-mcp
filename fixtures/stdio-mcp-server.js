#!/usr/bin/env node
/**
 * fixtures/stdio-mcp-server.js — 验收用极简 MCP server（零依赖）
 *
 * 目的：为 dsh-mcp 端到端验收提供一个可被 dsh-mcp-client 以 stdio 拉起的
 * MCP server，不依赖任何 npm 包、不访问网络、不写磁盘。
 *
 * 协议：newline-delimited JSON-RPC 2.0 over stdin/stdout（MCP stdio transport）。
 * 支持方法（够验收用）：
 *   - initialize             → protocolVersion（回显客户端请求值）/capabilities/serverInfo
 *   - notifications/initialized → 通知，无响应
 *   - ping                   → MCP 标准 ping，返回 {}
 *   - tools/list             → 一个 ping 工具（inputSchema 无参数）
 *   - tools/call (ping)      → content [{ type:'text', text:'pong' }]
 *   - 其他方法               → JSON-RPC error -32601（通知则静默丢弃）
 *
 * 手工验证：
 *   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
 *     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 *     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 *     '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ping"}}' \
 *     | node fixtures/stdio-mcp-server.js
 *
 * stdout 只用于协议消息；诊断信息一律走 stderr，避免污染 JSON-RPC 流。
 */
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const JSON_RPC_VERSION = '2.0'
const ERROR_PARSE = -32700
const ERROR_INVALID_REQUEST = -32600
const ERROR_METHOD_NOT_FOUND = -32601
const ERROR_INVALID_PARAMS = -32602
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

export const SERVER_INFO = Object.freeze({ name: 'dsh-mcp-fixture', version: '0.1.0' })

/** 唯一的测试工具：调用返回 "pong"。 */
export const PING_TOOL = Object.freeze({
  name: 'ping',
  description: "Reply 'pong'. Used by dsh-mcp end-to-end acceptance checks.",
  inputSchema: { type: 'object', properties: {} },
})

/**
 * 启动 fixture server；测试可注入自定义 input/output 流。
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [streams]
 * @returns {import('node:readline').Interface} readline 实例（便于测试关闭）
 */
export function createFixtureServer({ input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      output.write(serialize(errorResponse(null, ERROR_PARSE, 'Parse error')))
      return
    }
    handleMessage(message, (payload) => output.write(serialize(payload)))
  })
  return lines
}

/**
 * 处理单条 JSON-RPC 消息；`send` 只负责写回响应（通知不调用 send）。
 */
function handleMessage(message, send) {
  if (!isPlainObject(message)) {
    send(errorResponse(null, ERROR_INVALID_REQUEST, 'Invalid Request'))
    return
  }
  const isNotification = !hasOwn(message, 'id')
  const id = isNotification ? null : message.id
  if (message.jsonrpc !== JSON_RPC_VERSION || typeof message.method !== 'string') {
    send(errorResponse(id, ERROR_INVALID_REQUEST, 'Invalid Request'))
    return
  }

  switch (message.method) {
    case 'initialize':
      if (isNotification) return
      send(successResponse(id, buildInitializeResult(message.params)))
      return
    case 'notifications/initialized':
      // 客户端确认初始化完成：通知，无响应。
      return
    case 'ping':
      // MCP 标准 ping 工具方法：请求返回空对象。
      if (isNotification) return
      send(successResponse(id, {}))
      return
    case 'tools/list':
      if (isNotification) return
      send(successResponse(id, { tools: [PING_TOOL] }))
      return
    case 'tools/call': {
      if (isNotification) return
      const toolName = isPlainObject(message.params) ? message.params.name : undefined
      if (toolName !== PING_TOOL.name) {
        send(errorResponse(id, ERROR_INVALID_PARAMS, `Unknown tool: ${String(toolName)}`))
        return
      }
      send(successResponse(id, { content: [{ type: 'text', text: 'pong' }] }))
      return
    }
    default:
      if (isNotification) return
      send(errorResponse(id, ERROR_METHOD_NOT_FOUND, `Method not found: ${message.method}`))
  }
}

/** initialize 响应：回显客户端要求的协议版本，兼容不同版本客户端。 */
function buildInitializeResult(params) {
  const requestedVersion =
    isPlainObject(params) && typeof params.protocolVersion === 'string' && params.protocolVersion !== ''
      ? params.protocolVersion
      : DEFAULT_PROTOCOL_VERSION
  return {
    protocolVersion: requestedVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
  }
}

function successResponse(id, result) {
  return { jsonrpc: JSON_RPC_VERSION, id, result }
}

function errorResponse(id, code, message) {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } }
}

function serialize(payload) {
  return `${JSON.stringify(payload)}\n`
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

// 直接执行时启动 server；被测试 import 时不产生顶层副作用。
const entryUrl = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href
if (entryUrl !== null && import.meta.url === entryUrl) {
  createFixtureServer()
}
