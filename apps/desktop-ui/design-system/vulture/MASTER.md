# Vulture — Design System (MASTER)

> Vulture 是 macOS 风格的桌面端 AI Agent 客户端。这份文档是项目的设计真理来源（Single Source of Truth）。
> 当为某个具体页面写代码时，先检查 `pages/<page>.md` 是否存在；存在即使用其覆盖，否则使用 MASTER。

## 1. Product Identity

- **Type**: Desktop AI agent / chat productivity tool（类 Claude Desktop / Linear / Anthropic Console）
- **Tone**: warm-neutral · content-first · elegant minimalism · macOS-native feel
- **Audience**: 专业开发者、生产力用户；对工具型 UI 的克制美学敏感
- **Anti-tone**: 不要彩色渐变 SaaS、不要 brutalism、不要 neumorphism、不要表情符号化

## 2. Pattern

**Workbench-style three-zone layout**（已实现，保留）：

```
┌───────── 32px Titlebar (overlay, drag region) ─────────┐
│  Traffic-light │      window-drag region (full)        │
├──────┬─────────────────────────────────────────────────┤
│      │                                                 │
│ 280px│            Content Panel                        │
│Side- │  · Chat / Agents / Settings / Skills / History  │
│ bar  │  · 顶部 32px 透明区透出 titlebar                │
│      │  · max-w 960~1080px 居中                        │
│      │                                                 │
└──────┴─────────────────────────────────────────────────┘
```

- 主导航在 sidebar，**不要**改成 Top Tabs / Bottom Nav
- Modal 与 Drawer 都从 `top: 32px` 之下开始（避开 titlebar）

## 3. Style

- **Style category**: *Minimal & Direct* + *Bento-flavored Cards*
- **Effects**:
  - 阴影克制：`--shadow-card-rest` 几乎不可见，hover 时升级到 `--shadow-card-hover`
  - 圆角分级：6 / 8 / 12 / 16（按 sm / md / lg / xl 对应）
  - 不使用 glass blur 作为装饰，仅用于 modal scrim
  - 不使用渐变填充按钮，brand 色保持纯色块

## 4. Color (KEEP existing tokens)

项目现有 tokens 已经做得很好，**不要替换为外部数据库给出的 teal 调色板**。保留：

| Role | Token | Value | Notes |
|------|-------|-------|-------|
| Brand | `--brand-500` | `#c44e54` | salmon-rose，主 CTA |
| Brand hover | `--brand-600` | `#a83e44` | |
| Brand soft | `--brand-050` | `rgba(196,78,84,0.08)` | active row, soft tint |
| Brand ring | `--brand-ring` | `rgba(196,78,84,0.28)` | focus ring 3px |
| Shell from | `--shell-gradient-from` | `#f5f1ea` | 暖米黄 |
| Shell to | `--shell-gradient-to` | `#edf1ee` | 冷绿调（细微） |
| BG primary | `--bg-primary` | `#ffffff` | |
| BG secondary | `--bg-secondary` | `#faf9f6` | warm off-white |
| BG tertiary | `--bg-tertiary` | `#eceae6` | |
| Text primary | `--text-primary` | `rgba(15,15,15,0.92)` | |
| Text secondary | `--text-secondary` | `rgba(15,15,15,0.65)` | |
| Text tertiary | `--text-tertiary` | `rgba(15,15,15,0.62)` | meta |
| Text quaternary | `--text-quaternary` | `rgba(15,15,15,0.48)` | placeholder |
| Danger | `--danger` | `#dc2626` | |

### 待补充（缺口）

```css
/* 语义状态色 — 当前只有 danger，缺 success/warning/info */
--success:    #16a34a;
--success-bg: rgba(22, 163, 74, 0.10);
--warning:    #d97706;
--warning-bg: rgba(217, 119, 6, 0.10);
--info:       #2563eb;
--info-bg:    rgba(37, 99, 235, 0.08);
```

### 暗色模式（缺失，需补）

```css
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --shell-gradient-from: #1c1b18;
    --shell-gradient-to:   #1a1c1b;
    --bg-primary:   #1f1e1c;
    --bg-secondary: #181715;
    --bg-tertiary:  #2a2825;
    --fill-quaternary: rgba(255,255,255,0.04);
    --fill-tertiary:   rgba(255,255,255,0.08);
    --fill-secondary:  rgba(255,255,255,0.14);
    --fill-primary:    rgba(255,255,255,0.20);
    --text-primary:    rgba(255,255,255,0.92);
    --text-secondary:  rgba(255,255,255,0.65);
    --text-tertiary:   rgba(255,255,255,0.50);
    --text-quaternary: rgba(255,255,255,0.36);
    --brand-050: rgba(230, 125, 130, 0.14);
    --brand-500: #e67d82;   /* 暗色提亮一档以满足对比度 */
    --brand-600: #c44e54;
  }
}
```

## 5. Typography (KEEP existing)

```
--font-sans: 'SF Pro Display', 'SF Pro Text', 'Inter', -apple-system, ...
--font-mono: 'SF Mono', 'JetBrains Mono', Menlo, ...
```

最接近的设计语言是 **Minimal Swiss / Inter-only**。系统字体优先（macOS 上 SF Pro，无网络依赖）。

### 字阶（已存在，沿用）

| Token | px | 用途 |
|-------|----|------|
| `--text-xs` | 12 | meta / badge / pill |
| `--text-sm` | 13 | secondary copy / settings rail |
| `--text-base` | 14 | body, message bubble |
| `--text-md` | 15 | modal title |
| `--text-lg` | 19 | h3 / card title |
| `--text-xl` | 22 | section heading |
| `--text-2xl` | 28 | page H1 |

字重原则：H1/H2 600，强调 600~650，正文 400，meta 500。

## 6. Spacing & Radius (KEEP)

- Spacing: `4 / 8 / 12 / 16 / 20 / 24 / 32` —— 严格遵循
- Radius: `4 / 6 / 8 / 12 / 16 / 9999`

## 7. Iconography (CRITICAL RULES)

- **必须用 SVG**，禁止用 emoji 作为结构性图标 ⚠️
- 推荐图标库：`lucide-react`（线性、stroke 1.8，与现有 inline SVG 风格一致）
- Stroke 统一：1.8（小图标）/ 2（按钮内）
- 单色：使用 `stroke="currentColor"`，由父级 color 决定颜色
- 尺寸 token：13 / 14 / 16 / 18 / 20

**当前违规**：`OnboardingCard.tsx:18,29` 使用 ⚡ / 🔑 — 必须替换为 SVG。

## 8. Motion

- Duration: 120ms (microinteraction) / 160ms (drawer slide) / 240ms (modal)
- Easing: `cubic-bezier(0.2, 0.8, 0.2, 1)` 作为通用 spring 替代
- 仅动画 `transform` / `opacity`，禁止动画 `width`/`height`/`top`/`left`
- **强制**：所有动画必须包裹在 `prefers-reduced-motion` 兜底中

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 9. State System (统一规范)

| State | Visual |
|-------|--------|
| Resting | 默认 token |
| Hover | bg `+0.04 fill` 或 brand-600 |
| Active/Pressed | 同 hover + scale(0.98)（仅按钮和卡片，不动 list row） |
| Focus visible | `box-shadow: 0 0 0 3px var(--brand-ring)` |
| Selected | `--brand-050` bg + `--brand-600` text + 600 weight |
| Disabled | opacity 0.4 + `cursor: not-allowed` |
| Loading | spinner + 文字 "…"（按钮内部，禁止整页 spinner） |

## 10. Form Patterns

- 必须有可见 label（不允许只用 placeholder）；label 用 `<label>` 关联，`font-size:12`、`color:text-secondary`
- 错误信息紧贴字段下方，配合 `aria-live="polite"`
- input 高度 32px，padding 8px 10px，border `--fill-tertiary` → focus `--brand-500` + ring
- 必填字段加 `*` 前缀，颜色 `--danger`

## 11. Accessibility (must-have)

- [ ] 文字对比 ≥ 4.5:1（已校核：tertiary on white ≈ 5.0:1 ✓）
- [ ] icon-only 按钮加 `aria-label`（当前 ✓）
- [ ] 动画支持 `prefers-reduced-motion`（当前 ✗，必补）
- [ ] 暗色模式独立验证（当前 ✗，缺整个暗模式）
- [ ] 错误消息 `role="alert"` 或 `aria-live`
- [ ] 焦点可见性：禁用 `outline: 0` 时必须配合 `box-shadow` ring
- [ ] 键盘可达：popover/drawer/modal 支持 Esc 关闭

## 12. File Organization (项目纪律)

- 单文件 < 800 行（CLAUDE.md 全局规则）
- **当前违规**：`SettingsPage.tsx` 1006 行 — 必须拆为 `Settings/{General,Model,Memory,Mcp,Browser,Channels}.tsx`
- 大量 inline style 必须迁移到 `styles.css` 或同目录 module / styled 实现，避免 token 漂移

## 13. Anti-patterns（必避免）

- ❌ Emoji 作为 icon
- ❌ Inline style 写 hex 值（绕过 token）
- ❌ Transparent border 替代 layout reservation（hover 突然多 1px 边）
- ❌ 滚动条不定制
- ❌ Markdown 内容用 `<pre>` 渲染（当前 MessageBubble 是这样）
- ❌ 用 `box-sizing: content-box`、固定 px 宽度

## 14. Pre-Delivery Checklist

- [ ] 没有新增 emoji icon
- [ ] 没有新增 inline hex 颜色
- [ ] 焦点可见 ring 完整
- [ ] 暗色模式视觉验证（实现暗色之后必查）
- [ ] reduced-motion 视觉验证
- [ ] 文件 < 800 行
- [ ] 错误状态有 ARIA live
- [ ] 桌面端触发区 ≥ 28×28
