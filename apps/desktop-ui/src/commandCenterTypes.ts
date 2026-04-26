export type AgentToolName = "shell.exec" | "browser.snapshot" | "browser.click";

export type AgentView = {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: string;
  tools: AgentToolName[];
  instructions: string;
};

export type WorkspaceView = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type OpenAiAuthStatus = {
  configured: boolean;
  source: "keychain" | "environment" | "missing";
};

export type SaveAgentRequest = AgentView;

export type SaveWorkspaceRequest = {
  id: string;
  name: string;
  path: string;
};
