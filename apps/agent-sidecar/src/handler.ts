import { ZodError } from "zod";
import { runAgent as defaultRunAgent } from "./agents";
import { parseJsonLine, type RpcMessage } from "./rpc";
import type { ToolGateway } from "./tools";

type GatewayFactory = (runId: string) => ToolGateway;
type RunAgent = (params: unknown, createGateway: GatewayFactory) => Promise<unknown>;

export type RequestHandlerOptions = {
  runAgent?: RunAgent;
  writeMessage?: (message: RpcMessage) => void;
};

function errorResponse(
  id: string | number | undefined,
  code: string,
  message: string,
  recoverable: boolean,
): RpcMessage {
  return {
    id,
    error: {
      code,
      message,
      recoverable,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isZodError(error: unknown): error is ZodError {
  return error instanceof ZodError || (typeof error === "object" && error !== null && "issues" in error);
}

function requestIdFromJson(line: string): string | number | undefined {
  try {
    const raw = JSON.parse(line) as { id?: unknown };
    return typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : undefined;
  } catch {
    return undefined;
  }
}

export function createRequestHandler(options: RequestHandlerOptions = {}) {
  const runAgent = options.runAgent ?? defaultRunAgent;
  const writeMessage = options.writeMessage ?? (() => {});

  const createGateway: GatewayFactory = (runId) => ({
    async request(toolName: string, input: Record<string, unknown>) {
      writeMessage({
        method: "tool.request",
        params: { runId, tool: toolName, input },
      });

      return { ok: false, reason: "interactive tool response loop is owned by Rust integration" };
    },
  });

  return async function handleLine(line: string): Promise<RpcMessage> {
    let request: ReturnType<typeof parseJsonLine>;

    try {
      request = parseJsonLine(line);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return errorResponse(undefined, "PARSE_ERROR", errorMessage(error), true);
      }

      return errorResponse(requestIdFromJson(line), "INVALID_PARAMS", errorMessage(error), true);
    }

    if (request.method === "health.check") {
      return { id: request.id, result: { ok: true, runtime: "bun" } };
    }

    if (request.method === "run.create") {
      try {
        const events = await runAgent(request.params, createGateway);
        return { id: request.id, result: { events } };
      } catch (error) {
        const code = isZodError(error) ? "INVALID_PARAMS" : "RUN_FAILED";
        return errorResponse(request.id, code, errorMessage(error), true);
      }
    }

    return errorResponse(
      request.id,
      "METHOD_NOT_FOUND",
      `Unknown method ${request.method}`,
      false,
    );
  };
}
