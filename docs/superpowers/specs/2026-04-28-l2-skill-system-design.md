# L2 Skill System Design

## Goal

Add a small, complete skill system so a Vulture agent can load reusable local capability packages, expose their metadata to the model, and let the model read the full instructions only when relevant.

The first slice should match the useful core of OpenClaw's skill behavior while staying aligned with OpenAI Agent Skills semantics: a skill is a directory containing `SKILL.md` with front matter and Markdown instructions.

## Scope

In scope:

- Load local skills from the active workspace and profile-level skills directory.
- Parse `SKILL.md` front matter with required `name` and `description`.
- Support per-agent skill allowlists.
- Expose available skills to the model as run context containing `name`, `description`, and `path`.
- Reuse the existing `read` tool for loading full `SKILL.md` content.
- Enforce basic local safety: realpath containment, symlink escape rejection, hidden/node_modules skipping, and `SKILL.md` size limits.
- Support small eligibility gates from OpenClaw metadata: `always`, `os`, and `requires.env`.
- Add focused tests for discovery, precedence, filtering, and prompt/context injection.

Out of scope for this slice:

- Skill registry, marketplace, install flows, Skill Workshop, or remote skill downloads.
- Hosted OpenAI skill upload/version management.
- Replacing the current function-tool shell bridge with SDK `shellTool`.
- UI management for enabling/disabling skills.

## Skill Locations

The initial loader will use two roots:

1. `<workspace>/skills`
2. `<profileDir>/skills`

If the same skill name appears in both places, workspace wins. This gives project-local skills the strongest priority without importing OpenClaw's full multi-root precedence model.

Each immediate child directory under a root is considered a candidate skill if it contains `SKILL.md`. A root that itself contains `SKILL.md` may also be loaded as a single skill for tests and future reuse.

## Skill Format

`SKILL.md` must contain front matter with:

- `name`: stable display and allowlist key.
- `description`: short model-facing usage hint.

Supported optional front matter in this slice:

- `disable-model-invocation`: if true, do not include it in the model-visible catalog.
- `user-invocable`: parsed and preserved for future command support, but no UI command behavior in this slice.
- `metadata.openclaw`: JSON metadata supporting `always`, `os`, and `requires.env`.

OpenClaw metadata for binary checks, config checks, installers, command dispatch, and display hints remains out of scope for this slice.

## Runtime Integration

The gateway already creates an Agents SDK `Agent` per run with `instructions`, `tools`, `RunContext`, and per-run model provider wiring. The skill slice should not bypass that structure.

At run start:

1. Resolve the active agent and workspace.
2. Load and filter skills for that agent.
3. Build a compact available-skills block:

   ```text
   The following skills provide specialized instructions for specific tasks.
   Use the read tool to load a skill's file when the task matches its description.

   <available_skills>
     <skill>
       <name>...</name>
       <description>...</description>
       <location>...</location>
     </skill>
   </available_skills>
   ```

4. Append that block to the run input context, not to persistent agent instructions in storage.

This mirrors OpenClaw's lazy-load catalog and matches OpenAI's documented behavior that the model receives skill metadata and reads the full `SKILL.md` via path when needed.

## Protocol And Storage

Extend agent protocol with an optional `skills` field:

- `undefined`: no explicit filter, use all eligible skills.
- `[]`: disable all skills for that agent.
- `["skill-name"]`: include only matching skill names.

Persist it in the existing agent row payload path with a safe default for older rows. No separate skills database is needed for this slice.

## Safety

The loader must:

- Resolve every root and candidate through realpath.
- Reject candidates whose real path escapes the configured root.
- Reject `SKILL.md` files opened through path symlinks.
- Cap `SKILL.md` bytes.
- Ignore hidden directories and `node_modules`.
- Treat invalid front matter or missing required fields as a skipped skill, not a fatal run error.

Skill content is trusted only after local review. The system should expose local files selected by the developer/operator, not arbitrary end-user skill uploads.

## Testing

Add focused tests before production code for:

- Loading a valid skill from workspace.
- Workspace skill overriding profile skill with the same name.
- Empty agent skill allowlist producing no skill context.
- Named allowlist including only matching skills.
- Symlink escape or oversized `SKILL.md` skipped.
- Run factory receiving a system/user context containing the available-skills block.

## Acceptance Criteria

- Dropping `skills/example/SKILL.md` into the active workspace makes the agent aware of the skill on the next run.
- Asking for a matching task leads the model to have enough metadata to call `read` on the skill file.
- An agent configured with `skills: []` receives no skill catalog.
- Invalid or unsafe skill paths cannot escape the configured roots.
- Existing tools, approvals, run recovery, token usage, and attachments continue to work unchanged.
