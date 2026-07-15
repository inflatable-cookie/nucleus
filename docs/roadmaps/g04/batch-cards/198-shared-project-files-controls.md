# 198 Shared Project Files Controls

Status: planned
Owner: Codex
Updated: 2026-07-15
Milestone: `../041-shared-project-files-control.md`
Auto-start next card: yes

## Objective

Expose optional Shared project files configuration, sync policy, health, and
repair diagnostics behind project management controls.

## Acceptance

- configuration is absent from basic New project and New chat flows
- the UI distinguishes active server state from projected Git files
- one active target is enforced truthfully
- sync and conflict state reuse server diagnostics rather than client guesses

## Stop Conditions

- project creation blocks on Git or forge configuration
- the UI implies every code repository receives management files
