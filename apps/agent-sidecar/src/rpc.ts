import { JsonRpcRequest } from "@vulture/protocol";

export type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    recoverable?: boolean;
    details?: Record<string, unknown>;
  };
};

export function parseJsonLine(line: string) {
  const raw = JSON.parse(line);
  return JsonRpcRequest.parse(raw);
}

export function serializeMessage(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}
