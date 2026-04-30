import * as React from "react";
import { useEffect, useRef } from "react";

/**
 * Cursor-tracked spotlight glue: returns a ref + the three mouse handlers
 * to spread on the target element. The hook caches the element's bounding
 * rect on `mouseenter` and writes `--mouse-x` / `--mouse-y` (0-1 normalised)
 * to the element's inline style on each `mousemove`. CSS `::after` reads
 * the custom properties via `calc(var(...) * 100%)` to position a radial
 * gradient that follows the cursor.
 *
 * Direct DOM mutation (`style.setProperty`) is intentional — mousemove
 * fires at 60-120Hz and we don't want to trigger React re-renders. The
 * handlers are returned by a stable identity-equal object via `useRef`
 * so React doesn't see them as fresh props each render.
 *
 * On window resize the cached rect goes stale; we listen for resize and
 * invalidate it so the next move event re-measures.
 *
 * The hook returns nothing on the *cursor leave* code path — the consumer
 * is expected to fade the spotlight via a CSS opacity transition. The
 * coordinates stay at their last value so the fade reads as continuous.
 */
export function useCursorGloss<T extends HTMLElement>(): {
  ref: React.RefObject<T>;
  onMouseEnter: () => void;
  onMouseMove: (event: React.MouseEvent<T>) => void;
  onMouseLeave: () => void;
} {
  // Initialiser is `null` at runtime but the type asserts non-null so the
  // hook is compatible with React 18's `RefObject<T>` (legacy) ref-prop
  // signature, which doesn't accept the newer `T | null` shape.
  const ref = useRef<T>(null as unknown as T);
  const rectRef = useRef<DOMRect | null>(null);

  useEffect(() => {
    function invalidate() {
      rectRef.current = null;
    }
    window.addEventListener("resize", invalidate);
    return () => window.removeEventListener("resize", invalidate);
  }, []);

  // Stable handler identity so consumers can spread `{...gloss}` without
  // tripping React's prop-equality fast paths. We don't memoise via
  // useCallback — the closures are bound to refs that never change identity.
  //
  // INVARIANT: the handler closures may ONLY reference refs (whose `.current`
  // mutates in place) — NOT props or state captured by render. The handlers
  // are bound at first render and retained across the component lifetime;
  // closing over a fresh prop here would silently freeze that prop's value
  // forever. If you need to read a prop or piece of state inside a handler,
  // either (a) plumb it through a ref written in a `useEffect`, or (b) drop
  // the `useRef` wrapper and switch to `useCallback([dep])`.
  const handlers = useRef({
    onMouseEnter() {
      rectRef.current = ref.current?.getBoundingClientRect() ?? null;
    },
    onMouseMove(event: React.MouseEvent<T>) {
      const node = ref.current;
      const rect = rectRef.current;
      if (!node || !rect) return;
      const x = ((event.clientX - rect.left) / rect.width).toFixed(3);
      const y = ((event.clientY - rect.top) / rect.height).toFixed(3);
      node.style.setProperty("--mouse-x", x);
      node.style.setProperty("--mouse-y", y);
    },
    onMouseLeave() {
      rectRef.current = null;
    },
  });

  return {
    ref,
    onMouseEnter: handlers.current.onMouseEnter,
    onMouseMove: handlers.current.onMouseMove,
    onMouseLeave: handlers.current.onMouseLeave,
  };
}
