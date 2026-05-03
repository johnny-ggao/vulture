import { useState } from "react";
import { Row } from "./shared";
import {
  DisabledSelect,
  DisabledToggle,
  FormRow,
  SectionGroup,
} from "./GeneralSection";
import { SettingsSection } from "./SettingsSection";
import type { SettingsPageProps } from "./types";

/* ============================================================
 * BrowserSection (C2)
 *
 * Anchored on the real Browser Relay pairing (status + relay port +
 * pairing token). Adds kit-faithful UI shells for browser profiles,
 * UA / proxy / timeouts, and the sensitive-domain whitelist. The
 * shells stay disabled until backend support lands.
 * ============================================================ */

const SENSITIVE = ["github.com", "linear.app", "notion.so", "mail.google.com"];

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

  const statusLabel = status?.paired
    ? "已连接"
    : status?.enabled
    ? "等待扩展配对"
    : "未启用";

  return (
    <SettingsSection
      title="浏览器"
      description="通过本地 Chrome 扩展连接桌面浏览器，供 browser.navigate / browser.wait / browser.screenshot 等工具调用。"
      action={
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={startPairing}
        >
          {busy ? "配对中…" : "开始配对"}
        </button>
      }
    >
      <SectionGroup title="浏览器中继 (Browser Relay)">
        <Row label="状态" value={statusLabel} />
        {status?.relayPort ? <Row label="端口" value={String(status.relayPort)} /> : null}
        {status?.extensionVersion ? (
          <Row label="扩展版本" value={status.extensionVersion} />
        ) : null}
        {typeof status?.tabCount === "number" ? (
          <Row label="标签页" value={`${status.tabCount} 个`} />
        ) : null}
        {status?.activeTab ? (
          <Row
            label="当前页面"
            value={`${status.activeTab.title || "Untitled"} · ${status.activeTab.url}`}
          />
        ) : null}
        {status?.pairingToken ? (
          <Row label="配对令牌" value={status.pairingToken} />
        ) : null}
      </SectionGroup>

      <SectionGroup title="会话">
        <FormRow label="默认会话" hint="浏览器会话设置尚未接入。">
          <DisabledSelect value="work">
            <option value="work">工作</option>
            <option value="personal">个人</option>
            <option value="research">调研</option>
          </DisabledSelect>
        </FormRow>
        <FormRow label="会话隔离" hint="不同用途使用独立 cookie 与登录态。">
          <DisabledToggle on />
        </FormRow>
      </SectionGroup>

      <SectionGroup title="抓取与代理">
        <FormRow label="UserAgent" hint="智能体抓取网页时使用的 UA。">
          <DisabledSelect value="default">
            <option value="default">Chrome 桌面（默认）</option>
            <option value="mobile">iPhone Safari</option>
            <option value="bot">VultureBot/1.0</option>
            <option value="custom">自定义…</option>
          </DisabledSelect>
        </FormRow>
        <FormRow label="HTTP 代理" hint="留空则直连。">
          <input
            className="provider-text-input"
            placeholder="http://127.0.0.1:7890"
            disabled
            aria-disabled="true"
          />
        </FormRow>
        <FormRow label="超时 / 重试">
          <span className="inline-fields">
            <span className="mini-field">超时 <b>30s</b></span>
            <span className="mini-field">重试 <b>2 次</b></span>
            <span className="mini-field">并发 <b>4</b></span>
          </span>
        </FormRow>
        <FormRow label="允许执行 JS"><DisabledToggle on /></FormRow>
        <FormRow label="允许下载文件" hint="下载到 ~/Downloads/Vulture/。"><DisabledToggle on /></FormRow>
      </SectionGroup>

      <SectionGroup title="安全">
        <FormRow label="敏感站点白名单" hint="只有列表中的域名才允许填写表单或登录。">
          <div className="tag-row">
            {SENSITIVE.map((d) => (
              <span key={d} className="tag is-on">{d}</span>
            ))}
            <button type="button" className="tag-add" disabled>+ 添加域名</button>
          </div>
        </FormRow>
        <FormRow label="阻止追踪器"><DisabledToggle on /></FormRow>
      </SectionGroup>
    </SettingsSection>
  );
}
