import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";

export interface ExtractedMemorySuggestion {
  content: string;
  reason: string;
  targetPath: string;
}

export interface ExtractMemorySuggestionsInput {
  llm: LlmCallable;
  model: string;
  workspacePath: string;
  runId: string;
  userInput: string;
  assistantOutput: string;
  memorySummary: string;
}

export async function extractMemorySuggestions(
  input: ExtractMemorySuggestionsInput,
): Promise<ExtractedMemorySuggestion[]> {
  const finalText = await collectFinalText(input.llm({
    systemPrompt: [
      "You extract durable memory candidates for a developer/operator agent.",
      "Return strict JSON only: {\"suggestions\":[{\"content\":\"...\",\"reason\":\"...\",\"targetPath\":\"MEMORY.md\"}]}",
      "Only include stable user preferences, project facts, conventions, or long-lived corrections.",
      "Do not include temporary task details, one-off outputs, secrets, credentials, or vague summaries.",
      "Use targetPath MEMORY.md unless the user explicitly requested a daily note.",
    ].join("\n"),
    userInput: [
      `Memory summary:\n${input.memorySummary || "(none)"}`,
      `User message:\n${input.userInput}`,
      `Assistant final answer:\n${input.assistantOutput}`,
    ].join("\n\n"),
    model: input.model,
    runId: `${input.runId}-memory-extract`,
    workspacePath: input.workspacePath,
  }));
  return parseSuggestions(finalText);
}

async function collectFinalText(stream: AsyncGenerator<LlmYield, void, unknown>): Promise<string> {
  let finalText = "";
  for await (const event of stream) {
    if (event.kind === "final") finalText = event.text;
  }
  return finalText;
}

function parseSuggestions(value: string): ExtractedMemorySuggestion[] {
  const parsed = tryParseJson(value);
  if (!isRecord(parsed) || !Array.isArray(parsed.suggestions)) return [];
  return parsed.suggestions.flatMap((item): ExtractedMemorySuggestion[] => {
    if (!isRecord(item)) return [];
    if (
      typeof item.content !== "string" ||
      typeof item.reason !== "string" ||
      typeof item.targetPath !== "string"
    ) {
      return [];
    }
    const content = item.content.trim();
    if (!content) return [];
    return [{
      content,
      reason: item.reason.trim() || "Durable memory candidate.",
      targetPath: item.targetPath.trim() || "MEMORY.md",
    }];
  });
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
