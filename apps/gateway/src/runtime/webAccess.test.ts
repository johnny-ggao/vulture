import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@vulture/agent-runtime";
import {
  BingHtmlSearchProvider,
  BraveHtmlSearchProvider,
  BraveSearchApiProvider,
  createFallbackSearchProvider,
  createWebAccessService,
  DuckDuckGoHtmlSearchProvider,
  GeminiSearchProvider,
  PerplexitySearchProvider,
  searchProviderFromSettings,
  SearxngSearchProvider,
  TavilySearchProvider,
  type SearchProvider,
} from "./webAccess";

describe("WebAccessService", () => {
  test("classifies public, private, invalid, and non-http urls", () => {
    const service = createWebAccessService({
      fetch: async () => new Response(""),
    });

    expect(service.classifyUrl("https://example.com/path")).toMatchObject({
      ok: true,
      url: "https://example.com/path",
      isPrivate: false,
    });
    expect(service.classifyUrl("http://localhost:3000")).toMatchObject({
      ok: true,
      isPrivate: true,
    });
    expect(service.classifyUrl("file:///etc/hosts")).toMatchObject({
      ok: false,
      code: "tool.permission_denied",
    });
    expect(service.classifyUrl("not a url")).toMatchObject({
      ok: false,
      code: "tool.execution_failed",
    });
  });

  test("searches through the configured provider and applies the result limit", async () => {
    const requested: string[] = [];
    const service = createWebAccessService({
      fetch: async (url) => {
        requested.push(String(url));
        return new Response(
          [
            '<a class="result__a" href="https://example.com/a">Example &amp; A</a>',
            '<a class="result__a" href="https://example.com/b">Example B</a>',
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/html" } },
        );
      },
    });

    await expect(service.search({ query: "agent search", limit: 1 })).resolves.toEqual({
      query: "agent search",
      provider: "duckduckgo-html",
      results: [{ title: "Example & A", url: "https://example.com/a" }],
    });
    expect(requested[0]).toContain("duckduckgo.com/html/");
    expect(requested[0]).toContain("agent%20search");
  });

  test("normalizes DuckDuckGo redirect result urls", async () => {
    const service = createWebAccessService({
      fetch: async () =>
        new Response(
          '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Factual%3Fa%3D1%26b%3D2">Redirected</a>',
          { status: 200, headers: { "content-type": "text/html" } },
        ),
    });

    await expect(service.search({ query: "redirect", limit: 5 })).resolves.toMatchObject({
      results: [{ title: "Redirected", url: "https://example.com/actual?a=1&b=2" }],
    });
  });

  test("searches SearXNG JSON results", async () => {
    const provider = new SearxngSearchProvider({
      baseUrl: "https://search.example.com/",
      fetch: async (url) => {
        const requested = new URL(String(url));
        expect(requested.origin).toBe("https://search.example.com");
        expect(requested.pathname).toBe("/search");
        expect(requested.searchParams.get("q")).toBe("agent search");
        expect(requested.searchParams.get("format")).toBe("json");
        return Response.json({
          results: [
            {
              title: "Agents",
              url: "https://example.com/agents",
              content: "SDK docs",
            },
            {
              title: "Ignored",
              url: "",
            },
          ],
        });
      },
    });

    await expect(provider.search({ query: "agent search", limit: 5 })).resolves.toEqual({
      query: "agent search",
      provider: "searxng",
      results: [{ title: "Agents", url: "https://example.com/agents", snippet: "SDK docs" }],
    });
  });

  test("resolves the configured search provider for each search call", async () => {
    let useSearxng = false;
    const service = createWebAccessService({
      fetch: async (url) => {
        if (String(url).includes("search.example.com")) {
          return Response.json({
            results: [{ title: "SearXNG Result", url: "https://example.com/searxng" }],
          });
        }
        return new Response(
          '<a class="result__a" href="https://example.com/ddg">Duck Result</a>',
          { status: 200, headers: { "content-type": "text/html" } },
        );
      },
      resolveSearchProvider: ({ fetch }) =>
        useSearxng
          ? new SearxngSearchProvider({ baseUrl: "https://search.example.com", fetch })
          : null,
    });

    await expect(service.search({ query: "x", limit: 1 })).resolves.toMatchObject({
      provider: "duckduckgo-html",
      results: [{ title: "Duck Result" }],
    });
    useSearxng = true;
    await expect(service.search({ query: "x", limit: 1 })).resolves.toMatchObject({
      provider: "searxng",
      results: [{ title: "SearXNG Result" }],
    });
  });

  test("Bing provider parses b_algo result blocks and extracts snippets", async () => {
    const requested: string[] = [];
    const provider = new BingHtmlSearchProvider(async (url) => {
      requested.push(String(url));
      return new Response(
        `
          <li class="b_algo">
            <h2><a href="https://example.com/a">Result &amp; A</a></h2>
            <div class="b_caption"><p>First snippet text</p></div>
          </li>
          <li class="b_algo">
            <h2><a href="https://example.com/b">Result B</a></h2>
            <p>Second snippet</p>
          </li>
        `,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });

    await expect(provider.search({ query: "vulture agent", limit: 5 })).resolves.toEqual({
      query: "vulture agent",
      provider: "bing-html",
      results: [
        { title: "Result & A", url: "https://example.com/a", snippet: "First snippet text" },
        { title: "Result B", url: "https://example.com/b", snippet: "Second snippet" },
      ],
    });
    expect(requested[0]).toContain("bing.com/search");
    expect(requested[0]).toContain("vulture+agent");
  });

  test("Brave provider parses snippet blocks and decodes title text", async () => {
    const requested: string[] = [];
    const provider = new BraveHtmlSearchProvider(async (url) => {
      requested.push(String(url));
      return new Response(
        `
          <div class="snippet" data-type="web">
            <a class="heading-serpresult" href="https://example.com/x">
              <div class="title">Brave &amp; Result X</div>
            </a>
            <div class="snippet-description">Brave snippet text</div>
          </div>
          <div class="snippet" data-type="web">
            <a href="https://example.com/y"><span class="title">Result Y</span></a>
            <div class="snippet-description">Y snippet</div>
          </div>
        `,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });

    await expect(provider.search({ query: "agent runtime", limit: 5 })).resolves.toEqual({
      query: "agent runtime",
      provider: "brave-html",
      results: [
        {
          title: "Brave & Result X",
          url: "https://example.com/x",
          snippet: "Brave snippet text",
        },
        { title: "Result Y", url: "https://example.com/y", snippet: "Y snippet" },
      ],
    });
    expect(requested[0]).toContain("search.brave.com/search");
    expect(requested[0]).toContain("agent+runtime");
  });

  test("fallback provider tries each provider until one returns results", async () => {
    const calls: string[] = [];
    const failing: SearchProvider = {
      id: "failing",
      search: async () => {
        calls.push("failing");
        throw new Error("upstream blocked");
      },
    };
    const empty: SearchProvider = {
      id: "empty",
      search: async () => {
        calls.push("empty");
        return { query: "x", provider: "empty", results: [] };
      },
    };
    const succeed: SearchProvider = {
      id: "succeed",
      search: async () => {
        calls.push("succeed");
        return {
          query: "x",
          provider: "succeed",
          results: [{ title: "Hit", url: "https://example.com/hit" }],
        };
      },
    };
    const provider = createFallbackSearchProvider([failing, empty, succeed]);

    await expect(provider.search({ query: "x", limit: 5 })).resolves.toEqual({
      query: "x",
      provider: "succeed",
      results: [{ title: "Hit", url: "https://example.com/hit" }],
    });
    expect(calls).toEqual(["failing", "empty", "succeed"]);
  });

  test("fallback provider raises when all providers fail or are empty", async () => {
    const provider = createFallbackSearchProvider([
      {
        id: "a",
        search: async () => {
          throw new Error("a failed");
        },
      },
      {
        id: "b",
        search: async () => ({ query: "x", provider: "b", results: [] }),
      },
    ]);

    await expect(provider.search({ query: "x" })).rejects.toMatchObject({
      code: "tool.execution_failed",
    });
  });

  test("Brave API provider sends subscription token and parses web.results payload", async () => {
    const requested: { url: string; headers: Record<string, string> }[] = [];
    const provider = new BraveSearchApiProvider({
      apiKey: "br-secret",
      fetch: async (url, init) => {
        requested.push({
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return Response.json({
          web: {
            results: [
              {
                title: "Brave API Hit",
                url: "https://example.com/api",
                description: "API snippet",
              },
              { title: "", url: "https://drop.example.com" },
            ],
          },
        });
      },
    });

    await expect(provider.search({ query: "agent search", limit: 3 })).resolves.toEqual({
      query: "agent search",
      provider: "brave-api",
      results: [
        { title: "Brave API Hit", url: "https://example.com/api", snippet: "API snippet" },
      ],
    });
    expect(requested[0].url).toContain("api.search.brave.com/res/v1/web/search");
    expect(requested[0].url).toContain("count=3");
    expect(requested[0].url).toContain("text_decorations=false");
    expect(requested[0].headers["x-subscription-token"]).toBe("br-secret");
  });

  test("Brave API provider rejects missing key and surfaces non-2xx as a tool error", async () => {
    expect(() => new BraveSearchApiProvider({ apiKey: "  ", fetch: async () => new Response() }))
      .toThrow("Brave Search API key is required");

    const provider = new BraveSearchApiProvider({
      apiKey: "br-secret",
      fetch: async () => new Response("rate limited", { status: 429 }),
    });
    await expect(provider.search({ query: "x" })).rejects.toMatchObject({
      code: "tool.execution_failed",
      message: "Brave Search API returned 429",
    });
  });

  test("Tavily provider POSTs Bearer auth and surfaces snippet from content field", async () => {
    const requested: { url: string; init?: RequestInit }[] = [];
    const provider = new TavilySearchProvider({
      apiKey: "tvly-secret",
      fetch: async (url, init) => {
        requested.push({ url: String(url), init });
        return Response.json({
          results: [
            {
              title: "Tavily Hit",
              url: "https://example.com/t",
              content: "Tavily snippet text",
            },
          ],
        });
      },
    });

    await expect(provider.search({ query: "agents", limit: 5 })).resolves.toEqual({
      query: "agents",
      provider: "tavily-api",
      results: [
        { title: "Tavily Hit", url: "https://example.com/t", snippet: "Tavily snippet text" },
      ],
    });
    expect(requested[0].url).toBe("https://api.tavily.com/search");
    expect(requested[0].init?.method).toBe("POST");
    const headers = new Headers(requested[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tvly-secret");
    const body = JSON.parse(String(requested[0].init?.body ?? "{}"));
    expect(body).toMatchObject({
      query: "agents",
      max_results: 5,
      include_raw_content: false,
      search_depth: "basic",
    });
  });

  test("Tavily provider asks for raw_content when withContent>0 and exposes it as content", async () => {
    let capturedBody: Record<string, unknown> = {};
    const provider = new TavilySearchProvider({
      apiKey: "tvly-secret",
      fetch: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({
          results: [
            {
              title: "Tavily Hit",
              url: "https://example.com/t",
              content: "snippet",
              raw_content: "Full readable body of the page.",
            },
          ],
        });
      },
    });

    const result = await provider.search({ query: "x", withContent: 1 });
    expect(capturedBody).toMatchObject({
      include_raw_content: true,
      search_depth: "advanced",
    });
    expect(result.results[0]).toEqual({
      title: "Tavily Hit",
      url: "https://example.com/t",
      snippet: "snippet",
      content: "Full readable body of the page.",
    });
  });

  test("Tavily provider rejects missing key and surfaces non-2xx as a tool error", async () => {
    expect(() => new TavilySearchProvider({ apiKey: " ", fetch: async () => new Response() }))
      .toThrow("Tavily API key is required");

    const provider = new TavilySearchProvider({
      apiKey: "tvly-secret",
      fetch: async () => new Response("limited", { status: 429 }),
    });
    await expect(provider.search({ query: "x" })).rejects.toMatchObject({
      code: "tool.execution_failed",
      message: "Tavily API returned 429",
    });
  });

  test("Perplexity provider exposes synthesized answer + structured search results", async () => {
    const requested: { url: string; init?: RequestInit }[] = [];
    const provider = new PerplexitySearchProvider({
      apiKey: "pplx-secret",
      fetch: async (url, init) => {
        requested.push({ url: String(url), init });
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Vulture is a local-first AI agent platform.",
              },
            },
          ],
          search_results: [
            {
              title: "Vulture readme",
              url: "https://example.com/readme",
              snippet: "Local-first agent platform",
            },
          ],
          citations: ["https://example.com/readme"],
        });
      },
    });

    const result = await provider.search({ query: "what is vulture", limit: 5 });
    expect(result.provider).toBe("perplexity-api");
    expect(result.answer).toBe("Vulture is a local-first AI agent platform.");
    expect(result.results).toEqual([
      {
        title: "Vulture readme",
        url: "https://example.com/readme",
        snippet: "Local-first agent platform",
      },
    ]);
    expect(requested[0].url).toBe("https://api.perplexity.ai/chat/completions");
    expect(requested[0].init?.method).toBe("POST");
    const headers = new Headers(requested[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer pplx-secret");
    const body = JSON.parse(String(requested[0].init?.body ?? "{}"));
    expect(body.model).toBe("sonar");
    expect(body.messages?.[0]?.content).toBe("what is vulture");
  });

  test("Perplexity provider falls back to citations when search_results missing", async () => {
    const provider = new PerplexitySearchProvider({
      apiKey: "pplx-secret",
      fetch: async () =>
        Response.json({
          choices: [{ message: { role: "assistant", content: "Answer text" } }],
          citations: ["https://example.com/a", "https://example.com/b"],
        }),
    });

    const result = await provider.search({ query: "x" });
    expect(result.answer).toBe("Answer text");
    expect(result.results).toEqual([
      { title: "https://example.com/a", url: "https://example.com/a" },
      { title: "https://example.com/b", url: "https://example.com/b" },
    ]);
  });

  test("Perplexity provider rejects missing key and surfaces non-2xx", async () => {
    expect(() => new PerplexitySearchProvider({ apiKey: " ", fetch: async () => new Response() }))
      .toThrow("Perplexity API key is required");

    const provider = new PerplexitySearchProvider({
      apiKey: "pplx-secret",
      fetch: async () => new Response("limited", { status: 429 }),
    });
    await expect(provider.search({ query: "x" })).rejects.toMatchObject({
      code: "tool.execution_failed",
      message: "Perplexity API returned 429",
    });
  });

  test("Gemini provider parses grounding chunks into search results with synthesized answer", async () => {
    const requested: { url: string; init?: RequestInit }[] = [];
    const provider = new GeminiSearchProvider({
      apiKey: "AIzaXYZ",
      fetch: async (url, init) => {
        requested.push({ url: String(url), init });
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  { text: "Bun is " },
                  { text: "a JavaScript runtime." },
                ],
              },
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: "https://bun.sh", title: "Bun" } },
                  { web: { uri: "https://github.com/oven-sh/bun", title: "GitHub" } },
                  // Duplicate URL — should be deduped.
                  { web: { uri: "https://bun.sh", title: "Bun (dup)" } },
                  // Missing uri — should be ignored.
                  { web: { title: "no uri" } },
                ],
              },
            },
          ],
        });
      },
    });

    const result = await provider.search({ query: "what is bun", limit: 5 });
    expect(result.provider).toBe("gemini-search");
    expect(result.answer).toBe("Bun is a JavaScript runtime.");
    expect(result.results).toEqual([
      { title: "Bun", url: "https://bun.sh" },
      { title: "GitHub", url: "https://github.com/oven-sh/bun" },
    ]);
    expect(requested[0].url).toContain(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(requested[0].url).toContain("key=AIzaXYZ");
    const body = JSON.parse(String(requested[0].init?.body ?? "{}"));
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.contents?.[0]?.parts?.[0]?.text).toBe("what is bun");
  });

  test("Gemini provider rejects missing key and surfaces non-2xx", async () => {
    expect(() => new GeminiSearchProvider({ apiKey: "  ", fetch: async () => new Response() }))
      .toThrow("Gemini API key is required");

    const provider = new GeminiSearchProvider({
      apiKey: "AIzaXYZ",
      fetch: async () => new Response("forbidden", { status: 403 }),
    });
    await expect(provider.search({ query: "x" })).rejects.toMatchObject({
      code: "tool.execution_failed",
      message: "Gemini grounding API returned 403",
    });
  });

  test("withContent does not refetch results that already carry provider content", async () => {
    const fetched: string[] = [];
    const tavilyLike: SearchProvider = {
      id: "tavily-api",
      search: async () => ({
        query: "x",
        provider: "tavily-api",
        results: [
          {
            title: "From Tavily",
            url: "https://example.com/t",
            content: "Native Tavily body",
          },
          { title: "No body", url: "https://example.com/extra" },
        ],
      }),
    };
    const service = createWebAccessService({
      fetch: async (url) => {
        fetched.push(String(url));
        return new Response(
          "<html><body><main><p>Page extra body.</p></main></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      },
      searchProvider: tavilyLike,
    });

    const result = await service.search({ query: "x", withContent: 2 });
    expect(result.results[0].content).toBe("Native Tavily body");
    expect(result.results[1].content).toContain("Page extra body");
    // Only the second result should have triggered a fetch.
    expect(fetched).toEqual(["https://example.com/extra"]);
  });

  test("searchProviderFromSettings returns the correct provider per id", () => {
    const fetchImpl = async () => new Response();
    expect(searchProviderFromSettings({ provider: "multi", searxngBaseUrl: null }, fetchImpl)).toBeNull();
    expect(
      searchProviderFromSettings({ provider: "duckduckgo-html", searxngBaseUrl: null }, fetchImpl),
    ).toBeInstanceOf(DuckDuckGoHtmlSearchProvider);
    expect(
      searchProviderFromSettings({ provider: "bing-html", searxngBaseUrl: null }, fetchImpl),
    ).toBeInstanceOf(BingHtmlSearchProvider);
    expect(
      searchProviderFromSettings({ provider: "brave-html", searxngBaseUrl: null }, fetchImpl),
    ).toBeInstanceOf(BraveHtmlSearchProvider);
    expect(
      searchProviderFromSettings(
        { provider: "brave-api", searxngBaseUrl: null, braveApiKey: "abc" },
        fetchImpl,
      ),
    ).toBeInstanceOf(BraveSearchApiProvider);
    // brave-api without a key should refuse to instantiate
    expect(
      searchProviderFromSettings(
        { provider: "brave-api", searxngBaseUrl: null, braveApiKey: null },
        fetchImpl,
      ),
    ).toBeNull();
    expect(
      searchProviderFromSettings(
        { provider: "tavily-api", searxngBaseUrl: null, tavilyApiKey: "tvly" },
        fetchImpl,
      ),
    ).toBeInstanceOf(TavilySearchProvider);
    expect(
      searchProviderFromSettings(
        { provider: "tavily-api", searxngBaseUrl: null, tavilyApiKey: null },
        fetchImpl,
      ),
    ).toBeNull();
    expect(
      searchProviderFromSettings(
        { provider: "perplexity-api", searxngBaseUrl: null, perplexityApiKey: "pplx" },
        fetchImpl,
      ),
    ).toBeInstanceOf(PerplexitySearchProvider);
    expect(
      searchProviderFromSettings(
        { provider: "perplexity-api", searxngBaseUrl: null, perplexityApiKey: null },
        fetchImpl,
      ),
    ).toBeNull();
    expect(
      searchProviderFromSettings(
        { provider: "gemini-search", searxngBaseUrl: null, geminiApiKey: "AIzaXYZ" },
        fetchImpl,
      ),
    ).toBeInstanceOf(GeminiSearchProvider);
    expect(
      searchProviderFromSettings(
        { provider: "gemini-search", searxngBaseUrl: null, geminiApiKey: null },
        fetchImpl,
      ),
    ).toBeNull();
    expect(
      searchProviderFromSettings(
        { provider: "searxng", searxngBaseUrl: "https://search.example.com/" },
        fetchImpl,
      ),
    ).toBeInstanceOf(SearxngSearchProvider);
  });

  test("default WebAccessService uses fallback chain across DDG, Bing, Brave", async () => {
    const requested: string[] = [];
    const service = createWebAccessService({
      fetch: async (url) => {
        requested.push(String(url));
        if (String(url).includes("duckduckgo.com")) {
          // DDG returns no results — force fallback to next provider
          return new Response("<html></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        if (String(url).includes("bing.com")) {
          return new Response(
            '<li class="b_algo"><h2><a href="https://example.com/bing">Bing Hit</a></h2></li>',
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        return new Response("", { status: 200 });
      },
    });

    const result = await service.search({ query: "fallback test", limit: 1 });
    expect(result.provider).toBe("bing-html");
    expect(result.results).toEqual([{ title: "Bing Hit", url: "https://example.com/bing" }]);
    // DDG was tried first, then Bing
    expect(requested[0]).toContain("duckduckgo.com");
    expect(requested[1]).toContain("bing.com");
  });

  test("withContent enriches top-K results with extracted main-content text", async () => {
    const fetched: string[] = [];
    const service = createWebAccessService({
      fetch: async (url) => {
        const href = String(url);
        fetched.push(href);
        if (href.includes("duckduckgo.com")) {
          return new Response(
            [
              '<a class="result__a" href="https://example.com/a">Result A</a>',
              '<a class="result__a" href="https://example.com/b">Result B</a>',
              '<a class="result__a" href="https://example.com/c">Result C</a>',
            ].join("\n"),
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        if (href === "https://example.com/a") {
          return new Response(
            "<html><body><nav>chrome</nav><main><h1>Page A</h1><p>Body of page A.</p></main></body></html>",
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        if (href === "https://example.com/b") {
          return new Response(
            "<html><body><main><p>Body of page B.</p></main></body></html>",
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        return new Response("Page C plain", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    });

    const result = await service.search({ query: "agents", withContent: 2 });
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toMatchObject({
      title: "Result A",
      url: "https://example.com/a",
    });
    expect(result.results[0].content).toContain("Page A");
    expect(result.results[0].content).toContain("Body of page A");
    expect(result.results[0].content).not.toContain("chrome");
    expect(result.results[1].content).toContain("Body of page B");
    // Third result should not be enriched (withContent=2)
    expect(result.results[2].content).toBeUndefined();
    // Must have made the search call plus 2 page fetches, not 3
    expect(fetched.filter((u) => u.startsWith("https://example.com/"))).toHaveLength(2);
  });

  test("withContent silently skips private hosts and fetch failures", async () => {
    const service = createWebAccessService({
      fetch: async (url) => {
        const href = String(url);
        if (href.includes("duckduckgo.com")) {
          return new Response(
            [
              '<a class="result__a" href="http://127.0.0.1:9999/private">Private</a>',
              '<a class="result__a" href="https://example.com/broken">Broken</a>',
              '<a class="result__a" href="https://example.com/ok">OK</a>',
            ].join("\n"),
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        if (href.includes("/broken")) {
          return new Response("server error", { status: 500 });
        }
        if (href.includes("/ok")) {
          return new Response(
            "<html><body><main><p>OK page body.</p></main></body></html>",
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        throw new Error(`unexpected fetch ${href}`);
      },
    });

    const result = await service.search({ query: "x", withContent: 5 });
    expect(result.results[0].content).toBeUndefined(); // private
    expect(result.results[1].content).toBeUndefined(); // 500
    expect(result.results[2].content).toContain("OK page body");
  });

  test("withContent caps each result body at contentMaxBytes", async () => {
    const big = "a".repeat(2000);
    const service = createWebAccessService({
      fetch: async (url) => {
        const href = String(url);
        if (href.includes("duckduckgo.com")) {
          return new Response(
            '<a class="result__a" href="https://example.com/big">Big</a>',
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        return new Response(`<html><body><main><p>${big}</p></main></body></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });

    const result = await service.search({ query: "x", withContent: 1, contentMaxBytes: 100 });
    expect(result.results[0].content?.length).toBe(100);
  });

  test("fetches public urls and truncates content by byte limit", async () => {
    const service = createWebAccessService({
      fetch: async () =>
        new Response("abcdef", {
          status: 203,
          headers: { "content-type": "text/plain" },
        }),
    });

    await expect(service.fetch({ url: "https://example.com/readme.txt", maxBytes: 3 }))
      .resolves.toEqual({
        url: "https://example.com/readme.txt",
        status: 203,
        contentType: "text/plain",
        content: "abc",
        truncated: true,
      });
  });

  test("extracts main-content text and links from public html, dropping nav/script noise", async () => {
    const service = createWebAccessService({
      fetch: async () =>
        new Response(
          `
            <html>
              <head>
                <title>Example &amp; Docs</title>
                <meta name="description" content="Agent documentation">
              </head>
              <body>
                <nav>Navigation</nav>
                <main>
                  <h1>Agents SDK</h1>
                  <p>Build useful agents that ship to production with confidence and care.</p>
                  <p>This guide walks through agent runtime, tools, and recovery patterns.</p>
                  <a href="/docs">Docs</a>
                  <a href="https://example.org/blog">Blog</a>
                </main>
                <script>ignored()</script>
              </body>
            </html>
          `,
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });

    const result = await service.extract({
      url: "https://example.com/start",
      maxBytes: 1_000,
      maxLinks: 5,
    });

    expect(result.url).toBe("https://example.com/start");
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/html; charset=utf-8");
    expect(result.title).toBe("Example & Docs");
    expect(result.description).toBe("Agent documentation");
    expect(result.text).toContain("Agents SDK");
    expect(result.text).toContain("Build useful agents");
    expect(result.text).not.toContain("Navigation");
    expect(result.text).not.toContain("ignored()");
    expect(result.links).toEqual([
      { text: "Docs", url: "https://example.com/docs" },
      { text: "Blog", url: "https://example.org/blog" },
    ]);
    expect(result.truncated).toBe(false);
  });

  test("extracts plain text responses without html metadata", async () => {
    const service = createWebAccessService({
      fetch: async () =>
        new Response("abcdef", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    });

    await expect(service.extract({ url: "https://example.com/readme.txt", maxBytes: 3 }))
      .resolves.toEqual({
        url: "https://example.com/readme.txt",
        status: 200,
        contentType: "text/plain",
        title: null,
        description: null,
        text: "abc",
        links: [],
        truncated: true,
      });
  });

  test("rejects private fetches without approval and allows them with approval", async () => {
    const service = createWebAccessService({
      fetch: async () => new Response("private", { status: 200 }),
    });

    await expect(service.fetch({ url: "http://127.0.0.1:7777" })).rejects.toThrow(
      "web_fetch private host requires approval",
    );
    await expect(
      service.fetch({ url: "http://127.0.0.1:7777", approvalToken: "approved" }),
    ).resolves.toMatchObject({
      url: "http://127.0.0.1:7777/",
      content: "private",
    });
  });

  test("times out slow fetches with a clear tool error", async () => {
    const service = createWebAccessService({
      timeoutMs: 1,
      fetch: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });

    await expect(service.fetch({ url: "https://example.com/slow" })).rejects.toMatchObject({
      code: "tool.execution_failed",
      message: "web_fetch timed out",
    } satisfies Partial<ToolCallError>);
  });
});
