import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";

describe("dom available", () => {
  test("renders a paragraph", () => {
    render(<p>hello</p>);
    expect(screen.getByText("hello")).toBeDefined();
  });
});
