chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "snapshot") {
    sendResponse({
      title: document.title,
      url: location.href,
      text: document.body?.innerText?.slice(0, 20000) ?? "",
    });
    return true;
  }

  return false;
});
