# 439 Completion SCM Read Model Composition

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../095-completion-scm-readiness-control-integration.md`

## Purpose

Compose completion SCM readiness candidates, provider-neutral mapping,
diagnostics, and authority proof into one read model.

## Scope

- Consume task-state history projections.
- Preserve adapter and workflow labels as metadata.
- Keep missing adapter support visible as readiness state.
- Keep SCM and forge effects out of the read model.

## Acceptance Criteria

- [x] Read model composes candidates, mapping, diagnostics, and authority.
- [x] Provider-neutral vocabulary remains intact.
- [x] Unsupported and repair-required states remain visible.
- [x] No SCM or forge authority is granted.

## Validation

- `cargo test -p nucleus-server completion_scm_read_model -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
