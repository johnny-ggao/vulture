---
name: code-review-checklist
description: Use when reviewing your own diff before commit, or when reviewing someone else's PR. Checklist for catching common defects in TypeScript/Rust/React code.
---

# Code Review Checklist

## When to use
- Before committing a non-trivial change.
- Before opening a PR.
- When asked to review someone else's diff.

## Checklist

### Correctness
- Does each new function / method have a single clear responsibility?
- Are error paths handled, or do they silently return / throw the wrong thing?
- Are edge cases covered: empty input, null, max-size, off-by-one boundaries?
- Are async functions awaited where they should be? Any unhandled promises?

### Tests
- Is there a test that would have caught the bug being fixed? (For bug fixes specifically.)
- Are the tests asserting behavior, not implementation details?
- Do the tests run in isolation — no shared state, no test ordering dependency?

### Readability
- Are names accurate? `getX` should not have side effects; `loadX` should not return a partial.
- Is there a comment that restates what the code already says? Delete it.
- Is there a comment that explains *why* a non-obvious choice was made? Keep it.

### Security
- Does any user-controllable string flow into shell, SQL, or eval without escaping?
- Are secrets read from env / Keychain, not committed?
- Are paths validated against a workspace boundary (no path traversal)?

### Performance
- Any O(n²) or worse over user-controllable input?
- Any synchronous file reads in a hot path?

### Project conventions
- Does the change follow the existing file's style (immutability, file size, naming)?
- Are new dependencies justified? Could a 5-line implementation replace them?
