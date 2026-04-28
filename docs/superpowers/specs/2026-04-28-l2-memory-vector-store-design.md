# L2 Memory + Vector Store Design

## Goal

Add a small, local-first memory layer so each Vulture agent can remember durable facts and preferences, retrieve relevant memories for a run, and inject them through the existing per-run context path.

This slice keeps the OpenAI Agents SDK integration stable: memories are resolved before a run starts and passed as run context. It does not mutate SDK globals or hide state inside the model provider.

## Scope

In scope:

- Store memories locally per agent.
- Add, list, and delete memories through gateway APIs.
- Search memories for a user input before run creation.
- Inject top matching memories into `contextPrompt` alongside skills.
- Use OpenAI `text-embedding-3-small` embeddings when available.
- Fall back to deterministic keyword scoring when embeddings are unavailable.
- Add a Memory settings page for manual memory management.

Out of scope:

- Automatic conversation summarization into memories.
- Memory decay, confidence scoring, or background consolidation.
- Cross-agent shared memory.
- Hosted OpenAI vector stores or file search.
- User accounts, sync, or cloud storage.

## Data Model

Add a `memories` table:

- `id`: stable memory id.
- `agent_id`: owning agent.
- `content`: user-visible memory text.
- `embedding_json`: optional numeric vector stored as JSON for the first slice.
- `keywords_json`: normalized fallback tokens.
- `created_at`, `updated_at`: timestamps.

The first implementation stores vectors in SQLite JSON rather than adding `sqlite-vec` immediately. This keeps the product path local and lets the retrieval interface stabilize before introducing a native extension dependency. The storage boundary should still be named around embeddings/search so it can be swapped to `sqlite-vec` later without changing routes or UI.

## Gateway API

Add routes under `/v1/agents/:agentId/memories`:

- `GET /v1/agents/:agentId/memories`
  Returns memories newest first.

- `POST /v1/agents/:agentId/memories`
  Body: `{ content: string }`.
  Creates a memory, attempts embedding, stores fallback keywords either way.

- `DELETE /v1/agents/:agentId/memories/:memoryId`
  Deletes a memory owned by that agent.

Optional internal search API can stay private for this slice. Run creation calls the store/retriever directly.

## Retrieval

Before `POST /v1/conversations/:cid/runs` calls the LLM:

1. Load the conversation agent.
2. Retrieve top memories for the current user input.
3. Build a compact `<memories>` context block.
4. Combine it with the existing skills prompt.
5. Pass the combined string as `contextPrompt`.

Embedding search:

- Use cosine similarity against stored embeddings.
- Query embedding uses `text-embedding-3-small`.
- If no embedding provider is configured or any embedding call fails, use keyword scoring.

Keyword fallback:

- Normalize lowercase tokens.
- Score memories by overlap count with the input tokens.
- Return top matches with score greater than zero.

No retrieval failure should fail the user run. Memory errors should degrade to no memory context and be logged/test-covered.

## Context Format

Memory context is appended before skills:

```xml
<memories>
  <memory id="mem_...">User prefers concise Chinese answers.</memory>
</memories>
```

The model sees only matching memories, not the entire memory database. Keep the block small: default top-k is 5.

## UI

Replace the Settings page memory placeholder with a small management panel:

- Agent selector.
- Text area to add a memory.
- Memory list with content, timestamp, and delete action.
- Empty state when no memories exist.

The first UI is manual only. It should not imply automatic memory extraction.

## OpenAI/Agents SDK Alignment

- Memory retrieval happens at the application boundary before `Runner.run`.
- The Agents SDK still receives stable per-run model/provider wiring.
- The model-visible memory block goes through `contextPrompt`, matching the current skill injection path.
- The local store remains product state, separate from SDK session state.

## Acceptance Criteria

- A memory added for `local-work-agent` appears in the Memory page.
- A memory for one agent is not listed or injected for another agent.
- A relevant user input causes the memory to appear in run `contextPrompt`.
- Deleting the memory removes it from later retrieval.
- With no OpenAI API key, keyword fallback still retrieves matching memories.
- Existing skills context still appears when both skills and memories are available.
- Existing gateway and desktop-ui tests pass.

## Tests

Gateway:

- Migration creates `memories`.
- `MemoryStore` create/list/delete round trip.
- Retriever uses keyword fallback without API key.
- Retriever ranks embedding-backed memories when embeddings are supplied.
- Run route combines memory and skill context.

Desktop UI:

- Settings Memory tab lists memories.
- Add memory posts to gateway and refreshes list.
- Delete memory removes it from the list.

