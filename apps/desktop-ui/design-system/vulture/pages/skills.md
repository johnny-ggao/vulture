# Skills Page Override

## 当前问题

| # | 位置 | 问题 | 严重 |
|---|------|------|------|
| 1 | `SkillsPage.tsx:142-176` | skill 卡片所有样式 inline | P1 |
| 2 | `SkillsPage.tsx:191-205` | `Badge` 组件本地实现，应抽到 shared | P1 |
| 3 | 整体 | 没有 search 框，skill 多了找不到 | P1 |
| 4 | 整体 | 没有按 source 分组（builtin / plugin / project） | P2 |
| 5 | 整体 | 没有 skill 详情查看（README / 例子） | P3 |
| 6 | 策略按钮 | "全部启用" / "全部禁用" 是颜色切换，但没有视觉区分主次 | P2 |

## Override 规则

### 顶栏（升级）

```
[ 🔍 搜索 skill...         ]   智能体 [select]   策略 [seg-all|allowlist|none]
```

- search input：full-width，左侧 search icon
- 策略改为分段控件 (segmented control)，三档同屏可见
- 智能体下拉收紧到 220px，与右侧策略段并排

### Skill list

按 source 分组（accordion）：

```
PROJECT (3)         ▼
  [skill card]
  [skill card]
PLUGIN (12)         ▼
  ...
BUILTIN (8)         ▼
```

每组 header 可折叠，badge 显示数量。

### Skill card

```tsx
<article className="skill-card" data-enabled={enabled}>
  <div className="primary">
    <strong>{name}</strong>
    <SourceBadge value={source} />
    {modelInvocationEnabled && <Badge tone="info">模型可见</Badge>}
  </div>
  <p className="desc">{description}</p>
  <code className="path">{filePath}</code>
  <Toggle checked={enabled} onChange={...} />   {/* 替代 button */}
</article>
```

- Toggle 用现代 switch（28×16），比 button "启用/禁用" 更直观
- `data-enabled={false}` 时整卡片 opacity 0.7，name 变 secondary 色
- hover 显示"详情"按钮 → 打开 modal 显示 skill README
- 复制 file path：path 区域 hover 出现 copy icon

### Empty / loading state

- empty：图标 + "当前智能体没有可加载的 skill"
- loading：3 个 skeleton card

## 不要做的事

- ❌ 不要把 enabled 状态做成大号 checkbox（switch 对 binary 更合适）
- ❌ 不要在 list 内放 skill markdown 内容（详情用 modal）
