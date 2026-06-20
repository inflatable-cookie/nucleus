# 422 Live Evidence Completion Handler Authority Regressions

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../091-live-evidence-completion-request-handler-diagnostics.md`

## Purpose

Prove live evidence completion diagnostics requests remain read-only.

## Scope

- Exercise query vocabulary, handler composition, and missing-state routing.
- Block task mutation, provider execution, SCM, callback, interruption, and
  recovery authority.

## Acceptance Criteria

- [x] Handler cannot mutate task state.
- [x] Handler cannot start provider/SCM effects.
- [x] Handler cannot answer callbacks or resume/interrupt providers.
- [x] DTOs remain sanitized.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_handler_authority -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
