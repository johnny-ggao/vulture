import type { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { SubagentSessionStore } from "../domain/subagentSessionStore";

export type AcceptanceRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "recoverable";

export type AcceptanceStep =
  | {
      action: "writeSkill";
      as: string;
      name: string;
      description: string;
      body: string;
    }
  | {
      action: "createAgent";
      as: string;
      id: string;
      name: string;
      description: string;
      model?: string;
      reasoning?: "low" | "medium" | "high";
      tools: string[];
      skills?: string[];
      handoffAgentIds?: string[];
      instructions: string;
    }
  | {
      action: "createConversation";
      as: string;
      agentId?: string;
    }
  | {
      action: "sendMessage";
      conversation: string;
      input: string;
      attachmentIds?: string[];
      asRun: string;
      asMessage?: string;
      idempotencyKey?: string;
      sameRunAs?: string;
    }
  | {
      action: "waitForRun";
      run: string;
      status: AcceptanceRunStatus;
      timeoutMs?: number;
    }
  | {
      action: "listMessages";
      conversation: string;
      as: string;
    }
  | {
      action: "assertMessages";
      messages: string;
      roles?: string[];
      contains?: string[];
    }
  | {
      action: "seedInterruptedToolRun";
      conversation: string;
      asRun: string;
      runId?: string;
      tool: string;
      callId?: string;
      idempotent?: boolean;
    }
  | {
      action: "seedRunningRun";
      conversation: string;
      asRun: string;
      runId?: string;
    }
  | {
      action: "restartGateway";
    }
  | {
      action: "uploadTextAttachment";
      as: string;
      fileName: string;
      content: string;
      mimeType?: string;
    }
  | {
      action: "assertMessageAttachment";
      message: string;
      displayName?: string;
      mimeType?: string;
    }
  | {
      action: "readRunEvents";
      run: string;
      as: string;
      lastSeq?: number;
      lastSeqFrom?: string;
    }
  | {
      action: "assertRunEvents";
      events: string;
      types: string[];
    }
  | {
      action: "listConversationRuns";
      conversation: string;
      as: string;
      status?: AcceptanceRunStatus | "active";
    }
  | {
      action: "assertRuns";
      runs: string;
      statuses?: AcceptanceRunStatus[];
      containsRun?: string;
    }
  | {
      action: "cancelRun";
      run: string;
    }
  | {
      action: "readAttachmentContent";
      attachment: string;
      as: string;
    }
  | {
      action: "assertAttachmentContent";
      content: string;
      equals: string;
    }
  | {
      action: "createMcpServer";
      as: string;
      id: string;
      name: string;
      command: string;
      args?: string[];
      cwd?: string | null;
      env?: Record<string, string>;
      trust?: "trusted" | "ask" | "disabled";
      enabled?: boolean;
      enabledTools?: string[] | null;
      disabledTools?: string[];
    }
  | {
      action: "listMcpServers";
      as: string;
    }
  | {
      action: "assertMcpServers";
      servers: string;
      containsServer?: string;
      runtimeStatuses?: Array<McpServerResource["runtime"]["status"]>;
    }
  | {
      action: "listMcpTools";
      server: string;
      as: string;
    }
  | {
      action: "assertMcpTools";
      tools: string;
      names?: string[];
    }
  | {
      action: "seedSubagentSession";
      parentConversation: string;
      parentRun: string;
      as: string;
      agentId?: string;
      label: string;
      title?: string;
      task?: string;
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
    }
  | {
      action: "listSubagentSessions";
      as: string;
      parentConversation?: string;
      parentRun?: string;
      limit?: number;
    }
  | {
      action: "assertSubagentSessions";
      sessions: string;
      containsSession?: string;
      parentConversation?: string;
      parentRun?: string;
      statuses?: Array<SubagentSessionResource["status"]>;
      titles?: Array<string | null>;
      tasks?: Array<string | null>;
      resultSummaries?: Array<string | null>;
    }
  | {
      action: "listSubagentMessages";
      session: string;
      as: string;
    }
  | {
      action: "seedApprovedSubagentWorkflow";
      conversation: string;
      asRun: string;
      asSubagent: string;
      childAgentId: string;
      label: string;
      title?: string;
      task?: string;
      userInput: string;
      childResult: string;
      finalText: string;
      callId?: string;
    }
  | {
      action: "parallelRuns";
      runs: Array<{
        conversation: string;
        input: string;
        asRun: string;
        asMessage?: string;
        idempotencyKey?: string;
      }>;
    }
  | {
      action: "assertDistinctRuns";
      runs: string[];
    };

export interface AcceptanceScenario {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  steps: AcceptanceStep[];
}

export interface AcceptanceRunnerOptions {
  app: Hono;
  token: string;
  scenario: AcceptanceScenario;
  artifactDir: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  runId?: string;
  profileDir?: string;
  restartApp?: () => Hono;
}

export interface AcceptanceStepResult {
  index: number;
  action: AcceptanceStep["action"];
  status: "passed" | "failed";
  startedAt: string;
  endedAt: string;
  error?: string;
}

export interface AcceptanceRunResult {
  scenarioId: string;
  scenarioName: string;
  status: "passed" | "failed";
  artifactPath: string;
  steps: AcceptanceStepResult[];
  resources: AcceptanceResources;
}

interface ConversationResource {
  id: string;
  agentId?: string;
}

interface RunResource {
  id: string;
  status: AcceptanceRunStatus;
}

interface MessageResource {
  id: string;
  role: string;
  content: string;
  attachments?: AttachmentResource[];
}

interface AttachmentResource {
  id: string;
  blobId: string;
  kind: "image" | "file";
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  contentUrl: string;
  createdAt: string;
}

interface McpServerResource {
  id: string;
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  trust: "trusted" | "ask" | "disabled";
  enabled: boolean;
  enabledTools: string[] | null;
  disabledTools: string[];
  runtime: {
    status: "connected" | "disconnected" | "failed";
    lastError: string | null;
    toolCount: number;
    updatedAt: string | null;
  };
}

interface McpToolResource {
  name: string;
  description?: string;
  enabled: boolean;
}

interface SubagentSessionResource {
  id: string;
  parentConversationId: string;
  parentRunId: string;
  agentId: string;
  conversationId: string;
  label: string;
  title: string | null;
  task: string | null;
  status: "active" | "completed" | "failed" | "cancelled";
  messageCount: number;
  resultSummary: string | null;
  resultMessageId: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AgentResource {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: "low" | "medium" | "high";
  tools: string[];
  skills?: string[];
  handoffAgentIds: string[];
}

interface SkillResource {
  name: string;
  description: string;
  path: string;
}

interface RunEventResource {
  id?: string;
  type: string;
  seq?: number;
  data: unknown;
}

interface AcceptanceResources {
  conversations: Record<string, ConversationResource>;
  runs: Record<string, RunResource>;
  messages: Record<string, MessageResource>;
  messageLists: Record<string, MessageResource[]>;
  attachments: Record<string, AttachmentResource>;
  runEvents: Record<string, RunEventResource[]>;
  runLists: Record<string, RunResource[]>;
  attachmentContents: Record<string, string>;
  mcpServers: Record<string, McpServerResource>;
  mcpServerLists: Record<string, McpServerResource[]>;
  mcpToolLists: Record<string, McpToolResource[]>;
  subagentSessions: Record<string, SubagentSessionResource>;
  subagentSessionLists: Record<string, SubagentSessionResource[]>;
  agents: Record<string, AgentResource>;
  skills: Record<string, SkillResource>;
}

interface RunnerState {
  app: Hono;
  resources: AcceptanceResources;
  observations: unknown[];
}

export async function runAcceptanceScenario(options: AcceptanceRunnerOptions): Promise<AcceptanceRunResult> {
  const state: RunnerState = {
    app: options.app,
    resources: {
      conversations: {},
      runs: {},
      messages: {},
      messageLists: {},
      attachments: {},
      runEvents: {},
      runLists: {},
      attachmentContents: {},
      mcpServers: {},
      mcpServerLists: {},
      mcpToolLists: {},
      subagentSessions: {},
      subagentSessionLists: {},
      agents: {},
      skills: {},
    },
    observations: [],
  };
  const steps: AcceptanceStepResult[] = [];
  const startedAt = new Date().toISOString();
  const artifactPath = join(options.artifactDir, `${safePathSegment(options.scenario.id)}-${safePathSegment(options.runId ?? startedAt)}`);
  mkdirSync(artifactPath, { recursive: true });

  let status: AcceptanceRunResult["status"] = "passed";
  for (let index = 0; index < options.scenario.steps.length; index += 1) {
    const step = options.scenario.steps[index];
    const stepStartedAt = new Date().toISOString();
    try {
      await executeStep(options, state, step);
      steps.push({
        index,
        action: step.action,
        status: "passed",
        startedAt: stepStartedAt,
        endedAt: new Date().toISOString(),
      });
    } catch (cause) {
      status = "failed";
      steps.push({
        index,
        action: step.action,
        status: "failed",
        startedAt: stepStartedAt,
        endedAt: new Date().toISOString(),
        error: cause instanceof Error ? cause.message : String(cause),
      });
      break;
    }
  }

  const result: AcceptanceRunResult = {
    scenarioId: options.scenario.id,
    scenarioName: options.scenario.name,
    status,
    artifactPath,
    steps,
    resources: state.resources,
  };
  writeArtifacts(options.scenario, result, state.observations);
  return result;
}

async function executeStep(
  options: AcceptanceRunnerOptions,
  state: RunnerState,
  step: AcceptanceStep,
): Promise<void> {
  switch (step.action) {
    case "writeSkill": {
      if (!options.profileDir) throw new Error("writeSkill requires profileDir");
      const skillDir = join(options.profileDir, "skills", safePathSegment(step.name));
      mkdirSync(skillDir, { recursive: true });
      const path = join(skillDir, "SKILL.md");
      writeFileSync(
        path,
        [
          "---",
          `name: ${step.name}`,
          `description: ${step.description}`,
          "---",
          "",
          step.body,
          "",
        ].join("\n"),
      );
      state.resources.skills[step.as] = { name: step.name, description: step.description, path };
      observe(state, step.action, { alias: step.as, skill: state.resources.skills[step.as] });
      return;
    }
    case "createAgent": {
      const agent = await requestJson<AgentResource>(options, state, "/v1/agents", {
        method: "POST",
        idempotencyKey: `${options.scenario.id}:agent:${step.id}`,
        body: {
          id: step.id,
          name: step.name,
          description: step.description,
          model: step.model ?? "gpt-5.4",
          reasoning: step.reasoning ?? "medium",
          tools: step.tools,
          skills: step.skills,
          handoffAgentIds: step.handoffAgentIds,
          instructions: step.instructions,
        },
      });
      state.resources.agents[step.as] = agent;
      observe(state, step.action, { alias: step.as, agent });
      return;
    }
    case "createConversation": {
      const conversation = await requestJson<ConversationResource>(options, state, "/v1/conversations", {
        method: "POST",
        body: { agentId: step.agentId ?? "local-work-agent" },
      });
      state.resources.conversations[step.as] = conversation;
      observe(state, step.action, { alias: step.as, conversation });
      return;
    }
    case "sendMessage": {
      const conversation = requireAlias(state.resources.conversations, step.conversation, "conversation");
      const response = await requestJson<{
        run: RunResource;
        message: MessageResource;
        eventStreamUrl: string;
      }>(options, state, `/v1/conversations/${conversation.id}/runs`, {
        method: "POST",
        idempotencyKey: step.idempotencyKey,
        body: {
          input: step.input,
          attachmentIds: step.attachmentIds?.map((alias) =>
            requireAlias(state.resources.attachments, alias, "attachment").id
          ),
        },
      });
      if (step.sameRunAs) {
        const expected = requireAlias(state.resources.runs, step.sameRunAs, "run");
        if (response.run.id !== expected.id) {
          throw new Error(`Expected run ${response.run.id} to match ${step.sameRunAs} (${expected.id})`);
        }
      }
      state.resources.runs[step.asRun] = response.run;
      if (step.asMessage) state.resources.messages[step.asMessage] = response.message;
      observe(state, step.action, {
        conversation: step.conversation,
        input: step.input,
        runAlias: step.asRun,
        run: response.run,
        message: response.message,
        eventStreamUrl: response.eventStreamUrl,
      });
      return;
    }
    case "waitForRun": {
      const run = requireAlias(state.resources.runs, step.run, "run");
      const final = await waitForRun(options, state, run.id, step.status, step.timeoutMs);
      state.resources.runs[step.run] = final;
      observe(state, step.action, { runAlias: step.run, run: final });
      return;
    }
    case "listMessages": {
      const conversation = requireAlias(state.resources.conversations, step.conversation, "conversation");
      const response = await requestJson<{ items: MessageResource[] }>(
        options,
        state,
        `/v1/conversations/${conversation.id}/messages`,
      );
      state.resources.messageLists[step.as] = response.items;
      observe(state, step.action, { alias: step.as, messages: response.items });
      return;
    }
    case "assertMessages": {
      const messages = requireAlias(state.resources.messageLists, step.messages, "message list");
      if (step.roles) {
        const actual = messages.map((message) => message.role);
        if (!arrayEquals(actual, step.roles)) {
          throw new Error(`Expected message roles ${JSON.stringify(step.roles)}, received ${JSON.stringify(actual)}`);
        }
      }
      for (const expected of step.contains ?? []) {
        if (!messages.some((message) => message.content.includes(expected))) {
          throw new Error(`Expected at least one message to contain ${JSON.stringify(expected)}`);
        }
      }
      observe(state, step.action, { alias: step.messages });
      return;
    }
    case "seedInterruptedToolRun": {
      const conversation = requireAlias(state.resources.conversations, step.conversation, "conversation");
      const run: RunResource = {
        id: step.runId ?? `r-acceptance-${Date.now()}`,
        status: "running",
      };
      seedInterruptedToolRun(options, {
        runId: run.id,
        conversationId: conversation.id,
        agentId: conversation.agentId ?? "local-work-agent",
        tool: step.tool,
        callId: step.callId ?? `tc-${Date.now()}`,
        idempotent: step.idempotent,
      });
      state.resources.runs[step.asRun] = run;
      observe(state, step.action, { runAlias: step.asRun, run, tool: step.tool });
      return;
    }
    case "seedRunningRun": {
      const conversation = requireAlias(state.resources.conversations, step.conversation, "conversation");
      const run: RunResource = {
        id: step.runId ?? `r-acceptance-${Date.now()}`,
        status: "running",
      };
      seedRunningRun(options, {
        runId: run.id,
        conversationId: conversation.id,
        agentId: conversation.agentId ?? "local-work-agent",
      });
      state.resources.runs[step.asRun] = run;
      observe(state, step.action, { runAlias: step.asRun, run });
      return;
    }
    case "restartGateway": {
      if (!options.restartApp) throw new Error("restartGateway requires restartApp");
      state.app = options.restartApp();
      observe(state, step.action, { restarted: true });
      return;
    }
    case "uploadTextAttachment": {
      const attachment = await uploadTextAttachment(options, state, step);
      state.resources.attachments[step.as] = attachment;
      observe(state, step.action, { alias: step.as, attachment });
      return;
    }
    case "assertMessageAttachment": {
      const message = requireAlias(state.resources.messages, step.message, "message");
      const attachments = message.attachments ?? [];
      const matched = attachments.find((attachment) => {
        if (step.displayName && attachment.displayName !== step.displayName) return false;
        if (step.mimeType && !mimeTypeMatches(attachment.mimeType, step.mimeType)) return false;
        return true;
      });
      if (!matched) {
        throw new Error(
          `Expected message ${step.message} to have attachment ${JSON.stringify({
            displayName: step.displayName,
            mimeType: step.mimeType,
          })}, received ${JSON.stringify(attachments)}`,
        );
      }
      observe(state, step.action, { messageAlias: step.message, attachment: matched });
      return;
    }
    case "readRunEvents": {
      const run = requireAlias(state.resources.runs, step.run, "run");
      const events = await readRunEvents(options, state, run.id, resolveLastSeq(state, step));
      state.resources.runEvents[step.as] = events;
      observe(state, step.action, { alias: step.as, runAlias: step.run, events });
      return;
    }
    case "assertRunEvents": {
      const events = requireAlias(state.resources.runEvents, step.events, "run events");
      const actual = events.map((event) => event.type);
      for (const type of step.types) {
        if (!actual.includes(type)) {
          throw new Error(`Expected run events ${step.events} to include ${type}, received ${JSON.stringify(actual)}`);
        }
      }
      observe(state, step.action, { alias: step.events, types: step.types });
      return;
    }
    case "listConversationRuns": {
      const conversation = requireAlias(state.resources.conversations, step.conversation, "conversation");
      const query = step.status ? `?status=${encodeURIComponent(step.status)}` : "";
      const response = await requestJson<{ items: RunResource[] }>(
        options,
        state,
        `/v1/conversations/${conversation.id}/runs${query}`,
      );
      state.resources.runLists[step.as] = response.items;
      observe(state, step.action, { alias: step.as, runs: response.items });
      return;
    }
    case "assertRuns": {
      const runs = requireAlias(state.resources.runLists, step.runs, "run list");
      if (step.statuses) {
        const actual = runs.map((run) => run.status);
        if (!arrayEquals(actual, step.statuses)) {
          throw new Error(`Expected run statuses ${JSON.stringify(step.statuses)}, received ${JSON.stringify(actual)}`);
        }
      }
      if (step.containsRun) {
        const expectedRun = requireAlias(state.resources.runs, step.containsRun, "run");
        if (!runs.some((run) => run.id === expectedRun.id)) {
          throw new Error(`Expected run list ${step.runs} to contain ${expectedRun.id}`);
        }
      }
      observe(state, step.action, { alias: step.runs });
      return;
    }
    case "cancelRun": {
      const run = requireAlias(state.resources.runs, step.run, "run");
      const cancelled = await requestJson<RunResource>(options, state, `/v1/runs/${run.id}/cancel`, {
        method: "POST",
      });
      state.resources.runs[step.run] = cancelled;
      observe(state, step.action, { runAlias: step.run, run: cancelled });
      return;
    }
    case "readAttachmentContent": {
      const attachment = requireAlias(state.resources.attachments, step.attachment, "attachment");
      const content = await readAttachmentContent(options, state, attachment.id);
      state.resources.attachmentContents[step.as] = content;
      observe(state, step.action, { alias: step.as, attachment: step.attachment, bytes: content.length });
      return;
    }
    case "assertAttachmentContent": {
      const content = requireAlias(state.resources.attachmentContents, step.content, "attachment content");
      if (content !== step.equals) {
        throw new Error(`Expected attachment content ${JSON.stringify(step.equals)}, received ${JSON.stringify(content)}`);
      }
      observe(state, step.action, { alias: step.content });
      return;
    }
    case "createMcpServer": {
      const server = await requestJson<McpServerResource>(options, state, "/v1/mcp/servers", {
        method: "POST",
        body: {
          id: step.id,
          name: step.name,
          transport: "stdio",
          command: step.command,
          args: step.args,
          cwd: step.cwd,
          env: step.env,
          trust: step.trust,
          enabled: step.enabled,
          enabledTools: step.enabledTools,
          disabledTools: step.disabledTools,
        },
      });
      state.resources.mcpServers[step.as] = server;
      observe(state, step.action, { alias: step.as, server });
      return;
    }
    case "listMcpServers": {
      const response = await requestJson<{ items: McpServerResource[] }>(options, state, "/v1/mcp/servers");
      state.resources.mcpServerLists[step.as] = response.items;
      observe(state, step.action, { alias: step.as, servers: response.items });
      return;
    }
    case "assertMcpServers": {
      const servers = requireAlias(state.resources.mcpServerLists, step.servers, "MCP server list");
      if (step.containsServer) {
        const expected = requireAlias(state.resources.mcpServers, step.containsServer, "MCP server");
        if (!servers.some((server) => server.id === expected.id)) {
          throw new Error(`Expected MCP server list ${step.servers} to contain ${expected.id}`);
        }
      }
      if (step.runtimeStatuses) {
        const actual = servers.map((server) => server.runtime.status);
        if (!arrayEquals(actual, step.runtimeStatuses)) {
          throw new Error(`Expected MCP runtime statuses ${JSON.stringify(step.runtimeStatuses)}, received ${JSON.stringify(actual)}`);
        }
      }
      observe(state, step.action, { alias: step.servers });
      return;
    }
    case "listMcpTools": {
      const server = requireAlias(state.resources.mcpServers, step.server, "MCP server");
      const response = await requestJson<{ items: McpToolResource[] }>(
        options,
        state,
        `/v1/mcp/servers/${encodeURIComponent(server.id)}/tools`,
      );
      state.resources.mcpToolLists[step.as] = response.items;
      observe(state, step.action, { alias: step.as, server: step.server, tools: response.items });
      return;
    }
    case "assertMcpTools": {
      const tools = requireAlias(state.resources.mcpToolLists, step.tools, "MCP tool list");
      if (step.names) {
        const actual = tools.map((tool) => tool.name);
        if (!arrayEquals(actual, step.names)) {
          throw new Error(`Expected MCP tools ${JSON.stringify(step.names)}, received ${JSON.stringify(actual)}`);
        }
      }
      observe(state, step.action, { alias: step.tools });
      return;
    }
    case "seedSubagentSession": {
      const parentConversation = requireAlias(
        state.resources.conversations,
        step.parentConversation,
        "conversation",
      );
      const parentRun = requireAlias(state.resources.runs, step.parentRun, "run");
      const session = seedSubagentSession(options, {
        parentConversationId: parentConversation.id,
        parentRunId: parentRun.id,
        agentId: step.agentId ?? "local-work-agent",
        label: step.label,
        title: step.title,
        task: step.task,
        messages: step.messages ?? [],
      });
      state.resources.subagentSessions[step.as] = session;
      observe(state, step.action, { alias: step.as, session });
      return;
    }
    case "listSubagentSessions": {
      const params = new URLSearchParams();
      if (step.parentConversation) {
        params.set(
          "parentConversationId",
          requireAlias(state.resources.conversations, step.parentConversation, "conversation").id,
        );
      }
      if (step.parentRun) {
        params.set("parentRunId", requireAlias(state.resources.runs, step.parentRun, "run").id);
      }
      if (step.limit) params.set("limit", String(step.limit));
      const query = params.toString();
      const response = await requestJson<{ items: SubagentSessionResource[] }>(
        options,
        state,
        `/v1/subagent-sessions${query ? `?${query}` : ""}`,
      );
      state.resources.subagentSessionLists[step.as] = response.items;
      observe(state, step.action, { alias: step.as, sessions: response.items });
      return;
    }
    case "assertSubagentSessions": {
      const sessions = requireAlias(state.resources.subagentSessionLists, step.sessions, "subagent session list");
      if (step.statuses) {
        const actual = sessions.map((session) => session.status);
        if (!arrayEquals(actual, step.statuses)) {
          throw new Error(`Expected subagent statuses ${JSON.stringify(step.statuses)}, received ${JSON.stringify(actual)}`);
        }
      }
      if (step.titles) {
        const actual = sessions.map((session) => session.title);
        if (!arrayEquals(actual, step.titles)) {
          throw new Error(`Expected subagent titles ${JSON.stringify(step.titles)}, received ${JSON.stringify(actual)}`);
        }
      }
      if (step.tasks) {
        const actual = sessions.map((session) => session.task);
        if (!arrayEquals(actual, step.tasks)) {
          throw new Error(`Expected subagent tasks ${JSON.stringify(step.tasks)}, received ${JSON.stringify(actual)}`);
        }
      }
      if (step.resultSummaries) {
        const actual = sessions.map((session) => session.resultSummary);
        if (!arrayEquals(actual, step.resultSummaries)) {
          throw new Error(
            `Expected subagent result summaries ${JSON.stringify(step.resultSummaries)}, received ${JSON.stringify(actual)}`,
          );
        }
      }
      if (step.containsSession) {
        const expected = requireAlias(
          state.resources.subagentSessions,
          step.containsSession,
          "subagent session",
        );
        if (!sessions.some((session) => session.id === expected.id)) {
          throw new Error(`Expected subagent list ${step.sessions} to contain ${expected.id}`);
        }
      }
      if (step.parentConversation) {
        const expected = requireAlias(state.resources.conversations, step.parentConversation, "conversation");
        if (!sessions.every((session) => session.parentConversationId === expected.id)) {
          throw new Error(`Expected all subagent sessions to belong to parent conversation ${expected.id}`);
        }
      }
      if (step.parentRun) {
        const expected = requireAlias(state.resources.runs, step.parentRun, "run");
        if (!sessions.every((session) => session.parentRunId === expected.id)) {
          throw new Error(`Expected all subagent sessions to belong to parent run ${expected.id}`);
        }
      }
      observe(state, step.action, { alias: step.sessions });
      return;
    }
    case "listSubagentMessages": {
      const session = requireAlias(state.resources.subagentSessions, step.session, "subagent session");
      const response = await requestJson<{ items: MessageResource[] }>(
        options,
        state,
        `/v1/subagent-sessions/${encodeURIComponent(session.id)}/messages`,
      );
      state.resources.messageLists[step.as] = response.items;
      observe(state, step.action, { alias: step.as, messages: response.items });
      return;
    }
    case "seedApprovedSubagentWorkflow": {
      const conversation = requireAlias(state.resources.conversations, step.conversation, "conversation");
      const result = seedApprovedSubagentWorkflow(options, {
        conversationId: conversation.id,
        parentAgentId: conversation.agentId ?? "local-work-agent",
        childAgentId: step.childAgentId,
        label: step.label,
        title: step.title,
        task: step.task,
        userInput: step.userInput,
        childResult: step.childResult,
        finalText: step.finalText,
        callId: step.callId ?? "c-subagent-spawn",
      });
      state.resources.runs[step.asRun] = result.run;
      state.resources.subagentSessions[step.asSubagent] = result.session;
      observe(state, step.action, {
        runAlias: step.asRun,
        subagentAlias: step.asSubagent,
        run: result.run,
        session: result.session,
      });
      return;
    }
    case "parallelRuns": {
      const responses = await Promise.all(
        step.runs.map(async (entry) => {
          const conversation = requireAlias(
            state.resources.conversations,
            entry.conversation,
            "conversation",
          );
          const response = await requestJson<{
            run: RunResource;
            message: MessageResource;
            eventStreamUrl: string;
          }>(options, state, `/v1/conversations/${conversation.id}/runs`, {
            method: "POST",
            idempotencyKey: entry.idempotencyKey,
            body: { input: entry.input },
          });
          return { entry, response };
        }),
      );
      for (const { entry, response } of responses) {
        state.resources.runs[entry.asRun] = response.run;
        if (entry.asMessage) state.resources.messages[entry.asMessage] = response.message;
      }
      observe(state, step.action, {
        runs: responses.map(({ entry, response }) => ({
          conversation: entry.conversation,
          input: entry.input,
          runAlias: entry.asRun,
          run: response.run,
        })),
      });
      return;
    }
    case "assertDistinctRuns": {
      const ids = step.runs.map(
        (alias) => requireAlias(state.resources.runs, alias, "run").id,
      );
      const unique = new Set(ids);
      if (unique.size !== ids.length) {
        throw new Error(
          `Expected distinct run IDs across ${JSON.stringify(step.runs)}, got ${JSON.stringify(ids)}`,
        );
      }
      observe(state, step.action, { runs: step.runs, ids });
      return;
    }
  }
}

async function waitForRun(
  options: AcceptanceRunnerOptions,
  state: RunnerState,
  runId: string,
  expectedStatus: AcceptanceRunStatus,
  timeoutMs = options.timeoutMs ?? 10_000,
): Promise<RunResource> {
  const deadline = Date.now() + timeoutMs;
  let latest = await requestJson<RunResource>(options, state, `/v1/runs/${runId}`);
  while (Date.now() <= deadline) {
    if (latest.status === expectedStatus) return latest;
    if (isTerminal(latest.status) && latest.status !== expectedStatus) {
      throw new Error(`Run ${runId} reached ${latest.status}, expected ${expectedStatus}`);
    }
    await delay(options.pollIntervalMs ?? 100);
    latest = await requestJson<RunResource>(options, state, `/v1/runs/${runId}`);
  }
  throw new Error(`Run ${runId} did not reach ${expectedStatus} within ${timeoutMs}ms; latest status was ${latest.status}`);
}

async function requestJson<T>(
  options: AcceptanceRunnerOptions,
  state: RunnerState,
  path: string,
  request: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const res = await currentApp(options, state).request(path, {
    method: request.method ?? "GET",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": request.idempotencyKey ?? `${options.scenario.id}:${path}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message = typeof parsed?.message === "string" ? parsed.message : text;
    throw new Error(`HTTP ${res.status} ${path}: ${message}`);
  }
  return parsed as T;
}

function currentApp(options: AcceptanceRunnerOptions, state?: RunnerState): Hono {
  return state?.app ?? options.app;
}

async function readRunEvents(
  options: AcceptanceRunnerOptions,
  state: RunnerState,
  runId: string,
  lastSeq?: number,
): Promise<RunEventResource[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
  };
  if (lastSeq !== undefined) headers["Last-Event-ID"] = String(lastSeq);
  const res = await currentApp(options, state).request(`/v1/runs/${runId}/events`, {
    method: "GET",
    headers,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} /v1/runs/${runId}/events: ${text}`);
  }
  return parseSseEvents(text);
}

async function readAttachmentContent(
  options: AcceptanceRunnerOptions,
  state: RunnerState,
  attachmentId: string,
): Promise<string> {
  const res = await currentApp(options, state).request(`/v1/attachments/${encodeURIComponent(attachmentId)}/content`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${options.token}`,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} /v1/attachments/${attachmentId}/content: ${text}`);
  }
  return text;
}

function parseSseEvents(text: string): RunEventResource[] {
  const events: RunEventResource[] = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split(/\n/).map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length === 0) continue;
    let id: string | undefined;
    let type = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      if (line.startsWith("event:")) type = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const dataText = dataLines.join("\n");
    const data = dataText ? JSON.parse(dataText) as unknown : null;
    const seq = typeof data === "object" && data !== null && "seq" in data && typeof data.seq === "number"
      ? data.seq
      : id !== undefined
        ? Number.parseInt(id, 10)
        : undefined;
    events.push({ id, type, seq: Number.isNaN(seq) ? undefined : seq, data });
  }
  return events;
}

function resolveLastSeq(
  state: RunnerState,
  step: Extract<AcceptanceStep, { action: "readRunEvents" }>,
): number | undefined {
  if (step.lastSeq !== undefined) return step.lastSeq;
  if (!step.lastSeqFrom) return undefined;
  const events = requireAlias(state.resources.runEvents, step.lastSeqFrom, "run events");
  const seqs = events.map((event) => event.seq).filter((seq): seq is number => typeof seq === "number");
  return seqs.length === 0 ? undefined : Math.max(...seqs);
}

async function uploadTextAttachment(
  options: AcceptanceRunnerOptions,
  state: RunnerState,
  step: Extract<AcceptanceStep, { action: "uploadTextAttachment" }>,
): Promise<AttachmentResource> {
  const form = new FormData();
  form.set(
    "file",
    new File([step.content], step.fileName, {
      type: step.mimeType ?? "text/plain",
    }),
  );
  const res = await currentApp(options, state).request("/v1/attachments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Idempotency-Key": `${options.scenario.id}:attachment:${Date.now()}:${Math.random().toString(16).slice(2)}`,
    },
    body: form,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const message = typeof parsed?.message === "string" ? parsed.message : text;
    throw new Error(`HTTP ${res.status} /v1/attachments: ${message}`);
  }
  return parsed as AttachmentResource;
}

function seedInterruptedToolRun(
  options: AcceptanceRunnerOptions,
  input: {
    runId: string;
    conversationId: string;
    agentId: string;
    tool: string;
    callId: string;
    idempotent?: boolean;
  },
): void {
  if (!options.profileDir) throw new Error("seedInterruptedToolRun requires profileDir");
  const db = openDatabase(join(options.profileDir, "data.sqlite"));
  applyMigrations(db);
  try {
    db.query(
      `INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id, started_at)
       VALUES (?, ?, ?, 'running', 'm-acceptance-seed', ?)`,
    ).run(input.runId, input.conversationId, input.agentId, new Date().toISOString());
    db.query(
      `INSERT INTO run_recovery_state(
         run_id, schema_version, sdk_state, metadata_json, checkpoint_seq, active_tool_json, updated_at
       ) VALUES (?, 1, ?, ?, 0, ?, ?)`,
    ).run(
      input.runId,
      "acceptance-sdk-state",
      JSON.stringify({
        runId: input.runId,
        conversationId: input.conversationId,
        agentId: input.agentId,
        model: "gpt-5.4",
        systemPrompt: "system",
        userInput: "acceptance recovery",
        workspacePath: "",
        providerKind: "stub",
        updatedAt: new Date().toISOString(),
      }),
      JSON.stringify({
        callId: input.callId,
        tool: input.tool,
        input: {},
        startedSeq: 0,
        idempotent: input.idempotent,
      }),
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

function seedRunningRun(
  options: AcceptanceRunnerOptions,
  input: {
    runId: string;
    conversationId: string;
    agentId: string;
  },
): void {
  if (!options.profileDir) throw new Error("seedRunningRun requires profileDir");
  const db = openDatabase(join(options.profileDir, "data.sqlite"));
  applyMigrations(db);
  try {
    db.query(
      `INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id, started_at)
       VALUES (?, ?, ?, 'running', 'm-acceptance-seed', ?)`,
    ).run(input.runId, input.conversationId, input.agentId, new Date().toISOString());
  } finally {
    db.close();
  }
}

function seedSubagentSession(
  options: AcceptanceRunnerOptions,
  input: {
    parentConversationId: string;
    parentRunId: string;
    agentId: string;
    label: string;
    title?: string;
    task?: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  },
): SubagentSessionResource {
  if (!options.profileDir) throw new Error("seedSubagentSession requires profileDir");
  const db = openDatabase(join(options.profileDir, "data.sqlite"));
  applyMigrations(db);
  try {
    const conversations = new ConversationStore(db);
    const messages = new MessageStore(db);
    const runs = new RunStore(db);
    const sessions = new SubagentSessionStore(db, { runs, messages });
    const child = conversations.create({
      agentId: input.agentId,
      title: input.title ?? input.label,
    });
    for (const message of input.messages) {
      messages.append({
        conversationId: child.id,
        role: message.role,
        content: message.content,
        runId: null,
      });
    }
    const session = sessions.create({
      parentConversationId: input.parentConversationId,
      parentRunId: input.parentRunId,
      agentId: input.agentId,
      conversationId: child.id,
      label: input.label,
      title: input.title,
      task: input.task,
    });
    return sessions.refreshStatus(session.id) as SubagentSessionResource;
  } finally {
    db.close();
  }
}

function seedApprovedSubagentWorkflow(
  options: AcceptanceRunnerOptions,
  input: {
    conversationId: string;
    parentAgentId: string;
    childAgentId: string;
    label: string;
    title?: string;
    task?: string;
    userInput: string;
    childResult: string;
    finalText: string;
    callId: string;
  },
): { run: RunResource; session: SubagentSessionResource } {
  if (!options.profileDir) throw new Error("seedApprovedSubagentWorkflow requires profileDir");
  const db = openDatabase(join(options.profileDir, "data.sqlite"));
  applyMigrations(db);
  try {
    const conversations = new ConversationStore(db);
    const messages = new MessageStore(db);
    const runs = new RunStore(db);
    const sessions = new SubagentSessionStore(db, { runs, messages });
    const userMessage = messages.append({
      conversationId: input.conversationId,
      role: "user",
      content: input.userInput,
      runId: null,
    });
    const run = runs.create({
      conversationId: input.conversationId,
      agentId: input.parentAgentId,
      triggeredByMessageId: userMessage.id,
    });
    runs.markRunning(run.id);
    runs.appendEvent(run.id, {
      type: "run.started",
      agentId: input.parentAgentId,
      model: "gpt-5.4",
    });
    const toolInput = {
      agentId: input.childAgentId,
      label: input.label,
      title: input.title ?? input.label,
      message: input.task ?? input.userInput,
    };
    runs.appendEvent(run.id, {
      type: "tool.planned",
      callId: input.callId,
      tool: "sessions_spawn",
      input: toolInput,
    });
    runs.appendEvent(run.id, {
      type: "tool.ask",
      callId: input.callId,
      tool: "sessions_spawn",
      reason: `建议开启子智能体 ${input.label}：${input.label}`,
      approvalToken: "acceptance-approved-subagent",
    });
    runs.appendEvent(run.id, { type: "tool.started", callId: input.callId });

    const child = conversations.create({
      agentId: input.childAgentId,
      title: input.title ?? input.label,
    });
    const childPrompt = messages.append({
      conversationId: child.id,
      role: "user",
      content: toolInput.message,
      runId: null,
    });
    const childRun = runs.create({
      conversationId: child.id,
      agentId: input.childAgentId,
      triggeredByMessageId: childPrompt.id,
    });
    const childAssistant = messages.append({
      conversationId: child.id,
      role: "assistant",
      content: input.childResult,
      runId: childRun.id,
    });
    runs.markSucceeded(childRun.id, childAssistant.id);
    const session = sessions.create({
      parentConversationId: input.conversationId,
      parentRunId: run.id,
      agentId: input.childAgentId,
      conversationId: child.id,
      label: input.label,
      title: input.title,
      task: toolInput.message,
    });
    runs.appendEvent(run.id, {
      type: "tool.completed",
      callId: input.callId,
      output: {
        sessionId: session.id,
        conversationId: child.id,
        runId: childRun.id,
      },
    });
    const completedSession = sessions.refreshStatus(session.id) as SubagentSessionResource;
    const yieldCallId = `${input.callId}-yield`;
    runs.appendEvent(run.id, {
      type: "tool.planned",
      callId: yieldCallId,
      tool: "sessions_yield",
      input: { parentRunId: run.id },
    });
    runs.appendEvent(run.id, { type: "tool.started", callId: yieldCallId });
    runs.appendEvent(run.id, {
      type: "tool.completed",
      callId: yieldCallId,
      output: {
        active: [],
        completed: [
          {
            sessionId: completedSession.id,
            agentId: completedSession.agentId,
            title: completedSession.title,
            task: completedSession.task,
            resultSummary: completedSession.resultSummary,
          },
        ],
        failed: [],
      },
    });
    runs.appendEvent(run.id, { type: "text.delta", text: input.finalText });
    const assistantMessage = messages.append({
      conversationId: input.conversationId,
      role: "assistant",
      content: input.finalText,
      runId: run.id,
    });
    runs.markSucceeded(run.id, assistantMessage.id);
    runs.appendEvent(run.id, {
      type: "run.completed",
      resultMessageId: assistantMessage.id,
      finalText: input.finalText,
    });
    return {
      run: runs.get(run.id) as RunResource,
      session: completedSession,
    };
  } finally {
    db.close();
  }
}

function writeArtifacts(
  scenario: AcceptanceScenario,
  result: AcceptanceRunResult,
  observations: unknown[],
): void {
  writeFileSync(join(result.artifactPath, "summary.json"), `${JSON.stringify({
    scenarioId: result.scenarioId,
    scenarioName: result.scenarioName,
    status: result.status,
    steps: result.steps,
    resources: result.resources,
  }, null, 2)}\n`);
  writeFileSync(join(result.artifactPath, "events.jsonl"), observations.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  writeFileSync(join(result.artifactPath, "transcript.md"), renderTranscript(scenario, result));
}

function renderTranscript(scenario: AcceptanceScenario, result: AcceptanceRunResult): string {
  const lines = [
    `# ${scenario.name}`,
    "",
    `Scenario: ${scenario.id}`,
    `Status: ${result.status}`,
    "",
    "## Steps",
    "",
  ];
  for (const step of result.steps) {
    lines.push(`- ${step.status.toUpperCase()} ${step.index + 1}. ${step.action}${step.error ? `: ${step.error}` : ""}`);
  }
  lines.push("", "## Messages", "");
  for (const [alias, messages] of Object.entries(result.resources.messageLists)) {
    lines.push(`### ${alias}`, "");
    for (const message of messages) {
      lines.push(`- ${message.role}: ${message.content}`);
      for (const attachment of message.attachments ?? []) {
        lines.push(`  - attachment: ${attachment.displayName} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`);
      }
    }
    lines.push("");
  }
  if (Object.keys(result.resources.attachments).length > 0) {
    lines.push("## Attachments", "");
    for (const [alias, attachment] of Object.entries(result.resources.attachments)) {
      lines.push(`- ${alias}: ${attachment.displayName} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`);
    }
    lines.push("");
  }
  if (Object.keys(result.resources.runLists).length > 0) {
    lines.push("## Run Lists", "");
    for (const [alias, runs] of Object.entries(result.resources.runLists)) {
      lines.push(`### ${alias}`, "");
      for (const run of runs) {
        lines.push(`- ${run.id}: ${run.status}`);
      }
      lines.push("");
    }
  }
  if (Object.keys(result.resources.attachmentContents).length > 0) {
    lines.push("## Attachment Contents", "");
    for (const [alias, content] of Object.entries(result.resources.attachmentContents)) {
      lines.push(`- ${alias}: ${JSON.stringify(content)}`);
    }
    lines.push("");
  }
  if (Object.keys(result.resources.mcpServerLists).length > 0) {
    lines.push("## MCP Servers", "");
    for (const [alias, servers] of Object.entries(result.resources.mcpServerLists)) {
      lines.push(`### ${alias}`, "");
      for (const server of servers) {
        lines.push(`- ${server.id}: ${server.runtime.status} (${server.trust})`);
      }
      lines.push("");
    }
  }
  if (Object.keys(result.resources.mcpToolLists).length > 0) {
    lines.push("## MCP Tools", "");
    for (const [alias, tools] of Object.entries(result.resources.mcpToolLists)) {
      lines.push(`### ${alias}`, "");
      for (const tool of tools) {
        lines.push(`- ${tool.name}: ${tool.enabled ? "enabled" : "disabled"}`);
      }
      if (tools.length === 0) lines.push("- none");
      lines.push("");
    }
  }
  if (Object.keys(result.resources.subagentSessionLists).length > 0) {
    lines.push("## Subagent Sessions", "");
    for (const [alias, sessions] of Object.entries(result.resources.subagentSessionLists)) {
      lines.push(`### ${alias}`, "");
      for (const session of sessions) {
        const parts = [
          `${session.id}: ${session.status} ${session.label}`,
          session.title ? `title=${session.title}` : null,
          session.task ? `task=${session.task}` : null,
          session.resultSummary ? `result=${session.resultSummary}` : null,
        ].filter(Boolean);
        lines.push(`- ${parts.join(" | ")}`);
      }
      if (sessions.length === 0) lines.push("- none");
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function observe(state: RunnerState, action: AcceptanceStep["action"], data: unknown): void {
  state.observations.push({
    ts: new Date().toISOString(),
    action,
    data,
  });
}

function requireAlias<T>(items: Record<string, T>, alias: string, kind: string): T {
  const value = items[alias];
  if (!value) throw new Error(`Unknown ${kind} alias ${JSON.stringify(alias)}`);
  return value;
}

function isTerminal(status: AcceptanceRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function arrayEquals<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mimeTypeMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.split(";")[0]?.trim() === expected;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
