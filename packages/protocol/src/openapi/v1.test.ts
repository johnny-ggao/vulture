import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildOpenApiV1 } from "./v1";

type OpenApiDoc = {
  openapi: string;
  paths: Record<string, Record<string, {
    operationId?: string;
    responses?: Record<string, unknown>;
  }>>;
  components: { schemas: Record<string, unknown> };
};

describe("OpenAPI v1", () => {
  test("documents core gateway REST paths", () => {
    const doc = buildOpenApiV1() as OpenApiDoc;

    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/v1/agents");
    expect(Object.keys(doc.paths)).toContain("/v1/conversations/{cid}/runs");
    expect(Object.keys(doc.paths)).toContain("/v1/attachments");
    expect(Object.keys(doc.components.schemas)).toContain("RunEvent");
    expect(Object.keys(doc.components.schemas)).toContain("PostMessageRequest");
  });

  test("has unique operation ids for every operation", () => {
    const doc = buildOpenApiV1() as OpenApiDoc;
    const operationIds = Object.values(doc.paths).flatMap((pathItem) =>
      Object.values(pathItem).map((operation) => operation.operationId),
    );

    expect(operationIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  test("all local schema refs resolve", () => {
    const doc = buildOpenApiV1() as OpenApiDoc;
    const refs = collectRefs(doc);

    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      const schemaName = ref.slice("#/components/schemas/".length);
      expect(doc.components.schemas[schemaName]).toBeDefined();
    }
  });

  test("schemas preserve Zod constraints", () => {
    const doc = buildOpenApiV1() as OpenApiDoc;
    const agent = doc.components.schemas.Agent as {
      required: string[];
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    const postMessage = doc.components.schemas.PostMessageRequest as {
      properties: { attachmentIds: { maxItems: number } };
    };

    expect(agent.required).toContain("id");
    expect(agent.additionalProperties).toBe(false);
    expect(agent.properties.reasoning).toEqual({
      type: "string",
      enum: ["low", "medium", "high"],
    });
    expect(postMessage.properties.attachmentIds.maxItems).toBe(10);
  });

  test("generated artifact is up to date", () => {
    const expected = `${JSON.stringify(buildOpenApiV1(), null, 2)}\n`;
    const actual = readFileSync(resolve(import.meta.dir, "../../openapi/v1.json"), "utf8");
    expect(actual).toBe(expected);
  });
});

function collectRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof child === "string") {
      refs.add(child);
    } else {
      collectRefs(child, refs);
    }
  }
  return refs;
}
