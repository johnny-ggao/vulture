---
name: systematic-debugging
description: Use when something is broken, a test is failing, or behavior is unexpected. Hypothesis-driven, root-cause focused — not symptom-patching.
---

# Systematic Debugging

## When to use
- A test is failing and the cause is not immediately obvious from the diff.
- A user-visible bug is reported.
- A behavior diverges from documented or expected output.

## Steps
1. Reproduce the failure deterministically. If you cannot reproduce, you cannot debug — find a smaller test case first.
2. State the hypothesis in one sentence. Example: "The cache returns stale data because the TTL is computed before the entry is inserted."
3. Identify the cheapest experiment that confirms or refutes the hypothesis. Often: add one log line, run one query, read one specific function.
4. Run the experiment. Note the result.
5. If confirmed, fix the root cause — not the symptom. The fix should make the failing test pass AND prevent the same class of bug from recurring.
6. If refuted, generate a new hypothesis from what the experiment told you. Do not "try things until it works" — every action must be tied to a hypothesis.
7. Once fixed, write a regression test (if there isn't one already).

## Common pitfalls
- Pattern-matching to past bugs without verifying. Two bugs can share symptoms but have different causes.
- Adding `try/catch` that swallows the error. The error tells you what's wrong; suppressing it just hides the next failure mode.
- Stopping at the first thing that "works" without confirming why. If you don't know why the fix worked, you don't know what else broke.
