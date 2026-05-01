import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@vulture/agent-runtime";
import { createWebAccessService, SearxngSearchProvider } from "./webAccess";

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

  test("extracts structured text and links from public html", async () => {
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
                  <p>Build useful agents.</p>
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

    await expect(
      service.extract({ url: "https://example.com/start", maxBytes: 1_000, maxLinks: 5 }),
    ).resolves.toEqual({
      url: "https://example.com/start",
      status: 200,
      contentType: "text/html; charset=utf-8",
      title: "Example & Docs",
      description: "Agent documentation",
      text: "Navigation Agents SDK Build useful agents. Docs Blog",
      links: [
        { text: "Docs", url: "https://example.com/docs" },
        { text: "Blog", url: "https://example.org/blog" },
      ],
      truncated: false,
    });
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
