import { describe, expect, test, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingCard } from "./OnboardingCard";

describe("OnboardingCard", () => {
  test("renders both auth options", () => {
    render(
      <OnboardingCard
        onSignInWithChatGPT={async () => {}}
        onFocusApiKey={() => {}}
      />,
    );
    expect(screen.getByText(/Sign in with ChatGPT/i)).toBeDefined();
    expect(screen.getByText(/OpenAI API key/i)).toBeDefined();
  });

  test("ChatGPT sign in triggers callback", () => {
    const onSignIn = mock(async () => {});
    render(
      <OnboardingCard onSignInWithChatGPT={onSignIn} onFocusApiKey={() => {}} />,
    );
    fireEvent.click(screen.getByText(/Sign in with ChatGPT/i));
    expect(onSignIn).toHaveBeenCalled();
  });

  test("API key click triggers focus callback", () => {
    const onFocus = mock(() => {});
    render(
      <OnboardingCard onSignInWithChatGPT={async () => {}} onFocusApiKey={onFocus} />,
    );
    fireEvent.click(screen.getByText(/OpenAI API key/i));
    expect(onFocus).toHaveBeenCalled();
  });
});
