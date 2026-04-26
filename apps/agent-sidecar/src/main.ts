import { runAgent } from "./agents";
import { parseJsonLine, serializeMessage } from "./rpc";

const gateway = {
  async request(toolName: string, input: Record<string, unknown>) {
    process.stdout.write(
      serializeMessage({
        method: "tool.request",
        params: { runId: "pending", tool: toolName, input },
      }),
    );

    return { ok: false, reason: "interactive tool response loop is owned by Rust integration" };
  },
};

async function handleLine(line: string) {
  const request = parseJsonLine(line);

  if (request.method === "health.check") {
    return { id: request.id, result: { ok: true, runtime: "bun" } };
  }

  if (request.method === "run.create") {
    const events = await runAgent(request.params, gateway);
    return { id: request.id, result: { events } };
  }

  return {
    id: request.id,
    error: {
      code: "METHOD_NOT_FOUND",
      message: `Unknown method ${request.method}`,
      recoverable: false,
    },
  };
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const response = await handleLine(line);
    process.stdout.write(serializeMessage(response));
  }
}
