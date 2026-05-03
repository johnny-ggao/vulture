import type { ApiClient } from "./client";

export interface FilesListResponse {
  paths: string[];
  truncated: boolean;
}

/**
 * Wraps `GET /v1/files?root=…` for the @-mention picker. Callers must pass
 * an absolute root path (typically the active conversation's working
 * directory). Returns relative paths capped at 500 by default.
 */
export const filesApi = {
  list: (client: ApiClient, root: string, max?: number): Promise<FilesListResponse> => {
    const params = new URLSearchParams({ root });
    if (max !== undefined) params.set("max", String(max));
    return client.get<FilesListResponse>(`/v1/files?${params.toString()}`);
  },
};
