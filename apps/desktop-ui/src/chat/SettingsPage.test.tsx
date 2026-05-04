import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react/pure";
import { SettingsPage, type SettingsPageProps } from "./SettingsPage";
import type { McpServer } from "../api/mcpServers";
import type {
  UpdateWebSearchSettings,
  WebSearchSettingsResponse,
  WebSearchTestResult,
} from "../api/webSearchSettings";
import type { ModelSettingsResponse } from "../api/modelSettings";

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

const defaultModelSettings: ModelSettingsResponse = {
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      auth: "api-key",
      models: [
        { id: "gpt-5.5", modelRef: "openai/gpt-5.5", name: "GPT-5.5", reasoning: true, input: ["text", "image"] },
        { id: "gpt-5.4", modelRef: "openai/gpt-5.4", name: "GPT-5.4", reasoning: true, input: ["text", "image"] },
      ],
      authProfiles: [
        { id: "openai-api-key", provider: "openai", mode: "api_key", label: "OpenAI API Key", status: "missing" },
      ],
      authOrder: ["openai-api-key"],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      auth: "api-key",
      models: [
        { id: "claude-sonnet-4.5", modelRef: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", reasoning: true, input: ["text"] },
      ],
      authProfiles: [
        { id: "anthropic-api-key", provider: "anthropic", mode: "api_key", label: "Anthropic API Key", status: "missing" },
      ],
      authOrder: ["anthropic-api-key"],
    },
  ],
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
    onGetModelSettings: mock(async () => defaultModelSettings),
    onTestModelConnectivity: mock(async (input: { modelRef: string }) => ({
      ok: true,
      provider: input.modelRef.split("/")[0] ?? "openai",
      model: input.modelRef,
      profileId: "openai-api-key",
      message: "stub auth ok",
    })),
    onGetWebSearchSettings: mock(async (): Promise<WebSearchSettingsResponse> => ({
      settings: {
        provider: "multi",
        searxngBaseUrl: null,
        braveApiKey: null,
        tavilyApiKey: null,
        perplexityApiKey: null,
        geminiApiKey: null,
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      providers: [
        { id: "multi", label: "Auto", requiresBaseUrl: false, requiresApiKey: false },
        { id: "duckduckgo-html", label: "DuckDuckGo HTML", requiresBaseUrl: false, requiresApiKey: false },
        { id: "searxng", label: "SearXNG", requiresBaseUrl: true, requiresApiKey: false },
        { id: "brave-api", label: "Brave Search API", requiresBaseUrl: false, requiresApiKey: true },
      ],
    })),
    onUpdateWebSearchSettings: mock(async (
      input: UpdateWebSearchSettings,
    ): Promise<WebSearchSettingsResponse> => ({
      settings: {
        provider: input.provider ?? "multi",
        searxngBaseUrl: input.searxngBaseUrl ?? null,
        braveApiKey: input.braveApiKey ?? null,
        tavilyApiKey: input.tavilyApiKey ?? null,
        perplexityApiKey: input.perplexityApiKey ?? null,
        geminiApiKey: input.geminiApiKey ?? null,
        updatedAt: "2026-05-01T00:00:01.000Z",
      },
      providers: [
        { id: "multi", label: "Auto", requiresBaseUrl: false, requiresApiKey: false },
        { id: "duckduckgo-html", label: "DuckDuckGo HTML", requiresBaseUrl: false, requiresApiKey: false },
        { id: "searxng", label: "SearXNG", requiresBaseUrl: true, requiresApiKey: false },
        { id: "brave-api", label: "Brave Search API", requiresBaseUrl: false, requiresApiKey: true },
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
    expect(screen.queryByText("隐私与数据")).toBeNull();
    expect(screen.queryByText("匿名使用统计")).toBeNull();
    expect(screen.queryByText("本地数据目录")).toBeNull();
    expect(screen.queryByText("安静时段")).toBeNull();
    expect(screen.queryByText("启用安静时段")).toBeNull();
    expect(screen.queryByText("勿扰例外")).toBeNull();
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
  test("model tab shows the provider directory", async () => {
    render(<SettingsPage {...props({
      authStatus: {
        apiKey: { state: "set", source: "keychain" },
        codex: { state: "not_signed_in" },
      },
    })} />);

    fireEvent.click(screen.getByRole("tab", { name: "模型" }));

    expect(screen.queryByLabelText("模型配置摘要")).toBeNull();
    expect(screen.queryByRole("heading", { level: 3, name: "默认值" })).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "模型提供商" })).toBeDefined();
    });
    expect(screen.getAllByRole("option").length).toBeGreaterThan(1);
    expect(screen.getByRole("heading", { level: 3, name: "OpenAI" })).toBeDefined();
    expect(screen.getByText("连接方式")).toBeDefined();
    expect(screen.getByText("使用静态 API Key 连接。")).toBeDefined();
    expect(screen.getAllByText("推理").length).toBeGreaterThan(0);
    expect(screen.getAllByText("文本").length).toBeGreaterThan(0);
    expect(screen.getAllByText("图像").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "添加密钥" }));

    expect(screen.getByLabelText("OpenAI API Key API Key")).toBeDefined();
  });

  test("model tab groups Codex under OpenAI instead of a gateway provider", async () => {
    render(<SettingsPage {...props({
      onGetModelSettings: mock(async (): Promise<ModelSettingsResponse> => ({
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            auth: "api-key",
            models: [
              { id: "gpt-5.5", modelRef: "openai/gpt-5.5", name: "GPT-5.5", reasoning: true, input: ["text"] },
            ],
            authProfiles: [
              { id: "codex", provider: "openai", mode: "oauth", label: "ChatGPT / Codex", status: "configured", email: "dev@example.com" },
              { id: "openai-api-key", provider: "openai", mode: "api_key", label: "OpenAI API Key", status: "configured" },
            ],
            authOrder: ["codex", "openai-api-key"],
          },
          {
            id: "anthropic",
            name: "Anthropic",
            api: "anthropic-messages",
            models: [
              { id: "claude-sonnet-4.5", modelRef: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", reasoning: true, input: ["text"] },
            ],
            authProfiles: [
              { id: "anthropic-api-key", provider: "anthropic", mode: "api_key", label: "Anthropic API Key", status: "missing" },
            ],
            authOrder: ["anthropic-api-key"],
          },
        ],
      })),
    })} />);

    fireEvent.click(screen.getByRole("tab", { name: "模型" }));

    expect(await screen.findByRole("heading", { level: 3, name: "OpenAI" })).toBeDefined();
    expect(screen.getAllByText("ChatGPT / Codex").length).toBeGreaterThan(0);
    expect(screen.getAllByText("OpenAI API Key").length).toBeGreaterThan(0);
    expect(screen.getByText("openai/gpt-5.5")).toBeDefined();
    expect(screen.queryByText("Codex Gateway")).toBeNull();
  });

  test("model tab lets Anthropic API key profile enter edit mode", async () => {
    render(<SettingsPage {...props()} />);

    fireEvent.click(screen.getByRole("tab", { name: "模型" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /Anthropic/ })).toBeDefined();
    });
    fireEvent.click(screen.getByRole("option", { name: /Anthropic/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加密钥" }));

    expect(screen.getByLabelText("Anthropic API Key API Key")).toBeDefined();
  });

  test("test connectivity button calls onTestModelConnectivity and shows ok feedback", async () => {
    const onTestModelConnectivity = mock(async () => ({
      ok: true,
      provider: "openai",
      model: "openai/gpt-5.5",
      profileId: "openai-api-key",
      message: "OpenAI auth ok · 12 个模型可见",
    }));

    render(<SettingsPage {...props({
      onTestModelConnectivity,
      onGetModelSettings: mock(async (): Promise<ModelSettingsResponse> => ({
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            api: "openai-responses",
            models: [
              { id: "gpt-5.5", modelRef: "openai/gpt-5.5", name: "GPT-5.5", reasoning: true, input: ["text"] },
            ],
            authProfiles: [
              { id: "openai-api-key", provider: "openai", mode: "api_key", label: "OpenAI API Key", status: "configured" },
            ],
            authOrder: ["openai-api-key"],
          },
        ],
      })),
    })} />);

    fireEvent.click(screen.getByRole("tab", { name: "模型" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "测试连通性" })).toBeDefined();
    });
    fireEvent.click(screen.getByRole("button", { name: "测试连通性" }));

    await waitFor(() => {
      expect(onTestModelConnectivity).toHaveBeenCalledWith({ modelRef: "openai/gpt-5.5" });
    });
    expect(await screen.findByText(/OpenAI auth ok/)).toBeDefined();
  });

  test("test connectivity button surfaces upstream failure inline", async () => {
    const onTestModelConnectivity = mock(async () => ({
      ok: false,
      provider: "google",
      model: "google/gemini-2.5-flash",
      profileId: "gemini-api-key",
      message: "Gemini 连通失败 (HTTP 401: Invalid API key)",
    }));

    render(<SettingsPage {...props({
      onTestModelConnectivity,
      onGetModelSettings: mock(async (): Promise<ModelSettingsResponse> => ({
        providers: [
          {
            id: "google",
            name: "Google Gemini",
            api: "gemini-generate-content",
            models: [
              { id: "gemini-2.5-flash", modelRef: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true, input: ["text"] },
            ],
            authProfiles: [
              { id: "gemini-api-key", provider: "google", mode: "api_key", label: "Gemini API Key", status: "configured" },
            ],
            authOrder: ["gemini-api-key"],
          },
        ],
      })),
    })} />);

    fireEvent.click(screen.getByRole("tab", { name: "模型" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "测试连通性" })).toBeDefined();
    });
    fireEvent.click(screen.getByRole("button", { name: "测试连通性" }));

    expect(await screen.findByText(/Gemini 连通失败.*HTTP 401.*Invalid API key/)).toBeDefined();
  });
});

describe("SettingsPage Web Search", () => {
  test("updates SearXNG provider settings and tests the provider", async () => {
    const onUpdateWebSearchSettings = mock(async (
      input: UpdateWebSearchSettings,
    ): Promise<WebSearchSettingsResponse> => ({
      settings: {
        provider: input.provider ?? "multi",
        searxngBaseUrl: input.searxngBaseUrl ?? null,
        braveApiKey: input.braveApiKey ?? null,
        tavilyApiKey: input.tavilyApiKey ?? null,
        perplexityApiKey: input.perplexityApiKey ?? null,
        geminiApiKey: input.geminiApiKey ?? null,
        updatedAt: "2026-05-01T00:00:01.000Z",
      },
      providers: [
        { id: "multi", label: "Auto", requiresBaseUrl: false, requiresApiKey: false },
        { id: "duckduckgo-html", label: "DuckDuckGo HTML", requiresBaseUrl: false, requiresApiKey: false },
        { id: "searxng", label: "SearXNG", requiresBaseUrl: true, requiresApiKey: false },
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
        braveApiKey: null,
        tavilyApiKey: null,
        perplexityApiKey: null,
        geminiApiKey: null,
        query: "OpenAI Agents SDK",
      });
    });
    expect(await screen.findByText(/2 个结果/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(onUpdateWebSearchSettings).toHaveBeenCalledWith({
        provider: "searxng",
        searxngBaseUrl: "https://search.example.com",
        braveApiKey: null,
        tavilyApiKey: null,
        perplexityApiKey: null,
        geminiApiKey: null,
      });
    });
  });
});
