---
name: task-decomposition
description: Use when a request is large or has multiple independent pieces. Break it into smaller tasks, identify dependencies, and decide what to do in parallel vs sequentially.
---

# Task Decomposition

## When to use
- The user's request mentions multiple components or stages.
- A single task would touch more than ~5 files.
- You're about to write more than ~3 todo items at once.

## Steps

1. Restate the request in your own words. Confirm with the user if it's ambiguous.
2. List each independent unit of work as one item. An item is "independent" if it can be tested in isolation and committed without breaking the rest.
3. For each item, name:
   - The output (what file changes / what new behavior).
   - The verification (the command that proves it works).
   - The dependencies (other items that must land first).
4. Decide order:
   - Items with no dependencies → can run in parallel.
   - Items with dependencies → run after their predecessors.
5. Use the `update_plan` tool to record the items.
6. Work one item at a time. Mark each complete before starting the next.

## Common pitfalls

- Items that are too coarse ("implement the feature") — break further.
- Items that are too fine ("rename a variable") — fold into a parent item.
- Hidden dependencies discovered mid-work — pause, update the plan, then resume.
- Working on multiple items at once — produces tangled diffs that are hard to review and easy to rollback wrongly.

## Stop condition

Each item should be:
- Self-contained (one commit, one verification command).
- Reversible (can be reverted without breaking later items).
- Reviewable in under ~15 minutes by a human.

If an item violates any of these, it needs further decomposition.
