import { useState, type ReactNode } from "react";
import { Stub } from "./shared";
import { GeneralSection } from "./GeneralSection";
import { ModelSection } from "./ModelSection";
import { MemorySection } from "./MemorySection";
import { McpSection } from "./McpSection";
import { BrowserSection } from "./BrowserSection";
import { RunLogsPanel } from "../RunLogsPage";
import {
  BrowserIcon,
  ChannelIcon,
  DiagnosticsIcon,
  GeneralIcon,
  MemoryIcon,
  ModelIcon,
  PluginIcon,
} from "./icons";
import type { SettingsPageProps } from "./types";

const SECTIONS = [
  { key: "general",  label: "通用",       icon: <GeneralIcon /> },
  { key: "model",    label: "模型",       icon: <ModelIcon /> },
  { key: "memory",   label: "记忆",       icon: <MemoryIcon /> },
  { key: "mcp",      label: "MCP 服务器", icon: <PluginIcon /> },
  { key: "browser",  label: "浏览器",     icon: <BrowserIcon /> },
  { key: "diagnostics", label: "运行日志", icon: <DiagnosticsIcon /> },
  { key: "channels", label: "消息渠道",   icon: <ChannelIcon /> },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export function SettingsPage(props: SettingsPageProps) {
  const [section, setSection] = useState<SectionKey>("general");
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>设置</h1>
          <p>偏好、模型、记忆与连接器。MCP / 消息渠道分区仍为后续预留。</p>
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
    case "general":  return <GeneralSection {...props} />;
    case "model":    return <ModelSection {...props} />;
    case "memory":   return <MemorySection {...props} />;
    case "mcp":      return <McpSection {...props} />;
    case "browser":  return <BrowserSection {...props} />;
    case "diagnostics":
      return (
        <RunLogsPanel
          embedded
          agents={props.agents}
          onListRunLogs={props.onListRunLogs}
          onLoadRunTrace={props.onLoadRunTrace}
        />
      );
    case "channels": return <Stub title="消息渠道" body="向微信、飞书等渠道转发会话事件。Phase 4 启用。" />;
  }
}
