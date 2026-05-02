const portInput = document.querySelector("#port");
const tokenInput = document.querySelector("#token");
const statusBox = document.querySelector("#status");
const statusLabel = document.querySelector("#status-label");
const statusPill = document.querySelector("#status-pill");
const statusDetail = document.querySelector("#status-detail");
const tabsCount = document.querySelector("#tabs-count");
const activeTab = document.querySelector("#active-tab");
const tabsSection = document.querySelector("#tabs-section");
const tabsHeader = document.querySelector("#tabs-header");
const tabsList = document.querySelector("#tabs-list");
const pairingSettings = document.querySelector("#pairing-settings");
const debug = document.querySelector("#debug");
const saveButton = document.querySelector("#save");
const tabsButton = document.querySelector("#tabs");

chrome.storage.local.get(["pairingToken", "relayPort"]).then(async (stored) => {
  if (stored.pairingToken) tokenInput.value = stored.pairingToken;
  if (stored.relayPort) portInput.value = stored.relayPort;
  const configured = Boolean(stored.pairingToken && stored.relayPort);
  pairingSettings.open = !configured;
  renderPairingStatus(formatPairingStatus({ configured }));
  if (configured) await refreshTabs();
});

saveButton.addEventListener("click", async () => {
  const pairingToken = tokenInput.value.trim();
  const relayPort = Number(portInput.value.trim());
  if (!pairingToken || !Number.isFinite(relayPort) || relayPort <= 0) {
    renderPairingStatus(formatPairingStatus({
      configured: false,
      error: "请输入有效端口和配对令牌。",
    }));
    pairingSettings.open = true;
    return;
  }

  saveButton.disabled = true;
  renderPairingStatus(formatPairingStatus({ configured: true, pending: true }));
  await chrome.storage.local.set({ pairingToken, relayPort });
  try {
    const response = await chrome.runtime.sendMessage({
      type: "pair",
      payload: { pairingToken, relayPort },
    });
    const paired = response?.ok === true;
    renderPairingStatus(formatPairingStatus({
      configured: true,
      paired,
      error: paired ? null : response?.error,
    }));
    pairingSettings.open = !paired;
    setDebug(response);
    if (paired) await refreshTabs();
  } catch (error) {
    renderPairingStatus(formatPairingStatus({
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    }));
    pairingSettings.open = true;
  } finally {
    saveButton.disabled = false;
  }
});

tabsButton.addEventListener("click", refreshTabs);
tabsHeader.addEventListener("click", () => {
  tabsSection.dataset.open = tabsSection.dataset.open === "true" ? "false" : "true";
});

async function refreshTabs() {
  tabsButton.disabled = true;
  try {
    const tabs = await chrome.runtime.sendMessage({ type: "listTabs" });
    renderTabsSummary(formatTabsSummary(tabs));
    setDebug(tabs);
  } catch (error) {
    renderTabsSummary({
      count: "无法读取标签页",
      active: error instanceof Error ? error.message : String(error),
      tabs: [],
    });
  } finally {
    tabsButton.disabled = false;
  }
}

export function formatPairingStatus({ configured, paired = false, pending = false, error = null }) {
  if (error) {
    return {
      tone: "error",
      label: "连接失败",
      detail: String(error),
    };
  }
  if (paired) {
    return {
      tone: "connected",
      label: "已连接",
      detail: "浏览器工具可以使用当前 Chrome 页面。",
    };
  }
  if (pending || configured) {
    return {
      tone: "pending",
      label: "等待配对",
      detail: "保持 Vulture 桌面端运行，然后点击连接桌面端。",
    };
  }
  return {
    tone: "idle",
    label: "未配置",
    detail: "从 Vulture 设置页复制端口和配对令牌。",
  };
}

export function formatTabsSummary(payload) {
  const tabs = Array.isArray(payload?.params?.tabs)
    ? payload.params.tabs
    : Array.isArray(payload?.tabs)
      ? payload.tabs
      : [];
  const normalizedTabs = tabs.map((tab) => ({
    id: tab?.id ?? tab?.tabId ?? 0,
    windowId: tab?.windowId ?? 0,
    title: tab?.title || "Untitled",
    url: tab?.url || "",
    active: Boolean(tab?.active),
  }));
  const current = normalizedTabs.find((tab) => tab.active) ?? normalizedTabs[0] ?? null;
  return {
    count: `${normalizedTabs.length} 个标签页`,
    active: current
      ? `${current.title || "Untitled"} · ${current.url || ""}`.trim()
      : "连接后显示当前 Chrome 页面。",
    tabs: normalizedTabs,
  };
}

function renderPairingStatus(status) {
  statusBox.dataset.state = status.tone;
  statusLabel.textContent = status.label;
  statusPill.textContent = status.tone === "connected"
    ? "Ready"
    : status.tone === "pending"
      ? "Pairing"
      : status.tone === "error"
        ? "Error"
        : "Idle";
  statusDetail.textContent = status.detail;
}

function renderTabsSummary(summary) {
  tabsCount.textContent = summary.count.replace(" 个标签页", "");
  activeTab.textContent = summary.tabs.length > 0
    ? trimActiveTab(summary.active)
    : "No active tab";
  renderTabs(summary.tabs);
}

function renderTabs(tabs) {
  tabsList.textContent = "";
  if (tabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-tabs";
    empty.textContent = "连接后显示可用标签页。";
    tabsList.appendChild(empty);
    tabsSection.dataset.open = "false";
    return;
  }
  tabs.forEach((tab) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tab-item";
    item.dataset.active = String(tab.active);
    item.title = tab.url;
    item.addEventListener("click", () => {
      if (!tab.id) return;
      chrome.tabs.update(tab.id, { active: true });
      window.close();
    });

    const dot = document.createElement("span");
    dot.className = "tab-dot";
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || tab.url || `Tab ${tab.id}`;
    item.append(dot, title);
    tabsList.appendChild(item);
  });
  if (tabsSection.dataset.open !== "true") {
    tabsSection.dataset.open = "true";
  }
}

function trimActiveTab(value) {
  const [title] = value.split(" · ");
  return title || "Active tab";
}

function setDebug(value) {
  debug.hidden = !value;
  debug.textContent = value ? JSON.stringify(value) : "";
}

renderPairingStatus(formatPairingStatus({ configured: false }));
renderTabsSummary(formatTabsSummary(null));
