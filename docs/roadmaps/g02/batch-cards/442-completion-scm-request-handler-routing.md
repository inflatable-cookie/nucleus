# 442 Completion SCM Request Handler Routing

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../095-completion-scm-readiness-control-integration.md`

## Purpose

Route completion SCM diagnostics through the server request handler.

## Scope

- Compose readiness from available task-state history evidence.
- Return repair/missing-state diagnostics when source state is absent.
- Include the domain in all-diagnostics snapshots if appropriate.
- Keep request handling read-only.

## Acceptance Criteria

- [x] Handler returns completion SCM readiness diagnostics.
- [x] Missing state is visible without panic or invented defaults.
- [x] All-diagnostics snapshots include sanitized completion SCM state.
- [x] Handler cannot execute SCM, forge, provider, callback, or recovery effects.

## Validation

- `cargo test -p nucleus-server completion_scm_handler_routing -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
