import { describe, expect, test } from "bun:test";
import { fetchCodexToken, type CodexShellResponse } from "./codexLlm";

function fakeShellFetch(seq: Array<{ status: number; body: unknown }>): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; method: string }>;
} {
  let i = 0;
  const calls: Array<{ url: string; method: string }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? "GET" });
    const r = seq[i++] ?? seq[seq.length - 1];
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const validToken: CodexShellResponse = {
  accessToken: "tok-abc",
  accountId: "acc-1",
  expiresAt: Date.now() + 3_600_000,
  email: "user@example.com",
};

describe("fetchCodexToken", () => {
  test("returns token on 200", async () => {
    const { fetchFn } = fakeShellFetch([{ status: 200, body: validToken }]);
    const result = await fetchCodexToken({
      shellUrl: "http://shell:4199",
      bearer: "tok",
      fetch: fetchFn,
    });
    expect(result).toEqual(validToken);
  });

  test("triggers refresh on 401, retries", async () => {
    const { fetchFn, calls } = fakeShellFetch([
      { status: 401, body: { code: "auth.codex_expired" } },
      { status: 200, body: validToken }, // refresh response
      { status: 200, body: validToken }, // re-fetch after refresh
    ]);
    const result = await fetchCodexToken({
      shellUrl: "http://shell:4199",
      bearer: "tok",
      fetch: fetchFn,
    });
    expect(result).toEqual(validToken);
    expect(calls.length).toBe(3);
    expect(calls[1].url).toContain("/auth/codex/refresh");
    expect(calls[1].method).toBe("POST");
  });

  test("throws on 404 (not signed in)", async () => {
    const { fetchFn } = fakeShellFetch([{ status: 404, body: { code: "auth.codex_not_signed_in" } }]);
    await expect(
      fetchCodexToken({ shellUrl: "http://shell:4199", bearer: "tok", fetch: fetchFn }),
    ).rejects.toMatchObject({ code: "auth.codex_not_signed_in" });
  });

  test("throws on second 401 after refresh", async () => {
    const { fetchFn } = fakeShellFetch([
      { status: 401, body: { code: "auth.codex_expired" } },
      { status: 401, body: { code: "auth.codex_expired" } },
    ]);
    await expect(
      fetchCodexToken({ shellUrl: "http://shell:4199", bearer: "tok", fetch: fetchFn }),
    ).rejects.toMatchObject({ code: "auth.codex_expired" });
  });
});
