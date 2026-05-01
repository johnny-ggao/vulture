import { describe, expect, test } from "bun:test";
import type { ApiClient } from "./client";
import { runLogsApi, type RunLogsListResponse, type RunTraceResponse } from "./runLogs";

function fakeClient(handlers: Partial<ApiClient>): ApiClient {
  return {
    get: handlers.get ?? (async () => ({} as never)),
    post: handlers.post ?? (async () => ({} as never)),
    postForm: handlers.postForm ?? (async () => ({} as never)),
    put: handlers.put ?? (async () => ({} as never)),
    patch: handlers.patch ?? (async () => ({} as never)),
    delete: handlers.delete ?? (async () => undefined),
  } as ApiClient;
}

describe("runLogsApi", () => {
  test("lists run log summaries with query params", async () => {
    const expected: RunLogsListResponse = { items: [], nextOffset: null };
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/run-logs?status=failed&agentId=local-work-agent&limit=25&offset=50");
        return expected as T;
      },
    });
    expect(
      await runLogsApi.list(client, {
        status: "failed",
        agentId: "local-work-agent",
        limit: 25,
        offset: 50,
      }),
    ).toEqual(expected);
  });

  test("loads trace details by run id", async () => {
    const expected = { events: [] } as unknown as RunTraceResponse;
    const client = fakeClient({
      get: async <T>(path: string) => {
        expect(path).toBe("/v1/runs/r-1/trace");
        return expected as T;
      },
    });
    expect(await runLogsApi.trace(client, "r-1")).toBe(expected);
  });
});
