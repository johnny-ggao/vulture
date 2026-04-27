import { describe, expect, test } from "bun:test";
import { fetchCodexToken, makeCodexResponsesFetch, type CodexShellResponse } from "./codexLlm";

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

function completedOutputFromSse(text: string): unknown[] {
  const completedBlock = text
    .split("\n\n")
    .find((block) => block.includes("response.completed"));
  expect(completedBlock).toBeDefined();
  const data = completedBlock
    ?.split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  expect(data).toBeDefined();
  const parsed = JSON.parse(data ?? "{}") as { response?: { output?: unknown[] } };
  return parsed.response?.output ?? [];
}

function fakeSseFetch(body: string): typeof fetch {
  return (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(body, { status: 200 })) as typeof fetch;
}

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

describe("makeCodexResponsesFetch", () => {
  test("injects buffered output items into empty response.completed output", async () => {
    const item = {
      id: "msg-1",
      type: "message",
      content: [{ type: "output_text", text: "hello" }],
    };
    const body = [
      `event: response.output_item.done`,
      `data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
      "",
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}`,
      "",
      "",
    ].join("\n");
    const wrapped = makeCodexResponsesFetch(fakeSseFetch(body));

    const text = await (await wrapped("https://chatgpt.com/backend-api/codex/responses")).text();

    expect(text).toContain(`"output":[${JSON.stringify(item)}]`);
  });

  test("injects output when terminal response.completed has no trailing delimiter", async () => {
    const item = {
      id: "msg-1",
      type: "message",
      content: [{ type: "output_text", text: "hello" }],
    };
    const body = [
      `event: response.output_item.done`,
      `data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
      "",
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}`,
    ].join("\n");
    const wrapped = makeCodexResponsesFetch(fakeSseFetch(body));

    const text = await (await wrapped("https://chatgpt.com/backend-api/codex/responses")).text();

    expect(text).toContain(`"output":[${JSON.stringify(item)}]`);
  });

  test("skips reasoning items when injecting completed output", async () => {
    const messageItem = {
      id: "msg-1",
      type: "message",
      content: [{ type: "output_text", text: "hello" }],
    };
    const reasoningItem = { id: "rs-1", type: "reasoning", encrypted_content: "opaque" };
    const body = [
      `event: response.output_item.done`,
      `data: ${JSON.stringify({ type: "response.output_item.done", item: reasoningItem })}`,
      "",
      `event: response.output_item.done`,
      `data: ${JSON.stringify({ type: "response.output_item.done", item: messageItem })}`,
      "",
      `event: response.completed`,
      `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}`,
      "",
      "",
    ].join("\n");
    const wrapped = makeCodexResponsesFetch(fakeSseFetch(body));

    const text = await (await wrapped("https://chatgpt.com/backend-api/codex/responses")).text();

    expect(completedOutputFromSse(text)).toEqual([messageItem]);
  });
});
