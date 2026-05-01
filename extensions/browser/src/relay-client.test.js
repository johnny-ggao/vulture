import { describe, expect, test } from "bun:test";
import { executeBrowserRequest } from "./relay-client.js";

describe("executeBrowserRequest", () => {
  test("dispatches input, scroll, and extract requests to the active tab", async () => {
    const messages = [];
    globalThis.chrome = {
      runtime: { getManifest: () => ({ version: "0.1.0" }) },
      tabs: {
        query: async () => [{ id: 7, active: true }],
        sendMessage: async (tabId, message) => {
          messages.push({ tabId, message });
          return { ok: true, type: message.type };
        },
      },
    };

    await expect(
      executeBrowserRequest({
        tool: "browser.input",
        input: { selector: "input[name=q]", text: "hello", submit: false },
      }),
    ).resolves.toEqual({ ok: true, type: "input" });
    await expect(
      executeBrowserRequest({
        tool: "browser.scroll",
        input: { selector: null, deltaY: 500 },
      }),
    ).resolves.toEqual({ ok: true, type: "scroll" });
    await expect(
      executeBrowserRequest({
        tool: "browser.extract",
        input: { maxTextChars: 1000, maxLinks: 5 },
      }),
    ).resolves.toEqual({ ok: true, type: "extract" });

    expect(messages).toEqual([
      {
        tabId: 7,
        message: { type: "input", selector: "input[name=q]", text: "hello", submit: false },
      },
      {
        tabId: 7,
        message: { type: "scroll", selector: null, deltaY: 500 },
      },
      {
        tabId: 7,
        message: { type: "extract", maxTextChars: 1000, maxLinks: 5 },
      },
    ]);
  });
});
