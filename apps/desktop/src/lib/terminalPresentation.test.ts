import { describe, expect, test } from "bun:test";
import type { TerminalSessionSnapshot } from "./terminalClient";
import { terminalStatusPresentation, terminalStatusRole } from "./terminalPresentation";

describe("terminalStatusPresentation", () => {
  test("keeps a healthy embedded terminal quiet", () => {
    expect(terminalStatusPresentation(false, null, session("host:embedded-desktop"))).toBeNull();
  });

  test("shows bounded opening and retryable open failure", () => {
    expect(terminalStatusPresentation(true, null, null)).toEqual({
      kind: "opening",
      message: "Opening terminal…",
      canRetry: false,
    });
    expect(terminalStatusPresentation(false, "Host unavailable", null)).toEqual({
      kind: "failure",
      message: "Host unavailable",
      canRetry: true,
    });
  });

  test("shows only host-confirmed non-local identity", () => {
    expect(terminalStatusPresentation(false, null, session("host:build-one"))).toEqual({
      kind: "remote",
      message: "Connected to build-one",
      canRetry: false,
    });
  });

  test("does not offer reopen for a live session input failure", () => {
    expect(
      terminalStatusPresentation(false, "Terminal input failed", session("host:embedded-desktop")),
    ).toEqual({
      kind: "failure",
      message: "Terminal input failed",
      canRetry: false,
    });
  });

  test("announces failures assertively and routine status politely", () => {
    expect(terminalStatusRole({ kind: "failure", message: "Unavailable", canRetry: true }))
      .toBe("alert");
    expect(terminalStatusRole({ kind: "opening", message: "Opening terminal…", canRetry: false }))
      .toBe("status");
    expect(terminalStatusRole(null)).toBeUndefined();
  });
});

function session(authoritativeHostId: string): TerminalSessionSnapshot {
  return {
    sessionId: "terminal:test",
    projectId: "project:test",
    panelId: "panel:test",
    resourceId: "resource:test",
    authoritativeHostId,
    rows: 24,
    cols: 80,
    attached: false,
    exited: false,
  };
}
