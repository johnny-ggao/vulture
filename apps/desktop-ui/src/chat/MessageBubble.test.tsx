import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MessageBubble } from "./MessageBubble";

describe("MessageBubble", () => {
  test("renders attachment names under message content", () => {
    render(
      <MessageBubble
        role="user"
        content="see attached"
        attachments={[
          {
            id: "att-1",
            blobId: "blob-1",
            kind: "file",
            displayName: "note.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            contentUrl: "/v1/attachments/att-1/content",
            createdAt: "2026-04-28T00:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByText("note.txt")).toBeDefined();
    expect(screen.getByText("5 B")).toBeDefined();
  });
});
