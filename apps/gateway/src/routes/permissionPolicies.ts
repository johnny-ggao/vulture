import { Hono } from "hono";
import type {
  PermissionPolicyAction,
  PermissionPolicyScope,
  PermissionPolicyStore,
  SavePermissionPolicyRuleInput,
} from "../domain/permissionPolicyStore";

export function permissionPoliciesRouter(store: PermissionPolicyStore): Hono {
  const app = new Hono();

  app.get("/v1/permission-policies", (c) => c.json({ items: store.list() }));

  app.post("/v1/permission-policies", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    try {
      return c.json(store.upsert(parseRule(raw)), 201);
    } catch (err) {
      return c.json({ code: "permission_policy.invalid", message: errorMessage(err) }, 400);
    }
  });

  app.delete("/v1/permission-policies/:id", (c) => {
    const deleted = store.delete(c.req.param("id"));
    return deleted ? c.body(null, 204) : c.json({ code: "permission_policy.not_found" }, 404);
  });

  app.post("/v1/permission-policies/explain", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    if (!raw || typeof raw !== "object") {
      return c.json({ code: "permission_policy.invalid", message: "body must be an object" }, 400);
    }
    const input = raw as Record<string, unknown>;
    return c.json(store.explain({
      agentId: nullableString(input.agentId),
      toolId: nullableString(input.toolId),
      category: nullableString(input.category),
      command: nullableString(input.command),
    }));
  });

  return app;
}

function parseRule(raw: unknown): SavePermissionPolicyRuleInput {
  if (!raw || typeof raw !== "object") throw new Error("body must be an object");
  const value = raw as Record<string, unknown>;
  const action = value.action;
  if (action !== "allow" && action !== "ask" && action !== "deny") {
    throw new Error("action is invalid");
  }
  const scope = value.scope;
  if (scope !== undefined && scope !== "global" && scope !== "agent") {
    throw new Error("scope is invalid");
  }
  return {
    id: optionalString(value.id),
    scope: scope as PermissionPolicyScope | undefined,
    agentId: nullableString(value.agentId),
    toolId: nullableString(value.toolId),
    category: nullableString(value.category),
    commandPrefix: nullableString(value.commandPrefix),
    action: action as PermissionPolicyAction,
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    reason: nullableString(value.reason),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
