import { describe, expect, test } from "bun:test";
import { useLayoutEffect, useState } from "react";
import { fireEvent, render } from "@testing-library/react";
import { useStickyBottomScroll } from "./useStickyBottomScroll";

/**
 * Harness that:
 *   - Hosts a fixed-height scroll container with `count` lines of
 *     content. Increasing `count` mimics new SSE events arriving.
 *   - Wires `[count]` as the deps array so each bump triggers the
 *     auto-scroll branch when the hook says we're stuck.
 *   - Exposes `stuck` + `scrollToBottom` so the test can assert state
 *     and drive the affordance directly.
 */
function Harness({ initial = 1 }: { initial?: number }) {
  const [count, setCount] = useState(initial);
  const handle = useStickyBottomScroll<HTMLDivElement>([count]);

  // Force the container into a known geometry so the scroll math is
  // deterministic. happy-dom doesn't lay out, so we set the offset
  // properties manually. useLayoutEffect (not useEffect) — layout
  // effects fire BEFORE the hook's regular useEffect, so the auto-
  // scroll branch reads our overridden scrollHeight, not the default.
  useLayoutEffect(() => {
    const node = handle.ref.current;
    if (!node) return;
    Object.defineProperty(node, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(node, "scrollHeight", {
      configurable: true,
      value: 100 + count * 50, // 50px per row beyond the first viewport
    });
  }, [count, handle.ref]);

  return (
    <div>
      <div
        ref={handle.ref}
        data-testid="scroll"
        style={{ height: 100, overflow: "auto" }}
      >
        {Array.from({ length: count }, (_, i) => (
          <p key={i} style={{ height: 50 }}>row {i}</p>
        ))}
      </div>
      <button data-testid="add" onClick={() => setCount((c) => c + 1)}>
        add row
      </button>
      <button data-testid="goto" onClick={() => handle.scrollToBottom()}>
        go bottom
      </button>
      <span data-testid="stuck">{handle.stuck ? "yes" : "no"}</span>
    </div>
  );
}

function readStuck(c: HTMLElement) {
  return c.querySelector("[data-testid=stuck]")?.textContent ?? "";
}

function setScrollTop(node: HTMLElement, value: number) {
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    value,
    writable: true,
  });
}

describe("useStickyBottomScroll", () => {
  test("starts in the stuck state and snaps the container to the bottom on each deps change", () => {
    const { container, getByTestId } = render(<Harness />);
    expect(readStuck(container)).toBe("yes");
    const scroll = getByTestId("scroll") as HTMLElement;
    // After first render: scrollHeight = 150, clientHeight = 100 → bottom = 50.
    expect(scroll.scrollTop).toBe(50);

    // Adding a row should re-scroll to the new bottom.
    fireEvent.click(getByTestId("add"));
    // count=2 → scrollHeight = 200; bottom = 100.
    expect(scroll.scrollTop).toBe(100);
  });

  test("scrolling up past the threshold flips stuck off and stops auto-scroll", () => {
    const { container, getByTestId } = render(<Harness initial={3} />);
    const scroll = getByTestId("scroll") as HTMLElement;
    // count=3 → scrollHeight = 250; first auto-snap = 150.
    expect(scroll.scrollTop).toBe(150);
    expect(readStuck(container)).toBe("yes");

    // User scrolls up well past the 80px threshold.
    setScrollTop(scroll, 0);
    fireEvent.scroll(scroll);
    expect(readStuck(container)).toBe("no");

    // New row arrives while detached — scroll stays put.
    fireEvent.click(getByTestId("add"));
    expect(scroll.scrollTop).toBe(0);
  });

  test("scrollToBottom programmatic call re-engages stuck and pins again", () => {
    const { container, getByTestId } = render(<Harness initial={3} />);
    const scroll = getByTestId("scroll") as HTMLElement;
    setScrollTop(scroll, 0);
    fireEvent.scroll(scroll);
    expect(readStuck(container)).toBe("no");

    fireEvent.click(getByTestId("goto"));
    expect(readStuck(container)).toBe("yes");

    // Subsequent row keeps us pinned.
    fireEvent.click(getByTestId("add"));
    // After scrollToBottom we're back in stuck mode; the next deps
    // change snaps to bottom again. count=4 → scrollHeight = 300 → 200.
    expect(scroll.scrollTop).toBe(200);
  });

  test("scrolling within the threshold (<= 80px from bottom) stays stuck", () => {
    const { container, getByTestId } = render(<Harness initial={3} />);
    const scroll = getByTestId("scroll") as HTMLElement;
    // 70px from bottom: scrollHeight=250, clientHeight=100, scrollTop=80 → distance=70.
    setScrollTop(scroll, 80);
    fireEvent.scroll(scroll);
    expect(readStuck(container)).toBe("yes");
  });
});
