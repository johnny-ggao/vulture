import { useState } from "react";
import type { SettingsPageProps } from "./types";
import { Row, describeActive } from "./shared";

export function ModelSection(props: SettingsPageProps) {
  const codex = props.authStatus?.codex;
  const apiKey = props.authStatus?.apiKey;
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState<"signin" | "signout" | "savekey" | null>(null);

  const expiresInMin = codex?.expiresAt
    ? Math.max(0, Math.floor((codex.expiresAt - Date.now()) / 60_000))
    : null;

  async function safeAction<T>(label: typeof busy, fn: () => Promise<T>) {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="page-card">
        <h3>当前在用</h3>
        <p style={{ color: "var(--text-secondary)" }}>{describeActive(props.authStatus)}</p>
      </div>

      <div className="page-card">
        <h3>ChatGPT 订阅 (推荐)</h3>
        {!codex || codex.state === "not_signed_in" ? (
          <>
            <p style={{ color: "var(--text-secondary)", marginBottom: 10 }}>使用 ChatGPT 订阅省去 API key 按 token 计费。</p>
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null}
              onClick={() => safeAction("signin", props.onSignInWithChatGPT)}
            >
              {busy === "signin" ? "正在打开浏览器…" : "用 ChatGPT 登录"}
            </button>
          </>
        ) : codex.state === "signed_in" ? (
          <>
            <Row label="状态" value={`已登录${codex.email ? " · " + codex.email : ""}`} />
            {expiresInMin !== null ? <Row label="过期" value={`${expiresInMin} 分钟后`} /> : null}
            {codex.importedFrom ? <Row label="来源" value="Codex CLI 导入" /> : null}
            <button
              type="button"
              className="btn-secondary"
              style={{ marginTop: 12 }}
              disabled={busy !== null}
              onClick={() => safeAction("signout", props.onSignOutCodex)}
            >
              {busy === "signout" ? "..." : "退出登录"}
            </button>
          </>
        ) : codex.state === "expired" ? (
          <>
            <p style={{ color: "var(--danger)", marginBottom: 10, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ExpiredIcon /> 凭据已过期
            </p>
            {codex.email ? <p style={{ color: "var(--text-tertiary)", fontSize: 12, marginBottom: 10 }}>{codex.email}</p> : null}
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null}
              onClick={() => safeAction("signin", props.onSignInWithChatGPT)}
            >
              {busy === "signin" ? "正在打开浏览器…" : "重新登录"}
            </button>
          </>
        ) : (
          <p>等待浏览器完成登录…</p>
        )}
      </div>

      <div className="page-card">
        <h3>OpenAI API Key (备选)</h3>
        {apiKey?.state === "set" ? (
          <>
            <Row label="状态" value="已配置" />
            <Row label="来源" value={apiKey.source ?? "keychain"} />
            <button
              type="button"
              className="btn-secondary"
              style={{ marginTop: 12 }}
              disabled={busy !== null}
              onClick={() => safeAction("savekey", props.onClearApiKey)}
            >
              清除
            </button>
          </>
        ) : (
          <>
            <p style={{ color: "var(--text-secondary)", marginBottom: 10 }}>仅在未登录 ChatGPT 时使用。按 token 计费。</p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="password"
                placeholder="sk-..."
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                style={{
                  flex: 1,
                  padding: "8px 10px",
                  border: "1px solid var(--fill-tertiary)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-primary)",
                  fontSize: 14,
                }}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null || !apiKeyInput.trim()}
                onClick={() => safeAction("savekey", async () => {
                  await props.onSaveApiKey(apiKeyInput.trim());
                  setApiKeyInput("");
                })}
              >
                {busy === "savekey" ? "..." : "保存"}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function ExpiredIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.5 1 14h14L8 1.5z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.5" r="0.5" fill="currentColor" />
    </svg>
  );
}
