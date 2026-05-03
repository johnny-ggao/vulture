import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react/pure";
import { SettingsPage, type SettingsPageProps } from "./SettingsPage";
import type { McpServer } from "../api/mcpServers";
import type {
  UpdateWebSearchSettings,
  WebSearchSettingsResponse,
  WebSearchTestResult,
} from "../api/webSearchSettings";

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
    onBack: mock(() => undefined),
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
    onGetWebSearchSettings: mock(async (): Promise<WebSearchSettingsResponse> => ({
      settings: {
        provider: "duckduckgo-html",
        searxngBaseUrl: null,
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      providers: [
        { id: "duckduckgo-html", label: "DuckDuckGo HTML", requiresBaseUrl: false },
        { id: "searxng", label: "SearXNG", requiresBaseUrl: true },
      ],
    })),
    onUpdateWebSearchSettings: mock(async (
      input: UpdateWebSearchSettings,
    ): Promise<WebSearchSettingsResponse> => ({
      settings: {
        provider: input.provider ?? "duckduckgo-html",
        searxngBaseUrl: input.searxngBaseUrl ?? null,
        updatedAt: "2026-05-01T00:00:01.000Z",
      },
      providers: [
        { id: "duckduckgo-html", label: "DuckDuckGo HTML", requiresBaseUrl: false },
        { id: "searxng", label: "SearXNG", requiresBaseUrl: true },
      ],
    })),
    onTestWebSearchSettings: mock(async (): Promise<WebSearchTestResult> => ({
      ok: true,
      provider: "searxng",
      query: "OpenAI Agents SDK",
      resultCount: 1,
      sample: { title: "OpenAI Agents SDK", url: "https://openai.github.io/openai-agents-js/" },
    })),
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
  test("renders standalone settings navigation above the settings tabs", () => {
    const onBack = mock(() => undefined);
    render(<SettingsPage {...props({ onBack })} />);

    expect(screen.queryByRole("heading", { level: 1, name: "设置" })).toBeNull();
    expect(screen.queryByText("统一配置模型、工具、记忆、联网、消息渠道与运行诊断。")).toBeNull();
    expect(screen.getByRole("tablist", { name: "设置分区" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "返回应用" }));
    expect(onBack).toHaveBeenCalled();
  });

  test("appearance setting updates and persists the theme preference", () => {
    localStorage.removeItem("vulture.theme");
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty("color-scheme");

    render(<SettingsPage {...props()} />);

    expect(screen.queryByText("跟随系统 / 浅色 / 深色。当前跟随系统。")).toBeNull();
    expect(screen.getByRole("radio", { name: "系统" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("vulture.theme")).toBe("dark");
    expect(screen.getByRole("radio", { name: "深色" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "系统" }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("vulture.theme")).toBeNull();
  });

  test("diagnostics tab keeps run logs in the embedded settings shell", async () => {
    render(<SettingsPage {...props()} />);

    fireEvent.click(screen.getByRole("tab", { name: "运行日志" }));

    expect(screen.getByRole("heading", { level: 2, name: "运行日志" })).toBeDefined();
    expect(screen.getByRole("toolbar", { name: "运行日志筛选" })).toBeDefined();
    expect(screen.queryByRole("toolbar", { name: "运行日志筛选与刷新" })).toBeNull();
    await screen.findByText("没有匹配的运行日志。");
  });

  test("tool checkbox updates the server disabledTools policy", async () => {
    const onUpdateMcpServer = mock(async (_id: string, patch) => ({ ...baseServer, ...patch }));
    render(<SettingsPage {...props({ onUpdateMcpServer })} />);

    fireEvent.click(screen.getByRole("tab", { name: "MCP 服务器" }));

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

    fireEvent.click(screen.getByRole("tab", { name: "MCP 服务器" }));

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

    fireEvent.click(screen.getByRole("tab", { name: "MCP 服务器" }));

    await waitFor(() => {
      expect(screen.getByText("Official Filesystem")).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "工具" }));

    expect(await screen.findByRole("checkbox", { name: /read_text_file/ })).toBeDefined();
  });
});

describe("SettingsPage Models", () => {
  test("model tab shows a summary and provider directory", () => {
    render(<SettingsPage {...props({
      authStatus: {
        apiKey: { state: "set", source: "keychain" },
        codex: { state: "not_signed_in" },
      },
    })} />);

    fireEvent.click(screen.getByRole("tab", { name: "模型" }));

    const summary = screen.getByLabelText("模型配置摘要");
    expect(within(summary).getByText(/已配置/)).toBeDefined();
    expect(within(summary).getByText(/7 个提供方/)).toBeDefined();
    expect(within(summary).getByText(/当前查看/)).toBeDefined();
    expect(screen.queryByRole("heading", { level: 3, name: "默认值" })).toBeNull();
    expect(screen.getByRole("listbox", { name: "模型提供商" })).toBeDefined();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(4);
    expect(screen.getByRole("heading", { level: 3, name: "OpenAI" })).toBeDefined();
  });
});

describe("SettingsPage Web Search", () => {
  test("updates SearXNG provider settings and tests the provider", async () => {
    const onUpdateWebSearchSettings = mock(async (
      input: UpdateWebSearchSettings,
    ): Promise<WebSearchSettingsResponse> => ({
      settings: {
        provider: input.provider ?? "duckduckgo-html",
        searxngBaseUrl: input.searxngBaseUrl ?? null,
        updatedAt: "2026-05-01T00:00:01.000Z",
      },
      providers: [
        { id: "duckduckgo-html", label: "DuckDuckGo HTML", requiresBaseUrl: false },
        { id: "searxng", label: "SearXNG", requiresBaseUrl: true },
      ],
    }));
    const onTestWebSearchSettings = mock(async (): Promise<WebSearchTestResult> => ({
      ok: true,
      provider: "searxng",
      query: "OpenAI Agents SDK",
      resultCount: 2,
      sample: { title: "Agents SDK", url: "https://example.com/sdk" },
    }));
    render(<SettingsPage {...props({ onUpdateWebSearchSettings, onTestWebSearchSettings })} />);

    fireEvent.click(screen.getByRole("tab", { name: "联网" }));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "搜索源" })).toBeDefined();
    });
    fireEvent.change(screen.getByRole("combobox", { name: "搜索源" }), {
      target: { value: "searxng" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "SearXNG URL" }), {
      target: { value: "https://search.example.com" },
    });

    fireEvent.click(screen.getByRole("button", { name: "测试" }));
    await waitFor(() => {
      expect(onTestWebSearchSettings).toHaveBeenCalledWith({
        provider: "searxng",
        searxngBaseUrl: "https://search.example.com",
        query: "OpenAI Agents SDK",
      });
    });
    expect(await screen.findByText(/2 个结果/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(onUpdateWebSearchSettings).toHaveBeenCalledWith({
        provider: "searxng",
        searxngBaseUrl: "https://search.example.com",
      });
    });
  });
});
