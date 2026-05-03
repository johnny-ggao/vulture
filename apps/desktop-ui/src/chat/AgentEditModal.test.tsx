import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { AgentEditModal } from "./AgentEditModal";
import { localAgentFixture as fixtureAgent } from "./__fixtures__/agent";

test("initialTab prop sets the active tab on mount", async () => {
  const { container } = render(
    <AgentEditModal
      open={true}
      agent={fixtureAgent}
      agents={[fixtureAgent]}
      toolGroups={[]}
      onClose={() => {}}
      onSave={async () => {}}
      initialTab="core"
    />,
  );
  expect(
    container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toMatch(/core|核心/i);
});

test("model picker uses provider-qualified values", () => {
  render(
    <AgentEditModal
      open={true}
      agent={{ ...fixtureAgent, model: "openai/gpt-5.4" }}
      agents={[fixtureAgent]}
      toolGroups={[]}
      authStatus={{
        active: "api_key",
        apiKey: { state: "set", source: "keychain" },
        codex: { state: "not_signed_in" },
      }}
      onClose={() => {}}
      onSave={async () => {}}
    />,
  );

  const model = screen.getByRole("combobox", { name: "模型" });
  expect(model.textContent).toContain("openai/gpt-5.4");
  expect(model.textContent).not.toContain("gateway/auto");
});
