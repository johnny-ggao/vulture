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
  | { type: "delete"; id: string };

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
  }
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

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { ...state, refetch, create, remove };
}
