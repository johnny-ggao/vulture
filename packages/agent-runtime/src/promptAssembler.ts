import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PromptAgent {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: string;
  tools: string[];
  handoffs?: PromptHandoffAgent[];
  instructions: string;
}

export interface PromptHandoffAgent {
  id: string;
  name: string;
  description: string;
}

export interface PromptWorkspace {
  id: string;
  name: string;
  path: string;
}

export interface AssembleArgs {
  packDir: string;
  agent: PromptAgent;
  workspace: PromptWorkspace;
  agentCoreDir?: string;
}

export interface CodexAssembleArgs extends AssembleArgs {
  userInput: string;
}

function readSection(packDir: string, file: string): string {
  const path = join(packDir, file);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

function loadWorkspaceAgentsMd(workspacePath: string): string {
  const p = join(workspacePath, "AGENTS.md");
  if (!existsSync(p)) return "No workspace AGENTS.md was found at the workspace root.";
  return readFileSync(p, "utf8").trim();
}

function readOptionalSection(dir: string | undefined, file: string): string {
  if (!dir) return "";
  return readSection(dir, file);
}

export function assembleAgentInstructions(args: AssembleArgs): string {
  const { packDir, agent, workspace } = args;
  const SOUL = readSection(packDir, "SOUL.md");
  const IDENTITY = readSection(packDir, "IDENTITY.md");
  const DEFAULT_AGENTS = readSection(packDir, "AGENTS.md");
  const TOOLS = readSection(packDir, "TOOLS.md");
  const USER = readSection(packDir, "USER.md");
  const agentCoreSoul = readOptionalSection(args.agentCoreDir, "SOUL.md");
  const agentCoreIdentity = readOptionalSection(args.agentCoreDir, "IDENTITY.md");
  const agentCoreAgents = readOptionalSection(args.agentCoreDir, "AGENTS.md");
  const agentCoreTools = readOptionalSection(args.agentCoreDir, "TOOLS.md");
  const agentCoreUser = readOptionalSection(args.agentCoreDir, "USER.md");
  const agentCoreHeartbeat = readOptionalSection(args.agentCoreDir, "HEARTBEAT.md");
  const workspaceAgents = loadWorkspaceAgentsMd(workspace.path);
  const handoffs = formatHandoffs(agent.handoffs ?? []);

  return `# Vulture Agent Pack

## SOUL.md
${SOUL}

## Agent Core SOUL.md
${agentCoreSoul || "No agent-core SOUL.md was found."}

## IDENTITY.md
${IDENTITY}

## Agent Core IDENTITY.md
${agentCoreIdentity || "No agent-core IDENTITY.md was found."}

### Selected Agent
- id: ${agent.id}
- name: ${agent.name}
- description: ${agent.description}
- model: ${agent.model}
- reasoning: ${agent.reasoning}
- workspace: ${workspace.name} (${workspace.path})

### Agent Instructions
${agent.instructions.trim()}

## USER.md
${USER}

## Agent Core USER.md
${agentCoreUser || "No agent-core USER.md was found."}

## AGENTS.md
### Default Agent Rules
${DEFAULT_AGENTS}

### Agent Core AGENTS.md
${agentCoreAgents || "No agent-core AGENTS.md was found."}

### Workspace AGENTS.md
${workspaceAgents}

## TOOLS.md
${TOOLS}

### Agent Core TOOLS.md
${agentCoreTools || "No agent-core TOOLS.md was found."}

## HEARTBEAT.md
${agentCoreHeartbeat || "No heartbeat instructions are configured."}

### Granted Tools
${agent.tools.join(", ")}

### Dynamic MCP Tools
MCP tools may be granted dynamically by connected MCP servers. When present, use their namespaced tool names exactly as provided by the runtime.

### Available Handoffs
${handoffs}
`.trim();
}

function formatHandoffs(handoffs: readonly PromptHandoffAgent[]): string {
  if (handoffs.length === 0) {
    return "No handoff agents are configured.";
  }
  return [
    "Decide autonomously whether a subagent is useful. The user does not need to manually request or name a subagent.",
    "Treat subagents as specialist tools: you remain responsible for the final user-facing answer.",
    "Use `sessions_spawn` with the target `agentId` only when the work is independent, parallelizable, and worth the added coordination.",
    "Before calling `sessions_spawn`, make the title and message explain the proposed delegation; the approval card is the user confirmation.",
    "`sessions_spawn.title` must be a short user-readable task name, and `sessions_spawn.message` must be a complete task brief.",
    "After a child task can complete, call `sessions_yield` to recover completed or failed child results before writing the final answer.",
    "Integrate completed child results into your final answer in your normal assistant voice; do not expose raw internal metadata.",
    "If the user denies the approval, continue with the task yourself or explain the limitation briefly.",
    ...handoffs.map((agent) =>
      `- agentId: ${agent.id}; name: ${agent.name}; description: ${agent.description || "No description"}`,
    ),
  ].join("\n");
}

export function assembleCodexPrompt(args: CodexAssembleArgs): string {
  const instructions = assembleAgentInstructions(args);
  return `${instructions}

## CURRENT TASK
Workspace: ${args.workspace.name} (${args.workspace.path})

User task:
${args.userInput.trim()}
`;
}
