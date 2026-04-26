import { createRequestHandler } from "./handler";
import { serializeMessage } from "./rpc";

const handleLine = createRequestHandler({
  writeMessage(message) {
    process.stdout.write(serializeMessage(message));
  },
});

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
