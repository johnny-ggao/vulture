import { useState, type ReactNode } from "react";
import type { AuthStatusView } from "../commandCenterTypes";

const SECTIONS = [
  { key: "general",  label: "通用",       icon: <DotIcon /> },
  { key: "model",    label: "模型",       icon: <DotIcon /> },
  { key: "memory",   label: "记忆",       icon: <DotIcon /> },
  { key: "mcp",      label: "MCP 服务器", icon: <DotIcon /> },
  { key: "browser",  label: "浏览器",     icon: <DotIcon /> },
  { key: "channels", label: "消息渠道",   icon: <DotIcon /> },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export interface SettingsPageProps {
  authStatus: AuthStatusView | null;
}

export function SettingsPage(props: SettingsPageProps) {
  const [section, setSection] = useState<SectionKey>("general");
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>设置</h1>
          <p>偏好、模型与连接器。仅 通用 / 模型 已对接后端，其余分区为 Phase 4 预留。</p>
        </div>
      </header>
      <div className="settings-layout">
        <aside className="settings-rail" aria-label="设置分区">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={section === s.key ? "active" : ""}
              onClick={() => setSection(s.key)}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </aside>
        <div className="settings-content">{renderSection(section, props)}</div>
      </div>
    </div>
  );
}

function renderSection(section: SectionKey, props: SettingsPageProps): ReactNode {
  switch (section) {
    case "general":  return <GeneralSection />;
    case "model":    return <ModelSection authStatus={props.authStatus} />;
    case "memory":   return <Stub title="记忆" body="为对话自动汇总长期记忆。Phase 4 启用。" />;
    case "mcp":      return <Stub title="MCP 服务器" body="挂载 Model Context Protocol 服务器。Phase 4 启用。" />;
    case "browser":  return <Stub title="浏览器" body="通过 Chrome 扩展连接桌面浏览器，供 browser.* 工具使用。Phase 4 启用。" />;
    case "channels": return <Stub title="消息渠道" body="向微信、飞书等渠道转发会话事件。Phase 4 启用。" />;
  }
}

function GeneralSection() {
  return (
    <div className="page-card">
      <h3>通用</h3>
      <p style={{ marginBottom: 12 }}>主题：跟随系统（Phase 4 加入主题切换）</p>
      <p style={{ color: "var(--text-tertiary)", fontSize: 12 }}>当前 UI 版本：Phase 3d 设计刷新</p>
    </div>
  );
}

function ModelSection({ authStatus }: { authStatus: AuthStatusView | null }) {
  const codex = authStatus?.codex;
  const apiKey = authStatus?.apiKey;
  return (
    <div className="page-card">
      <h3>模型</h3>
      <p style={{ marginBottom: 12 }}>当前在用：{describeActive(authStatus)}</p>
      <div style={{ display: "grid", gap: 8 }}>
        <Row label="ChatGPT 订阅 (Codex)" value={codex ? describeCodex(codex) : "—"} />
        <Row label="OpenAI API Key" value={apiKey?.state === "set" ? "已配置" : "未配置"} />
      </div>
      <p style={{ color: "var(--text-tertiary)", fontSize: 12, marginTop: 12 }}>
        在侧栏底部 AuthPanel 中切换登录方式 / 输入 API Key。
      </p>
    </div>
  );
}

function describeActive(s: AuthStatusView | null): string {
  if (!s) return "loading";
  if (s.active === "codex") return `Codex (${s.codex.email ?? "已登录"})`;
  if (s.active === "api_key") return "API Key";
  if (s.codex.state === "expired") return "Codex 已过期，请重新登录";
  return "未认证";
}

function describeCodex(c: AuthStatusView["codex"]): string {
  switch (c.state) {
    case "signed_in":   return c.email ? `已登录 · ${c.email}` : "已登录";
    case "expired":     return "已过期";
    case "logging_in":  return "登录中…";
    case "not_signed_in": return "未登录";
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      padding: "10px 0",
      borderBottom: "1px solid var(--fill-quaternary)",
      fontSize: 13,
    }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function Stub({ title, body }: { title: string; body: string }) {
  return (
    <div className="page-card">
      <h3>{title}</h3>
      <div className="placeholder">
        <span>{body}</span>
      </div>
    </div>
  );
}

function DotIcon() {
  return <span style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor", opacity: 0.5 }} />;
}
