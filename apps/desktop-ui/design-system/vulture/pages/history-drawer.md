# History Drawer Override

## 当前问题

| # | 位置 | 问题 | 严重 |
|---|------|------|------|
| 1 | `styles.css:807-913` | drawer 整体已经做得不错，无大问题 | — |
| 2 | `.history-row .row-delete` | 删除按钮 hover 才显示，无确认就删除 | P0 |
| 3 | search-field | 没有清空 (×) 按钮 | P2 |
| 4 | 整体 | 没有按时间分组（今天/昨天/本周/更早） | P2 |
| 5 | overlay | `top: 32px` 留出 titlebar，✓ 但点击 overlay 关闭逻辑要确认 | P1 |

## Override 规则

### 删除确认（必须）

直接 click delete → 改为：
- 第一次 click：row 进入 "deletion-pending" 状态
  - row 背景变 `--danger-bg`
  - 右侧出现 `[取消] [确认删除]` 按钮组
  - 5 秒后自动取消 pending，恢复正常
- 第二次 click 确认 → 真删除 + undo toast：

```
[ 已删除"项目计划讨论" ]   [ 撤销 ]
                         5s 后自动消失
```

### 时间分组

```
今天 (3)
  · 项目计划讨论       2 分钟前
  · 调试 npm 报错      1 小时前
昨天 (1)
本周 (8)
更早 (24)
```

`HistoryDrawer.tsx` 渲染时按 `updatedAt` 分桶。group-heading 已存在 css，沿用。

### Search 升级

- 输入时实时过滤（debounce 120ms）
- 右侧 ✕ 按钮在有内容时显示，点击清空
- 无匹配时：

```
[icon SearchX]
没有找到匹配 "xxx"
```

### Drawer 滑入动画

- 已有 160ms cubic-bezier，✓ OK
- 加 reduced-motion 兜底：动画时间改 30ms 仅 opacity

### 关闭交互

- 点击 overlay 关闭 ✓
- Esc 关闭（确认逻辑存在）
- 焦点回到打开 drawer 的按钮（focus restore）

## 不要做的事

- ❌ 不要把 drawer 做成浮动卡片（保持贴左侧布局）
- ❌ 不要直接删除（必须有撤销路径）
