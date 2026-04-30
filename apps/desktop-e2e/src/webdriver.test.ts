import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { WebDriverClient } from "./webdriver";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

interface RecordedRequest {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | undefined>;
}

interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const serversToClose: Server[] = [];

afterEach(async () => {
  while (serversToClose.length > 0) {
    const server = serversToClose.pop();
    if (server) {
      await closeServer(server);
    }
  }
});

describe("WebDriverClient", () => {
  test("supports W3C session responses and sends WebDriver request payloads", async () => {
    const requests: RecordedRequest[] = [];
    const { baseUrl } = await startMockServer(async (req) => {
      requests.push(req);

      switch (req.path) {
        case "/session":
          return {
            body: {
              value: {
                sessionId: "session-123",
                capabilities: { browserName: "desktop" },
              },
            },
          };
        case "/session/session-123/element":
          return {
            body: {
              value: {
                [ELEMENT_KEY]: "element-456",
              },
            },
          };
        case "/session/session-123/element/element-456/click":
          return { body: { value: null } };
        case "/session/session-123/element/element-456/value":
          return { body: { value: null } };
        case "/session/session-123/source":
          return { body: { value: "<main>ready</main>" } };
        case "/session/session-123/screenshot":
          return { body: { value: Buffer.from("png-bytes").toString("base64") } };
        default:
          if (req.method === "DELETE" && req.path === "/session/session-123") {
            return { body: { value: null } };
          }
          return { status: 404, body: { value: { message: `unexpected ${req.method} ${req.path}` } } };
      }
    });

    const client = new WebDriverClient(baseUrl);

    await expect(client.createSession()).resolves.toBe("session-123");
    await expect(client.findElement("css selector", "#chat-input")).resolves.toBe("element-456");
    await expect(client.click("element-456")).resolves.toBeUndefined();
    await expect(client.type("element-456", "hello")).resolves.toBeUndefined();
    await expect(client.pageSource()).resolves.toBe("<main>ready</main>");
    await expect(client.screenshot()).resolves.toEqual(Buffer.from("png-bytes"));
    await expect(client.deleteSession()).resolves.toBeUndefined();
    await expect(client.deleteSession()).resolves.toBeUndefined();

    expect(requests).toEqual([
      {
        method: "POST",
        path: "/session",
        body: JSON.stringify({
          capabilities: {
            alwaysMatch: {},
            firstMatch: [{}],
          },
        }),
        headers: {
          "content-type": "application/json",
        },
      },
      {
        method: "POST",
        path: "/session/session-123/element",
        body: JSON.stringify({
          using: "css selector",
          value: "#chat-input",
        }),
        headers: {
          "content-type": "application/json",
        },
      },
      {
        method: "POST",
        path: "/session/session-123/element/element-456/click",
        body: JSON.stringify({}),
        headers: {
          "content-type": "application/json",
        },
      },
      {
        method: "POST",
        path: "/session/session-123/element/element-456/value",
        body: JSON.stringify({
          text: "hello",
          value: ["h", "e", "l", "l", "o"],
        }),
        headers: {
          "content-type": "application/json",
        },
      },
      {
        method: "GET",
        path: "/session/session-123/source",
        body: "",
        headers: {
          "content-type": undefined,
        },
      },
      {
        method: "GET",
        path: "/session/session-123/screenshot",
        body: "",
        headers: {
          "content-type": undefined,
        },
      },
      {
        method: "DELETE",
        path: "/session/session-123",
        body: "",
        headers: {
          "content-type": undefined,
        },
      },
    ]);
  });

  test("supports JSON Wire session responses, legacy element ids, and encoded path segments", async () => {
    const requests: RecordedRequest[] = [];
    const sessionId = "session/with spaces?#";
    const elementId = "legacy element/#?";
    const encodedSessionId = encodeURIComponent(sessionId);
    const encodedElementId = encodeURIComponent(elementId);

    const { baseUrl } = await startMockServer(async (req) => {
      requests.push(req);

      switch (req.path) {
        case "/session":
          return {
            body: {
              sessionId,
              status: 0,
              value: {
                browserName: "desktop",
              },
            },
          };
        case `/session/${encodedSessionId}/element`:
          return {
            body: {
              value: {
                ELEMENT: elementId,
              },
            },
          };
        case `/session/${encodedSessionId}/element/${encodedElementId}/click`:
          return { body: { value: null } };
        default:
          if (req.method === "DELETE" && req.path === `/session/${encodedSessionId}`) {
            return { body: { value: null } };
          }
          return { status: 404, body: { value: { message: `unexpected ${req.method} ${req.path}` } } };
      }
    });

    const client = new WebDriverClient(baseUrl);

    await expect(client.createSession()).resolves.toBe(sessionId);
    await expect(client.findElement("accessibility id", "Send")).resolves.toBe(elementId);
    await expect(client.click(elementId)).resolves.toBeUndefined();
    await expect(client.deleteSession()).resolves.toBeUndefined();

    expect(requests.map((request) => request.path)).toEqual([
      "/session",
      `/session/${encodedSessionId}/element`,
      `/session/${encodedSessionId}/element/${encodedElementId}/click`,
      `/session/${encodedSessionId}`,
    ]);
  });

  test("rejects session commands before a session is created", async () => {
    const client = new WebDriverClient("http://127.0.0.1:4444");

    await expect(client.findElement("css selector", "#missing")).rejects.toThrow(
      "WebDriver session has not been created. Call createSession() first.",
    );
    await expect(client.pageSource()).rejects.toThrow(
      "WebDriver session has not been created. Call createSession() first.",
    );
  });

  test("surfaces WebDriver HTTP error payload messages", async () => {
    const { baseUrl } = await startMockServer(async (req) => {
      if (req.path === "/session") {
        return {
          body: {
            value: {
              sessionId: "session-123",
              capabilities: {},
            },
          },
        };
      }

      return {
        status: 404,
        body: {
          value: {
            message: "no such element",
          },
        },
      };
    });

    const client = new WebDriverClient(baseUrl);
    await client.createSession();

    await expect(client.findElement("css selector", "#does-not-exist")).rejects.toThrow("no such element");
  });

  test("falls back to HTTP status when an error payload has no message", async () => {
    const { baseUrl } = await startMockServer(async () => ({
      status: 502,
      body: {
        value: {},
      },
    }));

    const client = new WebDriverClient(baseUrl);

    await expect(client.createSession()).rejects.toThrow("HTTP 502");
  });
});

async function startMockServer(
  handler: (request: RecordedRequest) => MockResponse | Promise<MockResponse>,
): Promise<{ baseUrl: string }> {
  const server = createServer(async (request, response) => {
    const recorded = await recordRequest(request);
    const mockResponse = await handler(recorded);
    writeJson(response, mockResponse);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  serversToClose.push(server);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected mock server to listen on a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function recordRequest(request: IncomingMessage): Promise<RecordedRequest> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    method: request.method ?? "GET",
    path: request.url ?? "/",
    body: Buffer.concat(chunks).toString("utf8"),
    headers: {
      "content-type": request.headers["content-type"],
    },
  };
}

function writeJson(response: ServerResponse, mockResponse: MockResponse): void {
  const body = JSON.stringify(mockResponse.body ?? { value: null });
  response.writeHead(mockResponse.status ?? 200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body).toString(),
    ...mockResponse.headers,
  });
  response.end(body);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
