// System-level Tauri command types only — agent/workspace/profile types
// live in apps/desktop-ui/src/api/* now (mirroring the gateway HTTP contract).

export type OpenAiAuthStatus = {
  configured: boolean;
  source: "keychain" | "environment" | "codex" | "missing";
};

export type CodexLoginStart = {
  verificationUrl: string;
  userCode: string;
  alreadyAuthenticated: boolean;
};

export type CodexLoginRequest = {
  forceReauth: boolean;
};
