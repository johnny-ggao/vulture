export type AutoApprovalRisk = "low" | "medium" | "high" | "critical";
export type AutoApprovalDecision = "allow" | "deny" | "needs_user";

export interface AutoApprovalRequest {
  runId: string;
  callId: string;
  tool: string;
  input: unknown;
  workspacePath: string;
  reason: string;
}

export interface AutoApprovalReview {
  decision: AutoApprovalDecision;
  risk: AutoApprovalRisk;
  reason: string;
}

export interface AutoApprovalReviewer {
  review(request: AutoApprovalRequest): Promise<AutoApprovalReview>;
}

export const defaultAutoApprovalReviewer: AutoApprovalReviewer = {
  review: reviewApprovalRequest,
};

const CRITICAL_PATTERNS = [
  /(^|[\/\s])\.ssh([\/\s]|$)/i,
  /\bid_(rsa|ed25519|ecdsa|dsa)\b/i,
  /(^|[\/\s])\.env(\.|[\/\s]|$)/i,
  /\b(openai_api_key|api[_-]?key|secret|token|password)\b/i,
  /~\/\.aws\/credentials/i,
  /~\/\.kube\/config/i,
  /\bsecurity\s+find-/i,
];

const CRITICAL_DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\s+(\/|~)(\s|$)/i,
  /\bdd\s+.*\bof=\/dev\//i,
  /\bmkfs(\.|[\s])/i,
  /\bdiskutil\s+(erase|partition|apfs\s+delete)/i,
  /\bchmod\s+-R\s+777\s+\/(\s|$)/i,
];

const HIGH_RISK_COMMAND_PATTERNS = [
  /\bsudo\b/i,
  /\brm\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bkill(all)?\b/i,
  /\b(pnpm|npm|bun|yarn|brew|pip|cargo)\s+(install|add|remove|upgrade|update)\b/i,
  /(^|[^|])>\s*\S+/,
  /\|\s*(bash|sh|zsh)\b/i,
];

const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "memory_append",
  "memory_delete",
  "sessions_send",
  "sessions_spawn",
  "browser.click",
  "browser.type",
  "process.start",
  "process.kill",
]);

const NETWORK_READ_TOOLS = new Set(["web_search", "web_fetch"]);
const READ_ONLY_TOOLS = new Set([
  "read",
  "sessions_list",
  "sessions_read",
  "update_plan",
  "browser.snapshot",
]);

export async function reviewApprovalRequest(
  request: AutoApprovalRequest,
): Promise<AutoApprovalReview> {
  const text = `${request.tool} ${stringifyInput(request.input)} ${request.reason}`;
  if (matchesAny(text, CRITICAL_PATTERNS) || matchesAny(text, CRITICAL_DESTRUCTIVE_PATTERNS)) {
    return {
      decision: "deny",
      risk: "critical",
      reason: "The request touches credentials, secrets, or irreversible system operations.",
    };
  }

  if (request.tool === "shell.exec" || request.tool.startsWith("process.")) {
    if (matchesAny(text, HIGH_RISK_COMMAND_PATTERNS)) {
      return {
        decision: "needs_user",
        risk: "high",
        reason: "The command can mutate files, processes, packages, or system state.",
      };
    }
    return {
      decision: "allow",
      risk: "low",
      reason: "The command appears to be a read-only inspection.",
    };
  }

  if (MUTATING_TOOLS.has(request.tool)) {
    return {
      decision: "needs_user",
      risk: "high",
      reason: "The tool mutates state and should remain user-approved.",
    };
  }

  if (NETWORK_READ_TOOLS.has(request.tool)) {
    return {
      decision: "allow",
      risk: "medium",
      reason: "The tool performs a bounded public network read.",
    };
  }

  if (READ_ONLY_TOOLS.has(request.tool)) {
    return {
      decision: "allow",
      risk: "low",
      reason: "The tool is read-only.",
    };
  }

  return {
    decision: "needs_user",
    risk: "high",
    reason: "The tool is not covered by the automatic approval reviewer.",
  };
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  if (isRecord(input) && Array.isArray(input.argv)) {
    return input.argv.map(String).join(" ");
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
