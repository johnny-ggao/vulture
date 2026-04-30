import { useCallback, useEffect, useRef, useState } from "react";

export interface UndoableDeleteOptions<T> {
  /**
   * Called when the grace period elapses (or when the user dismisses
   * the toast) — actually deletes the item on the backend.
   *
   * Errors should be handled inside `commit` (e.g. refetch + reconcile);
   * the hook does not surface errors to the caller.
   */
  commit: (item: T) => Promise<void> | void;
  /** Grace window before the commit fires. Default: 5 seconds. */
  graceMs?: number;
}

export interface UndoableDeleteHandle<T> {
  /** The currently soft-deleted item, or `null` when the toast is hidden. */
  pending: T | null;
  /**
   * Begin a soft delete: stages `item` as the new pending row and starts
   * the grace timer. If a previous pending row exists, it commits
   * immediately (timers don't pile up — each delete owns its own
   * window).
   */
  startDelete: (item: T) => void;
  /** Cancel the timer and return the rescued item so callers can
   *  re-insert it locally. Returns null when there is no pending row. */
  undo: () => T | null;
  /** Cancel the timer and commit immediately (user closed the toast). */
  dismiss: () => void;
}

/**
 * Generic "soft delete + 5s undo" controller. The conversation list and
 * the agent list both use this exact pattern (hide the row immediately,
 * surface a Toast, only call the API when the user does NOT undo);
 * extracting the timer + ref bookkeeping into a hook keeps App.tsx free
 * of the boilerplate around `clearTimeout` / `aliveRef` / "commit on
 * unmount" cleanup.
 *
 * Cleanup invariant: when the component unmounts while a delete is
 * pending, the timer is cleared AND the commit fires synchronously via
 * a ref capture. Without this the row stays hidden locally forever
 * while the backend never gets the DELETE.
 */
export function useUndoableDelete<T>(
  opts: UndoableDeleteOptions<T>,
): UndoableDeleteHandle<T> {
  const graceMs = opts.graceMs ?? 5000;

  type PendingState = {
    item: T;
    timer: ReturnType<typeof setTimeout>;
  };
  const [pending, setPending] = useState<PendingState | null>(null);

  // Latest commit function — captured so the unmount cleanup uses the
  // freshest closure (apiClient may not exist on first render).
  const commitRef = useRef(opts.commit);
  commitRef.current = opts.commit;

  // Latest pending row — same trick. The unmount effect has [] deps so
  // it only fires once; without a ref it would only see the initial
  // null state.
  const pendingRef = useRef<PendingState | null>(null);
  pendingRef.current = pending;

  const startDelete = useCallback(
    (item: T) => {
      // Pile-up guard: commit any prior pending row before opening a new
      // window. Each delete should own exactly one timer.
      const prior = pendingRef.current;
      if (prior) {
        clearTimeout(prior.timer);
        void commitRef.current(prior.item);
      }

      const timer = setTimeout(() => {
        setPending(null);
        void commitRef.current(item);
      }, graceMs);
      setPending({ item, timer });
    },
    [graceMs],
  );

  const undo = useCallback((): T | null => {
    const current = pendingRef.current;
    if (!current) return null;
    clearTimeout(current.timer);
    setPending(null);
    return current.item;
  }, []);

  const dismiss = useCallback(() => {
    const current = pendingRef.current;
    if (!current) return;
    clearTimeout(current.timer);
    setPending(null);
    void commitRef.current(current.item);
  }, []);

  // Unmount cleanup: clear the timer and commit synchronously. We can't
  // depend on the timer firing — by the time it does, the component is
  // gone and React tears down the closure.
  useEffect(() => {
    return () => {
      const current = pendingRef.current;
      if (!current) return;
      clearTimeout(current.timer);
      void commitRef.current(current.item);
    };
  }, []);

  return {
    pending: pending?.item ?? null,
    startDelete,
    undo,
    dismiss,
  };
}
