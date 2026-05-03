import { useCallback, useEffect, useReducer } from "react";
import type { ApiClient } from "../api/client";
import {
  conversationsApi,
  type ConversationDto,
  type CreateConversationRequest,
} from "../api/conversations";

export interface ConversationsState {
  items: ConversationDto[];
  loading: boolean;
  error: string | null;
}

export type ConversationsAction =
  | { type: "load.start" }
  | { type: "load.success"; items: ConversationDto[] }
  | { type: "load.error"; error: string }
  | { type: "create.optimistic"; item: ConversationDto }
  | { type: "create.commit"; id: string; item: ConversationDto }
  | { type: "create.rollback"; id: string }
  | { type: "delete"; id: string }
  | { type: "restore"; item: ConversationDto };

export function conversationsReducer(
  state: ConversationsState,
  action: ConversationsAction,
): ConversationsState {
  switch (action.type) {
    case "load.start":
      return { ...state, loading: true, error: null };
    case "load.success":
      return { items: action.items, loading: false, error: null };
    case "load.error":
      return { ...state, loading: false, error: action.error };
    case "create.optimistic":
      return { ...state, items: [action.item, ...state.items] };
    case "create.commit":
      return {
        ...state,
        items: state.items.map((x) => (x.id === action.id ? action.item : x)),
      };
    case "create.rollback":
      return { ...state, items: state.items.filter((x) => x.id !== action.id) };
    case "delete":
      return { ...state, items: state.items.filter((x) => x.id !== action.id) };
    case "restore": {
      // De-duplicate in case the item already came back from a refetch.
      const without = state.items.filter((x) => x.id !== action.item.id);
      return { ...state, items: insertByUpdatedAt(without, action.item) };
    }
    default:
      return state;
  }
}

/**
 * Insert into a list sorted by updatedAt desc — the same order the API
 * returns. Used by `restore` so undoing a delete drops the item back into
 * its original position rather than always at the top.
 *
 * Items with malformed updatedAt fall back to the tail so they never crash
 * the comparison; a parallel refetch will sort the list correctly later.
 */
function insertByUpdatedAt(
  items: ConversationDto[],
  item: ConversationDto,
): ConversationDto[] {
  const target = parseTime(item.updatedAt);
  if (target === null) return [...items, item];
  for (let i = 0; i < items.length; i += 1) {
    const candidate = parseTime(items[i].updatedAt);
    if (candidate !== null && candidate <= target) {
      return [...items.slice(0, i), item, ...items.slice(i)];
    }
  }
  return [...items, item];
}

function parseTime(input: string): number | null {
  const t = new Date(input).getTime();
  return Number.isNaN(t) ? null : t;
}

export function useConversations(client: ApiClient | null) {
  const [state, dispatch] = useReducer(conversationsReducer, {
    items: [],
    loading: false,
    error: null,
  });

  const refetch = useCallback(async () => {
    if (!client) return;
    dispatch({ type: "load.start" });
    try {
      const items = await conversationsApi.list(client);
      dispatch({ type: "load.success", items });
    } catch (cause) {
      dispatch({
        type: "load.error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [client]);

  const create = useCallback(
    async (req: CreateConversationRequest) => {
      if (!client) throw new Error("client not ready");
      const tempId = `c-temp-${crypto.randomUUID()}`;
      const optimistic: ConversationDto = {
        id: tempId,
        agentId: req.agentId,
        title: req.title ?? "",
        permissionMode: req.permissionMode ?? "default",
        workingDirectory: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      dispatch({ type: "create.optimistic", item: optimistic });
      try {
        const real = await conversationsApi.create(client, req);
        dispatch({ type: "create.commit", id: tempId, item: real });
        return real;
      } catch (cause) {
        dispatch({ type: "create.rollback", id: tempId });
        throw cause;
      }
    },
    [client],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!client) return;
      dispatch({ type: "delete", id });
      try {
        await conversationsApi.delete(client, id);
      } catch (cause) {
        // re-fetch on error to reconcile
        void refetch();
        throw cause;
      }
    },
    [client, refetch],
  );

  /**
   * Hide the conversation locally without calling the API. Pair with
   * `commitDelete` (after a grace period) or `restore` (to undo).
   */
  const softDelete = useCallback((id: string) => {
    dispatch({ type: "delete", id });
  }, []);

  /**
   * Re-insert a previously soft-deleted conversation into the list.
   */
  const restore = useCallback((item: ConversationDto) => {
    dispatch({ type: "restore", item });
  }, []);

  /**
   * Call the delete API for an already-soft-deleted conversation.
   * Refetch on failure so the UI re-syncs with the backend.
   */
  const commitDelete = useCallback(
    async (id: string) => {
      if (!client) return;
      try {
        await conversationsApi.delete(client, id);
      } catch (cause) {
        void refetch();
        throw cause;
      }
    },
    [client, refetch],
  );

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { ...state, refetch, create, remove, softDelete, restore, commitDelete };
}
