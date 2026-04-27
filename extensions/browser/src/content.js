chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "snapshot") {
    sendResponse({
      title: document.title,
      url: location.href,
      text: document.body?.innerText?.slice(0, 20000) ?? "",
    });
    return true;
  }

  if (message?.type === "click") {
    const selector = String(message.selector ?? "");
    const element = selector ? document.querySelector(selector) : null;
    if (!element) {
      sendResponse({ clicked: false, message: `element not found: ${selector}` });
      return true;
    }
    element.click();
    sendResponse({
      clicked: true,
      selector,
      title: document.title,
      url: location.href,
    });
    return true;
  }

  return false;
});
