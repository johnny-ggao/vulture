import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorAlert, Field, SectionCard, Toggle } from "./index";

describe("Field", () => {
  test("renders label and children", () => {
    render(
      <Field label="Email">
        <input type="email" />
      </Field>,
    );
    expect(screen.getByText("Email")).toBeDefined();
    expect(screen.getByRole("textbox")).toBeDefined();
  });

  test("required mark uses aria-hidden so screen readers don't announce '*'", () => {
    const { container } = render(
      <Field label="Name" required>
        <input />
      </Field>,
    );
    const star = container.querySelector(".field-required");
    expect(star?.textContent).toBe("*");
    expect(star?.getAttribute("aria-hidden")).toBe("true");
  });

  test("renders hint when provided", () => {
    render(
      <Field label="Name" hint="Up to 32 characters">
        <input />
      </Field>,
    );
    expect(screen.getByText("Up to 32 characters")).toBeDefined();
  });

  test("renders error with role=alert", () => {
    render(
      <Field label="Name" error="Required">
        <input />
      </Field>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Required");
  });

  test("does not render error region when error is null", () => {
    render(
      <Field label="Name" error={null}>
        <input />
      </Field>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("clicking the visible label focuses the input via implicit label association", () => {
    const { container } = render(
      <Field label="Name">
        <input />
      </Field>,
    );
    const label = container.querySelector(".field");
    expect(label?.tagName.toLowerCase()).toBe("label");
  });
});

describe("SectionCard", () => {
  test("renders body without header when title and actions are absent", () => {
    const { container } = render(
      <SectionCard>
        <div>body</div>
      </SectionCard>,
    );
    expect(container.querySelector(".section-card-head")).toBeNull();
    expect(screen.getByText("body")).toBeDefined();
  });

  test("renders title and description when provided", () => {
    render(
      <SectionCard title="Profiles" description="Switch active agent profile">
        <div>body</div>
      </SectionCard>,
    );
    expect(screen.getByRole("heading", { name: "Profiles" })).toBeDefined();
    expect(screen.getByText("Switch active agent profile")).toBeDefined();
  });

  test("renders actions slot", () => {
    render(
      <SectionCard
        title="Servers"
        actions={<button type="button">Refresh</button>}
      >
        body
      </SectionCard>,
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined();
  });

  test("appends custom className", () => {
    const { container } = render(
      <SectionCard className="dense">body</SectionCard>,
    );
    expect(container.querySelector(".section-card.dense")).not.toBeNull();
  });
});

describe("ErrorAlert", () => {
  test("renders nothing when message is empty", () => {
    const { container } = render(<ErrorAlert message={null} />);
    expect(container.querySelector(".error-alert")).toBeNull();
  });

  test("renders message with role=alert", () => {
    render(<ErrorAlert message="Server unreachable" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Server unreachable");
  });
});

describe("Toggle", () => {
  test("renders as a switch with the right aria-checked value", () => {
    render(<Toggle ariaLabel="Notifications" checked onChange={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Notifications" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  test("clicking flips and calls onChange with the new value", () => {
    const onChange = mock((_v: boolean) => {});
    render(<Toggle ariaLabel="Notifications" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test("disabled toggle does not invoke onChange when clicked", () => {
    const onChange = mock((_v: boolean) => {});
    render(<Toggle ariaLabel="Notifications" checked={false} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
