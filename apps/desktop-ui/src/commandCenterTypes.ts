// System-level Tauri command types only — agent/workspace/profile types
// live in apps/desktop-ui/src/api/* now (mirroring the gateway HTTP contract).

export type OpenAiAuthStatus = {
  configured: boolean;
  source: "keychain" | "environment" | "codex" | "missing";
};

// Phase 3c — Codex subscription OAuth types

export type AuthSource = OpenAiAuthStatus["source"];

export type AuthActiveProvider = "codex" | "api_key" | "none";

export type CodexStatusState = "not_signed_in" | "signed_in" | "expired" | "logging_in";

export interface CodexStatusView {
  state: CodexStatusState;
  email?: string;
  expiresAt?: number;
  importedFrom?: string;
}

export type ApiKeyState = "not_set" | "set";

export interface ApiKeyStatusView {
  state: ApiKeyState;
  source?: AuthSource;
}

export interface AuthStatusView {
  active: AuthActiveProvider;
  codex: CodexStatusView;
  apiKey: ApiKeyStatusView;
}

export interface ChatGPTLoginStart {
  url: string;
  alreadyAuthenticated: boolean;
}
