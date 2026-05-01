import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react/pure";
import { SettingsPage, type SettingsPageProps } from "./SettingsPage";
import type { McpServer } from "../api/mcpServers";

const baseServer: McpServer = {
  id: "official-filesystem",
  profileId: "default",
  name: "Official Filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
  cwd: null,
  env: {},
  trust: "trusted",
  enabled: true,
  enabledTools: null,
  disabledTools: [],
  createdAt: "2026-04-28T00:00:00.000Z",
  updatedAt: "2026-04-28T00:00:00.000Z",
  runtime: {
    status: "connected",
    lastError: null,
    toolCount: 2,
    updatedAt: "2026-04-28T00:00:00.000Z",
  },
};

function props(overrides: Partial<SettingsPageProps> = {}): SettingsPageProps {
  return {
    authStatus: null,
    browserStatus: null,
    agents: [{
      id: "local-work-agent",
      name: "Local Work Agent",
      description: "",
      model: "gpt-5.4",
      reasoning: "medium",
      tools: [],
      workspace: {
        id: "local-work-agent",
        name: "Local Work Agent",
        path: "/tmp/workspace",
        createdAt: "2026-04-28T00:00:00.000Z",
        updatedAt: "2026-04-28T00:00:00.000Z",
      },
      instructions: "",
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
    }],
    selectedAgentId: "local-work-agent",
    profiles: [{ id: "default", name: "Default", activeAgentId: "local-work-agent" }],
    activeProfileId: "default",
    switchingProfileId: null,
    onSelectAgent: mock(() => undefined),
    onListMemories: mock(async () => []),
    onGetMemoryStatus: mock(async () => null),
    onReindexMemory: mock(async () => ({
      agentId: "local-work-agent",
      rootPath: "",
      fileCount: 0,
      chunkCount: 0,
      indexedAt: null,
      files: [],
    })),
    onCreateMemory: mock(async () => {
      throw new Error("unused");
    }),
    onDeleteMemory: mock(async () => undefined),
    onListMcpServers: mock(async () => [baseServer]),
    onCreateMcpServer: mock(async () => baseServer),
    onUpdateMcpServer: mock(async (_id: string, patch) => ({ ...baseServer, ...patch })),
    onDeleteMcpServer: mock(async () => undefined),
    onReconnectMcpServer: mock(async () => baseServer),
    onListMcpServerTools: mock(async () => [
      { name: "list_directory", description: "List directory", enabled: true },
      { name: "read_text_file", description: "Read file", enabled: true },
      { name: "write_file", description: "Write file", enabled: true },
      { name: "delete_file", description: "Delete file", enabled: true },
    ]),
    onListRunLogs: mock(async () => ({ items: [], nextOffset: null })),
    onLoadRunTrace: mock(async () => {
      throw new Error("unused");
    }),
    onCreateProfile: mock(async () => undefined),
    onSwitchProfile: mock(async () => undefined),
    onSignInWithChatGPT: mock(async () => undefined),
    onSignOutCodex: mock(async () => undefined),
    onSaveApiKey: mock(async () => undefined),
    onClearApiKey: mock(async () => undefined),
    onStartBrowserPairing: mock(async () => undefined),
    ...overrides,
  };
}

describe("SettingsPage MCP tools", () => {
  test("tool checkbox updates the server disabledTools policy", async () => {
    const onUpdateMcpServer = mock(async (_id: string, patch) => ({ ...baseServer, ...patch }));
    render(<SettingsPage {...props({ onUpdateMcpServer })} />);

    fireEvent.click(screen.getByRole("button", { name: "MCP 服务器" }));

    await waitFor(() => {
      expect(screen.getByText("Official Filesystem")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "工具" }));

    const checkbox = await screen.findByRole("checkbox", { name: /read_text_file/ });
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(onUpdateMcpServer).toHaveBeenCalledWith("official-filesystem", {
        enabledTools: null,
        disabledTools: ["read_text_file"],
      });
    });
  });

  test("read-only preset allowlists read-like MCP tools", async () => {
    const onUpdateMcpServer = mock(async (_id: string, patch) => ({ ...baseServer, ...patch }));
    render(<SettingsPage {...props({ onUpdateMcpServer })} />);

    fireEvent.click(screen.getByRole("button", { name: "MCP 服务器" }));

    await waitFor(() => {
      expect(screen.getByText("Official Filesystem")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    await screen.findByRole("checkbox", { name: /write_file/ });

    fireEvent.click(screen.getByRole("button", { name: "只读" }));

    await waitFor(() => {
      expect(onUpdateMcpServer).toHaveBeenCalledWith("official-filesystem", {
        enabledTools: ["list_directory", "read_text_file"],
        disabledTools: [],
      });
    });
  });

  test("tools view tolerates servers returned by an older gateway without tool policy fields", async () => {
    const legacyServer = { ...baseServer };
    delete (legacyServer as Partial<McpServer>).enabledTools;
    delete (legacyServer as Partial<McpServer>).disabledTools;
    render(<SettingsPage {...props({
      onListMcpServers: mock(async () => [legacyServer as McpServer]),
      onListMcpServerTools: mock(async () => [
        { name: "read_text_file", description: "Read file" },
      ]),
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "MCP 服务器" }));

    await waitFor(() => {
      expect(screen.getByText("Official Filesystem")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "工具" }));

    expect(await screen.findByRole("checkbox", { name: /read_text_file/ })).toBeDefined();
  });
});
