import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ArtifactStore } from "../domain/artifactStore";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { PermissionPolicyStore } from "../domain/permissionPolicyStore";
import { RunStore } from "../domain/runStore";
import { SkillCatalogStore } from "../domain/skillCatalogStore";
import { SubagentSessionStore } from "../domain/subagentSessionStore";
import { artifactsRouter } from "./artifacts";
import { browserCapabilitiesRouter } from "./browserCapabilities";
import { mcpProxyRouter } from "./mcpProxy";
import { permissionPoliciesRouter } from "./permissionPolicies";
import { runTraceRouter } from "./runTrace";
import { runtimeDiagnosticsRouter } from "./runtimeDiagnostics";
import { skillCatalogRouter } from "./skillCatalog";

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("product ops foundation routes", () => {
  test("imports and installs a skill catalog package", async () => {
    const { dir, cleanup } = tempDir("vulture-skill-catalog-");
    const packageDir = join(dir, "packages", "csv-insights");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "SKILL.md"),
      [
        "---",
        "name: csv-insights",
        "description: Analyze CSV files",
        "version: 1.2.3",
        "---",
        "",
        "Use this for CSV analysis.",
        "",
      ].join("\n"),
    );
    const app = skillCatalogRouter(new SkillCatalogStore(dir));

    const imported = await app.request("/v1/skill-catalog/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packagePath: packageDir }),
    });
    expect(imported.status).toBe(201);
    expect(await imported.json()).toMatchObject({
      name: "csv-insights",
      version: "1.2.3",
      installed: false,
    });

    const installed = await app.request("/v1/skill-catalog/csv-insights/install", { method: "POST" });
    expect(installed.status).toBe(200);
    expect(await installed.json()).toMatchObject({
      name: "csv-insights",
      installed: true,
      installedVersion: "1.2.3",
    });
    cleanup();
  });

  test("explains permission policy matches before default ask", async () => {
    const { dir, cleanup } = tempDir("vulture-permission-policy-");
    const app = permissionPoliciesRouter(
      new PermissionPolicyStore(join(dir, "policies", "permission-policies.json")),
    );

    const created = await app.request("/v1/permission-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "deny-rm",
        toolId: "process.exec",
        commandPrefix: "rm ",
        action: "deny",
        reason: "destructive command",
      }),
    });
    expect(created.status).toBe(201);

    const denied = await app.request("/v1/permission-policies/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolId: "process.exec", command: "rm -rf tmp" }),
    });
    expect(await denied.json()).toMatchObject({
      action: "deny",
      matchedRule: { id: "deny-rm" },
      reason: "destructive command",
    });

    const fallback = await app.request("/v1/permission-policies/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolId: "fs.read" }),
    });
    expect(await fallback.json()).toMatchObject({ action: "ask", matchedRule: null });
    cleanup();
  });

  test("creates artifacts and exposes them in run trace", async () => {
    const { dir, cleanup } = tempDir("vulture-run-trace-");
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    const conversations = new ConversationStore(db);
    const messages = new MessageStore(db);
    const runs = new RunStore(db);
    const subagentSessions = new SubagentSessionStore(db, { runs, messages });
    const artifacts = new ArtifactStore(join(dir, "artifacts", "index.json"));
    const conversation = conversations.create({ agentId: "local-work-agent" });
    const user = messages.append({
      conversationId: conversation.id,
      role: "user",
      content: "make report",
      runId: null,
    });
    const run = runs.create({
      conversationId: conversation.id,
      agentId: conversation.agentId,
      triggeredByMessageId: user.id,
    });
    runs.appendEvent(run.id, { type: "run.started", agentId: conversation.agentId, model: "gpt-5.4" });

    const app = new Hono();
    app.route("/", artifactsRouter(artifacts));
    app.route("/", runTraceRouter({ runs, messages, subagentSessions, artifacts }));

    const created = await app.request("/v1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: run.id,
        conversationId: conversation.id,
        agentId: conversation.agentId,
        kind: "text",
        title: "Report",
        content: "hello",
      }),
    });
    expect(created.status).toBe(201);

    const trace = await app.request(`/v1/runs/${run.id}/trace`);
    expect(trace.status).toBe(200);
    const body = await trace.json();
    expect(body.run.id).toBe(run.id);
    expect(body.events).toHaveLength(1);
    expect(body.artifacts).toMatchObject([{ title: "Report", content: "hello" }]);
    db.close();
    cleanup();
  });

  test("exposes browser, MCP proxy, and runtime diagnostic descriptors", async () => {
    const app = new Hono();
    app.route("/", browserCapabilitiesRouter());
    app.route("/", mcpProxyRouter());
    app.route("/", runtimeDiagnosticsRouter());

    const browser = await app.request("/v1/browser/capabilities");
    expect(browser.status).toBe(200);
    expect((await browser.json()).supportedTools.length).toBeGreaterThan(0);

    const manifest = await app.request("/v1/mcp/server/manifest");
    expect(manifest.status).toBe(200);
    expect((await manifest.json()).tools.length).toBeGreaterThan(0);

    const diagnostics = await app.request("/v1/runtime/diagnostics");
    expect(diagnostics.status).toBe(200);
    expect(typeof (await diagnostics.json()).runtime.node).toBe("string");
  });
});
