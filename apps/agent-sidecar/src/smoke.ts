import { createRequestHandler } from "./handler";

process.env.VULTURE_AGENT_MODE = process.env.VULTURE_AGENT_MODE ?? "mock";

const emitted: unknown[] = [];
const handleLine = createRequestHandler({
  writeMessage(message) {
    emitted.push(message);
  },
});

const response = await handleLine(
  JSON.stringify({
    id: "sidecar-smoke",
    method: "run.create",
    params: {
      profileId: "default",
      workspaceId: "local",
      agentId: "local-work-agent",
      input: "verification smoke",
    },
  }),
);

const result =
  typeof response.result === "object" && response.result !== null ? response.result : {};
const events = "events" in result ? result.events : undefined;

if (!Array.isArray(events) || events.length === 0) {
  throw new Error(`sidecar smoke expected result events, received ${JSON.stringify(response)}`);
}

if (
  process.env.VULTURE_MOCK_TOOL_REQUEST === "1" &&
  !emitted.some((message) => {
    if (typeof message !== "object" || message === null || !("method" in message)) {
      return false;
    }

    return message.method === "tool.request";
  })
) {
  throw new Error("sidecar smoke expected a mock tool.request message");
}

process.stdout.write(
  JSON.stringify({
    ok: true,
    eventTypes: events.map((event) => event.type),
    toolRequests: emitted.length,
  }) + "\n",
);
