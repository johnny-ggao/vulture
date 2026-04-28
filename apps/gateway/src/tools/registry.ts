import type { GatewayToolSpec } from "./types";

export class ToolRegistry {
  private readonly specs = new Map<string, GatewayToolSpec>();

  constructor(specs: readonly GatewayToolSpec[] = []) {
    for (const spec of specs) {
      this.register(spec);
    }
  }

  register(spec: GatewayToolSpec): void {
    if (this.specs.has(spec.id)) {
      throw new Error(`duplicate tool id: ${spec.id}`);
    }
    this.specs.set(spec.id, spec);
  }

  get(id: string): GatewayToolSpec | undefined {
    return this.specs.get(id);
  }

  list(): GatewayToolSpec[] {
    return [...this.specs.values()];
  }
}

export interface ToolPolicy {
  allow?: readonly string[];
  deny?: readonly string[];
}

export function resolveEffectiveTools(
  registry: ToolRegistry,
  policy: ToolPolicy = {},
): GatewayToolSpec[] {
  const deny = new Set(policy.deny ?? []);
  const allow = policy.allow ? new Set(policy.allow) : null;
  if (allow) {
    for (const toolId of allow) {
      if (!registry.get(toolId)) {
        throw new Error(`unknown allowed tool: ${toolId}`);
      }
    }
  }
  return registry
    .list()
    .filter((tool) => !deny.has(tool.id))
    .filter((tool) => !allow || allow.has(tool.id));
}
