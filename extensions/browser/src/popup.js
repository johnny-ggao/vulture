const tokenInput = document.querySelector("#token");
const output = document.querySelector("#output");

document.querySelector("#save").addEventListener("click", async () => {
  await chrome.storage.local.set({ pairingToken: tokenInput.value.trim() });
  output.textContent = "saved";
});

document.querySelector("#tabs").addEventListener("click", async () => {
  const tabs = await chrome.runtime.sendMessage({ type: "listTabs" });
  output.textContent = JSON.stringify(tabs);
});
