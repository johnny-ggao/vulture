import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Segmented } from "./Segmented";

type V = "low" | "medium" | "high";

const OPTS = [
  { value: "low" as V, label: "Low" },
  { value: "medium" as V, label: "Medium" },
  { value: "high" as V, label: "High" },
];

describe("Segmented", () => {
  test("renders one radio per option, exposes the active state via aria-checked", () => {
    render(
      <Segmented
        ariaLabel="Mode"
        value="medium"
        options={OPTS}
        onChange={() => {}}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Mode" });
    expect(group).toBeDefined();
    const low = screen.getByRole("radio", { name: "Low" });
    const med = screen.getByRole("radio", { name: "Medium" });
    const hi = screen.getByRole("radio", { name: "High" });
    expect(low.getAttribute("aria-checked")).toBe("false");
    expect(med.getAttribute("aria-checked")).toBe("true");
    expect(hi.getAttribute("aria-checked")).toBe("false");
  });

  test("clicking a segment fires onChange with the segment's value", () => {
    const onChange = mock((_v: V) => {});
    render(
      <Segmented
        ariaLabel="Mode"
        value="low"
        options={OPTS}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "High" }));
    expect(onChange).toHaveBeenCalledWith("high");
  });

  test("disabled segment does NOT fire onChange when clicked", () => {
    const onChange = mock((_v: V) => {});
    render(
      <Segmented
        ariaLabel="Mode"
        value="low"
        options={[
          { value: "low" as V, label: "Low" },
          { value: "medium" as V, label: "Medium", disabled: true },
        ]}
        onChange={onChange}
      />,
    );
    const med = screen.getByRole("radio", { name: "Medium" });
    expect((med as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(med);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("compact size adds the .segmented-compact track class", () => {
    const { container } = render(
      <Segmented
        ariaLabel="Mode"
        value="low"
        options={OPTS}
        onChange={() => {}}
        size="compact"
      />,
    );
    const group = container.querySelector(".segmented");
    expect(group?.classList.contains("segmented-compact")).toBe(true);
  });
});
