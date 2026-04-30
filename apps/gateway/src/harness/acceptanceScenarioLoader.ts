import { readFileSync } from "node:fs";
import type { AcceptanceScenario, AcceptanceStep } from "./acceptanceRunner";

const STEP_ACTIONS = new Set<AcceptanceStep["action"]>([
  "createConversation",
  "sendMessage",
  "waitForRun",
  "listMessages",
  "assertMessages",
  "seedInterruptedToolRun",
  "seedRunningRun",
  "restartGateway",
  "uploadTextAttachment",
  "assertMessageAttachment",
  "readRunEvents",
  "assertRunEvents",
  "listConversationRuns",
  "assertRuns",
  "cancelRun",
  "readAttachmentContent",
  "assertAttachmentContent",
  "createMcpServer",
  "listMcpServers",
  "assertMcpServers",
  "listMcpTools",
  "assertMcpTools",
]);

export function loadAcceptanceScenarioFile(path: string): AcceptanceScenario {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  try {
    return validateAcceptanceScenario(raw);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${path}: ${message}`);
  }
}

export function loadAcceptanceScenarioFiles(paths: readonly string[]): AcceptanceScenario[] {
  return paths.map((path) => loadAcceptanceScenarioFile(path));
}

export function validateAcceptanceScenario(value: unknown): AcceptanceScenario {
  if (!isRecord(value)) throw new Error("Acceptance scenario must be an object");
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("Acceptance scenario id must be a non-empty string");
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error("Acceptance scenario name must be a non-empty string");
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error("Acceptance scenario description must be a string");
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) {
      throw new Error("Acceptance scenario tags must be strings");
    }
  }
  if (!Array.isArray(value.steps)) {
    throw new Error("Acceptance scenario steps must be an array");
  }
  const steps = value.steps.map((step, index) => validateStep(step, index));
  return {
    id: value.id,
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.tags === undefined ? {} : { tags: value.tags }),
    steps,
  };
}

function validateStep(value: unknown, index: number): AcceptanceStep {
  if (!isRecord(value)) throw new Error(`Acceptance step ${index} must be an object`);
  if (typeof value.action !== "string") {
    throw new Error(`Acceptance step ${index} action must be a string`);
  }
  if (!STEP_ACTIONS.has(value.action as AcceptanceStep["action"])) {
    throw new Error(`Unsupported acceptance step action ${JSON.stringify(value.action)} at index ${index}`);
  }
  return value as unknown as AcceptanceStep;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
