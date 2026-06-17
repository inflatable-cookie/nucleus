# 252 Render Seeded Command Diagnostics

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Confirm the Svelte command diagnostics panel renders seeded evidence clearly.

## Scope

- Render list row fields.
- Render selected detail fields.
- Preserve empty and error handling.
- Keep layout stable with long ids and summaries.

## Out Of Scope

- Final visual design.
- Artifact downloads.
- Execution controls.

## Promotion Targets

- `apps/desktop/src/lib/CommandDiagnosticsPanel.svelte`
- `apps/desktop/src/styles.css`

## Acceptance Criteria

- Seeded evidence appears in the panel.
- Long ids and summaries do not break layout.
- No server state is mutated by selection.

## Outcome

The command diagnostics panel renders seeded command evidence rows and detail
fields from `queryCommandHistory`. Selection, loading, and errors remain local
Svelte state.
