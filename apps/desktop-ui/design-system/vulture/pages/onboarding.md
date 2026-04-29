# Onboarding Page Override

> `OnboardingCard.tsx` 是新用户第一眼看到的界面。**emoji icon 必须立即修复**。

## 当前问题

| # | 位置 | 问题 | 严重 |
|---|------|------|------|
| 1 | `OnboardingCard.tsx:18` | `⚡` emoji 作为 icon | **P0** |
| 2 | `OnboardingCard.tsx:29` | `🔑` emoji 作为 icon | **P0** |
| 3 | 整体 | 没有 illustration / hero，hero-mark 太朴素 | P2 |
| 4 | 文案 | "Sign in with ChatGPT" 是英文，与产品其他中文界面不一致 | P2 |
| 5 | 行 8 | `<p>选择登录方式开始使用：</p>` 末尾全角冒号 | P3 |

## Override 规则

### Icon 替换（立即）

```tsx
// 原
<span className="onboarding-icon">⚡</span>

// 改成（lucide-react）
import { Zap, KeyRound } from "lucide-react";
<Zap className="onboarding-icon" size={20} aria-hidden />
<KeyRound className="onboarding-icon" size={20} aria-hidden />
```

并在 styles.css 给 `.onboarding-icon` 加 color：
- 主选项（ChatGPT 登录）：`color: var(--brand-500)`
- 次选项（API key）：`color: var(--text-tertiary)`

### Hero 区

保留 V mark，但加微动效：
- mount 时 `scale 0.92→1, opacity 0→1` 240ms ease-out
- `prefers-reduced-motion` 下仅 fade

### 文案

- "Sign in with ChatGPT" → "用 ChatGPT 登录"
- 保留小字 "用订阅省 API key 费用（推荐）"
- "选择登录方式开始使用：" → "选择登录方式开始" 或拆为两行

### 主选项视觉强化

主推 ChatGPT 登录：
- `border: 1px solid var(--brand-500)` ✓ 已有
- 背景 `linear-gradient(180deg, var(--brand-050), transparent)` 增加层次
- hover：`box-shadow: 0 8px 20px rgba(196,78,84,0.12)` + `transform: translateY(-1px)`

### 第三选项（建议）

补充"先看看 / 跳过"链接（小字）：

```
[ ChatGPT 登录 ]
[ API key      ]

      跳过，先探索界面
```

允许用户先看 UI，回头再连账号。

## 不要做的事

- ❌ 不要把卡片做成全屏 wizard（保持 ≤ 480px）
- ❌ 不要加视频/动效 hero（保持克制）
