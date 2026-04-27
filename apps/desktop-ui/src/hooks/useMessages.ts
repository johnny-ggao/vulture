import { useCallback, useEffect, useReducer } from "react";
import type { ApiClient } from "../api/client";
import { conversationsApi, type MessageDto } from "../api/conversations";

export interface MessagesState {
  items: MessageDto[];
  loading: boolean;
  error: string | null;
}

export type MessagesAction =
  | { type: "load.start" }
  | { type: "load.success"; items: MessageDto[] }
  | { type: "load.error"; error: string }
  | { type: "append"; item: MessageDto }
  | { type: "clear" };

export function messagesReducer(state: MessagesState, action: MessagesAction): MessagesState {
  switch (action.type) {
    case "load.start":
      return { ...state, loading: true, error: null };
    case "load.success":
      return { items: action.items, loading: false, error: null };
    case "load.error":
      return { ...state, loading: false, error: action.error };
    case "append":
      if (state.items.some((m) => m.id === action.item.id)) return state;
      return { ...state, items: [...state.items, action.item] };
    case "clear":
      return { items: [], loading: false, error: null };
  }
}

export function useMessages(client: ApiClient | null, conversationId: string | null) {
  const [state, dispatch] = useReducer(messagesReducer, {
    items: [],
    loading: false,
    error: null,
  });

  const refetch = useCallback(async () => {
    if (!client || !conversationId) {
      dispatch({ type: "clear" });
      return;
    }
    dispatch({ type: "load.start" });
    try {
      const items = await conversationsApi.listMessages(client, conversationId);
      dispatch({ type: "load.success", items });
    } catch (cause) {
      dispatch({
        type: "load.error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, [client, conversationId]);

  const append = useCallback((item: MessageDto) => {
    dispatch({ type: "append", item });
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { ...state, refetch, append };
}
