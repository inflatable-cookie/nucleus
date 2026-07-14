# 177 Terminal Host Runtime Boundary

Status: completed
Owner: Codex
Updated: 2026-07-14
Milestone: `../035-host-routed-terminal-panel.md`
Auto-start next card: yes

## Objective

Add byte-oriented terminal session types, host-owned PTY lifecycle, bounded
replay, and a local Tauri adapter without exposing paths or shell commands to
the renderer.

## Acceptance

- project and terminal authority remain host-owned
- open or attach, input, resize, close, output, exit, and diagnostics are typed
- panel remount does not terminate the session
- the local adapter identifies its authoritative host

## Outcome

`TerminalHostRuntime` owns PTY sessions, bounded output replay, byte input,
resize, exit, and close. Tauri adapts it through typed commands and a channel;
paths and shell selection stay host-side.
