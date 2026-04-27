import { describe, test } from "bun:test";

// This integration test is a placeholder that documents the desired flow:
//   1. Mount App with a fake runtime descriptor
//   2. Stub useRuntimeDescriptor to return a known {gateway.port, token}
//   3. Spin up an in-process buildServer with stub LLM
//   4. fireEvent.click on "+ 新消息"; type "hello"; press Enter
//   5. Wait for run.completed (50 × 100ms poll); assert assistant bubble appears
//
// Wiring useRuntimeDescriptor for happy-dom tests requires injecting a runtime
// override or refactoring the hook to accept a test-mode RuntimeDescriptor.
// Phase 3b ships M6 with manual smoke coverage; this test is left skipped as
// a known follow-up. See the M6 task list in the Phase 3b plan.

describe.skip("App integration (TODO: wire RuntimeDescriptor for tests)", () => {
  test("placeholder — manual smoke covers this path in Phase 3b", () => {});
});
