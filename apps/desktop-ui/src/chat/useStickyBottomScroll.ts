import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Within how many pixels of the bottom counts as "at the bottom" for
 * the purposes of staying stuck. Anything past this threshold pauses
 * auto-scroll so the user reading history isn't snapped down by an
 * incoming token.
 */
const STICK_THRESHOLD_PX = 80;

export interface StickyBottomScrollHandle<T extends HTMLElement> {
  /** Attach to the scroll container. */
  ref: React.RefObject<T | null>;
  /** True when the user is at (or within `STICK_THRESHOLD_PX` of) the
   *  bottom — auto-scroll is active. False once they scroll up. */
  stuck: boolean;
  /** Programmatically scroll the container to the bottom (smooth, or
   *  instant if reduced-motion is on). Re-enables `stuck`. */
  scrollToBottom: () => void;
}

/**
 * Sticky-bottom scroll controller for the chat message list.
 *
 * Behaviour:
 *   1. While the user is at the bottom (within STICK_THRESHOLD_PX),
 *      every change to `deps` (e.g. new message, new SSE event) snaps
 *      the container to the bottom. This is the "live tail" feel users
 *      expect from chat surfaces while the agent is producing tokens.
 *   2. The moment the user scrolls up past the threshold, `stuck`
 *      flips false and we STOP auto-scrolling. The user is reading
 *      history; don't fight them.
 *   3. Calling `scrollToBottom()` (e.g. from a "回到底部" button) jumps
 *      back and re-engages the stuck state — the next incoming event
 *      keeps them pinned.
 *
 * The scroll listener uses `{ passive: true }` so it doesn't block the
 * scroll thread. Reduced-motion preference disables smooth scrolling.
 */
export function useStickyBottomScroll<T extends HTMLElement>(
  deps: ReadonlyArray<unknown>,
): StickyBottomScrollHandle<T> {
  const ref = useRef<T>(null);
  const [stuck, setStuck] = useState(true);
  // Mirror in a ref so the deps-driven effect below can read the latest
  // value without taking a dependency on `stuck` (which would defeat
  // the "snap on new content" semantics).
  const stuckRef = useRef(stuck);
  stuckRef.current = stuck;

  // Track the user's scroll position. Toggles stuck on/off based on
  // distance from the bottom edge. We compute distance per scroll
  // event — cheap (3 numeric reads), no rAF needed.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    function onScroll() {
      if (!node) return;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const nextStuck = distance <= STICK_THRESHOLD_PX;
      // Only setState on transition — avoids re-renders on every tick.
      if (stuckRef.current !== nextStuck) setStuck(nextStuck);
    }
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  // Whenever the watched deps change AND we're stuck, snap to bottom.
  // We use direct scrollTop assignment (not scrollTo with smooth) here
  // so consecutive token bursts don't queue overlapping smooth scrolls
  // — that would feel laggy. Smooth is reserved for the explicit
  // "回到底部" button via scrollToBottom().
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!stuckRef.current) return;
    const node = ref.current;
    if (!node) return;
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  }, deps);

  const scrollToBottom = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node.scrollTo({
      top: node.scrollHeight,
      behavior: reduced ? "auto" : "smooth",
    });
    setStuck(true);
  }, []);

  return { ref, stuck, scrollToBottom };
}
