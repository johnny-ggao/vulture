# Settings Page Override

> `SettingsPage.tsx` 当前 **1006 行**（违反全局 800 行规则），且大量 inline style — 必须优先重构。

## 当前问题

| # | 位置 | 问题 | 严重 |
|---|------|------|------|
| 1 | 整体 | 1006 行单文件，包含 6 个 section 子组件 | P0 |
| 2 | 全文 | 大量 inline style（`border`, `padding`, `display:grid` 等）绕过 token | P0 |
| 3 | `SettingsPage.tsx:14-20` | 6 个 section icon 全部用 `<DotIcon />`（一个圆点），没有视觉识别度 | P1 |
| 4 | MCP / Memory section | `<input>` 只有 placeholder，没有可见 `<label>`（违反 form-labels） | P1 |
| 5 | Model section ChatGPT | 行 `⚠ 凭据已过期` 是 emoji，违反 no-emoji-icons | P1 |
| 6 | `Row()` 函数 | `value.length > 20` 触发 mono 字体的判断脆弱 | P2 |
| 7 | MCP card hover | 卡片 hover 没有反馈 | P3 |
| 8 | 配对令牌 | 长 token 直接显示，缺"复制"按钮 | P2 |

## Override 规则

### 文件拆分

```
src/chat/Settings/
  SettingsPage.tsx           ← shell，路由 + rail
  GeneralSection.tsx
  ModelSection.tsx
  MemorySection.tsx
  McpSection.tsx
  BrowserSection.tsx
  ChannelsSection.tsx        ← 当前 Stub
  shared/
    Row.tsx
    StatusPill.tsx
    Field.tsx                ← 抽 label + input/textarea wrapper
    SectionCard.tsx
```

每个 section 文件 < 250 行。

### Inline style 全部迁出

- 重复 pattern 抽取为 utility class：
  - `.row-between` (flex+space-between+gap)
  - `.stack` / `.stack-tight` (vertical grid)
  - `.muted-mono` (font-mono + text-tertiary + 12px + word-break)
- form input 全部使用同一 `.input` class（border `--fill-tertiary`、focus ring）

### Settings Rail icon 系统

替换 `DotIcon` 为有意义的 lucide 图标：

| Section | Icon |
|---------|------|
| 通用 | `Settings2` |
| 模型 | `Brain` 或 `Cpu` |
| 记忆 | `Database` |
| MCP 服务器 | `Plug` |
| 浏览器 | `Globe` |
| 消息渠道 | `MessageSquare` |

### Form label 规范

把所有 `<input placeholder="id: echo-server">` 改成：

```tsx
<Field label="ID" required helper="不可重复">
  <input value={...} onChange={...} placeholder="echo-server" />
</Field>
```

`<Field>` 自带：
- 可见 label（12px, text-secondary）
- `*` 必填标记
- helper text 下方一行（11px, text-tertiary）
- error 时上色 + `aria-invalid`

### 状态描述

- "凭据已过期"前的 ⚠ 改为 lucide `<AlertTriangle size={14} />` 图标
- 用 `--warning-bg` 软底容器替代单独的红字行

### 长字符串处理

- 配对令牌、API key 来源、记忆 root path 这类长字符串：
  - 包裹在 `<MonoString>` 组件，自带 hover 显示完整 + 旁边 `<CopyButton>`
- Row 的 mono 判断改为 prop：`<Row label="..." value="..." mono />`

### MCP 列表卡片

- 给 article hover 加：`box-shadow: var(--shadow-card-hover); transform: translateY(-1px); transition: 160ms`
- 状态 pill 颜色化：
  - `running` → `--success-bg` + `--success`
  - `connecting` → `--info-bg` + `--info`
  - `error` → `--danger-bg` + `--danger`
  - `idle` → 现有灰色
- 工具列表展开/收起加 chevron 图标 + 160ms fade

### Memory section

- "Markdown 文件是长期记忆源"加可点击 `<a>` 打开根目录的按钮
- 添加记忆 textarea 加字符计数 (`123 / 2000`)
- memory 卡片 hover 显示"复制路径"按钮

## 不要做的事

- ❌ 不要把 6 个 section 做成 tabs（rail 形态在窗口宽度下更稳）
- ❌ 不要在保存按钮成功后弹 toast（保持当前 inline 反馈），但要加 ✓ 微动画
