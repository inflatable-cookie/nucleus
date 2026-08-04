<script lang="ts">
  import { onMount } from "svelte";
  import { FitAddon } from "@xterm/addon-fit";
  import { Terminal } from "@xterm/xterm";
  import "@xterm/xterm/css/xterm.css";
  import {
    terminalTransport,
    type TerminalEvent,
    type TerminalSessionSnapshot,
  } from "./terminalClient";
  import { terminalStatusPresentation, terminalStatusRole } from "./terminalPresentation";

  let {
    panelId,
    projectId,
    resourceId = null,
  }: { panelId: string; projectId: string | null; resourceId?: string | null } = $props();

  let viewport = $state<HTMLDivElement | null>(null);
  let failure = $state<string | null>(null);
  let session = $state<TerminalSessionSnapshot | null>(null);
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let inputQueue = "";
  let writing = false;
  let mounted = $state(false);
  let activeProjectId: string | null = null;
  let openingProjectId: string | null = null;
  const status = $derived(terminalStatusPresentation(openingProjectId !== null, failure, session));

  $effect(() => {
    const selectedProjectId = projectId;
    if (!mounted || !terminal) return;
    if (!selectedProjectId) {
      failure = "Select a project to open a terminal";
      return;
    }
    void ensureSession(selectedProjectId);
  });

  onMount(() => {
    if (!viewport) {
      failure = "Terminal viewport is unavailable";
      return;
    }

    const theme = terminalTheme(viewport);
    terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: theme.background,
        foreground: theme.foreground,
        cursor: theme.foreground,
        cursorAccent: theme.background,
        selectionBackground: "#30455f99",
        black: theme.background,
        brightBlack: theme.muted,
      },
    });
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(viewport);
    fitAddon.fit();
    terminal.onData((data) => {
      inputQueue += data;
      void flushInput();
    });

    resizeObserver = new ResizeObserver(queueResize);
    resizeObserver.observe(viewport);
    mounted = true;

    return dispose;
  });

  async function ensureSession(selectedProjectId: string): Promise<void> {
    if (
      !terminal ||
      activeProjectId === selectedProjectId ||
      openingProjectId === selectedProjectId
    ) return;
    openingProjectId = selectedProjectId;
    session = null;
    terminal.reset();
    failure = null;
    try {
      const opened = await terminalTransport.openOrAttach(
        {
          projectId: selectedProjectId,
          panelId,
          resourceId,
          rows: Math.max(1, terminal.rows),
          cols: Math.max(1, terminal.cols),
        },
        (event) => handleEvent(selectedProjectId, event),
      );
      if (!mounted || projectId !== selectedProjectId) return;
      session = opened;
      activeProjectId = selectedProjectId;
      terminal.focus();
      queueResize();
      void flushInput();
    } catch (caught) {
      if (projectId === selectedProjectId) failure = formatError(caught);
    } finally {
      if (openingProjectId === selectedProjectId) openingProjectId = null;
    }
  }

  function retryOpen(): void {
    if (!projectId || openingProjectId) return;
    failure = null;
    activeProjectId = null;
    void ensureSession(projectId);
  }

  function handleEvent(eventProjectId: string, event: TerminalEvent): void {
    if (!terminal || projectId !== eventProjectId) return;
    if (event.kind === "output") {
      terminal.write(Uint8Array.from(event.data));
    } else if (event.kind === "diagnostic") {
      terminal.writeln(`\r\n\x1b[90m[${event.message}]\x1b[0m`);
    } else {
      const outcome = event.signal ?? (event.exitCode === null ? "unknown" : String(event.exitCode));
      terminal.writeln(`\r\n\x1b[90m[Process exited: ${outcome}]\x1b[0m`);
    }
  }

  async function flushInput(): Promise<void> {
    if (writing || !session || inputQueue.length === 0) return;
    writing = true;
    try {
      while (session && inputQueue.length > 0) {
        const chunk = inputQueue;
        inputQueue = "";
        await terminalTransport.write(session.sessionId, new TextEncoder().encode(chunk));
      }
    } catch (caught) {
      failure = formatError(caught);
    } finally {
      writing = false;
      if (inputQueue.length > 0) void flushInput();
    }
  }

  function queueResize(): void {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      void resize();
    }, 60);
  }

  async function resize(): Promise<void> {
    if (!terminal || !fitAddon) return;
    fitAddon.fit();
    if (!session || (session.rows === terminal.rows && session.cols === terminal.cols)) return;
    try {
      await terminalTransport.resize(session.sessionId, terminal.rows, terminal.cols);
      session = { ...session, rows: terminal.rows, cols: terminal.cols };
    } catch (caught) {
      failure = formatError(caught);
    }
  }

  function dispose(): void {
    mounted = false;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = null;
    terminal?.dispose();
    terminal = null;
    fitAddon = null;
  }

  function formatError(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
  }

  function terminalTheme(element: HTMLElement): {
    background: string;
    foreground: string;
    muted: string;
  } {
    const style = getComputedStyle(element);
    return {
      background: token(style, "--poodle-color-background-canvas", "#0d1013"),
      foreground: token(style, "--poodle-color-text-primary", "#d8dde5"),
      muted: token(style, "--poodle-color-text-muted", "#707985"),
    };
  }

  function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
    return style.getPropertyValue(name).trim() || fallback;
  }
</script>

<section class="terminal-panel" aria-label="Terminal">
  <div class="terminal-viewport" bind:this={viewport}></div>
  {#if status}
    <div
      class:terminal-status--remote={status.kind === "remote"}
      class="terminal-status"
      role={terminalStatusRole(status)}
      aria-live={status.kind === "failure" ? "assertive" : "polite"}
    >
      <span>{status.message}</span>
      {#if status.canRetry}
        <button type="button" onclick={retryOpen}>Retry</button>
      {/if}
    </div>
  {/if}
</section>

<style>
  .terminal-panel {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: var(--poodle-color-background-canvas);
  }

  .terminal-viewport {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .terminal-viewport :global(.xterm) {
    height: 100%;
    padding: 10px 12px;
  }

  .terminal-viewport :global(.xterm .xterm-viewport) {
    background-color: var(--poodle-color-background-canvas);
    scrollbar-width: thin;
  }

  .terminal-status {
    position: absolute;
    inset: auto 12px 12px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--poodle-color-border-default) 75%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--poodle-color-background-surface) 94%, transparent);
    color: var(--poodle-color-text-muted);
    font-size: 12px;
  }

  .terminal-status--remote {
    inset: 10px 12px auto auto;
    padding: 5px 8px;
  }

  .terminal-status button {
    padding: 0.2rem 0.45rem;
    color: var(--poodle-color-text-secondary);
    font: inherit;
    border: 1px solid var(--poodle-color-border-subtle);
    border-radius: var(--poodle-radius-control);
    background: transparent;
    cursor: pointer;
  }

  .terminal-status button:hover {
    color: var(--poodle-color-text-primary);
    background: var(--poodle-color-background-elevated);
  }
</style>
