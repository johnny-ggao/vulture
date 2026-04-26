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
