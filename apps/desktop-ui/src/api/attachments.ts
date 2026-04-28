import type { ApiClient } from "./client";
import type { MessageAttachmentDto } from "./conversations";

export const attachmentsApi = {
  upload: (client: ApiClient, file: File) => {
    const form = new FormData();
    form.set("file", file, file.name);
    return client.postForm<MessageAttachmentDto>("/v1/attachments", form);
  },
};
