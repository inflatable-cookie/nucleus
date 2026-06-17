# 254 Add Forbidden Command Control Regression

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Prevent the disposable diagnostics panel from gaining command controls before
server contracts exist.

## Scope

- Add a focused text, component, or fixture assertion where practical.
- Check for run, cancel, retry, approve, artifact download, PTY, and streaming
  controls.
- Keep the test cheap.

## Out Of Scope

- Full browser automation.
- Final permissions UX.

## Promotion Targets

- `apps/desktop`

## Acceptance Criteria

- Regression fails if forbidden controls are introduced casually.
- The check is scoped to the diagnostics panel.

## Outcome

A desktop Rust test reads `CommandDiagnosticsPanel.svelte` and fails if common
command-control or artifact-control entry points appear before contracts exist.
