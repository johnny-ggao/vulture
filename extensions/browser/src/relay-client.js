export function buildHello({ protocolVersion, extensionVersion, pairingToken }) {
  return {
    method: "Extension.hello",
    params: {
      protocol_version: protocolVersion,
      extension_version: extensionVersion,
      pairing_token: pairingToken,
    },
  };
}

export async function pairWithRelay({ relayPort, pairingToken }) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/browser/hello`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildHello({
      protocolVersion: 1,
      extensionVersion: chrome.runtime.getManifest().version,
      pairingToken,
    })),
  });
  if (!response.ok) {
    throw new Error(`pairing failed: ${response.status}`);
  }
  return response.json();
}

export async function pollBrowserRequest({ relayPort, pairingToken }) {
  const response = await fetch(
    `http://127.0.0.1:${relayPort}/browser/requests?token=${encodeURIComponent(pairingToken)}`,
  );
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`request poll failed: ${response.status}`);
  return response.json();
}

export async function postBrowserResult({ relayPort, pairingToken, requestId, ok, value }) {
  const response = await fetch(`http://127.0.0.1:${relayPort}/browser/results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: pairingToken,
      requestId,
      ok,
      value,
    }),
  });
  if (!response.ok) {
    throw new Error(`result post failed: ${response.status}`);
  }
  return response.json();
}

export async function postBrowserTabs({ relayPort, pairingToken }) {
  const tabs = await chrome.tabs.query({});
  const response = await fetch(`http://127.0.0.1:${relayPort}/browser/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: pairingToken,
      tabs: tabs.map(normalizeTab),
    }),
  });
  if (!response.ok) {
    throw new Error(`tabs post failed: ${response.status}`);
  }
  return response.json();
}

export function normalizeTab(tab) {
  return {
    id: tab.id ?? 0,
    windowId: tab.windowId ?? 0,
    title: tab.title ?? "",
    url: tab.url ?? "",
    active: Boolean(tab.active),
  };
}

export async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    method: "Browser.tabs",
    params: {
      tabs: tabs.map(normalizeTab),
    },
  };
}

export async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error("no active tab");
  return tab;
}

export async function executeBrowserRequest(request) {
  const tab = await activeTab();
  const tabId = tab.id;
  const tabMeta = {
    tabId,
    title: tab.title ?? "",
    url: tab.url ?? "",
  };
  if (request.tool === "browser.snapshot") {
    return chrome.tabs.sendMessage(tabId, { type: "snapshot" });
  }
  if (request.tool === "browser.click") {
    return chrome.tabs.sendMessage(tabId, {
      type: "click",
      selector: request.input?.selector,
    });
  }
  if (request.tool === "browser.input") {
    return chrome.tabs.sendMessage(tabId, {
      type: "input",
      selector: request.input?.selector,
      text: request.input?.text,
      submit: request.input?.submit ?? false,
    });
  }
  if (request.tool === "browser.scroll") {
    return chrome.tabs.sendMessage(tabId, {
      type: "scroll",
      selector: request.input?.selector ?? null,
      deltaY: request.input?.deltaY ?? 800,
    });
  }
  if (request.tool === "browser.extract") {
    return chrome.tabs.sendMessage(tabId, {
      type: "extract",
      maxTextChars: request.input?.maxTextChars ?? 20000,
      maxLinks: request.input?.maxLinks ?? 50,
    });
  }
  if (request.tool === "browser.navigate") {
    const url = String(request.input?.url ?? "");
    if (!url) throw new Error("browser.navigate missing url");
    const updated = await chrome.tabs.update(tabId, { url });
    return {
      navigated: true,
      tabId,
      title: updated?.title ?? tabMeta.title,
      url: updated?.url ?? url,
    };
  }
  if (request.tool === "browser.wait") {
    return chrome.tabs.sendMessage(tabId, {
      type: "wait",
      selector: request.input?.selector ?? null,
      timeoutMs: request.input?.timeoutMs ?? 5000,
    });
  }
  if (request.tool === "browser.screenshot") {
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return {
      ...tabMeta,
      mimeType: "image/png",
      image,
      fullPage: false,
    };
  }
  throw new Error(`unsupported browser tool: ${request.tool}`);
}
