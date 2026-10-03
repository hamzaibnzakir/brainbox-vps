import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorView } from "../ErrorView";
import { errorIs, toAppError } from "@/services/errors";

describe("ErrorView", () => {
  it("shows a human message and hides technical details until expanded", () => {
    render(
      <ErrorView
        error={{ code: "auth_failed", title: "Login failed", message: "The server rejected the password.", causes: ["Wrong password"], details: "russh: Auth failure" }}
      />,
    );
    expect(screen.getByText("Login failed")).toBeInTheDocument();
    expect(screen.getByText("Wrong password")).toBeInTheDocument();
    expect(screen.queryByText("russh: Auth failure")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /technical details/i }));
    expect(screen.getByText("russh: Auth failure")).toBeInTheDocument();
  });
});

describe("toAppError", () => {
  it("wraps unknown errors without losing the raw text", () => {
    const e = toAppError(new Error("boom"));
    expect(e.title).toBe("Something went wrong");
    expect(e.details).toBe("boom");
  });
  it("passes app errors through", () => {
    const e = toAppError({ code: "connection_timeout", title: "Timed out", message: "x" });
    expect(e.causes).toEqual([]);
    expect(errorIs(e, "connection_timeout")).toBe(true);
  });
});
