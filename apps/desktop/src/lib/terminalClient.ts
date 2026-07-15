import { Channel, invoke } from "@tauri-apps/api/core";

export interface TerminalOpenRequest {
  projectId: string;
  panelId: string;
  resourceId: string | null;
  rows: number;
  cols: number;
}

export interface TerminalSessionSnapshot {
  sessionId: string;
  projectId: string;
  panelId: string;
  resourceId: string | null;
  authoritativeHostId: string;
  rows: number;
  cols: number;
  attached: boolean;
  exited: boolean;
}

export type TerminalEvent =
  | { kind: "output"; sessionId: string; sequence: number; data: number[] }
  | { kind: "exited"; sessionId: string; exitCode: number | null; signal: string | null }
  | { kind: "diagnostic"; sessionId: string; message: string };

export interface TerminalTransport {
  openOrAttach(
    request: TerminalOpenRequest,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalSessionSnapshot>;
  write(sessionId: string, data: Uint8Array): Promise<void>;
  resize(sessionId: string, rows: number, cols: number): Promise<void>;
  close(projectId: string, panelId: string): Promise<void>;
}

class TauriTerminalTransport implements TerminalTransport {
  async openOrAttach(
    request: TerminalOpenRequest,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalSessionSnapshot> {
    const channel = new Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    return invoke<TerminalSessionSnapshot>("terminal_open_or_attach", {
      request,
      onEvent: channel,
    });
  }

  async write(sessionId: string, data: Uint8Array): Promise<void> {
    return invoke("terminal_write", { sessionId, data: Array.from(data) });
  }

  async resize(sessionId: string, rows: number, cols: number): Promise<void> {
    return invoke("terminal_resize", { sessionId, rows, cols });
  }

  async close(projectId: string, panelId: string): Promise<void> {
    return invoke("terminal_close_for_panel", { projectId, panelId });
  }
}

export const terminalTransport: TerminalTransport = new TauriTerminalTransport();

export async function closeTerminalPanel(projectId: string, panelId: string): Promise<void> {
  return terminalTransport.close(projectId, panelId);
}

export async function closeTerminalProject(projectId: string): Promise<void> {
  return invoke("terminal_close_for_project", { projectId });
}
