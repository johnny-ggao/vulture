import { z } from "zod";
import type { GatewayToolSpec } from "../tools/types";

const harnessTestApprovalParameters = z.object({
  message: z.string().nullable(),
});

/**
 * Test-only tool used by the acceptance harness to drive the production
 * approval gate end-to-end without depending on workspace boundaries
 * (write/edit/shell.exec) or the desktop shell bridge (browser.*).
 *
 * needsApproval always returns true, so any function_call to this tool
 * goes through the SDK's approval flow:
 *   tool({ needsApproval }) → sdkApprovalDecision → approvalQueue →
 *   POST /v1/runs/:rid/approvals → resume → execute.
 *
 * execute is a pure no-op that echoes the input back, so allow→execute
 * succeeds deterministically. Registered only when GatewayConfig flips
 * registerHarnessTestTools=true, which the acceptance harness CLI sets.
 * Production callers leave it off so the tool is invisible to real users.
 */
export function harnessTestApprovalTool(): GatewayToolSpec {
  return {
    id: "harness.test_approval",
    sdkName: "harness_test_approval",
    label: "Harness Test Approval",
    description:
      "Test-only tool that always requires approval and trivially echoes its input. Registered only when the gateway runs under the acceptance harness.",
    parameters: harnessTestApprovalParameters,
    source: "core",
    category: "runtime",
    risk: "approval",
    idempotent: true,
    needsApproval: () => ({
      needsApproval: true,
      reason: "harness test approval required",
    }),
    execute: async (_ctx, input) => {
      const value = input as { message?: string | null };
      return {
        ok: true,
        echoed: value.message ?? "approved",
      };
    },
  };
}
