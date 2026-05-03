import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
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
