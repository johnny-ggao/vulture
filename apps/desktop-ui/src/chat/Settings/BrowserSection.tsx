import { useState } from "react";
import { Row } from "./shared";
import { SectionCard } from "../components";
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
    <SectionCard
      title="浏览器中继 (Browser Relay)"
      description="通过本地 Chrome 扩展连接桌面浏览器，供 browser.snapshot / browser.click 工具调用。"
      actions={
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={startPairing}
        >
          {busy ? "..." : "开始配对"}
        </button>
      }
    >
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
    </SectionCard>
  );
}
