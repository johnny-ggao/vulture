# Multimodal Messages Design

Date: 2026-04-28
Scope: L1 multimodal user messages only
Status: Approved (brainstorm), pending implementation plan

## Goal

Add a small, complete multimodal message path: a user can attach images or files to a chat message, see those attachments persist in the conversation, and have the agent receive the message through the OpenAI Agents SDK content model.

This is an additive L1 feature on top of the existing Gateway-backed conversation and run system. It must preserve the current text-only path, run recovery, token usage display, tool approval flow, and multi-profile isolation.

## Confirmed Decisions

| Topic | Decision |
|---|---|
| Storage shape | SQLite metadata plus profile-local blob files |
| First attachment producers | User messages only |
| First attachment consumers | OpenAI Agents SDK input conversion and UI display |
| Blob root | Current profile directory under `blobs/` |
| Limits | 20 MB per file, 10 attachments per message |
| Supported classes | Images plus generic files |
| Out of scope | Assistant-generated attachments, OCR, semantic indexing, file search, drag ordering, cloud sync |

## Existing Context

Current messages are text-only:

- Protocol `MessageSchema` contains `content: string`.
- Gateway migration `002_runs.sql` creates `messages(content TEXT NOT NULL)`.
- `MessageStore.append()` writes only role, content, run id, and timestamp.
- `POST /v1/conversations/:cid/runs` accepts `{ input }`, appends a user message, creates a run, and passes `userInput: string` to the orchestrator.
- `runConversation()` and `LlmCallable` accept `userInput: string`.
- UI `Composer` sends text only; `MessageBubble` renders only text.

The OpenAI Agents SDK supports multimodal user input through message content arrays. The first implementation should adapt Vulture's stored attachments to `input_text`, `input_image`, and `input_file` content items at the LLM adapter boundary.

## Data Model

Add migration `005_message_attachments.sql`.

`blobs`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | `blob-<uuid>` |
| `sha256` | TEXT NOT NULL | Hash of original bytes |
| `mime_type` | TEXT NOT NULL | Browser-provided or detected fallback |
| `size_bytes` | INTEGER NOT NULL | Enforced against upload limit |
| `storage_path` | TEXT NOT NULL | Relative path under profile dir, never absolute |
| `original_name` | TEXT NOT NULL | Display/download name |
| `created_at` | TEXT NOT NULL | ISO-8601 |

`message_attachments`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | `att-<uuid>` |
| `message_id` | TEXT | NULL until the user sends; FK to `messages(id)` with cascade delete when set |
| `blob_id` | TEXT NOT NULL | FK to `blobs(id)` |
| `kind` | TEXT NOT NULL | `image` or `file` |
| `display_name` | TEXT NOT NULL | Stable per-message display label |
| `created_at` | TEXT NOT NULL | ISO-8601 |

Blob files live under:

```text
<profileDir>/blobs/<sha256[0..2]>/<blobId>
```

The database stores only the relative `storage_path`, for example `blobs/ab/blob-...`. Gateway resolves it against `cfg.profileDir` and rejects any path that escapes the profile directory.

## Protocol Types

Add attachment types in `packages/protocol/src/v1/conversation.ts`:

```ts
export const AttachmentKindSchema = z.enum(["image", "file"]);

export const MessageAttachmentSchema = z.object({
  id: z.string().min(1),
  blobId: z.string().min(1),
  kind: AttachmentKindSchema,
  displayName: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  contentUrl: z.string().min(1),
  createdAt: Iso8601Schema,
});
```

`MessageSchema` gains:

```ts
attachments: z.array(MessageAttachmentSchema).default([])
```

`PostMessageRequestSchema` becomes:

```ts
{
  input: string().min(1),
  attachmentIds: string().min(1).array().max(10).optional()
}
```

Existing clients that omit `attachmentIds` keep working. Existing messages returned from older DB rows have `attachments: []`.

## Gateway API

### Upload Attachment

`POST /v1/attachments`

- Request: `multipart/form-data` with one `file` field.
- Response: a draft attachment object:

```ts
{
  id: "att-...",
  blobId: "blob-...",
  kind: "image" | "file",
  displayName: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 12345,
  contentUrl: "/v1/attachments/att-.../content",
  createdAt: "..."
}
```

Upload creates a blob row and a temporary unattached attachment row with `message_id = NULL`. The row becomes attached when the user sends a message. In v1, unattached rows older than 24 hours are rejected during send validation. Automated cleanup is out of scope for this implementation.

### Fetch Content

`GET /v1/attachments/:id/content`

- Requires normal Gateway auth.
- Streams bytes from the profile-local blob path.
- Sets `Content-Type` and `Content-Disposition`.
- Returns 404 when the attachment or blob is missing.

### Send Message With Attachments

`POST /v1/conversations/:cid/runs`

Request:

```json
{
  "input": "Please analyze this image",
  "attachmentIds": ["att-..."]
}
```

Server behavior:

1. Validate the conversation exists.
2. Validate all attachment ids exist, have `message_id = NULL`, are within the limit, and belong to the current profile DB.
3. Append the user message.
4. Link the attachments to that user message in one SQLite transaction.
5. Create the run.
6. Pass both `userInput` and resolved attachment metadata to the orchestrator.

## Runtime and Agents SDK Mapping

Extend `LlmCallable` and `RunConversationArgs` with:

```ts
userAttachments?: LlmInputAttachment[]
```

`LlmInputAttachment` contains only runtime-safe fields:

```ts
{
  kind: "image" | "file";
  mimeType: string;
  displayName: string;
  sizeBytes: number;
  bytes: Uint8Array;
}
```

At the OpenAI Agents SDK adapter boundary:

- Text becomes `{ type: "input_text", text: userInput }`.
- Images become `{ type: "input_image", image: ... }`.
- Files become `{ type: "input_file", file: ... }`.

The exact SDK object form is kept inside the OpenAI/Codex LLM adapters, not spread through stores or UI. If an active provider rejects a file type, the run fails with a clear `attachment.unsupported` error and leaves the user message persisted.

Recovery metadata records attachment ids, not bytes. On resume, Gateway reloads attachment metadata and bytes from the profile blob store before calling the LLM adapter.

## UI

Composer adds an attachment button next to the send controls.

First-version behavior:

- Use the native file picker; support multiple selection up to 10 files total.
- Upload immediately after selection via `POST /v1/attachments`.
- Show pending/uploaded chips above the textarea.
- Image chips show a small thumbnail using `contentUrl`.
- Generic file chips show filename, MIME type, and size.
- A remove button detaches an upload from the draft before send.
- Send is disabled while uploads are pending.
- After send, the user `MessageBubble` displays the persisted attachments above the text.

No drag-and-drop is required for v1. Keyboard and screen-reader access should remain acceptable through normal button and input semantics.

## Error Handling

- File exceeds 20 MB: reject upload with `413` and `attachment.too_large`.
- More than 10 selected attachments: reject extra files client-side and surface a small inline error.
- Unsupported or unknown MIME: store as `application/octet-stream` and `kind=file`.
- Blob write fails: upload returns `500` and no metadata row is committed.
- Send references missing attachment: `400 attachment.not_found`.
- Send references attachment already linked to another message: `409 attachment.already_used`.
- Provider rejects attachment: run fails with `attachment.unsupported`; the user message and attachments remain visible.

## Security and Privacy

- Blob paths are profile-relative and resolved through a helper that rejects path traversal.
- Content URLs require Gateway bearer auth.
- Attachments are local-only and profile-scoped.
- The renderer never receives absolute blob file paths.
- File bytes are loaded only by Gateway when uploading, previewing, or invoking the LLM adapter.

## Testing

Protocol:

- `MessageSchema` parses messages with and without attachments.
- `PostMessageRequestSchema` accepts optional attachment ids and rejects more than 10.

Gateway:

- Migration creates `blobs` and `message_attachments`.
- Upload stores blob metadata and bytes under profile `blobs/`.
- Content endpoint returns stored bytes with the right MIME type.
- Sending a run with attachments links them to the user message.
- Messages list includes attachment metadata.
- Missing, reused, and oversized attachments return the expected errors.
- Run recovery reloads attachment ids from persisted metadata.

Runtime:

- `runConversation()` passes attachments to `LlmCallable`.
- OpenAI/Codex adapters convert text + image/file attachments into SDK content arrays.

UI:

- Composer uploads selected files, shows image/file chips, removes draft attachments, and sends attachment ids.
- MessageBubble renders persisted image/file attachments.
- Existing text-only App integration tests continue to pass.

## Rollout

This feature is additive. Existing text-only messages remain valid. The first release does not need a data migration rewrite for old rows beyond adding new attachment tables. If upload APIs are unavailable or fail, the text-only composer path still works.
