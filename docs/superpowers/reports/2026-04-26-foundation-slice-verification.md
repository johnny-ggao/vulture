# Foundation Slice Verification

Date: 2026-04-26

## Commands

- `bun run verify`
- `bun --filter @vulture/desktop-ui build`
- `cargo check -p vulture-desktop-shell`
- `VULTURE_AGENT_MODE=mock VULTURE_MOCK_TOOL_REQUEST=1 bun apps/agent-sidecar/src/smoke.ts`

## Result

All automated checks passed.

The root `verify` script now gates:

- JS protocol and sidecar tests.
- Workspace typecheck.
- Desktop UI production build.
- Cargo tests.
- Workspace clippy with `-D warnings`.
- Sidecar mock smoke with `VULTURE_MOCK_TOOL_REQUEST=1`.

The sidecar mock smoke command returned `run_started`, `model_delta`, and `run_completed` events and reported one emitted tool request.

Desktop-shell tests cover local default profile storage bootstrap, profile-scoped `permissions/audit.sqlite` creation, parsing sidecar `tool.request` stdout lines before the final result, routing the request through policy, and exercising the `tool.requested` plus `tool.policy_decision` audit append path.

## Manual Check

No GUI/manual Tauri launch was performed in this pass. Automated sidecar and desktop shell verification passed; manual GUI launch remains for a local smoke pass.
