# Context Management Design

## Goal

Add conversation context management so a Vulture agent can understand earlier turns in the same conversation while keeping long conversations within a controlled context budget.

The first slice should support both multi-turn continuity and long-conversation compression. It should stay aligned with the OpenAI Agents SDK session model instead of manually concatenating arbitrary chat history into prompts.

## Context

Vulture currently persists conversations and messages for the UI, but each run mainly passes the current user input plus `systemPrompt` and `contextPrompt` to the Agents SDK. Durable memory, skills, MCP tools, attachments, token usage, approvals, and run recovery already exist around that run path.

The installed OpenAI Agents SDK exposes a `Session` interface:

- `getSessionId()`
- `getItems(limit?)`
- `addItems(items)`
- `popItem()`
- `clearSession()`

The SDK also supports `sessionInputCallback`, which lets an application control how stored session history and the current turn are combined before the model call. This is the right integration point for Vulture-owned context compaction.

## Scope

In scope:

- Add a Vulture-managed SDK session per conversation.
- Persist SDK session items locally in Gateway SQLite.
- Feed session history into Agents SDK runs.
- Keep recent user and assistant text turns verbatim.
- Compress older text turns into a conversation summary.
- Use a no-tools summarization pass to create or refresh the summary.
- Keep compression failure non-blocking.
- Keep context summary separate from durable memory.
- Add focused tests for continuity, compaction, isolation, and failure fallback.

Out of scope for this slice:

- User-editable context summaries.
- A full context management UI page.
- Deep summarization of image or binary attachment content.
- Persisting history in OpenAI server-managed conversations.
- Replacing file-backed long-term memory.
- Complex semantic retrieval over conversation history.

## Recommended Approach

Use a custom Vulture SQLite session that implements the Agents SDK `Session` interface.

Each Vulture conversation maps to one SDK session:

```text
session id = conversation id
```

The session remains local. Vulture does not use OpenAI server-managed conversation state in this slice. This keeps local privacy, Codex provider compatibility, recovery, and existing conversation persistence under Vulture's control.

## Storage

Add two local persistence concepts.

### `conversation_contexts`

Stores the current compressed state for one conversation.

Fields:

- `conversation_id`
- `agent_id`
- `summary`
- `summarized_through_message_id`
- `input_item_count`
- `input_char_count`
- `created_at`
- `updated_at`

The summary is current-conversation working context, not durable memory. It should not be exposed through memory tools and should not be copied into `MEMORY.md`.

### `conversation_session_items`

Stores SDK-compatible input items for one conversation.

Fields:

- `id`
- `conversation_id`
- `message_id`
- `role`
- `item_json`
- `created_at`

Only user and assistant text messages are stored as session items in the first slice. Attachments are represented by compact metadata when needed:

```text
Attachment: <display name>, <mime type>, <size bytes>
```

Tool calls are not stored as full transcript items in this slice. Tool visibility remains in run events. Summaries may mention important tool outcomes in one sentence when they are already present in assistant text.

## Runtime Flow

### Starting A Run

When `POST /v1/conversations/:cid/runs` receives a user message:

1. Persist the user message as today.
2. Link attachments as today.
3. Append a session item for the new user text to the conversation session.
4. Build the normal system prompt and context prompt:
   - agent pack instructions
   - memory prompt
   - skills prompt
5. Create `VultureConversationSession(conversationId)`.
6. Run the Agents SDK with `{ session, sessionInputCallback }`.

The model input should be composed as:

1. Existing system prompt and dynamic context prompt.
2. Conversation context summary, if present.
3. Recent raw user and assistant turns.
4. Current user turn.

### Completing A Run

After a successful assistant response:

1. Persist the assistant message as today.
2. Append a session item for the assistant text.
3. Persist token usage as today.
4. Evaluate whether the conversation should be compacted.
5. If compaction is needed, schedule a no-tools summarization pass.

Compaction should not block the assistant message becoming visible. If compaction fails, the run still succeeds and the next run falls back to recent raw turns.

## Compaction Policy

Initial defaults:

- Keep the most recent 6 user/assistant text messages verbatim.
- Trigger compaction when there are more than 12 text messages in the conversation.
- Also trigger compaction when stored text is estimated above 24,000 characters.
- Cap the summary to about 2,000 characters.

These are character-based heuristics, not exact token counting. They are deterministic, easy to test, and good enough for the first local slice.

## Summary Prompt

The summarizer runs with no tools and a narrow instruction:

```text
Summarize the older part of this conversation for future turns.
Preserve stable user goals, constraints, preferences, decisions, pending tasks, and important results.
Do not include generic pleasantries.
Do not invent facts.
Return concise Markdown, maximum 2,000 characters.
```

Inputs:

- Existing summary, if any.
- Older messages that are about to be removed from raw context.
- Small metadata for attachments.

Output:

- New summary string.
- `summarized_through_message_id` pointing at the newest message covered by the summary.

The summary should be wrapped in the run context like this:

```text
Conversation context summary:
<summary>
...
</summary>

Recent conversation turns follow after this summary. Treat recent turns as more specific when they conflict with the summary.
```

## Session Input Callback

The `sessionInputCallback` owns final history shaping.

Given `historyItems` and `newItems`, it should:

1. Load current `conversation_contexts.summary`.
2. Select recent raw text session items that are newer than `summarized_through_message_id`.
3. Trim to the most recent 6 text messages.
4. Prefix the selected items with one synthetic user-context item containing the summary.
5. Append `newItems`.

If there is no summary, the callback returns recent raw history plus `newItems`.

If the session store is unavailable, the callback returns `newItems` only and logs the failure. A failed context lookup must not block message sending.

## Interaction With Existing Systems

### Memory

Memory remains durable cross-run and file-backed. Conversation context summary is ephemeral per conversation.

The final system/context prompt order is:

1. Agent pack instructions.
2. Memory guidance and memory summary.
3. Skill guidance.
4. Conversation context summary.
5. Recent session turns through the SDK session.

### Skills

Skill loading is unchanged. Skill prompt content should not be copied into conversation summaries.

### MCP And Core Tools

Tool registration and approval behavior are unchanged. The first context slice does not persist SDK tool call items as raw session history. This avoids replaying large tool outputs or leaking approval details into compressed context.

### Attachments

The current run still passes attachments to the model as today. Historical attachments are represented only by metadata in summaries and session text. Binary content is not reloaded into future turns.

### Run Recovery

Recovery metadata should include the conversation id and continue storing `contextPrompt` for the in-flight run as today. Recovery should not trigger compaction. Compaction only runs after a successful run reaches terminal state.

### Token Usage

Existing token usage display remains unchanged. Later UI can add a small context status, but this slice does not require it.

## API And UI

No required UI changes in the first slice.

Optional gateway introspection route for tests and later UI:

```text
GET /v1/conversations/:cid/context
```

Response:

```json
{
  "conversationId": "c-...",
  "summary": "...",
  "summarizedThroughMessageId": "m-...",
  "rawItemCount": 6,
  "updatedAt": "..."
}
```

The route is useful for manual verification, but the first product behavior should work without requiring users to manage context.

## Error Handling

- Session item persistence failure after user message append should fail the run creation with a clear internal error only if the current user turn cannot be represented.
- Summary generation failure should not fail the run.
- Summary parse or empty output should leave the previous summary unchanged.
- Invalid stored session item JSON should be skipped and logged.
- Conversation deletion should cascade or explicitly delete context and session items.

## Security And Privacy

All session history and summaries remain in local SQLite. No remote server-managed conversation is used.

Summaries must not contain secrets from tool outputs unless the assistant already included them in visible text. The first slice avoids raw tool output summarization for this reason.

Conversation summaries are lower priority than system, developer, agent, skill, and memory instructions. They should be framed as prior conversation context, not instructions.

## Testing

Gateway tests:

- `VultureConversationSession` implements `getItems`, `addItems`, `popItem`, and `clearSession`.
- A second run in the same conversation receives prior user/assistant text.
- A new conversation does not receive another conversation's session items or summary.
- Compaction keeps recent messages and summarizes older messages.
- Summary generation failure does not fail the completed run.
- Deleted conversations remove context/session rows.
- Invalid session JSON is skipped.

LLM adapter tests:

- `defaultRunFactory` passes `session` and `sessionInputCallback` to `Runner.run`.
- Existing recovery path still works without requiring a session.
- Context prompt composition remains unchanged for memory and skills.

Route/integration tests:

- Posting multiple runs to one conversation preserves continuity.
- Once threshold is exceeded, `GET /v1/conversations/:cid/context` returns a summary.
- Existing attachments, token usage, approvals, MCP tools, and memory tests continue to pass.

Manual verification:

1. Start a new conversation and send: `项目代号是 alpha-17，请记住本轮对话里会用到。`
2. Send: `项目代号是什么？请简单回答。`
3. Expected: assistant answers `alpha-17`.
4. Continue with more than 12 short turns.
5. Confirm the conversation still answers questions from early turns after compaction.
6. Start a new conversation and ask the same question.
7. Expected: the new conversation does not know `alpha-17`.

## Acceptance Criteria

- Agents can use prior text turns in the same conversation.
- Long conversations compact older text into a bounded summary.
- Recent turns remain verbatim after compaction.
- Context summaries are local, per conversation, and isolated.
- Compaction failures do not break normal chat.
- Durable memory remains separate from conversation context.
- Existing run recovery, approvals, token usage, attachments, skills, and MCP behavior remain unchanged.
