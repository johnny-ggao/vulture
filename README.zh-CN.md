# Vulture

[English](README.md) ・ [中文](README.zh-CN.md)

**Vulture** 是一个**本地优先（local-first）**的混合型桌面 AI 智能体平台。整套系统跑在你自己的机器上：用 Tauri Rust 做可信系统内核、用 Bun sidecar 跑 OpenAI Agents SDK 做编排、用 React + TypeScript 做前端，并提供可选的 Chrome 扩展用于浏览器自动化。没有云账号、默认不上传遥测——用本地 profile 替代账号，密钥全部存放在 macOS Keychain。

**首发平台为 macOS**。架构上保留 Windows / Linux 的可能性,但暂不主动支持。

## 特性亮点

- **本地优先**:所有会话、运行记录、凭证都留在本机。
- **模块化内核**:UI、Rust 内核、sidecar、浏览器扩展之间是分明的信任域。
- **策略化的工具调用**:每一次工具调用都由 Rust 内核裁决——放行、需审批、或拒绝。LLM 侧代码**永远拿不到隐式权限**。
- **浏览器即工具**:完整的 Chrome 扩展 + 中继子系统,全程审计。
- **Profile 隔离**:多 profile 互不干扰,各自拥有独立的数据库和 Keychain 条目。
- **强类型协议**:JSON Schema 作为唯一事实源,同时生成 TS 与 Rust 绑定。

## 架构

```text
┌──────────────────────────┐
│ React UI (apps/desktop-ui)│  不存密钥、不直接访问文件系统、不直连 sidecar
└──────────────┬────────────┘
               │ Tauri IPC
┌──────────────▼────────────┐
│ Tauri Rust 内核           │  keychain · 文件系统 · pty · profile
│ (apps/desktop-shell)      │  策略 · 审计 · 进程监管
└──────┬────────────┬───────┘
       │ 工具 RPC   │ 监管
┌──────▼─────┐  ┌───▼───────────────┐
│ Tool       │  │ Bun Agent Sidecar │  OpenAI Agents SDK
│ Gateway    │  │ (apps/gateway)    │  handoff · MCP · 流式
│ (Rust)     │  └───────────────────┘
└──────┬─────┘
       │ 中继
┌──────▼────────────────────┐
│ Chrome 扩展                │  高风险子系统,按 profile 配对、全程审计
│ (extensions/browser)      │
└───────────────────────────┘
```

## 仓库结构

```text
apps/desktop-ui      React + TypeScript 前端
apps/desktop-shell   Tauri Rust 桌面应用,负责系统集成
apps/gateway         Bun sidecar,OpenAI Agents SDK 运行时
extensions/browser   Chrome MV3 扩展,用于浏览器控制
crates/core          Rust 共享领域类型
crates/tool-gateway  Rust 工具执行、策略、审计
packages/protocol    共享 JSON Schema + 自动生成的 TS/Rust 绑定
packages/agent-runtime、packages/llm、packages/common
docs/superpowers     设计稿、计划、报告与路线图
```

## 环境要求

- macOS(推荐 Apple Silicon)
- Rust 工具链(由 `rust-toolchain.toml` 固定版本)
- [Bun](https://bun.sh) ≥ 1.1
- Node 22+(仅部分工具需要)
- Xcode Command Line Tools

## 快速开始

```bash
# 安装 JS workspace 依赖
bun install

# 以 dev 模式启动桌面 UI
bun run dev

# 对整个 workspace 进行类型检查
bun run typecheck

# 运行 protocol 单测
bun run test
```

如需打桌面安装包,请从 `apps/desktop-shell` 中驱动 Tauri(参见其 `tauri.conf.json`)。

## 验证脚本

仓库提供分层的验证脚本,按改动范围选择最小的那一个即可:

| 范围 | 命令 |
|------|------|
| 浏览器子系统 | `bun run verify:browser` |
| 指挥中心(UI + 内核) | `bun run verify:command-center` |
| 全量(TS + Rust + clippy) | `bun run verify` |

每个脚本都会跑对应的 TypeScript 类型检查、Bun 测试、Cargo 测试,并执行 `cargo clippy -D warnings`。

## 路线图

Vulture 按里程碑迭代,当前处于 **L0**(gateway 骨架)。后续子项目:

- **L1 — 持久化深化**:运行恢复、Token/费用追踪、多 profile、多模态消息、OpenAPI 自动代码生成。
- **L2 — 知识层**:skill 系统、基于 sqlite-vec 的记忆存储。
- **L3 — 外部集成**:MCP 客户端/服务端、PTY 终端、基于 CDP 的浏览器升级。
- **L4 — 多智能体**:子智能体编排、父子 run 追踪。

完整路线图见 [docs/superpowers/roadmap.md](docs/superpowers/roadmap.md)。

## 明确不做的事

以下是有意**不规划**的方向,需要的话请先讨论产品方向:

- 用户账号、云同步、计费体系。
- 远程外部客户端 —— gateway 只绑定 `127.0.0.1`。
- 真正的 RBAC / 多用户权限模型。
- 桌面应用退出后让 gateway 在后台常驻。
- 独立的 CLI 自带 gateway。

## License

UNLICENSED —— 见 [`Cargo.toml`](Cargo.toml)。在作者公开协议之前,保留所有权利。
