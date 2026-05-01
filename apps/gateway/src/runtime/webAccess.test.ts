import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@vulture/agent-runtime";
import { createWebAccessService } from "./webAccess";

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
