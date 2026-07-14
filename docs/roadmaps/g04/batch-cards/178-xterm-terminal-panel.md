# 178 Xterm Terminal Panel

Status: completed
Owner: Codex
Updated: 2026-07-14
Milestone: `../035-host-routed-terminal-panel.md`
Auto-start next card: yes

## Objective

Replace the Terminal placeholder with a minimal full-panel xterm client using
the transport-neutral terminal interface.

## Acceptance

- xterm receives raw output chunks and sends ordered input
- fit and debounced PTY resize follow the panel container
- remount attaches; explicit tab close terminates
- no permanent terminal toolbar is introduced

## Outcome

The Terminal panel now uses xterm and the fit addon through a transport-neutral
client interface. Remount attaches to the host session; tab close terminates
it explicitly.
