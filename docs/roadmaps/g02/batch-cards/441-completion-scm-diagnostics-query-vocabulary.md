# 441 Completion SCM Diagnostics Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../095-completion-scm-readiness-control-integration.md`

## Purpose

Add control API and envelope vocabulary for completion SCM diagnostics.

## Scope

- Add a diagnostics query kind.
- Add request-domain string mapping.
- Add response DTO variant.
- Keep vocabulary provider-neutral.

## Acceptance Criteria

- [x] Query vocabulary round-trips through request DTOs.
- [x] Response DTO variant serializes sanitized readiness.
- [x] Domain name avoids Git-only language.
- [x] No effect authority is introduced.

## Validation

- `cargo test -p nucleus-server completion_scm_query_vocabulary -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
