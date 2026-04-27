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

export function normalizeTab(tab) {
  return {
    id: tab.id ?? 0,
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
  if (request.tool === "browser.snapshot") {
    return chrome.tabs.sendMessage(tab.id, { type: "snapshot" });
  }
  if (request.tool === "browser.click") {
    return chrome.tabs.sendMessage(tab.id, {
      type: "click",
      selector: request.input?.selector,
    });
  }
  throw new Error(`unsupported browser tool: ${request.tool}`);
}
