import { useState } from "react";
import type { AuthStatusView } from "../commandCenterTypes";

export interface AuthPanelProps {
  authStatus: AuthStatusView;
  onSignInWithChatGPT: () => Promise<void>;
  onSignOutCodex: () => Promise<void>;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
}

type BusyAction = "signin" | "signout" | "savekey" | null;

export function AuthPanel(props: AuthPanelProps) {
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);

  async function safeAction<T>(label: BusyAction, fn: () => Promise<T>) {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  const codex = props.authStatus.codex;
  const apiKey = props.authStatus.apiKey;
  const expiresInMin = codex.expiresAt
    ? Math.max(0, Math.floor((codex.expiresAt - Date.now()) / 60_000))
    : null;

  return (
    <div className="auth-panel">
      <div className="auth-panel-section">
        <h4>ChatGPT 订阅 (推荐)</h4>
        {codex.state === "signed_in" ? (
          <>
            <p className="auth-panel-status">
              ⦿ 已登录{codex.email ? ` · ${codex.email}` : ""}
            </p>
            {expiresInMin !== null && (
              <p className="auth-panel-meta">过期：{expiresInMin} 分钟后</p>
            )}
            {codex.importedFrom && (
              <p className="auth-panel-meta">凭证已从 Codex CLI 导入</p>
            )}
            <button
              type="button"
              className="auth-panel-secondary"
              disabled={busy !== null}
              onClick={() => safeAction("signout", props.onSignOutCodex)}
            >
              {busy === "signout" ? "..." : "Sign out"}
            </button>
          </>
        ) : codex.state === "expired" ? (
          <>
            <p className="auth-panel-status auth-panel-error">⚠ 已过期</p>
            {codex.email && <p className="auth-panel-meta">{codex.email}</p>}
            <button
              type="button"
              className="auth-panel-primary"
              disabled={busy !== null}
              onClick={() => safeAction("signin", props.onSignInWithChatGPT)}
            >
              {busy === "signin" ? "Opening browser..." : "Sign in again"}
            </button>
          </>
        ) : codex.state === "logging_in" ? (
          <p className="auth-panel-status">等待浏览器完成登录…</p>
        ) : (
          <>
            <p className="auth-panel-status">◯ 未登录</p>
            <button
              type="button"
              className="auth-panel-primary"
              disabled={busy !== null}
              onClick={() => safeAction("signin", props.onSignInWithChatGPT)}
            >
              {busy === "signin" ? "Opening browser..." : "Sign in with ChatGPT"}
            </button>
          </>
        )}
      </div>

      <hr className="auth-panel-divider" />

      <div className="auth-panel-section">
        <h4>OpenAI API key (备选)</h4>
        {apiKey.state === "set" ? (
          <>
            <p className="auth-panel-status">
              ⦿ 已设置 ({apiKey.source ?? "keychain"})
            </p>
            <button
              type="button"
              className="auth-panel-secondary"
              disabled={busy !== null}
              onClick={() => safeAction("savekey", () => props.onClearApiKey())}
            >
              Clear
            </button>
          </>
        ) : (
          <>
            <p className="auth-panel-status">◯ 未设置</p>
            <div className="auth-panel-input-row">
              <input
                type="password"
                placeholder="sk-..."
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
              />
              <button
                type="button"
                className="auth-panel-secondary"
                disabled={busy !== null || !apiKeyInput.trim()}
                onClick={() =>
                  safeAction("savekey", async () => {
                    await props.onSaveApiKey(apiKeyInput.trim());
                    setApiKeyInput("");
                  })
                }
              >
                {busy === "savekey" ? "..." : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
