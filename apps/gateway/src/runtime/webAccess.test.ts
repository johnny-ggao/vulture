import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@vulture/agent-runtime";
import {
  BingHtmlSearchProvider,
  BraveHtmlSearchProvider,
  createFallbackSearchProvider,
  createWebAccessService,
  DuckDuckGoHtmlSearchProvider,
  SearxngSearchProvider,
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
