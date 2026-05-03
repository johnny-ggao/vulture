---
name: tdd-workflow
description: Use when implementing a new feature or fixing a bug that is reproducible. Drives the red/green/refactor loop and prevents implementation-before-verification.
---

# TDD Workflow

## When to use
- A new feature is being added.
- A bug has a clear reproduction.
- You are about to write a function with non-trivial logic.

## When NOT to use
- One-line refactors with no behavior change.
- Configuration / dependency edits.
- Pure typo fixes.

## Steps
1. Write the smallest test that names the desired behavior. The test must fail for the right reason — not because the function is missing, but because the behavior is missing.
2. Run the test. Confirm it fails. If it passes, the test is wrong.
3. Implement the minimal code that turns the test green. Resist adding features the test doesn't demand.
4. Run the test. Confirm it passes.
5. Refactor only if there is real duplication or unclear naming. Do not refactor for hypothetical future requirements.
6. Run the full test file (not just the new test) to catch regressions.
7. Commit. The commit should contain the test and the implementation together.

## Common pitfalls
- Writing the implementation first and the test second — this is not TDD; it's regression testing.
- Asserting on internal state (private fields, intermediate values) instead of observable behavior.
- Tests that mock the very thing they should verify.
- Skipping the "see it fail" step. If you never see red, you don't know your test exercises the change.
