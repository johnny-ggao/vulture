import { describe, expect, test } from "bun:test";

function installPopupGlobals() {
  const elements = new Map();
  globalThis.document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, {
          value: "",
          textContent: "",
          className: "",
          dataset: {},
          style: {},
          hidden: false,
          open: false,
          addEventListener() {},
          appendChild() {},
          append() {},
        });
      }
      return elements.get(selector);
    },
    createElement() {
      return {
        type: "",
        className: "",
        textContent: "",
        title: "",
        dataset: {},
        style: {},
        addEventListener() {},
        setAttribute() {},
        append() {},
        appendChild() {},
      };
    },
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
      },
    },
    runtime: {
      sendMessage: async () => ({ ok: true }),
    },
  };
}

describe("popup status formatting", () => {
  test("formats pair and tab state as readable UI copy", async () => {
    installPopupGlobals();
    const { formatPairingStatus, formatTabsSummary } = await import("./popup.js");

    expect(formatPairingStatus({ configured: false })).toEqual({
      tone: "idle",
      label: "未配置",
      detail: "从 Vulture 设置页复制端口和配对令牌。",
    });
    expect(formatPairingStatus({ configured: true, paired: true })).toEqual({
      tone: "connected",
      label: "已连接",
      detail: "浏览器工具可以使用当前 Chrome 页面。",
    });
    expect(formatTabsSummary({
      method: "Browser.tabs",
      params: {
        tabs: [
          { id: 1, title: "Docs", url: "https://example.com/docs", active: true },
          { id: 2, title: "Inbox", url: "https://mail.example.com", active: false },
        ],
      },
    })).toEqual({
      count: "2 个标签页",
      active: "Docs · https://example.com/docs",
      tabs: [
        { id: 1, windowId: 0, title: "Docs", url: "https://example.com/docs", active: true },
        { id: 2, windowId: 0, title: "Inbox", url: "https://mail.example.com", active: false },
      ],
    });
    expect(formatTabsSummary(null)).toEqual({
      count: "0 个标签页",
      active: "连接后显示当前 Chrome 页面。",
      tabs: [],
    });
  });
});
