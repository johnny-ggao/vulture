import { describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { useCursorGloss } from "./useCursorGloss";

/**
 * Tiny harness that wires the hook to a fixed-size div so we can drive
 * mouse events with deterministic geometry.
 */
function Probe() {
  const { ref, ...gloss } = useCursorGloss<HTMLDivElement>();
  return (
    <div
      ref={ref}
      data-testid="probe"
      style={{
        position: "fixed",
        top: 100,
        left: 100,
        width: 200,
        height: 100,
      }}
      {...gloss}
    />
  );
}

describe("useCursorGloss", () => {
  test("does not write CSS variables before mouseenter is observed", () => {
    const { container } = render(<Probe />);
    const node = container.querySelector("[data-testid=probe]") as HTMLDivElement;
    fireEvent.mouseMove(node, { clientX: 150, clientY: 150 });
    // Without an enter event the cached rect is null — handler returns early
    // and never writes the inline style.
    expect(node.style.getPropertyValue("--mouse-x")).toBe("");
    expect(node.style.getPropertyValue("--mouse-y")).toBe("");
  });

  test("writes --mouse-x / --mouse-y on mousemove after enter", () => {
    const { container } = render(<Probe />);
    const node = container.querySelector("[data-testid=probe]") as HTMLDivElement;
    fireEvent.mouseEnter(node);
    fireEvent.mouseMove(node, { clientX: 150, clientY: 125 });
    // happy-dom returns a zero-sized DOMRect for elements that haven't
    // been laid out, so the divisor can be 0 and the resulting value can
    // be `Infinity` / `NaN` — what we care about for this test is that
    // SOMETHING was written to both custom properties (the empty string
    // means the handler short-circuited).
    expect(node.style.getPropertyValue("--mouse-x")).not.toBe("");
    expect(node.style.getPropertyValue("--mouse-y")).not.toBe("");
  });

  test("preserves last cursor coords on mouseleave (no center-snap)", () => {
    const { container } = render(<Probe />);
    const node = container.querySelector("[data-testid=probe]") as HTMLDivElement;
    fireEvent.mouseEnter(node);
    fireEvent.mouseMove(node, { clientX: 150, clientY: 125 });
    const xBefore = node.style.getPropertyValue("--mouse-x");
    const yBefore = node.style.getPropertyValue("--mouse-y");
    expect(xBefore).not.toBe("");

    fireEvent.mouseLeave(node);
    // Coords should be untouched — opacity transition handles the exit.
    expect(node.style.getPropertyValue("--mouse-x")).toBe(xBefore);
    expect(node.style.getPropertyValue("--mouse-y")).toBe(yBefore);
  });

  test("after leave, a fresh enter+move re-binds rect and writes again", () => {
    const { container } = render(<Probe />);
    const node = container.querySelector("[data-testid=probe]") as HTMLDivElement;
    fireEvent.mouseEnter(node);
    fireEvent.mouseMove(node, { clientX: 150, clientY: 125 });
    fireEvent.mouseLeave(node);

    // After leave, a stray move (no enter) must NOT update — the rect was
    // invalidated.
    node.style.removeProperty("--mouse-x");
    fireEvent.mouseMove(node, { clientX: 200, clientY: 150 });
    expect(node.style.getPropertyValue("--mouse-x")).toBe("");

    // A fresh enter re-caches and the next move writes again.
    fireEvent.mouseEnter(node);
    fireEvent.mouseMove(node, { clientX: 200, clientY: 150 });
    expect(node.style.getPropertyValue("--mouse-x")).not.toBe("");
  });

  test("window resize invalidates the cached rect — stale rect can't sneak in", () => {
    const { container } = render(<Probe />);
    const node = container.querySelector("[data-testid=probe]") as HTMLDivElement;
    fireEvent.mouseEnter(node);
    fireEvent.mouseMove(node, { clientX: 150, clientY: 125 });
    expect(node.style.getPropertyValue("--mouse-x")).not.toBe("");

    // Simulate resize → cached rect is dropped.
    window.dispatchEvent(new Event("resize"));
    node.style.removeProperty("--mouse-x");

    // A move WITHOUT a fresh enter shouldn't write anything (rect is null).
    fireEvent.mouseMove(node, { clientX: 150, clientY: 125 });
    expect(node.style.getPropertyValue("--mouse-x")).toBe("");
  });
});
