import { useRef, useState, type ReactNode } from "react";
import { GeneralSection } from "./GeneralSection";
import { ModelSection } from "./ModelSection";
import { MemorySection } from "./MemorySection";
import { McpSection } from "./McpSection";
import { BrowserSection } from "./BrowserSection";
import { ChannelsSection } from "./ChannelsSection";
import { WebSearchSection } from "./WebSearchSection";
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
  { key: "web",      label: "联网",       icon: <BrowserIcon /> },
  { key: "browser",  label: "浏览器",     icon: <BrowserIcon /> },
  { key: "diagnostics", label: "运行日志", icon: <DiagnosticsIcon /> },
  { key: "channels", label: "消息渠道",   icon: <ChannelIcon /> },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export function SettingsPage(props: SettingsPageProps) {
  const [section, setSection] = useState<SectionKey>("general");
  const tabRefs = useRef<Record<SectionKey, HTMLButtonElement | null>>({
    general: null,
    model: null,
    memory: null,
    mcp: null,
    web: null,
    browser: null,
    diagnostics: null,
    channels: null,
  });

  function activateTab(next: SectionKey, focus: boolean) {
    setSection(next);
    if (focus) {
      // Defer focus to next microtask so React commits the new
      // tabIndex flip before we move focus, otherwise the browser
      // can lose track of the focused element on rapid key repeat.
      queueMicrotask(() => tabRefs.current[next]?.focus());
    }
  }

  function onTabKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const order = SECTIONS.map((s) => s.key);
    const idx = order.indexOf(section);
    if (idx < 0) return;
    let next: SectionKey | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = order[(idx + 1) % order.length] ?? null;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = order[(idx - 1 + order.length) % order.length] ?? null;
    } else if (event.key === "Home") {
      next = order[0] ?? null;
    } else if (event.key === "End") {
      next = order[order.length - 1] ?? null;
    }
    if (next === null) return;
    event.preventDefault();
    activateTab(next, true);
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>设置</h1>
          <p>偏好、模型、记忆与连接器。MCP / 消息渠道分区仍为后续预留。</p>
        </div>
      </header>
      <div className="settings-layout">
        <div
          className="settings-rail"
          role="tablist"
          aria-label="设置分区"
          aria-orientation="vertical"
          onKeyDown={onTabKey}
        >
          {SECTIONS.map((s) => {
            const active = section === s.key;
            return (
              <button
                key={s.key}
                ref={(node) => {
                  tabRefs.current[s.key] = node;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${s.key}`}
                aria-controls={`settings-panel-${s.key}`}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className={active ? "active" : ""}
                onClick={() => activateTab(s.key, false)}
              >
                {s.icon}
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
        <div
          className="settings-content"
          role="tabpanel"
          id={`settings-panel-${section}`}
          aria-labelledby={`settings-tab-${section}`}
          tabIndex={0}
        >
          {renderSection(section, props)}
        </div>
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
    case "web":      return <WebSearchSection {...props} />;
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
    case "channels": return <ChannelsSection />;
  }
}
