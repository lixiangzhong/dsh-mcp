# UI 风格偏好：softui 双主题（MCP 面板）

- **Type**: feedback
- **Topic**: dsh-mcp-ui-softui
- **Updated**: 2026-11-05T10:37:06Z

## Summary

用户偏好 softui 双主题面板；暗色面板用 bg-layer-2 + 白 6% 内层卡，禁止 bg-overlay 大面积；唯一渐变只给 CTA。

## Why

这是用户对视觉的明确纠正与指定风格；后续任何会话内组件改动若再回到"灰板+描边"或大面积 overlay 会重复踩坑。

## How to Apply

后续动 MCP 面板/其他会话内组件时按此套 softui 双主题令牌与纪律；深色大面积面板禁止用 bg-overlay；改完必须重建 12 页预览并用 Chrome 复核明暗两版。

## Context & Details

- 用户评价原 DSH 原生风格的 MCP 面板"配色布局太丑"；指定用 `/uistyle` 的 **softui** 变体重做。
- 关键决策：softui 是浅色规范，不能直接铺白底；**双主题适配**——颜色用宿主主题 token 映射，softui 只提供结构纪律（面差分层不靠描边、透明度文字阶梯、唯一渐变强调、三档柔阴影、大圆角、外松内紧）。
- 落地要点：
  - 面板 radius 20 / 内层卡 16 / 行 12 / 控件 12 / 药丸与开关 999；panel/card/server 的 borderWidth 必须为 0（层级靠面差）。
  - 暗色：panel = `--dsw-alias-bg-layer-2`（≈#2c2c2e），内层卡 = 白 6% 叠加（≈#39393b，比面板亮一档），**绝不可用 `--dsw-alias-bg-overlay`（#61666b）做大面积面板**（第一版就错在这，显得脏）。
  - 唯一渐变只给未信任 CTA（#38bdf8→#3b82f6 + 30% glow）；switch-on 纯 #3b82f6；状态点低饱和语义色；正文禁止彩色。
  - 遮罩暗色 rgba(0,0,0,.55)+blur8；面板阴影 0 24px 64px .55 + 0 2px 8px .4 + inset 1px 白 .06。
  - 面板 380 宽、padding 20、max-height min(64vh,680px)；警告收进项目卡「配置提示」；「文件内禁用」pill 中性化。
- 验证方式：静态预览 6 状态 × 明/暗（基于安装包官方主题 CSS）→ Chrome 900/1000 视口截图 + computed style 断言（radius/唯一渐变/borderWidth=0/对比度/无溢出）；真实宿主目视由用户刷新确认。
- 未改：设置→MCP 全局页保持 DSH 原生风格（本次只重做会话内面板与 composer 图标）。
