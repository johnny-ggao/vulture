import { useEffect, useState } from "react";
import type { Agent, AgentCoreFilesResponse } from "../api/agents";
import type { ToolCatalogGroup } from "../api/tools";
import { AgentCard, SectionCard } from "./components";
import {
  AgentEditModal,
  type AgentConfigPatch,
} from "./AgentEditModal";

export type { AgentConfigPatch };

export interface AgentsPageProps {
  agents: ReadonlyArray<Agent>;
  selectedAgentId: string;
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  onCreate: () => void;
  onOpenChat: (id: string) => void;
  onSave: (id: string, patch: AgentConfigPatch) => Promise<void>;
  onListFiles: (id: string) => Promise<AgentCoreFilesResponse>;
  onLoadFile: (id: string, name: string) => Promise<string>;
  onSaveFile: (id: string, name: string, content: string) => Promise<void>;
  /**
   * Optional one-tap delete handler. The parent owns the undo affordance
   * (typically a transient toast); the list dispatches immediately.
   */
  onDelete?: (id: string) => void;
}

/**
 * Browse view for the user's agents. Each agent is a card in a responsive
 * grid; clicking a card opens the edit modal. Heavy editor logic lives in
 * `AgentEditModal` so this component stays focused on browse + create.
 */
export function AgentsPage(props: AgentsPageProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingAgent =
    editingId !== null
      ? props.agents.find((agent) => agent.id === editingId) ?? null
      : null;

  // If the agent currently being edited is removed (e.g. an undo-toast
  // commit), close the modal rather than letting it render an empty shell.
  useEffect(() => {
    if (editingId !== null && !props.agents.some((a) => a.id === editingId)) {
      setEditingId(null);
    }
  }, [editingId, props.agents]);

  // The chat pane shares `selectedAgentId` with the Composer. Opening the
  // chat from a card or from inside the modal must update both: route the
  // user to the chat view (parent's responsibility) AND close the modal.
  function handleOpenChatFromAgent(id: string) {
    props.onOpenChat(id);
    setEditingId(null);
  }

  if (props.agents.length === 0) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h1>智能体</h1>
            <p>每个智能体捆绑模型、工具权限与人格设置，用来开启不同场景的对话。</p>
          </div>
        </header>
        <SectionCard className="agents-empty-page">
          <div className="agents-empty-art" aria-hidden="true">
            <EmptyAgentsIllustration />
          </div>
          <h2 className="agents-empty-title">还没有智能体</h2>
          <p className="agents-empty-desc">
            智能体捆绑模型、工具权限、Skills 与人格设置；按用途创建一个开始对话。
          </p>
          <button type="button" className="btn-primary" onClick={props.onCreate}>
            创建第一个智能体
          </button>
        </SectionCard>

        <AgentEditModal
          open={editingAgent !== null}
          agent={editingAgent}
          toolGroups={props.toolGroups}
          onClose={() => setEditingId(null)}
          onOpenChat={handleOpenChatFromAgent}
          onSave={props.onSave}
          onListFiles={props.onListFiles}
          onLoadFile={props.onLoadFile}
          onSaveFile={props.onSaveFile}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>智能体</h1>
          <p>每个智能体捆绑模型、工具权限与人格设置，用来开启不同场景的对话。</p>
        </div>
        <button type="button" className="btn-primary" onClick={props.onCreate}>
          新建智能体
        </button>
      </header>

      <div className="agents-grid">
        {props.agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onOpenEdit={(id) => setEditingId(id)}
            onOpenChat={props.onOpenChat}
            onDelete={props.onDelete}
          />
        ))}
      </div>

      <AgentEditModal
        open={editingAgent !== null}
        agent={editingAgent}
        toolGroups={props.toolGroups}
        onClose={() => setEditingId(null)}
        onOpenChat={handleOpenChatFromAgent}
        onSave={props.onSave}
        onListFiles={props.onListFiles}
        onLoadFile={props.onLoadFile}
        onSaveFile={props.onSaveFile}
      />
    </div>
  );
}

function EmptyAgentsIllustration() {
  return (
    <svg
      viewBox="0 0 96 96"
      width="96"
      height="96"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="14" y="22" width="68" height="42" rx="8" />
      <rect x="22" y="14" width="52" height="6" rx="3" />
      <circle cx="28" cy="38" r="6" />
      <path d="M40 36h26" />
      <path d="M40 44h18" />
      <path d="M28 56h36" />
    </svg>
  );
}
