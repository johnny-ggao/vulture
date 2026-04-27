import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AuthPanel } from "./AuthPanel";
import type { AuthStatusView } from "../commandCenterTypes";

const noAuthStatus: AuthStatusView = {
  active: "none",
  codex: { state: "not_signed_in" },
  apiKey: { state: "not_set" },
};

const codexSignedIn: AuthStatusView = {
  active: "codex",
  codex: {
    state: "signed_in",
    email: "user@example.com",
    expiresAt: Date.now() + 7_200_000,
  },
  apiKey: { state: "not_set" },
};

const codexExpired: AuthStatusView = {
  active: "none",
  codex: { state: "expired", email: "user@example.com" },
  apiKey: { state: "not_set" },
};

describe("AuthPanel", () => {
  test("renders signed-in state with email", () => {
    render(
      <AuthPanel
        authStatus={codexSignedIn}
        onSignInWithChatGPT={async () => {}}
        onSignOutCodex={async () => {}}
        onSaveApiKey={async () => {}}
        onClearApiKey={async () => {}}
      />,
    );
    expect(screen.getByText(/user@example.com/)).toBeDefined();
    expect(screen.getByText(/Sign out/i)).toBeDefined();
  });

  test("renders 'Sign in with ChatGPT' when not signed in", () => {
    render(
      <AuthPanel
        authStatus={noAuthStatus}
        onSignInWithChatGPT={async () => {}}
        onSignOutCodex={async () => {}}
        onSaveApiKey={async () => {}}
        onClearApiKey={async () => {}}
      />,
    );
    expect(screen.getByText(/Sign in with ChatGPT/i)).toBeDefined();
  });

  test("clicking sign in triggers callback", () => {
    const onSignIn = mock(async () => {});
    render(
      <AuthPanel
        authStatus={noAuthStatus}
        onSignInWithChatGPT={onSignIn}
        onSignOutCodex={async () => {}}
        onSaveApiKey={async () => {}}
        onClearApiKey={async () => {}}
      />,
    );
    fireEvent.click(screen.getByText(/Sign in with ChatGPT/i));
    expect(onSignIn).toHaveBeenCalled();
  });

  test("renders expired state with red marker", () => {
    const { container } = render(
      <AuthPanel
        authStatus={codexExpired}
        onSignInWithChatGPT={async () => {}}
        onSignOutCodex={async () => {}}
        onSaveApiKey={async () => {}}
        onClearApiKey={async () => {}}
      />,
    );
    expect(container.textContent).toContain("已过期");
  });

  test("API key save triggers callback with input value", () => {
    const onSave = mock(async () => {});
    render(
      <AuthPanel
        authStatus={noAuthStatus}
        onSignInWithChatGPT={async () => {}}
        onSignOutCodex={async () => {}}
        onSaveApiKey={onSave}
        onClearApiKey={async () => {}}
      />,
    );
    const input = screen.getByPlaceholderText(/sk-/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-abc" } });
    fireEvent.click(screen.getByText(/Save/i));
    expect(onSave).toHaveBeenCalledWith("sk-abc");
  });
});
