import type { ReactNode } from "react";
import { BrandMark } from "./components";

export type ViewKey =
  | "chat"
  | "agents"
  | "skills"
  | "artifacts"
  | "plugins"
  | "tasks"
  | "settings";

export interface WorkbenchSidebarProps {
  view: ViewKey;
  onSelectView: (v: ViewKey) => void;
  onNewConversation: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
}

const PRIMARY: Array<{ key: ViewKey; label: string; icon: ReactNode }> = [
  { key: "chat",    label: "对话",     icon: <IconChat /> },
  { key: "agents",  label: "智能体",   icon: <IconAgents /> },
  { key: "skills",  label: "技能",     icon: <IconSkills /> },
  { key: "artifacts", label: "产物",   icon: <IconArtifacts /> },
  { key: "plugins", label: "插件",     icon: <IconPlugins /> },
  { key: "tasks",   label: "定时任务", icon: <IconTasks /> },
];

export function WorkbenchSidebar(props: WorkbenchSidebarProps) {
  return (
    <aside className="sidebar" aria-label="主导航">
      <button
        type="button"
        className="sidebar-brand"
        onClick={() => props.onSelectView("chat")}
        aria-label="Vulture Work 首页"
      >
        <span className="sidebar-brand-mark">
          <BrandMark size={30} />
        </span>
        <span className="sidebar-brand-text">Vulture</span>
      </button>

      <nav className="sidebar-nav">
        {PRIMARY.map(({ key, label, icon }, idx) => {
          // ⌘1–6 jump-shortcuts mirror App.tsx's window-level handler;
          // surfacing the digit on the title attribute makes the
          // shortcut discoverable without opening ⌘K.
          const digit = idx + 1;
          const shortcut = `⌘ ${digit}`;
          const titleHint = key === "chat" ? `新建对话  ⌘ N` : `${label}  ${shortcut}`;
          return (
            <button
              key={key}
              type="button"
              className={"sb-item" + (props.view === key ? " sb-item-active" : "")}
              title={titleHint}
              aria-keyshortcuts={
                key === "chat" ? "Meta+N Control+N" : `Meta+${digit} Control+${digit}`
              }
              onClick={() => {
                if (key === "chat") {
                  props.onNewConversation();
                  return;
                }
                props.onSelectView(key);
              }}
            >
              {icon}
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={"sb-item" + (props.historyOpen ? " sb-item-active" : "")}
          title="历史  ⌘ B"
          aria-keyshortcuts="Meta+B Control+B"
          onClick={props.onToggleHistory}
          aria-expanded={props.historyOpen}
        >
          <IconHistory />
          <span>历史</span>
        </button>
      </nav>

      <nav className="sidebar-foot" aria-label="次要导航">
        <button
          type="button"
          className={"sb-item" + (props.view === "settings" ? " sb-item-active" : "")}
          title="设置  ⌘ ,"
          aria-keyshortcuts="Meta+Comma Control+Comma"
          onClick={() => props.onSelectView("settings")}
        >
          <IconSettings />
          <span>设置</span>
        </button>
      </nav>
    </aside>
  );
}

function IconChat() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M14 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0Z" /><path d="M3.5 13.5l-1 1 .5-2.5" /></svg>;
}
function IconAgents() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4.5" width="10" height="8" rx="2" /><path d="M8 2v2.5M5.5 8h.01M10.5 8h.01" /></svg>;
}
function IconSkills() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.5l1.6 3.4 3.7.5-2.7 2.6.7 3.7L8 11l-3.3 1.7.7-3.7L2.7 6.4l3.7-.5L8 2.5Z" /></svg>;
}
function IconArtifacts() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M3 2.75h6.25L13 6.5v6.75H3V2.75Z" /><path d="M9 3v4h4M5.5 9.5h5M5.5 12h3" /></svg>;
}
function IconPlugins() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 4.5l5.5-2 5.5 2v6.5l-5.5 3-5.5-3V4.5Z" /><path d="M8 2.5v11M2.5 4.5L8 7l5.5-2.5" /></svg>;
}
function IconTasks() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8.5" r="5.5" /><path d="M8 5.5v3l2 1.5" /></svg>;
}
function IconHistory() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3.5a5 5 0 1 1-4.4 2.6" /><path d="M3 3v3h3M8 5.5v3l2.2 1.3" /></svg>;
}
function IconSettings() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="2" /><path d="M13 8a5 5 0 0 0-.1-1.1l1.4-1-1-1.7-1.6.6a5 5 0 0 0-1.9-1.1L9.5 2H6.5l-.3 1.6a5 5 0 0 0-1.9 1.1l-1.6-.6-1 1.7 1.4 1A5 5 0 0 0 3 8a5 5 0 0 0 .1 1.1l-1.4 1 1 1.7 1.6-.6a5 5 0 0 0 1.9 1.1L6.5 14h3l.3-1.6a5 5 0 0 0 1.9-1.1l1.6.6 1-1.7-1.4-1A5 5 0 0 0 13 8Z" /></svg>;
}
