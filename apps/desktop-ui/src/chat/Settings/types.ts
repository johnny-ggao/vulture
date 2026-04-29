import type { AuthStatusView, BrowserRelayStatus } from "../../commandCenterTypes";
import type { Agent } from "../../api/agents";
import type { Memory, MemoryStatus } from "../../api/memories";
import type {
  McpServer,
  McpToolSummary,
  SaveMcpServer,
  UpdateMcpServer,
} from "../../api/mcpServers";

export interface SettingsPageProps {
  authStatus: AuthStatusView | null;
  browserStatus: BrowserRelayStatus | null;
  agents: ReadonlyArray<Agent>;
  selectedAgentId: string;
  profiles: Array<{ id: string; name: string; activeAgentId: string }>;
  activeProfileId: string | null;
  switchingProfileId: string | null;
  onSelectAgent: (agentId: string) => void;
  onListMemories: (agentId: string) => Promise<Memory[]>;
  onGetMemoryStatus: (agentId: string) => Promise<MemoryStatus | null>;
  onReindexMemory: (agentId: string) => Promise<MemoryStatus>;
  onCreateMemory: (agentId: string, content: string) => Promise<Memory>;
  onDeleteMemory: (agentId: string, memoryId: string) => Promise<void>;
  onListMcpServers: () => Promise<McpServer[]>;
  onCreateMcpServer: (input: SaveMcpServer) => Promise<McpServer>;
  onUpdateMcpServer: (id: string, patch: UpdateMcpServer) => Promise<McpServer>;
  onDeleteMcpServer: (id: string) => Promise<void>;
  onReconnectMcpServer: (id: string) => Promise<McpServer>;
  onListMcpServerTools: (id: string) => Promise<McpToolSummary[]>;
  onCreateProfile: (name: string) => Promise<void>;
  onSwitchProfile: (profileId: string) => Promise<void>;
  onSignInWithChatGPT: () => Promise<void>;
  onSignOutCodex: () => Promise<void>;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onStartBrowserPairing: () => Promise<void>;
}
