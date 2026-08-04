import type { TerminalSessionSnapshot } from "./terminalClient";

export type TerminalStatusPresentation = {
  kind: "opening" | "failure" | "remote";
  message: string;
  canRetry: boolean;
} | null;

const EMBEDDED_TERMINAL_HOST = "host:embedded-desktop";

export function terminalStatusPresentation(
  opening: boolean,
  failure: string | null,
  session: TerminalSessionSnapshot | null,
): TerminalStatusPresentation {
  if (failure) {
    return { kind: "failure", message: failure, canRetry: session === null };
  }
  if (opening) {
    return { kind: "opening", message: "Opening terminal…", canRetry: false };
  }
  if (session && session.authoritativeHostId !== EMBEDDED_TERMINAL_HOST) {
    return {
      kind: "remote",
      message: `Connected to ${hostLabel(session.authoritativeHostId)}`,
      canRetry: false,
    };
  }
  return null;
}

export function terminalStatusRole(
  status: TerminalStatusPresentation,
): "alert" | "status" | undefined {
  if (!status) return undefined;
  return status.kind === "failure" ? "alert" : "status";
}

function hostLabel(hostId: string): string {
  return hostId.replace(/^host:/, "") || hostId;
}
