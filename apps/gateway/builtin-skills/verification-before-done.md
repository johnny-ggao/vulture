---
name: verification-before-done
description: Use before claiming a task is complete, fixed, or passing. Requires running concrete verification commands and showing output — evidence over assertions.
---

# Verification Before Done

## When to use
- About to write "done", "fixed", "passing", "should work" in a response.
- Before creating a commit that fixes a bug.
- Before opening or merging a PR.
- Before declaring an iteration of agent work finished.

## Steps
1. Identify the verification command. Examples: `bun test path/to/file.test.ts`, `cargo check`, `cargo test --package <name>`, `bun run typecheck`.
2. Run the command. Capture the exit code AND the relevant output.
3. Read the output. Confirm it shows the expected success signal — not just exit code 0, but the actual line that says "all tests passed" / "no errors".
4. If you ran a partial verification (e.g., one test file out of the suite), explicitly note this — partial verification is not full verification.
5. Only after confirming, claim completion. The claim must reference what was verified, not what was attempted.

## Forbidden patterns
- Saying "the build should pass now" without running the build.
- Saying "this fixes the bug" without running the failing repro.
- Treating "no compile errors" as equivalent to "tests pass".
- Skipping verification because "the change was small". Small changes break things too.
