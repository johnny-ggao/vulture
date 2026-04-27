const portInput = document.querySelector("#port");
const tokenInput = document.querySelector("#token");
const output = document.querySelector("#output");

chrome.storage.local.get(["pairingToken", "relayPort"]).then((stored) => {
  if (stored.pairingToken) tokenInput.value = stored.pairingToken;
  if (stored.relayPort) portInput.value = stored.relayPort;
});

document.querySelector("#save").addEventListener("click", async () => {
  const pairingToken = tokenInput.value.trim();
  const relayPort = Number(portInput.value.trim());
  await chrome.storage.local.set({ pairingToken, relayPort });
  const response = await chrome.runtime.sendMessage({
    type: "pair",
    payload: { pairingToken, relayPort },
  });
  output.textContent = JSON.stringify(response);
});

document.querySelector("#tabs").addEventListener("click", async () => {
  const tabs = await chrome.runtime.sendMessage({ type: "listTabs" });
  output.textContent = JSON.stringify(tabs);
});
