import { buildHello, listTabs } from "./relay-client.js";

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

  return false;
});
