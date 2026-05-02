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

  test("dispatches navigate, wait, and screenshot requests", async () => {
    const messages = [];
    const updates = [];
    const captures = [];
    globalThis.chrome = {
      runtime: { getManifest: () => ({ version: "0.1.0" }) },
      tabs: {
        query: async () => [{ id: 9, active: true }],
        update: async (tabId, input) => {
          updates.push({ tabId, input });
          return { id: tabId, title: "Example", url: input.url, active: true };
        },
        sendMessage: async (tabId, message) => {
          messages.push({ tabId, message });
          return { ok: true, type: message.type, selector: message.selector ?? null };
        },
        captureVisibleTab: async (_windowId, options) => {
          captures.push(options);
          return "data:image/png;base64,abc";
        },
      },
    };

    await expect(
      executeBrowserRequest({
        tool: "browser.navigate",
        input: { url: "https://example.com" },
      }),
    ).resolves.toMatchObject({ navigated: true, tabId: 9, url: "https://example.com" });
    await expect(
      executeBrowserRequest({
        tool: "browser.wait",
        input: { selector: "main", timeoutMs: 1000 },
      }),
    ).resolves.toEqual({ ok: true, type: "wait", selector: "main" });
    await expect(
      executeBrowserRequest({
        tool: "browser.screenshot",
        input: { fullPage: false },
      }),
    ).resolves.toMatchObject({
      image: "data:image/png;base64,abc",
      mimeType: "image/png",
      tabId: 9,
    });

    expect(updates).toEqual([
      { tabId: 9, input: { url: "https://example.com" } },
    ]);
    expect(messages).toEqual([
      { tabId: 9, message: { type: "wait", selector: "main", timeoutMs: 1000 } },
    ]);
    expect(captures).toEqual([{ format: "png" }]);
  });
});
