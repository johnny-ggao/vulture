import { useState } from "react";
import { Row } from "./shared";
import type { SettingsPageProps } from "./types";

export function BrowserSection(props: SettingsPageProps) {
  const [busy, setBusy] = useState(false);
  const status = props.browserStatus;

  async function startPairing() {
    setBusy(true);
    try {
      await props.onStartBrowserPairing();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-card">
      <h3>浏览器中继 (Browser Relay)</h3>
      <p style={{ color: "var(--text-secondary)", marginBottom: 12 }}>
        通过本地 Chrome 扩展连接桌面浏览器，供 browser.snapshot / browser.click 工具调用。
      </p>
      <Row
        label="状态"
        value={
          status?.paired ? "已连接" :
          status?.enabled ? "等待扩展配对" :
          "未启用"
        }
      />
      {status?.relayPort ? <Row label="端口" value={String(status.relayPort)} /> : null}
      {status?.pairingToken ? (
        <Row label="配对令牌" value={status.pairingToken} />
      ) : null}
      <button
        type="button"
        className="btn-secondary"
        style={{ marginTop: 12 }}
        disabled={busy}
        onClick={startPairing}
      >
        {busy ? "..." : "开始配对"}
      </button>
    </div>
  );
}
