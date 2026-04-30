import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { useUndoableDelete } from "./useUndoableDelete";

interface Item {
  id: string;
}

/**
 * Tiny harness that wires the hook to a few buttons so we can drive the
 * lifecycle deterministically without `await`-ing real timers.
 *
 * The default grace window is 5s, but every test sets `graceMs` to a
 * small number so unmount-cleanup tests can still fire the timer in
 * bounded test time.
 */
function Harness({
  commit,
  graceMs,
}: {
  commit: (item: Item) => void | Promise<void>;
  graceMs?: number;
}) {
  const handle = useUndoableDelete<Item>({ commit, graceMs });
  return (
    <div>
      <button
        type="button"
        data-testid="del-a"
        onClick={() => handle.startDelete({ id: "A" })}
      >
        delA
      </button>
      <button
        type="button"
        data-testid="del-b"
        onClick={() => handle.startDelete({ id: "B" })}
      >
        delB
      </button>
      <button type="button" data-testid="undo" onClick={() => handle.undo()}>
        undo
      </button>
      <button type="button" data-testid="dismiss" onClick={() => handle.dismiss()}>
        dismiss
      </button>
      <span data-testid="pending-id">{handle.pending?.id ?? ""}</span>
    </div>
  );
}

function readPending(container: HTMLElement): string {
  const span = container.querySelector("[data-testid=pending-id]");
  return span?.textContent ?? "";
}

describe("useUndoableDelete", () => {
  test("startDelete stages the item as pending", () => {
    const commit = mock((_: Item) => {});
    const { container } = render(<Harness commit={commit} graceMs={50} />);
    fireEvent.click(container.querySelector("[data-testid=del-a]")!);
    expect(readPending(container)).toBe("A");
    expect(commit).not.toHaveBeenCalled();
  });

  test("the timer fires commit and clears pending", async () => {
    const commit = mock((_: Item) => {});
    const { container } = render(<Harness commit={commit} graceMs={20} />);
    fireEvent.click(container.querySelector("[data-testid=del-a]")!);
    await new Promise((r) => setTimeout(r, 60));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0]).toEqual({ id: "A" });
    expect(readPending(container)).toBe("");
  });

  test("undo clears pending and the commit never fires", async () => {
    const commit = mock((_: Item) => {});
    const { container } = render(<Harness commit={commit} graceMs={20} />);
    fireEvent.click(container.querySelector("[data-testid=del-a]")!);
    fireEvent.click(container.querySelector("[data-testid=undo]")!);
    expect(readPending(container)).toBe("");
    await new Promise((r) => setTimeout(r, 60));
    expect(commit).not.toHaveBeenCalled();
  });

  test("dismiss clears pending and commits synchronously", () => {
    const commit = mock((_: Item) => {});
    const { container } = render(<Harness commit={commit} graceMs={1000} />);
    fireEvent.click(container.querySelector("[data-testid=del-a]")!);
    fireEvent.click(container.querySelector("[data-testid=dismiss]")!);
    expect(readPending(container)).toBe("");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0]).toEqual({ id: "A" });
  });

  test("pile-up guard: starting a second delete commits the prior one", () => {
    const commit = mock((_: Item) => {});
    const { container } = render(<Harness commit={commit} graceMs={1000} />);
    fireEvent.click(container.querySelector("[data-testid=del-a]")!);
    fireEvent.click(container.querySelector("[data-testid=del-b]")!);
    // A is committed eagerly so its timer can't fire alongside B's
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0]).toEqual({ id: "A" });
    expect(readPending(container)).toBe("B");
  });

  test("unmount with a pending row commits synchronously", () => {
    const commit = mock((_: Item) => {});
    const { container, unmount } = render(
      <Harness commit={commit} graceMs={1000} />,
    );
    fireEvent.click(container.querySelector("[data-testid=del-a]")!);
    expect(commit).not.toHaveBeenCalled();
    unmount();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0]).toEqual({ id: "A" });
  });

  test("undo returns the staged item for the caller to re-insert", () => {
    let returned: Item | null = null;
    function H() {
      const handle = useUndoableDelete<Item>({
        commit: () => {},
        graceMs: 1000,
      });
      return (
        <>
          <button
            type="button"
            data-testid="del"
            onClick={() => handle.startDelete({ id: "Z" })}
          />
          <button
            type="button"
            data-testid="undo"
            onClick={() => {
              returned = handle.undo();
            }}
          />
        </>
      );
    }
    const { container } = render(<H />);
    fireEvent.click(container.querySelector("[data-testid=del]")!);
    fireEvent.click(container.querySelector("[data-testid=undo]")!);
    expect(returned).toEqual({ id: "Z" });
  });
});
