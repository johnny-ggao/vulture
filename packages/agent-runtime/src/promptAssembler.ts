import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PromptAgent {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: string;
  tools: string[];
  instructions: string;
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

export function assembleAgentInstructions(args: AssembleArgs): string {
  const { packDir, agent, workspace } = args;
  const SOUL = readSection(packDir, "SOUL.md");
  const IDENTITY = readSection(packDir, "IDENTITY.md");
  const DEFAULT_AGENTS = readSection(packDir, "AGENTS.md");
  const TOOLS = readSection(packDir, "TOOLS.md");
  const USER = readSection(packDir, "USER.md");
  const workspaceAgents = loadWorkspaceAgentsMd(workspace.path);

  return `# Vulture Agent Pack

## SOUL.md
${SOUL}

## IDENTITY.md
${IDENTITY}

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

## AGENTS.md
### Default Agent Rules
${DEFAULT_AGENTS}

### Workspace AGENTS.md
${workspaceAgents}

## TOOLS.md
${TOOLS}

### Granted Tools
${agent.tools.join(", ")}
`.trim();
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
