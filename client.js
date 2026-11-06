/**
 * Client half of @lixiangzhong/dsh-mcp.
 *
 * 设置里的 MCP 服务页面：只负责渲染与交互，所有读写都通过同源 Host 路由
 * `POST /dsh-mcp/api/<action>`（envelope `{ ok, data }` / `{ ok:false, error }`）。
 * 接口真相源是 docs/contracts/host-api.md，本文件不内置任何业务状态。
 *
 * 视觉层：全部样式收敛在 `.dm-mcp` 作用域内，由 apply 注入一个
 * `<style id="dm-mcp-style">`（ctx.effect 清理），只使用 DSH 官方主题变量。
 *
 * 模块形态：浏览器端 `window.__ModuleLoader__.load` 工厂（无 import / 无构建），
 * React 由浏览器模块表通过 `require('react')` 提供。
 */
window.__ModuleLoader__.load({
  id: '@lixiangzhong/dsh-mcp',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React
    // composer 插槽位于输入框内，有 overflow/transform 容器；固定覆盖层必须 portal 到 body。
    // 'react-dom' 属于浏览器基线模块表，但缺失时降级为就地渲染，避免整页不可用。
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      createPortal = null
    }

    // ---------------------------------------------------------------------
    // 常量
    // ---------------------------------------------------------------------

    /** locale 命名空间：所有页面文案都注册在这里。 */
    const LOCALE_NS = 'dsh-mcp'
    /** Host API 前缀（同源，无需 URL 前缀）。 */
    const API_BASE = '/dsh-mcp/api'
    /** 写请求中表示"保留原密钥值"的哨兵（契约 §2）。 */
    const SECRET_KEEP = '__KEEP__'
    /** list 返回的密钥掩码。 */
    const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022'
    /** 该值来自 YAML `!!js` 表达式（只可整体替换）。 */
    const EXPRESSION = '__EXPRESSION__'
    /** serverName 的合法格式（契约 §4.2）。 */
    const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
    /** 两种传输方式的 API 取值。 */
    const TRANSPORT_STDIO = 'stdio'
    const TRANSPORT_HTTP = 'streamable-http'
    /** 会话切换后角标刷新的防抖时长（避免连续切换时的请求风暴）。 */
    const BADGE_REFRESH_DEBOUNCE_MS = 250
    /** 注入样式的 style 元素 id（apply 负责创建与清理）。 */
    const STYLE_ID = 'dm-mcp-style'
    /** 空操作占位，避免 disabled 按钮仍触发回调。 */
    const noop = () => {}

    /** 错误码 → 文案 key（契约 §5）。 */
    const ERROR_KEY_BY_CODE = {
      FORBIDDEN: 'error.FORBIDDEN',
      BAD_REQUEST: 'error.BAD_REQUEST',
      INVALID_ARGUMENT: 'error.INVALID_ARGUMENT',
      CONFLICT: 'error.CONFLICT',
      NOT_FOUND: 'error.NOT_FOUND',
      NOT_EDITABLE: 'error.NOT_EDITABLE',
      UNSUPPORTED: 'error.UNSUPPORTED',
      WRITE_FAILED: 'error.WRITE_FAILED',
      INTERNAL: 'error.INTERNAL',
      NETWORK: 'error.NETWORK',
      // 客户端自用：路由不存在/响应不是 JSON 等协议层失败（Host 未启用或路径不匹配）。
      UNAVAILABLE: 'error.UNAVAILABLE',
    }

    /** fiber phase → 文案 key（契约 §3，外加预留的等待凭据态）。 */
    const PHASE_KEYS = {
      pending: 'phase.pending',
      loading: 'phase.loading',
      active: 'phase.active',
      failed: 'phase.failed',
      unloading: 'phase.unloading',
      disabled: 'phase.disabled',
      unknown: 'phase.unknown',
      // 预留：dsh-mcp-client 若上报等待凭据的新 phase，可直接落到该文案。
      waiting: 'phase.waiting',
    }

    /** fiber phase → 状态圆点色调（仅 semantic 色，不做装饰）。 */
    const PHASE_TONES = {
      pending: 'warn',
      loading: 'warn',
      active: 'success',
      failed: 'error',
      unloading: 'warn',
      disabled: 'idle',
      unknown: 'idle',
      waiting: 'warn',
    }

    /** 来源层 → 文案 key（契约 §3）。 */
    const SOURCE_KEYS = {
      profile: 'source.profile',
      home: 'source.home',
      bundle: 'source.bundle',
      other: 'source.other',
    }

    /** 项目 MCP server 状态 → 文案 key（project-internals §2 状态近似）。 */
    const PROJECT_STATUS_KEYS = {
      starting: 'composer.status.starting',
      connected: 'composer.status.connected',
      failed: 'composer.status.failed',
      stopped: 'composer.status.stopped',
    }

    /** 项目 MCP server 状态 → 状态圆点色调。 */
    const PROJECT_STATUS_TONES = {
      starting: 'warn',
      connected: 'success',
      failed: 'error',
      stopped: 'idle',
    }

    // ---------------------------------------------------------------------
    // 样式：所有选择器都限定在 .dm-mcp 内，只用 DSH 主题变量（带 fallback）
    // ---------------------------------------------------------------------

    const STYLE_TEXT = `
.dm-mcp {
  --dm-text: var(--dsw-alias-label-primary, inherit);
  --dm-text-2: var(--dsw-alias-label-secondary, #9aa0aa);
  --dm-text-3: var(--dsw-alias-label-tertiary, #7a808a);
  --dm-line: var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  --dm-line-strong: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
  --dm-layer-1: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.04));
  --dm-layer-2: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.07));
  --dm-layer-3: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.1));
  --dm-brand: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d6bfe));
  --dm-brand-hover: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #6b84ff));
  --dm-on-brand: var(--dsw-alias-label-primary-foreground, #ffffff);
  --dm-success: var(--dsw-alias-state-success-primary, #3fb950);
  --dm-warn: var(--dsw-alias-state-warn-primary, #d29922);
  --dm-error: var(--dsw-alias-state-error-primary, #f85149);
  --dm-radius: var(--dsw-radius-sm, 8px);
  --dm-radius-dialog: var(--dsw-radius-lg, 16px);
  --dm-ease: var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
  --dm-fast: var(--ds-transition-duration-fast, 140ms);
}
.dm-mcp {
  display: flex;
  flex-direction: column;
  gap: 20px;
  box-sizing: border-box;
  width: 100%;
  max-width: 920px;
  padding: 24px 0 40px;
  color: var(--dm-text);
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px;
  line-height: 1.55;
  /* 行布局按内容区宽度（不是窗口宽度）响应：Settings 内容区 = 窗口 - 188px 导航。 */
  container-type: inline-size;
  container-name: dm-mcp;
}
.dm-mcp *,
.dm-mcp *::before,
.dm-mcp *::after,
.dm-mcp-panel-root *,
.dm-mcp-panel-root *::before,
.dm-mcp-panel-root *::after {
  box-sizing: border-box;
}
.dm-mcp-panel-root {
  /* softui / 暖灰柔光：浅色基准令牌；深色在 body[data-ds-dark-theme] 里成对覆盖。 */
  --p-bg: #ffffff;
  --p-surface: #f5f5f7;
  --p-raised: #f0f0f2;
  --p-text: rgba(0, 0, 0, .95);
  --p-text-2: rgba(0, 0, 0, .55);
  --p-text-3: rgba(0, 0, 0, .44);
  --p-mute: rgba(0, 0, 0, .30);
  --p-fill: rgba(0, 0, 0, .05);
  --p-fill-hover: rgba(0, 0, 0, .08);
  --p-fill-strong: rgba(0, 0, 0, .10);
  --p-mask: rgba(15, 17, 21, .28);
  --p-success: #34d399;
  --p-error: #f43f5e;
  --p-warn: #f59e0b;
  --p-error-tint: rgba(244, 63, 94, .10);
  --p-warn-tint: rgba(245, 158, 11, .14);
  --p-grad-primary: linear-gradient(to right, #38bdf8, #3b82f6);
  --p-glow: 0 10px 15px -3px rgba(59, 130, 246, .30), 0 4px 6px -4px rgba(59, 130, 246, .30);
  --p-glow-hover: 0 20px 25px -5px rgba(59, 130, 246, .40), 0 8px 10px -6px rgba(59, 130, 246, .40);
  --p-sh-card: 0 4px 20px rgba(0, 0, 0, .05), 0 1px 3px rgba(0, 0, 0, .08);
  --p-sh-card-hover: 0 6px 20px rgba(0, 0, 0, .10), 0 2px 4px rgba(0, 0, 0, .08);
  --p-sh-float: 0 8px 30px rgba(81, 84, 97, .16), 0 2px 8px rgba(0, 0, 0, .06);
  --p-r-panel: 20px;
  --p-r-card: 16px;
  --p-r-row: 12px;
  --p-r-control: 12px;
  --p-focus: rgba(59, 130, 246, .50);
  --p-ease-feedback: .15s cubic-bezier(.4, 0, .2, 1);
  --p-ease-state: .3s;
  color: var(--p-text);
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px;
  line-height: 1.5;
}
/* 深色主题：面/文本/填充全部跟随宿主令牌，柔阴影加深并补 1px 白内高光。 */
body[data-ds-dark-theme] .dm-mcp-panel-root {
  /* softui 暗色语义：页面深 → 面板浅一档 → 内层再浅一档。
     面板用 layer-2（约 #2c2c2e），绝不用偏亮的 bg-overlay 铺大面积。 */
  --p-bg: var(--dsw-alias-bg-layer-2, #2c2c2e);
  --p-surface: rgba(255, 255, 255, .06);
  --p-raised: rgba(255, 255, 255, .10);
  /* 宿主 overlay 面偏中灰，secondary/tertiary 直接叠加时对比不足；
     用宿主 label-primary 的透明度阶梯保持「无彩色文字」并满足暗色对比。 */
  --p-text: var(--dsw-alias-label-primary, rgba(255, 255, 255, .95));
  --p-text-2: color-mix(in srgb, var(--dsw-alias-label-primary, #ffffff) 88%, transparent);
  --p-text-3: color-mix(in srgb, var(--dsw-alias-label-primary, #ffffff) 64%, transparent);
  --p-mute: color-mix(in srgb, var(--dsw-alias-label-primary, #ffffff) 40%, transparent);
  --p-fill: rgba(255, 255, 255, .08);
  --p-fill-hover: rgba(255, 255, 255, .12);
  --p-fill-strong: rgba(255, 255, 255, .14);
  --p-mask: rgba(0, 0, 0, .55);
  --p-error-tint: rgba(244, 63, 94, .16);
  --p-warn-tint: rgba(245, 158, 11, .18);
  --p-sh-card: 0 2px 8px rgba(0, 0, 0, .28), inset 0 1px 0 rgba(255, 255, 255, .05);
  --p-sh-card-hover: 0 6px 18px rgba(0, 0, 0, .38), inset 0 1px 0 rgba(255, 255, 255, .07);
  --p-sh-float: 0 24px 64px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .40), inset 0 1px 0 rgba(255, 255, 255, .06);
  --p-focus: rgba(96, 165, 250, .55);
}
.dm-mcp__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px 24px;
  flex-wrap: wrap;
}
.dm-mcp__heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dm-mcp__title {
  margin: 0;
  font-size: var(--dsw-font-l-20, 20px);
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
}
.dm-mcp__desc {
  margin: 0;
  max-width: 68ch;
  color: var(--dm-text-2);
  font-size: 13px;
  line-height: 1.5;
}
.dm-mcp__toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}
.dm-mcp__toolbar-sep {
  width: 1px;
  height: 20px;
  margin: 0 8px;
  background: var(--dm-line);
}
.dm-mcp__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--dm-radius);
  background: transparent;
  color: var(--dm-text);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--dm-fast) var(--dm-ease),
    border-color var(--dm-fast) var(--dm-ease),
    color var(--dm-fast) var(--dm-ease);
}
.dm-mcp__btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dm-brand));
  outline-offset: 2px;
}
.dm-mcp__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.dm-mcp__btn--primary {
  background: var(--dm-brand);
  color: var(--dm-on-brand);
}
.dm-mcp__btn--primary:hover:not(:disabled) {
  background: var(--dm-brand-hover);
}
.dm-mcp__btn--ghost {
  color: var(--dm-text-2);
}
.dm-mcp__btn--ghost:hover:not(:disabled) {
  background: var(--dm-layer-2);
  color: var(--dm-text);
}
/* 行内 icon-only 按钮：32x32，ghost 同级；删除仅在 hover/focus 时变 danger。 */
.dm-mcp__btn--icon {
  width: 32px;
  height: 32px;
  min-width: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--dm-radius);
  background: transparent;
  color: var(--dm-text-2);
}
.dm-mcp__btn--icon:hover:not(:disabled) {
  background: var(--dm-layer-2);
  color: var(--dm-text);
}
.dm-mcp__btn--icon:active:not(:disabled) {
  transform: scale(0.96);
}
.dm-mcp__btn--icon:disabled {
  opacity: 0.45;
  cursor: default;
}
.dm-mcp__btn--icon-danger:hover:not(:disabled),
.dm-mcp__btn--icon-danger:focus-visible {
  color: var(--dm-error);
  background: color-mix(in srgb, var(--dm-error) 11%, transparent);
}
.dm-mcp__icon {
  display: inline-flex;
}
.dm-mcp__icon-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dm-mcp__btn--danger-solid {
  background: var(--dm-error);
  color: var(--dsw-alias-bg-base, #16181d);
}
.dm-mcp__btn--danger-solid:hover:not(:disabled) {
  filter: brightness(0.92);
}
.dm-mcp__btn--sm {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
.dm-mcp__summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  flex-wrap: wrap;
  min-height: 18px;
  color: var(--dm-text-3);
  font-size: 12px;
}
.dm-mcp__summary-stats {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.dm-mcp__summary-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dm-mcp__summary-item + .dm-mcp__summary-item::before {
  content: "·";
  margin: 0 10px 0 4px;
  opacity: 0.6;
}
.dm-mcp__summary-num {
  color: var(--dm-text);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.dm-mcp__summary-updated {
  color: var(--dm-text-3);
}
.dm-mcp__notice-region {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dm-mcp__notice-region:empty {
  display: none;
}
.dm-mcp__notice {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px 8px 12px;
  border: 1px solid var(--dm-line-strong);
  border-radius: var(--dm-radius);
  background: var(--dm-layer-1);
  font-size: 13px;
}
.dm-mcp__notice-title {
  flex: none;
  font-weight: 600;
}
.dm-mcp__notice-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dm-mcp__notice--success {
  border-color: color-mix(in srgb, var(--dm-success) 45%, var(--dm-line));
  background: color-mix(in srgb, var(--dm-success) 10%, transparent);
}
.dm-mcp__notice--warn {
  border-color: color-mix(in srgb, var(--dm-warn) 45%, var(--dm-line));
  background: color-mix(in srgb, var(--dm-warn) 10%, transparent);
}
.dm-mcp__notice--error {
  border-color: var(--dm-error);
  background: color-mix(in srgb, var(--dm-error) 12%, transparent);
}
.dm-mcp__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--dm-line);
}
.dm-mcp__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 140px max-content;
  align-items: center;
  gap: 8px 20px;
  min-height: 72px;
  margin: 0 -8px;
  padding: 12px 8px;
  border-bottom: 1px solid var(--dm-line);
  transition: background-color var(--dm-fast) var(--dm-ease);
}
.dm-mcp__row:hover,
.dm-mcp__row:focus-within {
  background: var(--dm-layer-1);
}
.dm-mcp__row-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dm-mcp__row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dm-mcp__server {
  min-width: 0;
  overflow: hidden;
  color: var(--dm-text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-mcp__chip {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 18px;
  padding: 0 7px;
  border: 1px solid var(--dm-line);
  border-radius: 999px;
  color: var(--dm-text-3);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  line-height: 1;
  text-transform: uppercase;
}
.dm-mcp__chip--readonly {
  color: var(--dm-text-3);
  letter-spacing: 0.02em;
  text-transform: none;
}
.dm-mcp__row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--dm-text-3);
  font-family: var(--dsw-font-markdown-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 1.4;
}
.dm-mcp__id {
  flex: none;
  color: var(--dm-text-3);
}
.dm-mcp__dot-sep {
  flex: none;
  opacity: 0.6;
}
.dm-mcp__target {
  min-width: 0;
  overflow: hidden;
  color: var(--dm-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-mcp__row-status {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dm-mcp__status {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--dm-text);
  font-size: 13px;
  line-height: 1.3;
}
.dm-mcp__status-text {
  flex: none;
}
.dm-mcp__diagnostic {
  min-width: 0;
  overflow: hidden;
  color: var(--dm-text-3);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-mcp__diagnostic--stack {
  display: none;
}
.dm-mcp__diagnostic--status {
  display: block;
}
.dm-mcp__row-tools {
  color: var(--dm-text-3);
  font-size: 12px;
  line-height: 1.3;
}
.dm-mcp__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dm-text-3);
}
.dm-mcp__dot--success {
  background: var(--dm-success);
}
.dm-mcp__dot--warn {
  background: var(--dm-warn);
}
.dm-mcp__dot--error {
  background: var(--dm-error);
}
.dm-mcp__dot--idle {
  background: var(--dm-text-3);
}
.dm-mcp__row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: nowrap;
  gap: 4px;
}
/* 启停开关：button + role="switch"，34x20，thumb 16px。 */
.dm-mcp__switch {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--dm-line-strong);
  border-radius: 999px;
  background: var(--dm-layer-3);
  cursor: pointer;
  transition:
    background-color var(--dm-fast) var(--dm-ease),
    border-color var(--dm-fast) var(--dm-ease),
    opacity var(--dm-fast) var(--dm-ease);
}
.dm-mcp__switch:hover:not(:disabled) {
  background: var(--dm-layer-2);
}
.dm-mcp__switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dm-brand));
  outline-offset: 2px;
}
.dm-mcp__switch:disabled {
  opacity: 0.45;
  cursor: default;
}
.dm-mcp__switch-thumb {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dm-text-3);
  transition:
    transform var(--dm-fast) var(--dm-ease),
    background-color var(--dm-fast) var(--dm-ease);
}
.dm-mcp__switch--on {
  border-color: transparent;
  background: var(--dm-brand);
}
.dm-mcp__switch--on:hover:not(:disabled) {
  background: var(--dm-brand-hover);
}
.dm-mcp__switch--on .dm-mcp__switch-thumb {
  transform: translateX(14px);
  background: var(--dm-on-brand);
}
.dm-mcp__switch--busy .dm-mcp__switch-thumb {
  opacity: 0.55;
}
.dm-mcp__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 24px 0 4px;
}
.dm-mcp__empty-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}
.dm-mcp__empty-desc {
  margin: 0 0 10px;
  max-width: 60ch;
  color: var(--dm-text-2);
  font-size: 13px;
  line-height: 1.5;
}
.dm-mcp__skeleton {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--dm-line);
}
.dm-mcp__skel-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 140px max-content;
  align-items: center;
  gap: 8px 20px;
  min-height: 72px;
  padding: 12px 0;
  border-bottom: 1px solid var(--dm-line);
}
.dm-mcp__skel-main,
.dm-mcp__skel-status {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dm-mcp__skel-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.dm-mcp__skel-bar {
  position: relative;
  overflow: hidden;
  height: 10px;
  border-radius: var(--dm-radius);
  background: var(--dsw-alias-bg-skeleton, rgba(128, 128, 128, 0.16));
}
.dm-mcp__skel-bar::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, var(--dm-layer-3), transparent);
  transform: translateX(-100%);
  animation: dm-mcp-shimmer 1.4s var(--dm-ease) infinite;
}
.dm-mcp__skel-bar--name {
  width: 168px;
  height: 12px;
}
.dm-mcp__skel-bar--meta {
  width: 260px;
}
.dm-mcp__skel-bar--status {
  width: 92px;
}
.dm-mcp__skel-bar--tools {
  width: 64px;
  height: 9px;
}
.dm-mcp__skel-bar--switch {
  width: 34px;
  height: 20px;
  border-radius: 999px;
}
.dm-mcp__skel-bar--icon {
  width: 32px;
  height: 32px;
  border-radius: var(--dm-radius);
}
.dm-mcp__skel-bar--switch::after,
.dm-mcp__skel-bar--icon::after {
  display: none;
}
.dm-mcp__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@keyframes dm-mcp-shimmer {
  to {
    transform: translateX(100%);
  }
}
.dm-mcp__footer {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  min-width: 0;
  overflow: hidden;
  padding-top: 4px;
  color: var(--dm-text-3);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
}
.dm-mcp__footer-item {
  display: inline-flex;
  align-items: baseline;
  flex: 0 1 auto;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}
.dm-mcp__footer-item + .dm-mcp__footer-item::before {
  content: "·";
  flex: none;
  margin: 0 8px;
  opacity: 0.6;
}
.dm-mcp__path {
  max-width: 26ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-mcp__mono {
  font-family: var(--dsw-font-markdown-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11.5px;
}
.dm-mcp__overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--dsw-alias-bg-mask-2, rgba(0, 0, 0, 0.5));
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
.dm-mcp__dialog {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(80vh, 720px);
  overflow: hidden;
  border: 1px solid var(--dm-line);
  border-radius: var(--dm-radius-dialog);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-3, #1c1e24));
  box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0, 0, 0, 0.4));
  /* 弹窗内部栅格按弹窗宽度响应，不受页面容器宽度影响。 */
  container-type: inline-size;
  container-name: dm-mcp-dialog;
}
.dm-mcp__dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  height: 52px;
  padding: 0 12px 0 20px;
  border-bottom: 1px solid var(--dm-line);
}
.dm-mcp__dialog-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
}
.dm-mcp__dialog-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  padding: 20px;
  overflow-y: auto;
}
/* 确认类短文本弹窗：收紧上下空白，无固定 min-height，内容长时由 max-height 触发内部滚动。 */
.dm-mcp__dialog--compact .dm-mcp__dialog-body {
  gap: 8px;
  padding: 16px 20px 18px;
}
.dm-mcp__dialog-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: none;
  padding: 16px 20px;
  border-top: 1px solid var(--dm-line);
}
.dm-mcp__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dm-mcp__label {
  color: var(--dm-text-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
}
.dm-mcp__label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 24px;
}
.dm-mcp__input,
.dm-mcp__select,
.dm-mcp__textarea {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--dm-line-strong);
  border-radius: var(--dm-radius);
  background: var(--dm-layer-1);
  color: var(--dm-text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  outline: none;
  transition:
    border-color var(--dm-fast) var(--dm-ease),
    box-shadow var(--dm-fast) var(--dm-ease);
}
.dm-mcp__select {
  padding-right: 28px;
}
.dm-mcp__textarea {
  height: auto;
  min-height: 76px;
  padding: 8px 10px;
  resize: vertical;
}
.dm-mcp__input--mono {
  font-family: var(--dsw-font-markdown-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
}
.dm-mcp__input--readonly {
  color: var(--dm-text-3);
  cursor: default;
}
.dm-mcp__input::placeholder,
.dm-mcp__textarea::placeholder {
  color: var(--dm-text-3);
}
.dm-mcp__input:focus,
.dm-mcp__select:focus,
.dm-mcp__textarea:focus {
  border-color: var(--dm-brand);
  box-shadow: 0 0 0 var(--dsw-focus-ring-width, 2px) var(--dsw-focus-ring-color, var(--dm-brand));
}
.dm-mcp__grid-2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px 16px;
}
.dm-mcp__group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.dm-mcp__group-title {
  margin: 0;
  color: var(--dm-text-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
}
.dm-mcp__hint {
  margin: 0;
  color: var(--dm-text-3);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dm-mcp__empty-note {
  margin: 0;
  color: var(--dm-text-3);
  font-size: 12px;
  line-height: 1.5;
}
.dm-mcp__error-text {
  margin: 0;
  color: var(--dm-error);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dm-mcp__entries {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dm-mcp__entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
  align-items: center;
  gap: 8px;
}
.dm-mcp__entry .dm-mcp__btn {
  height: 34px;
}
.dm-mcp__check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--dm-text-2);
  font-size: 13px;
  line-height: 1.5;
}
.dm-mcp__check input {
  flex: none;
  margin: 3px 0 0;
  accent-color: var(--dm-brand);
}
.dm-mcp__check-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dm-mcp__check-hint {
  color: var(--dm-text-3);
  font-size: 12px;
}
/* 宽内容区（容器 >= 860px）：状态列放宽，信息更舒展。 */
@container dm-mcp (min-width: 860px) {
  .dm-mcp__row,
  .dm-mcp__skel-row {
    grid-template-columns: minmax(0, 1fr) 168px max-content;
  }
}
/* 内容区变窄（800px 设置面板的内容区约 564px 也落在这里）：
   行改为两行堆叠，名称独占整行且不省略；diagnostic 移到元信息行下方。 */
@container dm-mcp (max-width: 700px) {
  .dm-mcp__row,
  .dm-mcp__skel-row {
    grid-template-columns: minmax(0, 1fr) max-content;
    gap: 8px 16px;
  }
  .dm-mcp__row-main,
  .dm-mcp__skel-main {
    grid-column: 1 / -1;
  }
  .dm-mcp__row-status,
  .dm-mcp__skel-status {
    grid-column: 1;
  }
  .dm-mcp__row-actions,
  .dm-mcp__skel-actions {
    grid-column: 2;
    justify-content: flex-end;
  }
  .dm-mcp__row-head {
    flex-wrap: wrap;
  }
  .dm-mcp__server {
    flex: 0 1 auto;
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .dm-mcp__diagnostic--status {
    display: none;
  }
  .dm-mcp__diagnostic--stack {
    display: block;
  }
}
/* 弹窗内部的栅格按弹窗自身宽度响应（与页头/列表的容器无关）。 */
@container dm-mcp-dialog (max-width: 500px) {
  .dm-mcp__grid-2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
@container dm-mcp-dialog (max-width: 480px) {
  .dm-mcp__entry {
    grid-template-columns: minmax(0, 1fr);
  }
}
/* 极窄窗口只保留页头工具区换行这一条媒体查询。 */
@media (max-width: 520px) {
  .dm-mcp__header {
    align-items: flex-start;
  }
  .dm-mcp__toolbar {
    width: 100%;
    justify-content: flex-start;
  }
}

/* =========================================================================
   会话内项目 MCP（softui / 暖灰柔光，双主题跟随宿主）
   层级靠面差 + 圆角 + 三档柔阴影，不用描边分层；正文只用透明度阶梯。
   只作用于 composer 入口与面板，设置页 .dm-mcp__* 不受影响。
   ========================================================================= */
.dm-mcp-entry {
  --e-icon: rgba(0, 0, 0, .55);
  --e-icon-hover: rgba(0, 0, 0, .95);
  --e-fill: rgba(0, 0, 0, .05);
  --e-ring: #ffffff;
  --e-focus: rgba(59, 130, 246, .50);
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  min-width: 28px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--e-icon);
  cursor: pointer;
  transition:
    background var(--p-ease-feedback, .15s cubic-bezier(.4, 0, .2, 1)),
    color var(--p-ease-feedback, .15s cubic-bezier(.4, 0, .2, 1));
}
.dm-mcp-entry:hover:not(:disabled) {
  background: var(--e-fill);
  color: var(--e-icon-hover);
}
.dm-mcp-entry:active:not(:disabled) {
  transform: scale(.96);
}
.dm-mcp-entry:focus-visible {
  outline: 2px solid var(--e-focus);
  outline-offset: 2px;
}
.dm-mcp-entry:disabled {
  opacity: .45;
  cursor: default;
}
/* 6px 角标，用 1.5px 底色描边制造缺口 */
.dm-mcp-entry-badge {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  box-shadow: 0 0 0 1.5px var(--e-ring);
}
.dm-mcp-entry-badge--warn {
  background: #f59e0b;
}
.dm-mcp-entry-badge--error {
  background: #f43f5e;
}
body[data-ds-dark-theme] .dm-mcp-entry {
  --e-icon: var(--dsw-alias-label-secondary, rgba(255, 255, 255, .55));
  --e-icon-hover: var(--dsw-alias-label-primary, rgba(255, 255, 255, .95));
  --e-fill: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, .08));
  --e-ring: var(--dsw-alias-bg-layer-2, #1c1e24);
  --e-focus: rgba(96, 165, 250, .55);
}

/* 遮罩：浅色 rgba(15,17,21,.28)、深色 rgba(0,0,0,.5)，都带 8px blur */
.dm-mcp-panel-overlay {
  position: fixed;
  inset: 0;
  z-index: 1300;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 24px 16px 96px;
  background: var(--p-mask);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
/* 浮起面板：380 宽、radius 20、padding 20、max-height min(64vh, 680px) */
.dm-mcp-panel {
  display: flex;
  flex-direction: column;
  width: min(380px, calc(100vw - 32px));
  max-height: min(64vh, 680px);
  overflow: hidden;
  border: 0;
  border-radius: var(--p-r-panel, 20px);
  background: var(--p-bg);
  box-shadow: var(--p-sh-float);
  color: var(--p-text);
  font-family: var(--dsw-font-family, inherit);
  font-size: 13px;
  line-height: 1.5;
}
.dm-mcp-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: none;
  padding: 20px 20px 0;
}
.dm-mcp-panel-title {
  margin: 0;
  color: var(--p-text);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.25;
}
.dm-mcp-panel-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--p-text-3);
  font-family: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--p-ease-feedback),
    color var(--p-ease-state);
}
.dm-mcp-panel-close:hover {
  background: var(--p-fill);
  color: var(--p-text);
}
.dm-mcp-panel-close:focus-visible {
  outline: 2px solid var(--p-focus);
  outline-offset: 2px;
}
/* 头部下方一行：项目目录路径（单行省略，title 给全文） */
.dm-mcp-panel-path {
  flex: none;
  margin: 6px 20px 0;
  overflow: hidden;
  color: var(--p-text-3);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-mcp-panel-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-height: 0;
  padding: 16px 20px 20px;
  overflow-y: auto;
}
.dm-mcp-panel-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dm-mcp-panel-section-title {
  margin: 0;
  color: var(--p-text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}
/* 内部卡：radius 16，面差分层 + sh-card */
.dm-mcp-panel-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  border: 0;
  border-radius: var(--p-r-card, 16px);
  background: var(--p-surface);
  box-shadow: var(--p-sh-card);
}
.dm-mcp-panel-card--tight {
  gap: 0;
  padding: 6px;
}
.dm-mcp-panel-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dm-mcp-panel-card-title {
  color: var(--p-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
}
.dm-mcp-panel-card-desc {
  margin: 0;
  color: var(--p-text-3);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dm-mcp-panel-files {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dm-mcp-panel-file {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dm-mcp-panel-file-path {
  min-width: 0;
  overflow: hidden;
  color: var(--p-text-2);
  font-family: var(--dsw-font-markdown-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-mcp-panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
/* 面板按钮：控件 radius 12；唯一渐变只给「信任并启用」主 CTA */
.dm-mcp-panel-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--p-r-control, 12px);
  background: var(--p-fill);
  color: var(--p-text-2);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--p-ease-feedback),
    box-shadow var(--p-ease-feedback),
    color var(--p-ease-state),
    transform var(--p-ease-feedback);
}
.dm-mcp-panel-btn:hover:not(:disabled) {
  background: var(--p-fill-hover);
  color: var(--p-text);
}
.dm-mcp-panel-btn:active:not(:disabled) {
  transform: translateY(0);
}
.dm-mcp-panel-btn:focus-visible {
  outline: 2px solid var(--p-focus);
  outline-offset: 2px;
}
.dm-mcp-panel-btn:disabled {
  opacity: .45;
  cursor: default;
}
.dm-mcp-panel-btn--gradient {
  background: var(--p-grad-primary);
  color: #ffffff;
  box-shadow: var(--p-glow);
}
.dm-mcp-panel-btn--gradient:hover:not(:disabled) {
  background: var(--p-grad-primary);
  color: #ffffff;
  box-shadow: var(--p-glow-hover);
  transform: translateY(-1px);
}
.dm-mcp-panel-textbtn {
  align-self: flex-end;
  padding: 4px 2px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--p-text-3);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  cursor: pointer;
  transition: color var(--p-ease-state);
}
.dm-mcp-panel-textbtn:hover {
  color: var(--p-text);
}
.dm-mcp-panel-textbtn:focus-visible {
  outline: 2px solid var(--p-focus);
  outline-offset: 2px;
}
/* 药丸：fill 而非描边，radius 999 */
.dm-mcp-panel-pill {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 18px;
  padding: 0 8px;
  border: 0;
  border-radius: 999px;
  background: var(--p-fill);
  color: var(--p-text-3);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
}
.dm-mcp-panel-pill--warn {
  background: var(--p-warn-tint);
  color: var(--p-text-2);
}
.dm-mcp-panel-pill--muted {
  background: var(--p-fill);
  color: var(--p-text-3);
}
/* 状态点：低饱和语义色，6px */
.dm-mcp-panel-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--p-mute);
}
.dm-mcp-panel-dot--success {
  background: var(--p-success);
}
.dm-mcp-panel-dot--warn {
  background: var(--p-warn);
}
.dm-mcp-panel-dot--error {
  background: var(--p-error);
}
.dm-mcp-panel-dot--idle {
  background: var(--p-mute);
}
.dm-mcp-panel-status {
  flex: none;
  color: var(--p-text-2);
  font-size: 12px;
  line-height: 1.4;
}
.dm-mcp-panel-mute {
  color: var(--p-text-3);
  font-size: 12px;
  line-height: 1.4;
}
/* server 行：独立可悬浮小卡，radius 12 */
.dm-mcp-panel-server-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dm-mcp-panel-server {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--p-r-row, 12px);
  background: var(--p-surface);
  box-shadow: var(--p-sh-card);
  transition:
    background var(--p-ease-feedback),
    box-shadow var(--p-ease-feedback);
}
.dm-mcp-panel-server:hover {
  background: var(--p-raised);
  box-shadow: var(--p-sh-card-hover);
}
.dm-mcp-panel-server-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.dm-mcp-panel-server-id {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.dm-mcp-panel-server-name {
  min-width: 0;
  overflow: hidden;
  color: var(--p-text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-mcp-panel-server-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.4;
}
.dm-mcp-panel-server-error {
  min-width: 0;
  overflow: hidden;
  color: var(--p-text-3);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 开关：on 纯色 #3b82f6，不用渐变 */
.dm-mcp-panel-switch {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--p-fill-strong);
  cursor: pointer;
  transition:
    background var(--p-ease-feedback),
    opacity var(--p-ease-state);
}
.dm-mcp-panel-switch:hover:not(:disabled) {
  background: var(--p-fill-strong);
}
.dm-mcp-panel-switch:focus-visible {
  outline: 2px solid var(--p-focus);
  outline-offset: 2px;
}
.dm-mcp-panel-switch:disabled {
  opacity: .45;
  cursor: default;
}
.dm-mcp-panel-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--p-mute);
  transition:
    transform var(--p-ease-feedback),
    background var(--p-ease-feedback);
}
.dm-mcp-panel-switch--on {
  background: #3b82f6;
}
.dm-mcp-panel-switch--on .dm-mcp-panel-switch-thumb {
  transform: translateX(14px);
  background: #ffffff;
}
.dm-mcp-panel-switch--busy .dm-mcp-panel-switch-thumb {
  opacity: .55;
}
/* 配置提示：收进项目卡底部，小标题 + 12 tertiary 单行省略列表 */
.dm-mcp-panel-card-notes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin-top: 2px;
}
.dm-mcp-panel-card-note-title {
  margin: 0;
  color: var(--p-text-3);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}
.dm-mcp-panel-warning-list {
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  list-style: none;
  min-width: 0;
}
.dm-mcp-panel-warning {
  min-width: 0;
  overflow: hidden;
  color: var(--p-text-3);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 通知/错误：tint 面差，不加描边 */
.dm-mcp-panel-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--p-r-row, 12px);
  background: var(--p-error-tint);
  color: var(--p-text);
  font-size: 12px;
  line-height: 1.5;
}
.dm-mcp-panel-notice-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
}
.dm-mcp-panel-notice .dm-mcp-panel-btn {
  flex: none;
  height: 26px;
  padding: 0 10px;
  background: transparent;
  color: var(--p-text-2);
}
.dm-mcp-panel-notice .dm-mcp-panel-btn:hover:not(:disabled) {
  background: var(--p-fill);
}
/* 空态：居中留白，不用插画 */
.dm-mcp-panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 36px 12px;
  text-align: center;
}
.dm-mcp-panel-empty-title {
  margin: 0;
  color: var(--p-text);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
}
.dm-mcp-panel-empty-desc {
  margin: 0;
  max-width: 30ch;
  color: var(--p-text-3);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
}
/* 全局：一块 surface 卡内多行，行间 8px + hover 填充，无分割线 */
.dm-mcp-panel-global-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dm-mcp-panel-global-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--p-r-row, 12px);
  transition: background var(--p-ease-state);
}
.dm-mcp-panel-global-row:hover {
  background: var(--p-fill);
}
.dm-mcp-panel-global-name {
  min-width: 0;
  overflow: hidden;
  color: var(--p-text-2);
  font-size: 12.5px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-mcp-panel-global-meta {
  display: flex;
  align-items: center;
  flex: none;
  gap: 8px;
  color: var(--p-text-3);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
}
.dm-mcp-panel-global-foot {
  display: flex;
  justify-content: flex-end;
  padding: 2px 4px 0;
}
/* 加载骨架 */
.dm-mcp-panel-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.dm-mcp-panel-skel {
  position: relative;
  overflow: hidden;
  height: 12px;
  border-radius: 999px;
  background: var(--p-fill);
}
.dm-mcp-panel-skel::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, var(--p-fill-hover), transparent);
  transform: translateX(-100%);
  animation: dm-mcp-panel-shimmer 1.4s var(--p-ease-state) infinite;
}
.dm-mcp-panel-skel--name {
  width: 46%;
  height: 14px;
}
.dm-mcp-panel-skel--meta {
  width: 68%;
}
.dm-mcp-panel-skel--row {
  width: 100%;
  height: 54px;
  border-radius: var(--p-r-row, 12px);
}
@keyframes dm-mcp-panel-shimmer {
  to {
    transform: translateX(100%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dm-mcp,
  .dm-mcp *,
  .dm-mcp-panel-root,
  .dm-mcp-panel-root * {
    animation-duration: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
  }
  .dm-mcp__skel-bar::after,
  .dm-mcp-panel-root .dm-mcp__skel-bar::after {
    display: none;
  }
}
`

    // ---------------------------------------------------------------------
    // 文案：zh / en 两份完整字典，全部页面文案都从这里取
    // ---------------------------------------------------------------------

    const ZH = {
      sectionLabel: 'MCP 服务',
      sectionTitle: 'MCP 服务',
      sectionDescription: '管理当前 profile 的 MCP server，改动约 2 秒热生效。',
      'action.refresh': '刷新',
      'action.add': '新增服务',
      'action.delete': '删除',
      'action.save': '保存',
      'action.cancel': '取消',
      'action.close': '关闭',
      'state.loading': '加载中…',
      'state.applying': '应用中…',
      'state.error': '加载失败',
      'state.retry': '重试',
      'state.empty': '还没有可管理的 MCP 服务',
      'state.emptyHint': '用「新增服务」创建一个。',
      'notice.saved': '已保存。',
      'notice.savedPending': '已保存，等待生效（请查看日志）。',
      'notice.dismiss': '关闭提示',
      'summary.running': '运行中',
      'summary.failed': '加载失败',
      'summary.disabled': '已停用',
      'summary.tools': '工具',
      'summary.updated': '最后更新 {time}',
      'row.id': 'ID {id}',
      'row.tools': '{count} 个工具',
      'row.applying': '应用中…',
      'row.readOnlyShort': '只读',
      'row.readOnlyChip': '只读 · {source}',
      'row.editAria': '编辑 {name}',
      'row.deleteAria': '删除 {name}',
      'row.toggleOnAria': '启用 {name}',
      'row.toggleOffAria': '停用 {name}',
      'row.toggleBlocked': '该行不在 profile patch 中，无法在此启停',
      'row.readOnly': '该行来自 {source} 层，是只读行，不能编辑、启停或删除。',
      'phase.pending': '启动中',
      'phase.loading': '重连中',
      'phase.active': '运行中',
      'phase.failed': '加载失败',
      'phase.unloading': '停止中',
      'phase.disabled': '已停用',
      'phase.unknown': '未运行',
      'phase.waiting': '等待凭据',
      'source.profile': 'profile',
      'source.home': 'home',
      'source.bundle': 'bundle',
      'source.other': '其他',
      'transport.stdio': 'stdio',
      'transport.http': 'HTTP',
      'confirm.deleteTitle': '删除 MCP 服务',
      'confirm.deleteBody': '删除后会把该行从 profile patch 中移除，相关工具会立即消失。此操作不可撤销。',
      'form.addTitle': '新增 MCP 服务',
      'form.editTitle': '编辑 MCP 服务',
      'form.editingId': '编辑行 {id}',
      'form.serverName': '名称（serverName）',
      'form.serverNameHint': '仅允许字母、数字、下划线和中划线，最长 32 个字符。',
      'form.transport': '传输方式',
      'form.command': '命令',
      'form.commandHint': 'stdio 必填，例如 npx 或 node。',
      'form.args': '参数（每行一个）',
      'form.cwd': '工作目录（可选）',
      'form.env': '环境变量',
      'form.url': '服务 URL',
      'form.urlHint': 'streamable-http 必填，例如 http://127.0.0.1:7333/mcp。',
      'form.headers': '请求头',
      'form.secretsHint': '值保持 {mask} 表示不修改；清空该值则删除对应键；输入新值会整体替换。',
      'form.expressionHint': '值为 {expression} 的项来自 !!js 表达式，保持不变即可。',
      'form.advanced': '高级选项',
      'form.toolCallTimeoutMs': '工具调用超时（毫秒）',
      'form.maxInstructionBytes': '最大指令字节数',
      'form.failOnStartupError': '启动失败即报错',
      'form.failOnStartupError.unset': '默认',
      'form.failOnStartupError.true': '是',
      'form.failOnStartupError.false': '否',
      'form.enabled': '启用此服务',
      'form.keyPlaceholder': '键',
      'form.valuePlaceholder': '值',
      'form.addEntry': '添加',
      'form.removeEntry': '移除',
      'form.envEmpty': '尚未配置环境变量',
      'form.headersEmpty': '尚未配置请求头',
      'form.placeholder.serverName': '例如 my-server',
      'form.placeholder.url': 'http://127.0.0.1:7333/mcp',
      'form.placeholder.command': '例如 npx',
      'form.placeholder.args': '每行一个参数，例如：\n-y\nsome-mcp',
      'form.error.serverNameRequired': '请填写名称。',
      'form.error.serverNamePattern': '名称仅允许字母、数字、下划线和中划线，最长 32 个字符。',
      'form.error.serverNameDuplicate': '该名称已被其他行使用。',
      'form.error.commandRequired': 'stdio 传输必须填写命令。',
      'form.error.urlRequired': 'streamable-http 传输必须填写 URL。',
      'form.error.positiveInteger': '请输入正整数。',
      'form.error.duplicateKeys': '存在重复的键。',
      'error.FORBIDDEN': '没有访问权限（HTTP 403）。',
      'error.BAD_REQUEST': '请求格式不正确（HTTP 400）。',
      'error.INVALID_ARGUMENT': '参数校验未通过。',
      'error.CONFLICT': '配置已被外部修改，请刷新后重试。',
      'error.NOT_FOUND': '目标行不存在，请刷新后重试。',
      'error.NOT_EDITABLE': '该行来自只读层，无法修改。',
      'error.UNSUPPORTED': '该行使用表达式控制启停，无法安全改写，请在配置文件中手动修改。',
      'error.WRITE_FAILED': '写入配置文件失败。',
      'error.INTERNAL': '内部错误，请查看日志。',
      'error.NETWORK': '网络请求失败，请确认已连接到 DSH。',
      'error.UNAVAILABLE': '无法访问 MCP 管理接口，请确认插件已启用并重新加载页面。',
      'error.UNKNOWN': '未知错误。',
      'error.field': '字段：{field}',
      'error.detail': '详情：{detail}',
      'error.noRevision': '缺少配置基线（revision），请先刷新列表。',
      'composer.buttonLabel': '项目 MCP',
      'composer.ariaUntrusted': '项目 MCP，尚未信任',
      'composer.ariaFailed': '项目 MCP，有服务加载失败',
      'composer.panelTitle': '项目 MCP',
      'composer.projectSection': '本项目',
      'composer.globalSection': '全局',
      'composer.projectDir': '项目目录',
      'composer.noProjectDir': '未发现项目声明',
      'composer.sourceFiles': '来源文件',
      'composer.noFiles': '没找到 .mcp.json 或 .codex/config.toml',
      'composer.trustLabel': '信任状态',
      'composer.trusted': '已信任',
      'composer.untrusted': '未信任',
      'composer.trustEnable': '信任并启用',
      'composer.trustRevoke': '撤销信任',
      'composer.trustHint': '信任后本项目声明的 MCP 会在本会话自动挂载；项目文件保持只读。',
      'composer.trustFirst': '先信任该项目才能启用项目 MCP',
      'composer.reload': '重新加载项目 MCP',
      'composer.noServers': '项目声明里没有可用的 MCP server',
      'composer.warnings': '配置提示',
      'composer.noGlobal': '全局没有 MCP server',
      'composer.globalEmptyDesc': '全局 MCP 由设置页统一管理。',
      'composer.openSettings': '去设置管理',
      'composer.settingsHint': '当前无法直接打开设置，请打开「设置 > MCP 服务」管理全局 MCP。',
      'composer.status.starting': '启动中',
      'composer.status.connected': '已连接',
      'composer.status.failed': '加载失败',
      'composer.status.stopped': '已停止',
      'composer.sourceClaude': 'claude',
      'composer.sourceCodex': 'codex',
      'composer.overridesGlobal': '覆盖全局',
      'composer.fileDisabled': '该服务在项目文件里被禁用',
      'composer.fileDisabledChip': '文件内禁用',
      'composer.toggleOnAria': '启用 {name}',
      'composer.toggleOffAria': '停用 {name}',
      'footer.profileLabel': '配置文件',
      'footer.baselineLabel': '基线',
      'footer.updatedLabel': '更新于',
    }

    const EN = {
      sectionLabel: 'MCP servers',
      sectionTitle: 'MCP servers',
      sectionDescription: 'Manage the MCP servers of the active profile. Changes apply in about 2 seconds.',
      'action.refresh': 'Refresh',
      'action.add': 'Add server',
      'action.delete': 'Delete',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.close': 'Close',
      'state.loading': 'Loading…',
      'state.applying': 'Applying…',
      'state.error': 'Failed to load',
      'state.retry': 'Retry',
      'state.empty': 'No MCP servers to manage yet',
      'state.emptyHint': 'Click "Add server" to create one.',
      'notice.saved': 'Saved.',
      'notice.savedPending': 'Saved; waiting for the reload to take effect (check the logs).',
      'notice.dismiss': 'Dismiss notice',
      'summary.running': 'Running',
      'summary.failed': 'Failed',
      'summary.disabled': 'Disabled',
      'summary.tools': 'Tools',
      'summary.updated': 'Updated {time}',
      'row.id': 'ID {id}',
      'row.tools': '{count} tools',
      'row.applying': 'Applying…',
      'row.readOnlyShort': 'read-only',
      'row.readOnlyChip': 'read-only · {source}',
      'row.editAria': 'Edit {name}',
      'row.deleteAria': 'Delete {name}',
      'row.toggleOnAria': 'Enable {name}',
      'row.toggleOffAria': 'Disable {name}',
      'row.toggleBlocked': 'This row is not in the profile patch and cannot be toggled here',
      'row.readOnly': 'This row comes from the {source} layer and is read-only; it cannot be edited, toggled or deleted.',
      'phase.pending': 'Starting',
      'phase.loading': 'Reconnecting',
      'phase.active': 'Running',
      'phase.failed': 'Failed to load',
      'phase.unloading': 'Stopping',
      'phase.disabled': 'Disabled',
      'phase.unknown': 'Not running',
      'phase.waiting': 'Waiting for credentials',
      'source.profile': 'profile',
      'source.home': 'home',
      'source.bundle': 'bundle',
      'source.other': 'other',
      'transport.stdio': 'stdio',
      'transport.http': 'HTTP',
      'confirm.deleteTitle': 'Delete MCP server',
      'confirm.deleteBody': 'Deleting removes the row from the profile patch and its tools disappear immediately. This cannot be undone.',
      'form.addTitle': 'Add MCP server',
      'form.editTitle': 'Edit MCP server',
      'form.editingId': 'Editing row {id}',
      'form.serverName': 'Name (serverName)',
      'form.serverNameHint': 'Letters, digits, underscores and hyphens only; at most 32 characters.',
      'form.transport': 'Transport',
      'form.command': 'Command',
      'form.commandHint': 'Required for stdio, e.g. npx or node.',
      'form.args': 'Arguments (one per line)',
      'form.cwd': 'Working directory (optional)',
      'form.env': 'Environment variables',
      'form.url': 'Server URL',
      'form.urlHint': 'Required for streamable-http, e.g. http://127.0.0.1:7333/mcp.',
      'form.headers': 'Headers',
      'form.secretsHint': 'Keep {mask} to leave the value unchanged; clear the field to delete the key; type a new value to replace it.',
      'form.expressionHint': 'Values shown as {expression} come from !!js expressions; leaving them unchanged is enough.',
      'form.advanced': 'Advanced',
      'form.toolCallTimeoutMs': 'Tool call timeout (ms)',
      'form.maxInstructionBytes': 'Max instruction bytes',
      'form.failOnStartupError': 'Fail on startup error',
      'form.failOnStartupError.unset': 'Default',
      'form.failOnStartupError.true': 'Yes',
      'form.failOnStartupError.false': 'No',
      'form.enabled': 'Enable this server',
      'form.keyPlaceholder': 'Key',
      'form.valuePlaceholder': 'Value',
      'form.addEntry': 'Add',
      'form.removeEntry': 'Remove',
      'form.envEmpty': 'No environment variables configured',
      'form.headersEmpty': 'No headers configured',
      'form.placeholder.serverName': 'e.g. my-server',
      'form.placeholder.url': 'http://127.0.0.1:7333/mcp',
      'form.placeholder.command': 'e.g. npx',
      'form.placeholder.args': 'One argument per line, e.g.:\n-y\nsome-mcp',
      'form.error.serverNameRequired': 'Enter a name.',
      'form.error.serverNamePattern': 'Use letters, digits, underscores and hyphens; at most 32 characters.',
      'form.error.serverNameDuplicate': 'Another row already uses this name.',
      'form.error.commandRequired': 'stdio transport requires a command.',
      'form.error.urlRequired': 'streamable-http transport requires a URL.',
      'form.error.positiveInteger': 'Enter a positive integer.',
      'form.error.duplicateKeys': 'Duplicate keys.',
      'error.FORBIDDEN': 'Request not admitted (HTTP 403).',
      'error.BAD_REQUEST': 'Malformed request (HTTP 400).',
      'error.INVALID_ARGUMENT': 'Validation failed.',
      'error.CONFLICT': 'The configuration changed elsewhere; refresh and try again.',
      'error.NOT_FOUND': 'The target row does not exist; refresh and try again.',
      'error.NOT_EDITABLE': 'The row comes from a read-only layer.',
      'error.UNSUPPORTED': 'This row controls enablement with an expression and cannot be rewritten safely; edit the configuration file manually.',
      'error.WRITE_FAILED': 'Writing the configuration file failed.',
      'error.INTERNAL': 'Internal error; check the logs.',
      'error.NETWORK': 'Network request failed; make sure DSH is reachable.',
      'error.UNAVAILABLE': 'Cannot reach the MCP management API; make sure the plugin is enabled and reload the page.',
      'error.UNKNOWN': 'Unknown error.',
      'error.field': 'Field: {field}',
      'error.detail': 'Detail: {detail}',
      'error.noRevision': 'Missing the configuration baseline (revision); refresh the list first.',
      'composer.buttonLabel': 'Project MCP',
      'composer.ariaUntrusted': 'Project MCP, not trusted yet',
      'composer.ariaFailed': 'Project MCP, a server failed to load',
      'composer.panelTitle': 'Project MCP',
      'composer.projectSection': 'This project',
      'composer.globalSection': 'Global',
      'composer.projectDir': 'Project directory',
      'composer.noProjectDir': 'No project declaration found',
      'composer.sourceFiles': 'Source files',
      'composer.noFiles': 'No .mcp.json or .codex/config.toml found',
      'composer.trustLabel': 'Trust',
      'composer.trusted': 'Trusted',
      'composer.untrusted': 'Not trusted',
      'composer.trustEnable': 'Trust and enable',
      'composer.trustRevoke': 'Revoke trust',
      'composer.trustHint': 'After trusting, project MCP servers are mounted in this session; project files stay read-only.',
      'composer.trustFirst': 'Trust this project before enabling its MCP servers',
      'composer.reload': 'Reload project MCP',
      'composer.noServers': 'No project MCP servers declared',
      'composer.warnings': 'Config notes',
      'composer.noGlobal': 'No global MCP servers',
      'composer.globalEmptyDesc': 'Global MCP is managed from Settings.',
      'composer.openSettings': 'Manage in Settings',
      'composer.settingsHint': 'Open Settings > MCP servers to manage global MCP.',
      'composer.status.starting': 'Starting',
      'composer.status.connected': 'Connected',
      'composer.status.failed': 'Failed to load',
      'composer.status.stopped': 'Stopped',
      'composer.sourceClaude': 'claude',
      'composer.sourceCodex': 'codex',
      'composer.overridesGlobal': 'Overrides global',
      'composer.fileDisabled': 'This server is disabled in the project file',
      'composer.fileDisabledChip': 'Disabled in file',
      'composer.toggleOnAria': 'Enable {name}',
      'composer.toggleOffAria': 'Disable {name}',
      'footer.profileLabel': 'Config file',
      'footer.baselineLabel': 'Baseline',
      'footer.updatedLabel': 'Updated',
    }

    /** apply 内绑定到当前 locale 服务的翻译函数（slot 未注入 t 时的兜底）。 */
    let translate = (key) => key
    /** 插件 ctx：仅用于可选服务访问（settings.open 快捷键），不可用时代码自行降级。 */
    let pluginCtx = null

    // ---------------------------------------------------------------------
    // Host API 访问
    // ---------------------------------------------------------------------

    /** 一次 Host API 失败：code 来自契约错误码表，带 field/details。 */
    class ApiFailure extends Error {
      constructor(error) {
        super(typeof error.message === 'string' && error.message !== '' ? error.message : String(error.code ?? ''))
        this.name = 'ApiFailure'
        this.code = typeof error.code === 'string' && error.code !== '' ? error.code : 'INTERNAL'
        this.field = typeof error.field === 'string' && error.field !== '' ? error.field : undefined
        this.details = error.details
      }
    }

    /**
     * 调用一个 Host action：统一处理 HTTP 403/400、非 JSON 响应与业务错误 envelope。
     * @param {string} action list | upsert | remove | toggle
     * @param {object} [body] 请求体
     * @returns {Promise<object>} envelope.data
     * @throws {ApiFailure} 任一失败路径
     */
    async function callAction(action, body = {}) {
      let response
      try {
        response = await fetch(`${API_BASE}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
        })
      } catch (cause) {
        throw new ApiFailure({ code: 'NETWORK', message: messageOf(cause) })
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload !== null && typeof payload === 'object' && payload.ok === true) {
        return payload.data
      }
      const error = payload !== null && typeof payload === 'object' ? payload.error : null
      if (error !== null && typeof error === 'object') {
        throw new ApiFailure(error)
      }
      // 没有 envelope（例如网关错误页）时按 HTTP 状态兜底。
      if (response.status === 403) throw new ApiFailure({ code: 'FORBIDDEN' })
      if (response.status === 400) throw new ApiFailure({ code: 'BAD_REQUEST' })
      throw new ApiFailure({ code: 'UNAVAILABLE', details: { status: response.status } })
    }

    /**
     * 把失败对象渲染成本地化文案；本地校验失败可直接传 `{ text }`。
     * @param {(key: string, params?: object) => string} t 翻译函数
     * @param {unknown} failure ApiFailure | `{ text }` | 其他
     * @returns {string} 展示文案
     */
    function failureText(t, failure) {
      if (failure === null || failure === undefined) return t('error.UNKNOWN')
      if (typeof failure === 'object' && typeof failure.text === 'string') return failure.text
      const code = typeof failure === 'object' && typeof failure.code === 'string' ? failure.code : ''
      const key = ERROR_KEY_BY_CODE[code]
      const message = typeof failure === 'object' && typeof failure.message === 'string' ? failure.message : ''
      // 未知 code：按契约直接展示 Host 返回的原文，避免吞掉诊断信息。
      if (key === undefined) {
        let raw = message !== '' ? message : t('error.UNKNOWN')
        if (typeof failure === 'object' && typeof failure.field === 'string' && failure.field !== '') {
          raw = `${raw} ${t('error.field', { field: failure.field })}`
        }
        return raw
      }
      let text = t(key)
      if (typeof failure === 'object' && typeof failure.field === 'string' && failure.field !== '') {
        text = `${text} ${t('error.field', { field: failure.field })}`
      }
      if (typeof failure === 'object' && isPlainObject(failure.details)) {
        const detail = code === 'CONFLICT' && typeof failure.details.currentRevision === 'string'
          ? shortRevision(failure.details.currentRevision)
          : code === 'UNAVAILABLE' && typeof failure.details.status === 'number'
            ? `HTTP ${failure.details.status}`
            : (typeof failure.details.reason === 'string' ? failure.details.reason : '')
        if (detail !== '') text = `${text} ${t('error.detail', { detail })}`
      }
      return text
    }

    // ---------------------------------------------------------------------
    // 项目级 MCP Host API（契约 docs/contracts/project-internals.md §3）
    // ---------------------------------------------------------------------

    /**
     * 轻量角标数据：只有 relevant=true 时 composer 才显示入口图标。
     * @param {string} sessionId 会话 id
     * @returns {Promise<{ relevant: boolean, badge: 'untrusted'|'failed'|null }>}
     */
    async function fetchProjectBadge(sessionId) {
      const data = await callAction('project/badge', { sessionId })
      const source = isPlainObject(data) ? data : {}
      return {
        relevant: source.relevant === true,
        badge: source.badge === 'untrusted' || source.badge === 'failed' ? source.badge : null,
      }
    }

    /** 防御式字符串读取。 */
    function asText(value) {
      return typeof value === 'string' ? value : ''
    }

    /** 项目声明文件列表归一（path/format）。 */
    function normalizeProjectFiles(value) {
      if (!Array.isArray(value)) return []
      const files = []
      for (const item of value) {
        if (!isPlainObject(item)) continue
        const path = asText(item.path)
        if (path === '') continue
        files.push({ path, format: item.format === 'codex' ? 'codex' : 'claude' })
      }
      return files
    }

    /** 项目 server 行归一（字段全部做类型兜底，坏数据不至于打崩面板）。 */
    function normalizeProjectServer(value) {
      if (!isPlainObject(value)) return null
      const name = asText(value.name)
      if (name === '') return null
      const status = PROJECT_STATUS_KEYS[value.status] ? value.status : 'stopped'
      return {
        name,
        source: value.source === 'codex' ? 'codex' : 'claude',
        transport: value.transport === TRANSPORT_HTTP ? TRANSPORT_HTTP : TRANSPORT_STDIO,
        enabled: value.enabled === true,
        fileEnabled: value.fileEnabled !== false,
        status,
        lastError: asText(value.lastError),
        overridesGlobal: value.overridesGlobal === true,
        active: value.active === true,
        toolCount: typeof value.toolCount === 'number' && value.toolCount >= 0 ? value.toolCount : null,
      }
    }

    /** 全局 MCP 只读行归一（name/phase/toolCount/enabled）。 */
    function normalizeGlobalServer(value) {
      if (!isPlainObject(value)) return null
      const name = asText(value.name)
      if (name === '') return null
      return {
        name,
        phase: typeof value.phase === 'string' ? value.phase : null,
        toolCount: typeof value.toolCount === 'number' && value.toolCount >= 0 ? value.toolCount : 0,
        enabled: value.enabled !== false,
      }
    }

    /** project/session 视图归一。 */
    function normalizeProjectView(data) {
      const source = isPlainObject(data) ? data : {}
      return {
        cwd: asText(source.cwd),
        projectDir: asText(source.projectDir),
        files: normalizeProjectFiles(source.files),
        trusted: source.trusted === true,
        servers: Array.isArray(source.servers)
          ? source.servers.map(normalizeProjectServer).filter((server) => server !== null)
          : [],
        warnings: Array.isArray(source.warnings)
          ? source.warnings.filter((warning) => typeof warning === 'string' && warning !== '')
          : [],
        global: Array.isArray(source.global)
          ? source.global.map(normalizeGlobalServer).filter((server) => server !== null)
          : [],
      }
    }

    /** 打开面板/操作后拉取会话项目视图。 */
    async function fetchProjectSession(sessionId) {
      return normalizeProjectView(await callAction('project/session', { sessionId }))
    }

    /** 信任 / 撤销信任（写 trust.json，项目文件保持只读）。 */
    async function setProjectTrust(dir, trusted) {
      return callAction('project/trust', { dir, trusted: trusted === true })
    }

    /** 切换单个项目 server 的启用意愿（持久化到 trust.json）。 */
    async function toggleProjectServer(sessionId, serverName, enabled) {
      return callAction('project/toggle', { sessionId, serverName, enabled: enabled === true })
    }

    /** 重新读取项目声明并重建本会话挂载。 */
    async function reloadProjectSession(sessionId) {
      return normalizeProjectView(await callAction('project/reload', { sessionId }))
    }

    /**
     * 尽量用官方快捷键动作「settings.open」打开设置；拿不到该服务或没有该动作时返回 false，
     * UI 改为展示「设置 > MCP 服务」路径说明，绝不硬编码或操作别人的 DOM。
     * @returns {boolean} 是否已触发打开
     */
    function openSettingsBestEffort() {
      try {
        if (pluginCtx === null || typeof pluginCtx.get !== 'function') return false
        const shortcuts = pluginCtx.get('shortcuts')
        if (shortcuts === null || shortcuts === undefined || typeof shortcuts.invoke !== 'function') return false
        const catalog = shortcuts.catalog
        const rows = catalog !== undefined && typeof catalog.getSnapshot === 'function' ? catalog.getSnapshot() : null
        const available = Array.isArray(rows) && rows.some((row) => isPlainObject(row) && row.id === 'settings.open')
        if (!available) return false
        shortcuts.invoke('settings.open', { modal: null })
        return true
      } catch {
        return false
      }
    }

    // ---------------------------------------------------------------------
    // 通用纯函数
    // ---------------------------------------------------------------------

    /** 判断普通对象（排除 null / 数组）。 */
    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /** 安全读取错误 message。 */
    function messageOf(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    /** 取 revision 的短形式用于展示。 */
    function shortRevision(revision) {
      if (typeof revision !== 'string' || revision === '') return ''
      const value = revision.startsWith('sha256:') ? revision.slice('sha256:'.length) : revision
      return value.slice(0, 12)
    }

    /** 把 generatedAt 格式化为本地时分（摘要行与页脚用）；解析失败时原样返回。 */
    function formatClock(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      try {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
      } catch {
        return date.toISOString()
      }
    }

    /** 行状态文案。 */
    function phaseLabel(t, phase) {
      return t(PHASE_KEYS[phase] ?? PHASE_KEYS.unknown)
    }

    /** 行状态圆点色调（success / warn / error / idle）。 */
    function phaseTone(phase) {
      return PHASE_TONES[phase] ?? PHASE_TONES.unknown
    }

    /** 来源层文案。 */
    function sourceLabel(t, source) {
      return t(SOURCE_KEYS[source] ?? SOURCE_KEYS.other)
    }

    /** 行的 transport 展示 key；未知 transport 返回空串。 */
    function transportKey(row) {
      if (row.transport === TRANSPORT_HTTP) return 'transport.http'
      if (row.transport === TRANSPORT_STDIO) return 'transport.stdio'
      return ''
    }

    /** stdio 行把 command + args 拼成一行展示。 */
    function commandLine(row) {
      const parts = []
      if (typeof row.command === 'string' && row.command !== '') parts.push(row.command)
      if (Array.isArray(row.args)) {
        for (const arg of row.args) {
          if (typeof arg === 'string') parts.push(arg)
        }
      }
      return parts.join(' ')
    }

    /** 行的命令/URL 原始文本（列表单行省略展示，title 给全文）。 */
    function rowTarget(row) {
      if (row.transport === TRANSPORT_HTTP) {
        return typeof row.url === 'string' && row.url !== '' ? row.url : ''
      }
      return commandLine(row)
    }

    /** 把行内 env/headers（值恒为 MASK 或 EXPRESSION）换成表单行。 */
    function makeSecretEntries(map, nextEntryId) {
      if (!isPlainObject(map)) return []
      return Object.keys(map).map((key) => ({
        id: nextEntryId(),
        key,
        value: String(map[key]),
        original: true,
      }))
    }

    /** 表单 env/headers → 提交用的完整 map；未改动的掩码值回传 SECRET_KEEP。 */
    function buildSecretMap(entries) {
      const map = {}
      let count = 0
      for (const entry of entries) {
        const key = String(entry.key ?? '').trim()
        if (key === '') continue
        const value = String(entry.value ?? '')
        if (entry.original === true && (value === MASK || value === EXPRESSION)) {
          map[key] = SECRET_KEEP
          count += 1
          continue
        }
        // 清空 = 删除该 key（不出现在提交的 map 里）。
        if (value === '') continue
        map[key] = value
        count += 1
      }
      return count === 0 ? null : map
    }

    /** 参数文本框（每行一个）→ string[]，忽略空行。 */
    function splitArgs(text) {
      if (typeof text !== 'string') return []
      return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    }

    /** 可选的十进制正整数输入校验（空 = 未设置）。 */
    function isPositiveIntegerText(text) {
      const value = String(text ?? '').trim()
      if (value === '') return true
      if (!/^\d+$/.test(value)) return false
      const number = Number(value)
      return Number.isSafeInteger(number) && number > 0
    }

    /** 可选的十进制正整数 → number | null。 */
    function parseOptionalPositiveInteger(text) {
      const value = String(text ?? '').trim()
      if (!isPositiveIntegerText(value) || value === '') return null
      return Number(value)
    }

    /** env/headers 表单是否出现重复键。 */
    function hasDuplicateKeys(entries) {
      const seen = new Set()
      for (const entry of entries) {
        const key = String(entry.key ?? '').trim()
        if (key === '') continue
        if (seen.has(key)) return true
        seen.add(key)
      }
      return false
    }

    /** 表单初始状态（新增为空、编辑用行数据回填）。 */
    function createFormState(row, nextEntryId) {
      const editing = isPlainObject(row)
      return {
        originalId: editing ? String(row.id ?? '') : '',
        serverName: editing ? String(row.serverName ?? '') : '',
        transport: editing && row.transport === TRANSPORT_HTTP ? TRANSPORT_HTTP : TRANSPORT_STDIO,
        command: editing && typeof row.command === 'string' ? row.command : '',
        argsText: editing && Array.isArray(row.args) ? row.args.join('\n') : '',
        cwd: editing && typeof row.cwd === 'string' ? row.cwd : '',
        envRows: makeSecretEntries(editing ? row.env : null, nextEntryId),
        url: editing && typeof row.url === 'string' ? row.url : '',
        headerRows: makeSecretEntries(editing ? row.headers : null, nextEntryId),
        toolCallTimeoutMs: editing && typeof row.toolCallTimeoutMs === 'number' ? String(row.toolCallTimeoutMs) : '',
        maxInstructionBytes: editing && typeof row.maxInstructionBytes === 'number' ? String(row.maxInstructionBytes) : '',
        failOnStartupError: editing && typeof row.failOnStartupError === 'boolean' ? String(row.failOnStartupError) : 'unset',
        // reconnect 不在表单中编辑，但必须透传：Host 把 config 当作完整期望值做 diff，
        // 缺省会让已有 reconnect 节点被删除。
        reconnect: editing && isPlainObject(row.reconnect) ? row.reconnect : null,
        enabled: editing ? row.disabled !== true : true,
      }
    }

    /** 表单校验；返回 { field: 文案 }。 */
    function validateForm(t, form, rows) {
      const errors = {}
      const serverName = String(form.serverName ?? '').trim()
      if (serverName === '') {
        errors.serverName = t('form.error.serverNameRequired')
      } else if (!SERVER_NAME_PATTERN.test(serverName)) {
        errors.serverName = t('form.error.serverNamePattern')
      } else if (rows.some((row) => row.serverName === serverName && row.id !== form.originalId)) {
        errors.serverName = t('form.error.serverNameDuplicate')
      }
      if (form.transport === TRANSPORT_HTTP) {
        if (String(form.url ?? '').trim() === '') errors.url = t('form.error.urlRequired')
      } else if (String(form.command ?? '').trim() === '') {
        errors.command = t('form.error.commandRequired')
      }
      if (!isPositiveIntegerText(form.toolCallTimeoutMs)) errors.toolCallTimeoutMs = t('form.error.positiveInteger')
      if (!isPositiveIntegerText(form.maxInstructionBytes)) errors.maxInstructionBytes = t('form.error.positiveInteger')
      if (hasDuplicateKeys(form.envRows)) errors.env = t('form.error.duplicateKeys')
      if (hasDuplicateKeys(form.headerRows)) errors.headers = t('form.error.duplicateKeys')
      return errors
    }

    /** 表单状态 → upsert 请求的 row 载荷（transport 不适用的字段显式置 null）。 */
    function buildRowPayload(form) {
      const isHttp = form.transport === TRANSPORT_HTTP
      const args = isHttp ? [] : splitArgs(form.argsText)
      const command = String(form.command ?? '').trim()
      const cwd = String(form.cwd ?? '').trim()
      const url = String(form.url ?? '').trim()
      return {
        serverName: String(form.serverName ?? '').trim(),
        transport: form.transport,
        command: isHttp || command === '' ? null : command,
        args: isHttp || args.length === 0 ? null : args,
        cwd: isHttp || cwd === '' ? null : cwd,
        env: isHttp ? null : buildSecretMap(form.envRows),
        url: isHttp && url !== '' ? url : null,
        headers: isHttp ? buildSecretMap(form.headerRows) : null,
        toolCallTimeoutMs: parseOptionalPositiveInteger(form.toolCallTimeoutMs),
        maxInstructionBytes: parseOptionalPositiveInteger(form.maxInstructionBytes),
        failOnStartupError: form.failOnStartupError === 'unset' ? null : form.failOnStartupError === 'true',
        reconnect: isPlainObject(form.reconnect) ? form.reconnect : null,
        enabled: form.enabled === true,
      }
    }

    // ---------------------------------------------------------------------
    // 基础展示组件
    // ---------------------------------------------------------------------

    /** 组件卸载标记，异步回调返回前检查，避免卸载后 setState。 */
    function useAlive() {
      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])
      return alive
    }

    /** 文本按钮：variant 决定强调级别，size=sm 用于表单内联小按钮。 */
    function Button({ label, onClick, disabled, variant = 'ghost', size, title, type = 'button' }) {
      const classes = `dm-mcp__btn dm-mcp__btn--${variant}${size === 'sm' ? ' dm-mcp__btn--sm' : ''}`
      return h('button', {
        type,
        className: classes,
        disabled: disabled === true,
        title,
        onClick: disabled === true ? noop : onClick,
      }, label)
    }

    /** 状态圆点（8px，仅 semantic 色）。 */
    function StatusDot({ tone }) {
      return h('span', { className: `dm-mcp__dot dm-mcp__dot--${tone}`, 'aria-hidden': 'true' })
    }

    // 本 profile 的 client module graph 里没有任何 icon 包（无 ui-primitives / react-icons /
    // iconify），插件单文件无构建且禁止新增依赖，因此手写最小图标集：只做编辑与删除两个
    // 16px 线性图标（24-grid、currentColor、stroke 1.5、圆角端点），几何从简。
    /** 线性图标公共外壳（16px 渲染，24 网格）。 */
    function IconBase({ children }) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        className: 'dm-mcp__icon',
      }, children)
    }

    /** 编辑：笔杆 + 笔尖 + 底边。 */
    function PencilIcon() {
      return h(IconBase, null,
        h('path', { d: 'M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z' }),
        h('path', { d: 'M14 7l3 3' }))
    }

    /** 删除：桶盖 + 桶身 + 两条竖线。 */
    function TrashIcon() {
      return h(IconBase, null,
        h('path', { d: 'M4 7h16' }),
        h('path', { d: 'M9.5 7V5h5v2' }),
        h('path', { d: 'M6.5 7l1 12h9l1-12' }),
        h('path', { d: 'M10 10.5v5.5' }),
        h('path', { d: 'M14 10.5v5.5' }))
    }

    /** MCP 入口图标：三个节点 + 连线（表示外部集成），几何从简。 */
    function McpIcon() {
      return h(IconBase, null,
        h('circle', { cx: 12, cy: 5, r: 2.1 }),
        h('circle', { cx: 5.5, cy: 18, r: 2.1 }),
        h('circle', { cx: 18.5, cy: 18, r: 2.1 }),
        h('path', { d: 'M10.4 6.7 7 15.9' }),
        h('path', { d: 'M13.6 6.7 17 15.9' }),
        h('path', { d: 'M7.6 18h8.8' }))
    }

    /** 行内 icon-only 按钮：必须有 aria-label + title 兜底。 */
    function IconButton({ icon, label, title, onClick, disabled, danger }) {
      return h('button', {
        type: 'button',
        className: `dm-mcp__btn dm-mcp__btn--icon${danger ? ' dm-mcp__btn--icon-danger' : ''}`,
        'aria-label': label,
        title: title ?? label,
        disabled: disabled === true,
        onClick: disabled === true ? noop : onClick,
      }, h(icon))
    }

    /** 启停开关：原生 button + role="switch"，click 直接触发 toggle（Space/Enter 原生支持）。 */
    function ToggleSwitch({ label, checked, busy, disabled, blockedTitle, onChange }) {
      const classes = ['dm-mcp__switch']
      if (checked) classes.push('dm-mcp__switch--on')
      if (busy) classes.push('dm-mcp__switch--busy')
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        title: blockedTitle ?? label,
        className: classes.join(' '),
        disabled: disabled === true,
        onClick: disabled === true ? noop : onChange,
      }, h('span', { className: 'dm-mcp__switch-thumb', 'aria-hidden': 'true' }))
    }

    /** 字段容器：label 在控件上方，提示与错误在下方（label 包裹控件，点击文字可聚焦）。 */
    function Field({ label, hint, error, children }) {
      return h('label', { className: 'dm-mcp__field' },
        h('span', { className: 'dm-mcp__label' }, label),
        children,
        hint ? h('span', { className: 'dm-mcp__hint' }, hint) : null,
        error ? h('span', { className: 'dm-mcp__error-text', role: 'alert' }, error) : null)
    }

    /** 单行文本输入。 */
    function TextInput({ value, onChange, placeholder, mono, disabled, inputType, readOnly, title }) {
      const classes = ['dm-mcp__input']
      if (mono) classes.push('dm-mcp__input--mono')
      if (readOnly) classes.push('dm-mcp__input--readonly')
      return h('input', {
        type: inputType ?? 'text',
        className: classes.join(' '),
        value,
        placeholder,
        title,
        disabled: disabled === true,
        readOnly: readOnly === true,
        onChange: (event) => onChange(event.target.value),
      })
    }

    /** 下拉选择。 */
    function SelectInput({ value, onChange, options, disabled }) {
      return h('select', {
        className: 'dm-mcp__select',
        value,
        disabled: disabled === true,
        onChange: (event) => onChange(event.target.value),
      }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
    }

    /** 复选框 + 标签 + 提示。 */
    function CheckboxInput({ checked, onChange, label, hint, disabled }) {
      return h('label', { className: 'dm-mcp__check' },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h('span', { className: 'dm-mcp__check-text' },
          h('span', null, label),
          hint ? h('span', { className: 'dm-mcp__check-hint' }, hint) : null))
    }

    /** 提示条：success / warn / error 三种 semantic 色调；可带一个行内操作按钮。 */
    function NoticeBar({ t, tone, title, text, action, onDismiss }) {
      const toneClass = tone === 'error' ? 'error' : tone === 'warn' ? 'warn' : 'success'
      return h('div', {
        className: `dm-mcp__notice dm-mcp__notice--${toneClass}`,
        role: tone === 'error' ? 'alert' : 'status',
      },
      title ? h('span', { className: 'dm-mcp__notice-title' }, title) : null,
      h('span', { className: 'dm-mcp__notice-text' }, text),
      action ?? null,
      onDismiss ? h(Button, {
        label: t('action.close'),
        title: t('notice.dismiss'),
        onClick: onDismiss,
      }) : null)
    }

    /** 三行骨架屏，形状与列表行一致。 */
    function ListSkeleton({ label }) {
      const rows = [0, 1, 2].map((index) => h('div', { key: index, className: 'dm-mcp__skel-row' },
        h('div', { className: 'dm-mcp__skel-main' },
          h('div', { className: 'dm-mcp__skel-bar dm-mcp__skel-bar--name' }),
          h('div', { className: 'dm-mcp__skel-bar dm-mcp__skel-bar--meta' })),
        h('div', { className: 'dm-mcp__skel-status' },
          h('div', { className: 'dm-mcp__skel-bar dm-mcp__skel-bar--status' }),
          h('div', { className: 'dm-mcp__skel-bar dm-mcp__skel-bar--tools' })),
        h('div', { className: 'dm-mcp__skel-actions' },
          h('div', { className: 'dm-mcp__skel-bar dm-mcp__skel-bar--switch' }),
          h('div', { className: 'dm-mcp__skel-bar dm-mcp__skel-bar--icon' }),
          h('div', { className: 'dm-mcp__skel-bar dm-mcp__skel-bar--icon' }))))
      return h('div', { className: 'dm-mcp__skeleton', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
        h('span', { className: 'dm-mcp__sr' }, label),
        rows)
    }

    // ---------------------------------------------------------------------
    // 模态框（Esc 关闭 / 打开聚焦 / 关闭归还焦点 / aria-modal）
    // ---------------------------------------------------------------------

    /** 居中模态框，内容区独立滚动；compact 用于短文本确认弹窗。 */
    function Modal({ t, title, onClose, children, footer, compact }) {
      const panelRef = useRef(null)
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const previous = document.activeElement
        const panel = panelRef.current
        if (panel !== null) {
          // 优先可见表单控件；没有输入时聚焦弹窗内操作按钮，再退到底部按钮。
          const fields = panel.querySelectorAll('input, select, textarea')
          const target = fields[0]
            ?? panel.querySelector('.dm-mcp__dialog-body button')
            ?? panel.querySelector('.dm-mcp__dialog-foot button')
            ?? panel
          if (target !== null && typeof target.focus === 'function') target.focus()
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && previous !== undefined && typeof previous.focus === 'function' && previous.isConnected) {
            previous.focus()
          }
        }
      }, [onClose])
      return h('div', { className: 'dm-mcp__overlay' },
        h('div', {
          ref: panelRef,
          className: `dm-mcp__dialog${compact ? ' dm-mcp__dialog--compact' : ''}`,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          tabIndex: -1,
        },
        h('div', { className: 'dm-mcp__dialog-head' },
          h('h2', { className: 'dm-mcp__dialog-title' }, title),
          h(Button, { label: t('action.close'), onClick: onClose })),
        h('div', { className: 'dm-mcp__dialog-body' }, children),
        footer ? h('div', { className: 'dm-mcp__dialog-foot' }, footer) : null))
    }

    // ---------------------------------------------------------------------
    // 列表行
    // ---------------------------------------------------------------------

    /** 一行 MCP 服务：服务信息 / 状态 / 操作（只读行按钮禁用并提示）。 */
    function McpRow({ t, row, busy, onEdit, onToggle, onRemove }) {
      const editable = row.editable === true
      const rowBusy = busy !== null && busy.id === row.id
      const disabledByBusy = busy !== null
      const source = typeof row.source === 'string' ? row.source : 'other'
      const phase = row.disabled === true
        ? 'disabled'
        : (typeof row.phase === 'string' && PHASE_KEYS[row.phase] ? row.phase : 'unknown')
      const transport = transportKey(row)
      const name = String(row.serverName ?? row.id ?? '')
      const id = String(row.id ?? '')
      const target = rowTarget(row)
      const toolCount = typeof row.toolCount === 'number' && row.toolCount >= 0 ? row.toolCount : 0
      const readOnlyHint = editable ? undefined : t('row.readOnly', { source: sourceLabel(t, source) })
      const readOnlyChipLabel = editable ? '' : t('row.readOnlyChip', { source: sourceLabel(t, source) })
      const enabled = row.disabled !== true
      const toggleLabel = enabled
        ? t('row.toggleOffAria', { name })
        : t('row.toggleOnAria', { name })
      const diagnosticText = phase === 'failed' && typeof row.diagnostic === 'string' && row.diagnostic !== ''
        ? String(row.diagnostic)
        : ''
      return h('li', { className: 'dm-mcp__row', 'data-dsh-mcp-row': id },
        h('div', { className: 'dm-mcp__row-main' },
          h('div', { className: 'dm-mcp__row-head' },
            h('span', { className: 'dm-mcp__server', title: name }, name),
            transport ? h('span', { className: 'dm-mcp__chip' }, t(transport)) : null,
            editable
              ? null
              : h('span', {
                className: 'dm-mcp__chip dm-mcp__chip--readonly',
                title: readOnlyChipLabel,
                'aria-label': readOnlyChipLabel,
              }, t('row.readOnlyShort'))),
          h('div', { className: 'dm-mcp__row-meta' },
            h('span', { className: 'dm-mcp__id' }, t('row.id', { id })),
            target !== ''
              ? h('span', { className: 'dm-mcp__dot-sep', 'aria-hidden': 'true' }, '\u00b7')
              : null,
            target !== ''
              ? h('span', { className: 'dm-mcp__target', title: target }, target)
              : null),
          // 堆叠布局下 diagnostic 放在元信息行下方（宽布局由状态列内的副本展示）。
          diagnosticText !== ''
            ? h('div', { className: 'dm-mcp__diagnostic dm-mcp__diagnostic--stack', title: diagnosticText }, diagnosticText)
            : null),
        h('div', { className: 'dm-mcp__row-status' },
          h('div', { className: 'dm-mcp__status' },
            h(StatusDot, { tone: rowBusy ? 'warn' : phaseTone(phase) }),
            h('span', { className: 'dm-mcp__status-text' }, rowBusy ? t('row.applying') : phaseLabel(t, phase))),
          h('div', { className: 'dm-mcp__row-tools' }, t('row.tools', { count: toolCount })),
          diagnosticText !== ''
            ? h('div', { className: 'dm-mcp__diagnostic dm-mcp__diagnostic--status', title: diagnosticText }, diagnosticText)
            : null),
        h('div', { className: 'dm-mcp__row-actions' },
          h(ToggleSwitch, {
            label: toggleLabel,
            checked: enabled,
            busy: rowBusy,
            disabled: !editable || disabledByBusy,
            blockedTitle: editable ? undefined : t('row.toggleBlocked'),
            onChange: () => onToggle(row),
          }),
          h('div', { className: 'dm-mcp__icon-group' },
            h(IconButton, {
              icon: PencilIcon,
              label: t('row.editAria', { name }),
              onClick: () => onEdit(row),
              disabled: !editable || disabledByBusy,
              title: readOnlyHint,
            }),
            h(IconButton, {
              icon: TrashIcon,
              label: t('row.deleteAria', { name }),
              onClick: () => onRemove(row),
              disabled: !editable || disabledByBusy,
              title: readOnlyHint,
              danger: true,
            }))))
    }

    // ---------------------------------------------------------------------
    // 确认对话框
    // ---------------------------------------------------------------------

    /** 二次确认：写入期间按钮禁用并展示失败原因（不关闭对话框）。 */
    function ConfirmDialog({ t, title, message, confirmLabel, destructive, onClose, onConfirm }) {
      const alive = useAlive()
      const [pending, setPending] = useState(false)
      const [failure, setFailure] = useState(null)
      async function run() {
        if (pending) return
        setPending(true)
        setFailure(null)
        try {
          await onConfirm()
        } catch (error) {
          if (alive.current) setFailure(error)
        } finally {
          if (alive.current) setPending(false)
        }
      }
      const footer = [
        h(Button, { key: 'cancel', label: t('action.cancel'), onClick: pending ? noop : onClose }),
        h(Button, {
          key: 'confirm',
          label: pending ? t('state.applying') : confirmLabel,
          onClick: run,
          disabled: pending,
          variant: destructive ? 'danger-solid' : 'primary',
        }),
      ]
      return h(Modal, { t, title, onClose: pending ? noop : onClose, footer, compact: true },
        h('p', { className: 'dm-mcp__hint' }, message),
        failure ? h(NoticeBar, { t, tone: 'error', text: failureText(t, failure) }) : null)
    }

    // ---------------------------------------------------------------------
    // 新增 / 编辑表单
    // ---------------------------------------------------------------------

    /** env/headers 键值编辑器：label 行右侧 ghost 小按钮添加；已有键只读（改名 = 删旧增新）。 */
    function SecretEditor({ t, label, hint, emptyText, entries, onAdd, onRemove, onUpdate }) {
      return h('div', { className: 'dm-mcp__field' },
        h('div', { className: 'dm-mcp__label-row' },
          h('span', { className: 'dm-mcp__label' }, label),
          h(Button, { label: t('form.addEntry'), onClick: onAdd, size: 'sm' })),
        entries.length === 0
          ? h('p', { className: 'dm-mcp__empty-note' }, emptyText)
          : h('div', { className: 'dm-mcp__entries' },
            entries.map((entry, index) => h('div', { key: entry.id, className: 'dm-mcp__entry' },
              h(TextInput, {
                value: entry.key,
                readOnly: entry.original === true,
                onChange: (value) => onUpdate(index, { key: value }),
                placeholder: t('form.keyPlaceholder'),
                mono: true,
              }),
              h(TextInput, {
                value: entry.value,
                onChange: (value) => onUpdate(index, { value }),
                placeholder: t('form.valuePlaceholder'),
                mono: true,
              }),
              h(Button, {
                label: t('form.removeEntry'),
                onClick: () => onRemove(index),
              })))),
        hint ? h('p', { className: 'dm-mcp__hint' }, hint) : null)
    }

    /** 新增/编辑表单：按 transport 切换字段，提交 upsert 并带 baseRevision。 */
    function FormDialog({ t, mode, row, rows, revision, onClose, onSaved }) {
      const editing = mode === 'edit' && isPlainObject(row)
      const alive = useAlive()
      const entrySeq = useRef(0)
      const nextEntryId = useCallback(() => {
        entrySeq.current += 1
        return `entry-${entrySeq.current}`
      }, [])
      const [form, setForm] = useState(() => createFormState(editing ? row : null, nextEntryId))
      const [errors, setErrors] = useState({})
      const [failure, setFailure] = useState(null)
      const [pending, setPending] = useState(false)
      const isHttp = form.transport === TRANSPORT_HTTP

      const updateField = (name) => (value) => {
        setForm((current) => ({ ...current, [name]: value }))
      }
      const updateEntry = (listName, index, patch) => {
        setForm((current) => ({
          ...current,
          [listName]: current[listName].map((entry, position) => (position === index ? { ...entry, ...patch } : entry)),
        }))
      }
      const addEntry = (listName) => () => {
        setForm((current) => ({
          ...current,
          [listName]: current[listName].concat([{ id: nextEntryId(), key: '', value: '', original: false }]),
        }))
      }
      const removeEntry = (listName, index) => () => {
        setForm((current) => ({
          ...current,
          [listName]: current[listName].filter((entry, position) => position !== index),
        }))
      }

      async function submit() {
        if (pending) return
        const nextErrors = validateForm(t, form, rows)
        setErrors(nextErrors)
        setFailure(null)
        if (Object.keys(nextErrors).length > 0) return
        if (typeof revision !== 'string' || revision === '') {
          setFailure({ text: t('error.noRevision') })
          return
        }
        setPending(true)
        try {
          const payload = { baseRevision: revision, row: buildRowPayload(form) }
          if (editing) payload.originalId = form.originalId
          const data = await callAction('upsert', payload)
          if (alive.current) await onSaved(data)
        } catch (error) {
          if (alive.current) setFailure(error)
        } finally {
          if (alive.current) setPending(false)
        }
      }

      const transportOptions = [
        { value: TRANSPORT_STDIO, label: t('transport.stdio') },
        { value: TRANSPORT_HTTP, label: t('transport.http') },
      ]
      const failOptions = [
        { value: 'unset', label: t('form.failOnStartupError.unset') },
        { value: 'true', label: t('form.failOnStartupError.true') },
        { value: 'false', label: t('form.failOnStartupError.false') },
      ]
      const secretHint = `${t('form.secretsHint', { mask: MASK })} ${t('form.expressionHint', { expression: EXPRESSION })}`

      const footer = [
        h(Button, { key: 'cancel', label: t('action.cancel'), onClick: pending ? noop : onClose }),
        h(Button, {
          key: 'save',
          label: pending ? t('state.applying') : t('action.save'),
          onClick: submit,
          disabled: pending,
          variant: 'primary',
        }),
      ]

      return h(Modal, {
        t,
        title: editing ? t('form.editTitle') : t('form.addTitle'),
        onClose: pending ? noop : onClose,
        footer,
      },
      editing ? h('p', { className: 'dm-mcp__hint' }, t('form.editingId', { id: form.originalId })) : null,
      h('div', { className: 'dm-mcp__grid-2' },
        h(Field, {
          label: t('form.serverName'),
          hint: t('form.serverNameHint'),
          error: errors.serverName,
        }, h(TextInput, {
          value: form.serverName,
          onChange: updateField('serverName'),
          placeholder: t('form.placeholder.serverName'),
          mono: true,
        })),
        h(Field, { label: t('form.transport') }, h(SelectInput, {
          value: form.transport,
          onChange: updateField('transport'),
          options: transportOptions,
        }))),
      isHttp
        ? h(Field, { label: t('form.url'), hint: t('form.urlHint'), error: errors.url },
          h(TextInput, {
            value: form.url,
            onChange: updateField('url'),
            placeholder: t('form.placeholder.url'),
            mono: true,
          }))
        : h('div', { className: 'dm-mcp__group' },
          h(Field, { label: t('form.command'), hint: t('form.commandHint'), error: errors.command },
            h(TextInput, {
              value: form.command,
              onChange: updateField('command'),
              placeholder: t('form.placeholder.command'),
              mono: true,
            })),
          h(Field, { label: t('form.args') },
            h('textarea', {
              className: 'dm-mcp__textarea dm-mcp__input--mono',
              value: form.argsText,
              placeholder: t('form.placeholder.args'),
              onChange: (event) => updateField('argsText')(event.target.value),
            })),
          h(Field, { label: t('form.cwd') },
            h(TextInput, {
              value: form.cwd,
              onChange: updateField('cwd'),
              mono: true,
            })),
          h(SecretEditor, {
            t,
            label: t('form.env'),
            hint: secretHint,
            emptyText: t('form.envEmpty'),
            entries: form.envRows,
            onAdd: addEntry('envRows'),
            onRemove: removeEntry('envRows'),
            onUpdate: (index, patch) => updateEntry('envRows', index, patch),
          })),
      isHttp
        ? h(SecretEditor, {
          t,
          label: t('form.headers'),
          hint: secretHint,
          emptyText: t('form.headersEmpty'),
          entries: form.headerRows,
          onAdd: addEntry('headerRows'),
          onRemove: removeEntry('headerRows'),
          onUpdate: (index, patch) => updateEntry('headerRows', index, patch),
        })
        : null,
      h('div', { className: 'dm-mcp__group' },
        h('p', { className: 'dm-mcp__group-title' }, t('form.advanced')),
        h('div', { className: 'dm-mcp__grid-2' },
          h(Field, { label: t('form.toolCallTimeoutMs'), error: errors.toolCallTimeoutMs },
            h(TextInput, {
              value: form.toolCallTimeoutMs,
              onChange: updateField('toolCallTimeoutMs'),
              inputType: 'number',
            })),
          h(Field, { label: t('form.maxInstructionBytes'), error: errors.maxInstructionBytes },
            h(TextInput, {
              value: form.maxInstructionBytes,
              onChange: updateField('maxInstructionBytes'),
              inputType: 'number',
            }))),
        h('div', { className: 'dm-mcp__grid-2' },
          h(Field, { label: t('form.failOnStartupError') }, h(SelectInput, {
            value: form.failOnStartupError,
            onChange: updateField('failOnStartupError'),
            options: failOptions,
          })),
          h('div', { className: 'dm-mcp__field' },
            h(CheckboxInput, {
              checked: form.enabled,
              onChange: updateField('enabled'),
              label: t('form.enabled'),
            })))),
      errors.env ? h('p', { className: 'dm-mcp__error-text', role: 'alert' }, errors.env) : null,
      errors.headers ? h('p', { className: 'dm-mcp__error-text', role: 'alert' }, errors.headers) : null,
      failure ? h(NoticeBar, { t, tone: 'error', text: failureText(t, failure) }) : null)
    }

    // ---------------------------------------------------------------------
    // 页面主体
    // ---------------------------------------------------------------------

    /** 设置里的 MCP 页面根组件（由 settings.section 注入 t / close）。 */
    function McpSection(props) {
      const t = typeof props.t === 'function' ? props.t : translate
      const alive = useAlive()
      const [loadState, setLoadState] = useState({
        status: 'loading',
        rows: [],
        revision: null,
        profile: null,
        generatedAt: null,
        error: null,
      })
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [dialog, setDialog] = useState(null)

      const closeDialog = useCallback(() => setDialog(null), [])

      /** 拉取列表；quiet 模式用于写后静默刷新，不改 loading 态。 */
      const refresh = useCallback(async ({ quiet = false } = {}) => {
        if (!quiet) setBusy({ action: 'list' })
        if (!quiet) {
          setLoadState((current) => ({
            ...current,
            status: current.status === 'ready' ? 'ready' : 'loading',
            error: null,
          }))
        }
        try {
          const data = await callAction('list', {})
          if (!alive.current) return
          setLoadState({
            status: 'ready',
            rows: data !== null && typeof data === 'object' && Array.isArray(data.rows) ? data.rows : [],
            revision: data !== null && typeof data === 'object' && typeof data.revision === 'string' ? data.revision : null,
            profile: data !== null && typeof data === 'object' && isPlainObject(data.profile) ? data.profile : null,
            generatedAt: data !== null && typeof data === 'object' && typeof data.generatedAt === 'string' ? data.generatedAt : null,
            error: null,
          })
        } catch (error) {
          if (!alive.current) return
          if (quiet) {
            setNotice({ tone: 'error', text: failureText(t, error) })
          } else {
            setLoadState((current) => ({ ...current, status: 'error', error }))
          }
        } finally {
          if (alive.current && !quiet) setBusy(null)
        }
      }, [alive, t])

      // 打开页面自动加载（切换到本 section 时组件重新挂载）。
      useEffect(() => {
        refresh()
      }, [refresh])

      /** 写操作成功后：按 applied/timedOut 给出提示，关闭对话框并静默刷新列表。 */
      const finishWrite = useCallback(async (data) => {
        if (!alive.current) return
        const pending = isPlainObject(data) && data.applied === false && data.timedOut === true
        setNotice({
          tone: pending ? 'warn' : 'success',
          text: t(pending ? 'notice.savedPending' : 'notice.saved'),
        })
        setDialog(null)
        await refresh({ quiet: true })
      }, [alive, refresh, t])

      /** 执行一次写操作并维护行级"应用中"状态。 */
      const runWrite = useCallback(async (action, payload, rowId) => {
        setBusy({ action, id: rowId })
        setNotice(null)
        try {
          const data = await callAction(action, payload)
          await finishWrite(data)
          return data
        } finally {
          if (alive.current) setBusy(null)
        }
      }, [alive, finishWrite])

      const openAdd = useCallback(() => {
        setNotice(null)
        setDialog({ kind: 'form', mode: 'add' })
      }, [])

      const openEdit = useCallback((row) => {
        setNotice(null)
        setDialog({ kind: 'form', mode: 'edit', row })
      }, [])

      /**
       * 启停开关直接执行（可逆操作，不再二次确认）：
       * 请求期间行内 switch disabled，成功后走既有 applied/timedOut notice + 静默刷新；
       * 失败由 runWrite 抛出，这里转成既有错误提示（列表不动，开关随刷新回到原状态）。
       */
      const toggleRow = useCallback(async (row) => {
        const enable = row.disabled === true
        if (typeof loadState.revision !== 'string' || loadState.revision === '') {
          setNotice({ tone: 'error', text: t('error.noRevision') })
          return
        }
        setNotice(null)
        try {
          await runWrite('toggle', {
            baseRevision: loadState.revision,
            id: row.id,
            enabled: enable,
          }, row.id)
        } catch (error) {
          if (alive.current) setNotice({ tone: 'error', text: failureText(t, error) })
        }
      }, [alive, loadState.revision, runWrite, t])

      const askRemove = useCallback((row) => {
        setNotice(null)
        setDialog({
          kind: 'confirm',
          destructive: true,
          title: t('confirm.deleteTitle'),
          message: t('confirm.deleteBody', { name: row.serverName }),
          confirmLabel: t('action.delete'),
          onConfirm: () => runWrite('remove', {
            baseRevision: loadState.revision,
            id: row.id,
          }, row.id),
        })
      }, [loadState.revision, runWrite, t])

      const dismissNotice = useCallback(() => setNotice(null), [])

      // 状态摘要：运行中 / 加载失败 / 已停用 / 工具总数。
      const summary = (() => {
        const rows = loadState.rows
        let running = 0
        let failed = 0
        let disabled = 0
        let tools = 0
        for (const row of rows) {
          const toolCount = typeof row.toolCount === 'number' && row.toolCount > 0 ? row.toolCount : 0
          tools += toolCount
          if (row.disabled === true) {
            disabled += 1
          } else if (row.phase === 'active') {
            running += 1
          } else if (row.phase === 'failed') {
            failed += 1
          }
        }
        return { running, failed, disabled, tools }
      })()

      const busyAny = busy !== null
      const toolbar = h('div', { className: 'dm-mcp__toolbar' },
        h(Button, { label: t('action.refresh'), onClick: () => refresh(), disabled: busyAny }),
        h('span', { className: 'dm-mcp__toolbar-sep', 'aria-hidden': 'true' }),
        h(Button, {
          label: t('action.add'),
          onClick: openAdd,
          disabled: busyAny || loadState.revision === null,
          variant: 'primary',
        }))

      const header = h('header', { className: 'dm-mcp__header' },
        h('div', { className: 'dm-mcp__heading' },
          h('h2', { className: 'dm-mcp__title' }, t('sectionTitle')),
          h('p', { className: 'dm-mcp__desc' }, t('sectionDescription'))),
        toolbar)

      const showSummary = loadState.status === 'ready' && loadState.rows.length > 0
      const summaryRow = showSummary
        ? h('div', { className: 'dm-mcp__summary' },
          h('div', { className: 'dm-mcp__summary-stats' },
            h('span', { className: 'dm-mcp__summary-item' },
              h(StatusDot, { tone: 'success' }),
              h('span', null, t('summary.running')),
              h('span', { className: 'dm-mcp__summary-num' }, String(summary.running))),
            summary.failed > 0
              ? h('span', { className: 'dm-mcp__summary-item' },
                h(StatusDot, { tone: 'error' }),
                h('span', null, t('summary.failed')),
                h('span', { className: 'dm-mcp__summary-num' }, String(summary.failed)))
              : null,
            h('span', { className: 'dm-mcp__summary-item' },
              h(StatusDot, { tone: 'idle' }),
              h('span', null, t('summary.disabled')),
              h('span', { className: 'dm-mcp__summary-num' }, String(summary.disabled))),
            h('span', { className: 'dm-mcp__summary-item' },
              h('span', null, t('summary.tools')),
              h('span', { className: 'dm-mcp__summary-num' }, String(summary.tools)))),
          loadState.generatedAt !== null
            ? h('span', { className: 'dm-mcp__summary-updated' }, t('summary.updated', { time: formatClock(loadState.generatedAt) }))
            : null)
        : null

      const noticeBar = notice === null
        ? null
        : h(NoticeBar, {
          t,
          tone: notice.tone,
          text: notice.text,
          onDismiss: dismissNotice,
        })

      const body = (() => {
        if (loadState.status === 'loading') {
          return h(ListSkeleton, { label: t('state.loading') })
        }
        if (loadState.status === 'error') {
          return h(NoticeBar, {
            t,
            tone: 'error',
            title: t('state.error'),
            text: failureText(t, loadState.error),
            action: h(Button, {
              label: t('state.retry'),
              onClick: () => refresh(),
              disabled: busyAny,
            }),
          })
        }
        if (loadState.rows.length === 0) {
          return h('div', { className: 'dm-mcp__empty' },
            h('h3', { className: 'dm-mcp__empty-title' }, t('state.empty')),
            h('p', { className: 'dm-mcp__empty-desc' }, t('state.emptyHint')),
            h(Button, {
              label: t('action.add'),
              onClick: openAdd,
              disabled: busyAny || loadState.revision === null,
              variant: 'primary',
            }))
        }
        return h('ul', { className: 'dm-mcp__list' },
          loadState.rows.map((row) => h(McpRow, {
            key: typeof row.id === 'string' && row.id !== '' ? row.id : String(row.serverName ?? ''),
            t,
            row,
            busy,
            onEdit: openEdit,
            onToggle: toggleRow,
            onRemove: askRemove,
          })))
      })()

      const profile = loadState.profile
      const patchPath = isPlainObject(profile) && typeof profile.patchPath === 'string' ? profile.patchPath : ''
      const showFooter = loadState.status === 'ready'
        && (patchPath !== '' || loadState.revision !== null)
      const footer = showFooter
        ? h('footer', { className: 'dm-mcp__footer' },
          patchPath !== ''
            ? h('span', { className: 'dm-mcp__footer-item' },
              h('span', null, t('footer.profileLabel')),
              h('span', { className: 'dm-mcp__path dm-mcp__mono', title: patchPath }, patchPath))
            : null,
          loadState.revision !== null
            ? h('span', { className: 'dm-mcp__footer-item' },
              h('span', null, t('footer.baselineLabel')),
              h('span', { className: 'dm-mcp__mono' }, shortRevision(loadState.revision)))
            : null,
          loadState.generatedAt !== null
            ? h('span', { className: 'dm-mcp__footer-item' },
              h('span', null, t('footer.updatedLabel')),
              h('span', { className: 'dm-mcp__mono' }, formatClock(loadState.generatedAt)))
            : null)
        : null

      const activeDialog = (() => {
        if (dialog === null) return null
        if (dialog.kind === 'form') {
          return h(FormDialog, {
            key: 'form',
            t,
            mode: dialog.mode,
            row: dialog.row,
            rows: loadState.rows,
            revision: loadState.revision,
            onClose: closeDialog,
            onSaved: finishWrite,
          })
        }
        if (dialog.kind === 'confirm') {
          return h(ConfirmDialog, {
            key: 'confirm',
            t,
            title: dialog.title,
            message: dialog.message,
            confirmLabel: dialog.confirmLabel,
            destructive: dialog.destructive === true,
            onClose: closeDialog,
            onConfirm: dialog.onConfirm,
          })
        }
        return null
      })()

      return h('div', { className: 'dm-mcp' },
        header,
        summaryRow,
        h('div', { className: 'dm-mcp__notice-region', 'aria-live': 'polite' }, noticeBar),
        body,
        footer,
        activeDialog)
    }

    // ---------------------------------------------------------------------
    // 会话内项目 MCP（composer.input.left 图标 + softui 面板）
    // ---------------------------------------------------------------------

    /** composer 入口图标：relevant=true 才渲染；untrusted/failed 加 6px 角标。 */
    function McpProjectButton(props) {
      const t = typeof props.t === 'function' ? props.t : translate
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const alive = useAlive()
      const timerRef = useRef(null)
      const [badge, setBadge] = useState({ loaded: false, relevant: false, badge: null })
      const [open, setOpen] = useState(false)

      const refreshBadge = useCallback(() => {
        if (sessionId === '') {
          setBadge({ loaded: false, relevant: false, badge: null })
          return
        }
        // 会话切换后防抖刷新，避免快速切换会话时的请求风暴。
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          fetchProjectBadge(sessionId)
            .then((next) => {
              if (alive.current) setBadge({ loaded: true, relevant: next.relevant, badge: next.badge })
            })
            .catch(() => {
              if (alive.current) setBadge((current) => ({ ...current, loaded: true }))
            })
        }, BADGE_REFRESH_DEBOUNCE_MS)
      }, [alive, sessionId])

      useEffect(() => {
        refreshBadge()
        return () => {
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
        }
      }, [refreshBadge])

      // 会话切换时收起面板，避免面板仍展示上一个会话的项目数据。
      useEffect(() => {
        setOpen(false)
      }, [sessionId])

      const closePanel = useCallback(() => {
        setOpen(false)
        refreshBadge()
      }, [refreshBadge])

      if (sessionId === '' || badge.relevant !== true) return null

      const badgeKind = badge.badge === 'untrusted' ? 'warn' : badge.badge === 'failed' ? 'error' : null
      const label = badge.badge === 'untrusted'
        ? t('composer.ariaUntrusted')
        : badge.badge === 'failed'
          ? t('composer.ariaFailed')
          : t('composer.buttonLabel')
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'dm-mcp-entry',
          'aria-label': label,
          title: label,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((current) => !current),
        },
        h(McpIcon),
        badgeKind === null
          ? null
          : h('span', {
            className: `dm-mcp-entry-badge dm-mcp-entry-badge--${badgeKind}`,
            'aria-hidden': 'true',
          })),
        open
          ? h(McpProjectPanel, { t, sessionId, onClose: closePanel })
          : null)
    }

    // 面板内部小组件：softui 结构与质感；不复用设置页 .dm-mcp__* 组件样式。
    /** 面板按钮（控件 radius 12）；gradient 只用于未信任时的主 CTA。 */
    function PanelButton({ label, onClick, disabled, variant = 'ghost', title }) {
      return h('button', {
        type: 'button',
        className: `dm-mcp-panel-btn${variant === 'gradient' ? ' dm-mcp-panel-btn--gradient' : ''}`,
        disabled: disabled === true,
        title,
        onClick: disabled === true ? noop : onClick,
      }, label)
    }

    /** 面板右上关闭：32 圆钮。 */
    function PanelCloseButton({ label, onClick }) {
      return h('button', {
        type: 'button',
        className: 'dm-mcp-panel-close',
        'aria-label': label,
        title: label,
        onClick,
      }, '\u00d7')
    }

    /** 右对齐文本按钮（无下划线，hover 变标题色）。 */
    function PanelTextButton({ label, onClick }) {
      return h('button', { type: 'button', className: 'dm-mcp-panel-textbtn', onClick }, label)
    }

    /** 低饱和语义状态点（6px）。 */
    function PanelDot({ tone }) {
      return h('span', {
        className: `dm-mcp-panel-dot dm-mcp-panel-dot--${tone}`,
        'aria-hidden': 'true',
      })
    }

    /** 药丸标签：fill 而非描边。 */
    function PanelPill({ children, tone }) {
      return h('span', {
        className: `dm-mcp-panel-pill${tone === 'warn' ? ' dm-mcp-panel-pill--warn' : tone === 'muted' ? ' dm-mcp-panel-pill--muted' : ''}`,
      }, children)
    }

    /** 面板开关：role="switch"；on 纯色 #3b82f6，不用渐变。 */
    function PanelSwitch({ label, checked, busy, disabled, blockedTitle, onChange }) {
      const classes = ['dm-mcp-panel-switch']
      if (checked) classes.push('dm-mcp-panel-switch--on')
      if (busy) classes.push('dm-mcp-panel-switch--busy')
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        title: blockedTitle ?? label,
        className: classes.join(' '),
        disabled: disabled === true,
        onClick: disabled === true ? noop : onChange,
      }, h('span', { className: 'dm-mcp-panel-switch-thumb', 'aria-hidden': 'true' }))
    }

    /** 面板「本项目」server 行：独立可悬浮小卡。 */
    function ProjectServerRow({ t, server, trusted, busy, onToggle }) {
      const rowBusy = busy === `toggle:${server.name}`
      const blockedTitle = !trusted
        ? t('composer.trustFirst')
        : server.fileEnabled === false
          ? t('composer.fileDisabled')
          : undefined
      const toggleLabel = server.enabled
        ? t('composer.toggleOffAria', { name: server.name })
        : t('composer.toggleOnAria', { name: server.name })
      return h('div', { className: 'dm-mcp-panel-server' },
        h('div', { className: 'dm-mcp-panel-server-top' },
          h('div', { className: 'dm-mcp-panel-server-id' },
            h('span', { className: 'dm-mcp-panel-server-name', title: server.name }, server.name),
            h(PanelPill, null,
              t(server.source === 'codex' ? 'composer.sourceCodex' : 'composer.sourceClaude')),
            h(PanelPill, null,
              t(server.transport === TRANSPORT_HTTP ? 'transport.http' : 'transport.stdio')),
            server.overridesGlobal
              ? h(PanelPill, { tone: 'warn' }, t('composer.overridesGlobal'))
              : null,
            server.fileEnabled === false
              ? h(PanelPill, { tone: 'muted' }, t('composer.fileDisabledChip'))
              : null),
          h(PanelSwitch, {
            label: toggleLabel,
            checked: server.enabled,
            busy: rowBusy,
            disabled: busy !== null || !trusted || server.fileEnabled === false,
            blockedTitle,
            onChange: () => onToggle(server),
          })),
        h('div', { className: 'dm-mcp-panel-server-meta' },
          h(PanelDot, { tone: PROJECT_STATUS_TONES[server.status] }),
          h('span', { className: 'dm-mcp-panel-status' }, t(PROJECT_STATUS_KEYS[server.status])),
          typeof server.toolCount === 'number'
            ? h('span', { className: 'dm-mcp-panel-mute' }, t('row.tools', { count: server.toolCount }))
            : null),
        server.lastError !== ''
          ? h('div', { className: 'dm-mcp-panel-server-error', title: server.lastError }, server.lastError)
          : null)
    }

    /** 面板「全局」只读行：名称 + 状态点/状态词 + 工具数。 */
    function ProjectGlobalRow({ t, server }) {
      const phase = server.enabled === false
        ? 'disabled'
        : (typeof server.phase === 'string' && PHASE_KEYS[server.phase] ? server.phase : 'unknown')
      return h('div', { className: 'dm-mcp-panel-global-row' },
        h('span', { className: 'dm-mcp-panel-global-name', title: server.name }, server.name),
        h('div', { className: 'dm-mcp-panel-global-meta' },
          h(PanelDot, { tone: phaseTone(phase) }),
          h('span', null, phaseLabel(t, phase)),
          h('span', null, t('row.tools', { count: server.toolCount }))))
    }

    /** 项目 MCP 面板：portal 到 body，Esc/外点关闭，卸载时归还焦点。 */
    function McpProjectPanel({ t, sessionId, onClose }) {
      const alive = useAlive()
      const panelRef = useRef(null)
      const [state, setState] = useState({ status: 'loading', view: null, error: null })
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [settingsHint, setSettingsHint] = useState(false)

      const load = useCallback(async () => {
        setState((current) => (current.status === 'ready' ? current : { status: 'loading', view: null, error: null }))
        try {
          const view = await fetchProjectSession(sessionId)
          if (!alive.current) return
          setState({ status: 'ready', view, error: null })
        } catch (error) {
          if (!alive.current) return
          setState({ status: 'error', view: null, error })
        }
      }, [alive, sessionId])

      useEffect(() => {
        load()
      }, [load])

      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const previous = document.activeElement
        const panel = panelRef.current
        if (panel !== null && typeof panel.focus === 'function') panel.focus()
        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous !== null && previous !== undefined && typeof previous.focus === 'function' && previous.isConnected) {
            previous.focus()
          }
        }
      }, [onClose])

      /** 统一写操作：busy 标记 + 失败走既有 failureText。 */
      async function runAction(kind, action) {
        if (busy !== null) return
        setBusy(kind)
        setNotice(null)
        try {
          await action()
          await load()
        } catch (error) {
          if (alive.current) setNotice({ tone: 'error', text: failureText(t, error) })
        } finally {
          if (alive.current) setBusy(null)
        }
      }

      const view = state.status === 'ready' && state.view !== null ? state.view : null
      const safeView = view === null ? normalizeProjectView(null) : view
      const projectDir = safeView.projectDir
      const files = view === null ? [] : view.files
      const servers = view === null ? [] : view.servers
      const warnings = view === null ? [] : view.warnings
      const globalServers = view === null ? [] : view.global

      function handleTrust(trusted) {
        if (projectDir === '') return
        runAction('trust', () => setProjectTrust(projectDir, trusted))
      }

      function handleReload() {
        runAction('reload', () => reloadProjectSession(sessionId))
      }

      function handleToggle(server) {
        runAction(`toggle:${server.name}`, () => toggleProjectServer(sessionId, server.name, !server.enabled))
      }

      function handleOpenSettings() {
        if (openSettingsBestEffort() === true) {
          onClose()
          return
        }
        setSettingsHint(true)
      }

      /** 配置提示：收进项目卡底部的解析警告（12 tertiary 单行省略，title 全文）。 */
      const renderNotes = () => {
        if (warnings.length === 0) return null
        return h('div', { className: 'dm-mcp-panel-card-notes' },
          h('p', { className: 'dm-mcp-panel-card-note-title' }, t('composer.warnings')),
          h('ul', { className: 'dm-mcp-panel-warning-list' },
            warnings.map((warning, index) => h('li', {
              key: `warning-${index}`,
              className: 'dm-mcp-panel-warning',
              title: warning,
            }, warning))))
      }

      /** 项目卡：未信任 → 说明 + 渐变 CTA；已信任 → 来源文件 + trust 状态 + ghost 操作。 */
      const renderProjectCard = () => {
        if (projectDir === '' && files.length === 0) {
          return h('div', { className: 'dm-mcp-panel-empty' },
            h('p', { className: 'dm-mcp-panel-empty-title' }, t('composer.noProjectDir')),
            h('p', { className: 'dm-mcp-panel-empty-desc' }, t('composer.noFiles')))
        }
        if (!safeView.trusted) {
          return h('div', { className: 'dm-mcp-panel-card' },
            h('div', { className: 'dm-mcp-panel-card-head' },
              h(PanelDot, { tone: 'warn' }),
              h('span', { className: 'dm-mcp-panel-card-title' }, t('composer.untrusted'))),
            h('p', { className: 'dm-mcp-panel-card-desc' }, t('composer.trustHint')),
            h('div', { className: 'dm-mcp-panel-actions' },
              h(PanelButton, {
                label: busy === 'trust' ? t('state.applying') : t('composer.trustEnable'),
                variant: 'gradient',
                onClick: () => handleTrust(true),
                disabled: busy !== null,
              }),
              h(PanelButton, {
                label: busy === 'reload' ? t('state.applying') : t('composer.reload'),
                onClick: handleReload,
                disabled: busy !== null,
              })),
            renderNotes())
        }
        return h('div', { className: 'dm-mcp-panel-card' },
          h('div', { className: 'dm-mcp-panel-card-head' },
            h(PanelDot, { tone: 'success' }),
            h('span', { className: 'dm-mcp-panel-card-title' }, t('composer.trusted'))),
          files.length === 0
            ? h('p', { className: 'dm-mcp-panel-card-desc' }, t('composer.noFiles'))
            : h('div', { className: 'dm-mcp-panel-files' },
              files.map((file) => h('div', { key: file.path, className: 'dm-mcp-panel-file' },
                h('span', { className: 'dm-mcp-panel-file-path', title: file.path }, file.path),
                h(PanelPill, null,
                  t(file.format === 'codex' ? 'composer.sourceCodex' : 'composer.sourceClaude'))))),
          h('div', { className: 'dm-mcp-panel-actions' },
            h(PanelButton, {
              label: busy === 'trust' ? t('state.applying') : t('composer.trustRevoke'),
              onClick: () => handleTrust(false),
              disabled: busy !== null,
            }),
            h(PanelButton, {
              label: busy === 'reload' ? t('state.applying') : t('composer.reload'),
              onClick: handleReload,
              disabled: busy !== null,
            })),
          renderNotes())
      }

      /** 全局卡：单卡多行 + 底部右对齐文本按钮。 */
      const renderGlobalCard = () => {
        if (globalServers.length === 0) {
          return h('div', { className: 'dm-mcp-panel-empty' },
            h('p', { className: 'dm-mcp-panel-empty-title' }, t('composer.noGlobal')),
            h('p', { className: 'dm-mcp-panel-empty-desc' }, t('composer.globalEmptyDesc')))
        }
        return h('div', { className: 'dm-mcp-panel-card dm-mcp-panel-card--tight' },
          h('div', { className: 'dm-mcp-panel-global-list' },
            globalServers.map((server) => h(ProjectGlobalRow, { key: server.name, t, server }))),
          h('div', { className: 'dm-mcp-panel-global-foot' },
            h(PanelTextButton, { label: t('composer.openSettings'), onClick: handleOpenSettings })))
      }

      const body = (() => {
        if (state.status === 'loading') {
          return h('div', { className: 'dm-mcp-panel-skeleton' },
            h('div', { className: 'dm-mcp-panel-skel dm-mcp-panel-skel--name' }),
            h('div', { className: 'dm-mcp-panel-skel dm-mcp-panel-skel--meta' }),
            h('div', { className: 'dm-mcp-panel-skel dm-mcp-panel-skel--row' }),
            h('div', { className: 'dm-mcp-panel-skel dm-mcp-panel-skel--row' }))
        }
        if (state.status === 'error') {
          return h('div', { className: 'dm-mcp-panel-notice' },
            h('span', { className: 'dm-mcp-panel-notice-text' }, failureText(t, state.error)),
            h(PanelButton, { label: t('state.retry'), onClick: () => load() }))
        }
        return h(React.Fragment, null,
          notice === null
            ? null
            : h('div', { className: 'dm-mcp-panel-notice' },
              h('span', { className: 'dm-mcp-panel-notice-text' }, notice.text),
              h(PanelButton, { label: t('action.close'), onClick: () => setNotice(null) })),
          h('section', { className: 'dm-mcp-panel-section' },
            h('h3', { className: 'dm-mcp-panel-section-title' }, t('composer.projectSection')),
            renderProjectCard(),
            servers.length === 0
              ? (projectDir === '' && files.length === 0
                ? null
                : h('div', { className: 'dm-mcp-panel-empty' },
                  h('p', { className: 'dm-mcp-panel-empty-title' }, t('composer.noServers'))))
              : h('div', { className: 'dm-mcp-panel-server-list' },
                servers.map((server) => h(ProjectServerRow, {
                  key: server.name,
                  t,
                  server,
                  trusted: safeView.trusted,
                  busy,
                  onToggle: handleToggle,
                })))),
          h('section', { className: 'dm-mcp-panel-section' },
            h('h3', { className: 'dm-mcp-panel-section-title' }, t('composer.globalSection')),
            renderGlobalCard(),
            settingsHint
              ? h('p', { className: 'dm-mcp-panel-empty-desc' }, t('composer.settingsHint'))
              : null))
      })()

      const overlay = h('div', {
        className: 'dm-mcp-panel-root dm-mcp-panel-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
      },
      h('div', {
        ref: panelRef,
        className: 'dm-mcp-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('composer.panelTitle'),
        tabIndex: -1,
      },
      h('div', { className: 'dm-mcp-panel-head' },
        h('h2', { className: 'dm-mcp-panel-title' }, t('composer.panelTitle')),
        h(PanelCloseButton, { label: t('action.close'), onClick: onClose })),
      h('div', { className: 'dm-mcp-panel-path', title: projectDir },
        projectDir !== '' ? projectDir : t('composer.noProjectDir')),
      h('div', { className: 'dm-mcp-panel-body' }, body)))

      if (createPortal !== null && typeof document !== 'undefined' && document.body !== null && document.body !== undefined) {
        return createPortal(overlay, document.body)
      }
      return overlay
    }

    // ---------------------------------------------------------------------
    // 模块注册
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 所有页面文案进入 locale 命名空间；slot 通过 locale 选项拿到 t 并随语言切换重渲染。
        translate = ctx.locale.bind(LOCALE_NS)
        pluginCtx = ctx
        // 视觉层样式只注入一次，插件卸载时清理。
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const existing = document.getElementById(STYLE_ID)
          if (existing !== null) existing.remove()
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.dataset.plugin = '@lixiangzhong/dsh-mcp'
          style.textContent = STYLE_TEXT
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'dsh-mcp: styles')
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN }), 'dsh-mcp: dictionaries')
        ctx.effect(
          () => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'mcp',
            order: 90,
            label: () => translate('sectionLabel'),
            locale: LOCALE_NS,
          }, McpSection)),
          'dsh-mcp: settings section',
        )
        // 对话输入框左侧的项目级 MCP 入口（list 槽；固定覆盖层在组件内 portal 到 body）。
        ctx.effect(
          () => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
            name: 'conversation.input.left',
            id: 'mcp-project',
            order: -10,
            label: () => translate('composer.buttonLabel'),
            locale: LOCALE_NS,
          }, McpProjectButton)),
          'dsh-mcp: composer project entry',
        )
      },
    }
  },
})
