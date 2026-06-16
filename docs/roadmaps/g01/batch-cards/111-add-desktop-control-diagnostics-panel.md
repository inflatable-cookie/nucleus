# 111 Add Desktop Control Diagnostics Panel

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Replace the single command probe area with a small read-only diagnostics panel.

## Scope

- Add a diagnostics panel to the desktop shell.
- Display protocol family/version, request status, and last response/error.
- Keep the existing Tauri command path.
- Use Poodle components where they fit.

## Out Of Scope

- Project switcher.
- Task list.
- Terminal, browser, editor, or SCM panels.
- Live subscriptions.
- Remote transport.
- State mutation.

## Promotion Targets

- `apps/desktop/src`
- `apps/desktop/README.md`
- `docs/architecture/system-inventory.md`
- `docs/roadmaps/g01/012-desktop-control-diagnostics-and-panel-foundation.md`

## Acceptance Criteria

- [x] Diagnostics panel can issue the existing runtime metadata probe.
- [x] Diagnostics panel renders the response status and raw DTO payload.
- [x] Diagnostics panel renders command errors distinctly.
- [x] TypeScript remains view glue and DTO construction only.
- [x] No server behavior is added.

## Notes

- Added `ControlDiagnosticsPanel.svelte`.
- The panel displays protocol family, protocol version, last request id, last
  status, and raw DTO output.
- Browser-only Vite rendering cannot invoke Tauri commands, so command-path
  behavior remains covered by the desktop crate test.

## Validation

```sh
bun run check
bun run build
cargo test -p nucleus-desktop
```
