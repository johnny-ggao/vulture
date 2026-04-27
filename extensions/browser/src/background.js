import {
  buildHello,
  executeBrowserRequest,
  listTabs,
  pairWithRelay,
  pollBrowserRequest,
  postBrowserResult,
} from "./relay-client.js";

let pollTimer = null;

async function loadRelayConfig() {
  const { pairingToken, relayPort } = await chrome.storage.local.get([
    "pairingToken",
    "relayPort",
  ]);
  if (!pairingToken || !relayPort) return null;
  return { pairingToken, relayPort: Number(relayPort) };
}

async function pollOnce() {
  const config = await loadRelayConfig();
  if (!config) return;

  const request = await pollBrowserRequest(config);
  if (!request) return;

  try {
    const value = await executeBrowserRequest(request);
    await postBrowserResult({
      ...config,
      requestId: request.requestId,
      ok: true,
      value,
    });
  } catch (error) {
    await postBrowserResult({
      ...config,
      requestId: request.requestId,
      ok: false,
      value: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    pollOnce().catch(() => undefined);
  }, 1000);
  pollOnce().catch(() => undefined);
}

chrome.runtime.onStartup.addListener(startPolling);
chrome.runtime.onInstalled.addListener(startPolling);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "buildHello") {
    sendResponse(buildHello(message.payload));
    return true;
  }

  if (message?.type === "listTabs") {
    listTabs().then(sendResponse, (error) => {
      sendResponse({ error: String(error) });
    });
    return true;
  }

  if (message?.type === "pair") {
    pairWithRelay(message.payload)
      .then(() => {
        startPolling();
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  return false;
});

startPolling();
