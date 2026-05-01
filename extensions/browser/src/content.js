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

  if (message?.type === "input") {
    const selector = String(message.selector ?? "");
    const element = selector ? document.querySelector(selector) : null;
    if (!element) {
      sendResponse({ input: false, message: `element not found: ${selector}` });
      return true;
    }
    setElementValue(element, String(message.text ?? ""));
    if (message.submit === true) {
      submitElement(element);
    }
    sendResponse({
      input: true,
      selector,
      title: document.title,
      url: location.href,
    });
    return true;
  }

  if (message?.type === "scroll") {
    const selector = typeof message.selector === "string" ? message.selector : "";
    const deltaY = typeof message.deltaY === "number" ? message.deltaY : 800;
    const target = selector ? document.querySelector(selector) : null;
    if (selector && !target) {
      sendResponse({ scrolled: false, message: `element not found: ${selector}` });
      return true;
    }
    if (target) {
      target.scrollBy({ top: deltaY, behavior: "auto" });
    } else {
      window.scrollBy({ top: deltaY, behavior: "auto" });
    }
    sendResponse({
      scrolled: true,
      selector: selector || null,
      deltaY,
      scrollY: window.scrollY,
      title: document.title,
      url: location.href,
    });
    return true;
  }

  if (message?.type === "extract") {
    const maxTextChars = positiveInteger(message.maxTextChars, 20000);
    const maxLinks = positiveInteger(message.maxLinks, 50);
    sendResponse({
      title: document.title,
      url: location.href,
      text: (document.body?.innerText ?? "").slice(0, maxTextChars),
      links: extractLinks(maxLinks),
    });
    return true;
  }

  return false;
});

function setElementValue(element, value) {
  const prototype = Object.getPrototypeOf(element);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function submitElement(element) {
  const form = element.closest?.("form");
  if (form?.requestSubmit) {
    form.requestSubmit();
    return;
  }
  element.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
  }));
}

function extractLinks(maxLinks) {
  return [...document.querySelectorAll("a[href]")]
    .slice(0, maxLinks)
    .map((link) => ({
      text: (link.innerText || link.textContent || "").trim(),
      url: link.href,
    }))
    .filter((link) => link.url);
}

function positiveInteger(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}
