import { describe, expect, test } from "bun:test";
import {
  createBrowserTools,
  requestBrowserClick,
  requestBrowserSnapshot,
  type ToolGateway,
} from "./tools";

describe("browser tool adapters", () => {
  test("requestBrowserSnapshot forwards to the gateway", async () => {
    const requests: unknown[] = [];
    const result = { html: "<button>Save</button>" };
    const gateway: ToolGateway = {
      request: async (toolName, input) => {
        requests.push({ toolName, input });
        return result;
      },
    };

    await expect(requestBrowserSnapshot(gateway, { tabId: 1 })).resolves.toBe(result);
    expect(requests).toEqual([{ toolName: "browser.snapshot", input: { tabId: 1 } }]);
  });

  test("createBrowserTools exposes snapshot and click tool names", () => {
    const gateway: ToolGateway = {
      request: async () => ({ ok: true }),
    };

    const browserTools = createBrowserTools(gateway);

    expect(browserTools.snapshot.name).toBe("browser_snapshot");
    expect(browserTools.click.name).toBe("browser_click");
  });

  test("requestBrowserClick validates input and forwards to the gateway", async () => {
    const requests: unknown[] = [];
    const result = { clicked: true };
    const gateway: ToolGateway = {
      request: async (toolName, input) => {
        requests.push({ toolName, input });
        return result;
      },
    };

    await expect(requestBrowserClick(gateway, { tabId: 1, selector: "#save" })).resolves.toBe(
      result,
    );
    await expect(requestBrowserClick(gateway, { tabId: -1, selector: "" })).rejects.toThrow();

    expect(requests).toEqual([
      { toolName: "browser.click", input: { tabId: 1, selector: "#save" } },
    ]);
  });
});
