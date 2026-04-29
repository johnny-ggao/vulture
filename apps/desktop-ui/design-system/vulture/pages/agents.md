# Agents Page Override

## 当前问题

| # | 位置 | 问题 | 严重 |
|---|------|------|------|
| 1 | `AgentsPage.tsx:163-189` | agent list 卡片全 inline style（border / radius / padding） | P0 |
| 2 | `AgentsPage.tsx:316-336` | core file 文件按钮的 selected 用 `border-color` 切换，会发生 1px 跳动 | P1 |
| 3 | `AgentsPage.tsx` | `Field` 组件内置但样式简陋，input 没有统一边框/focus | P1 |
| 4 | 整体 | 没有 agent 头像/标识区分，全部一样的列表 | P2 |
| 5 | Tools 选择 | 缺少 search/filter，工具多了之后难以定位 | P2 |
| 6 | Instructions textarea | 8 行固定高度，没有 resize/全屏编辑 | P2 |
| 7 | 保存反馈 | 仅按钮文字变化，缺成功/失败 toast 或 inline 提示 | P1 |

## Override 规则

### Agent list（左 280px 列）

抽取为 `AgentListItem`，统一样式：

```tsx
<button className="agent-list-item" data-active={isActive}>
  <Avatar agent={agent} />        {/* 30×30 brand-tint 圆形 + 首字母 */}
  <div className="meta">
    <span className="name">{name}</span>
    <span className="model">{model}</span>
  </div>
  <ChevronRight size={14} />     {/* hover 显示 */}
</button>
```

CSS：
- 静态边框 `border: 1px solid transparent`，避免 hover 跳动
- selected: `--brand-050` bg + `--brand-500` 1px border + `--brand-600` text
- hover: bg `--fill-quaternary`

### Field 组件统一

把当前的 `<Field>` 升级到：

```tsx
<Field label="名称" required hint="只用于显示" error={errors.name}>
  <Input value={...} />
</Field>
```

`<Input>` 自带：
- height 32px
- border `--fill-tertiary`，focus `--brand-500` + 3px ring
- 暗色模式适配
- `[aria-invalid="true"]` 时变 `--danger`

### Instructions

- textarea 在 hover 时右下角出现"全屏编辑"图标按钮
- 全屏：modal 80vh × 720px，monaco/codemirror 体验，支持 `Cmd+Enter` 保存
- 计数器：右下角 `1234 / 50000` 字符（仅做提醒，不做硬限）

### Tool selector

参考 `ToolGroupSelector.tsx`（已存在）：
- 顶部加 search 输入框，实时过滤 group + tool name
- 全选 / 全清 / 仅只读 三个 preset 一直显示
- 当前选中的 tool 数量在标题旁显示 `(12 selected)`

### Core File editor

- 文件 list selected 状态：bg `--brand-050`，**保持 transparent border**，避免 1px 跳动
- textarea 文件编辑器：
  - 等宽字体 13px / line-height 1.6
  - 行号侧栏（可选 P3）
  - 顶栏显示文件状态：`修改未保存` / `已保存`
  - `Cmd+S` 触发保存
- 保存后 fileStatus "已保存" 显示 2 秒后自动消失（带 fade）

### 保存反馈

- 顶部按钮组旁添加保存状态指示：
  - 修改后未保存：`<Dot color="warning" />` + 文字"未保存"
  - 保存中：spinner
  - 保存完：`<Check />` 1.5s
  - 错误：`<AlertCircle color="danger" />` + tooltip 错误详情

### 空状态

`还没有智能体。` → 升级为：

```
[empty illustration / V mark soft]
还没有智能体
创建一个智能体来开始对话
[ + 新建智能体 ]
```

## 不要做的事

- ❌ 不要把 agent list 改成网格卡片（表格列形态对桌面工具更高效）
- ❌ 不要给 Instructions 加 markdown preview（保持纯文本编辑）
