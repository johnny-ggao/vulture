# Chat Page Override (ChatView + MessageBubble + Composer + RunEventStream)

> 这是 Vulture 的核心页面，**用户 90% 时间在这里**。优先级 P0。

## 当前问题

| # | 位置 | 问题 | 严重 |
|---|------|------|------|
| 1 | `MessageBubble.tsx:17` | 全部内容用 `<pre>` 渲染，没有 markdown / 代码高亮 / 链接化 | P0 |
| 2 | `MessageBubble.tsx` | assistant 消息没有"复制"按钮，没有 token usage hover 详情 | P1 |
| 3 | `ChatView.tsx:74-78` | 空状态过于克制：仅 V mark + 一句话，缺引导 prompt | P1 |
| 4 | `Composer.tsx:34-37` | thinking 模式靠循环 click 切换，发现性差，看不到全部选项 | P2 |
| 5 | `Composer.tsx:65-76` | agent picker 用原生 `<select>`，弹出菜单不能 brand 化、看不到 model meta | P2 |
| 6 | `ChatView.tsx:44-47` | 重连提示和错误条样式两套（chip vs banner），缺 ARIA live | P1 |
| 7 | `styles.css:537` | `composer textarea` `min-height: 44px` 在桌面端略高，建议 36~40 | P3 |
| 8 | 整体 | 没有 message stream 入场动画（不是必须，但能显著提质感） | P3 |

## Override 规则

### Message rendering

- 使用 `react-markdown` + `remark-gfm` + `rehype-highlight`（或 `shiki`）
- `<pre><code>` block 必须：
  - 圆角 `--radius-md`，padding `12px 14px`
  - 背景 `--fill-quaternary`（亮）/ `rgba(255,255,255,0.06)`（暗）
  - 顶部右侧悬浮"复制"图标按钮（hover 显示，120ms fade）
  - 显示语言 tag（小标签，左上）
- 行内 `code` 用 `--fill-quaternary` + `--font-mono` + 字号 13

### Assistant 消息附加 UI

- bubble 底部一行 hover 显示工具条：复制 / 重试 / 反馈 / 展开 token usage
- token usage 默认隐藏，hover bubble 时浮出（避免视觉噪声）
- 用 `aria-live="polite"` 包裹 streaming 文本，但仅声明一次，避免逐 chunk 朗读

### User 消息

- 保留 `--brand-050` 软底气泡，但 `border` 由 `1px solid rgba(196,78,84,0.14)` 改成 `1px solid transparent` + 仅 selected/hover 显示边——避免静态多 1px 切换
- 附件预览：图片 64×64 缩略图、文件 icon + 名称 + 大小，不显示 `IMG`/`FILE` 字符串

### Empty state（升级）

```
[ V mark logo ]
Start a conversation
Ask me to plan, write, debug, or explore.

[ Suggestion chips: 4 个 prompt ]
  · 帮我审查最近的代码改动
  · 解释这个错误日志
  · 起草一份产品方案
  · 总结这份文档
```

- chip 用 `--fill-quaternary` 底，hover 升 `--fill-tertiary` + scale(0.98)
- 点击直接填入 composer

### Composer

- thinking mode：从循环按钮改为**分段控件 (segmented control)** 三档同屏可见
  - 低/中/高 三档，brand-050 高亮当前档
- agent picker：原生 `<select>` 改为自绘 popover
  - 显示 agent name + 模型小字 meta
  - 顶部带 `+ 新建智能体` 入口
  - Esc / 点击外部关闭
- send 按钮在 disabled 状态：`opacity 0.5` + 仍保留 brand 底色，让用户清楚"待输入"

### 状态条统一

- 重连 / 错误 / send fail 统一改为 **inline status banner**，宽度 `min(720px, calc(100% - 48px))`，上侧 8px gap
- 三档颜色：
  - reconnecting → `--info-bg` + `--info`
  - sendError → `--danger-bg` + `--danger`
  - recovery → `--warning-bg` + `--warning`
- 全部加 `role="status"` 或 `role="alert"`（错误用 alert，提示用 status）

### 动画

- 新消息入场：`opacity 0→1, translateY 4px→0`，160ms ease-out
- streaming 时不动画 bubble，只动画 caret/光标（`@keyframes caret-blink`）
- `prefers-reduced-motion`：全部改为 `opacity 0→1` 30ms

## 不要做的事

- ❌ 不要给 message bubble 加阴影
- ❌ 不要做"AI 思考动画"流光（俗气）
- ❌ 不要把 composer 做成 fixed 浮在内容上（保持现有 sticky-bottom 形态）
- ❌ 不要为了暗色模式反转 brand 色
