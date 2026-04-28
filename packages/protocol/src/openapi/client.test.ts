import { describe, expect, test } from "bun:test";
import {
  buildOpenApiV1Path,
  getOpenApiV1Endpoint,
  OPENAPI_V1_ENDPOINTS_BY_OPERATION_ID,
  type OpenApiV1PathParams,
} from "./client";

describe("OpenAPI v1 client registry", () => {
  test("looks up endpoint metadata by operation id", () => {
    expect(getOpenApiV1Endpoint("createConversationRun")).toEqual({
      operationId: "createConversationRun",
      method: "POST",
      path: "/v1/conversations/{cid}/runs",
      tags: ["runs"],
      hasRequestBody: true,
      responseStatuses: [202, 404, 409],
    });
    expect(OPENAPI_V1_ENDPOINTS_BY_OPERATION_ID.getProfile.method).toBe("GET");
  });

  test("builds paths with encoded route parameters", () => {
    expect(buildOpenApiV1Path("getAgent", { id: "local work/agent" })).toBe(
      "/v1/agents/local%20work%2Fagent",
    );
    expect(buildOpenApiV1Path("createConversationRun", { cid: "c-1" })).toBe(
      "/v1/conversations/c-1/runs",
    );
    expect(buildOpenApiV1Path("getProfile")).toBe("/v1/profile");
  });

  test("throws when a required route parameter is missing at runtime", () => {
    expect(() =>
      buildOpenApiV1Path("getAttachmentContent", {} as OpenApiV1PathParams<"getAttachmentContent">),
    ).toThrow("missing OpenAPI path parameter 'id'");
  });
});
