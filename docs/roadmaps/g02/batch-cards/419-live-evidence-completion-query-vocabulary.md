# 419 Live Evidence Completion Query Vocabulary

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../091-live-evidence-completion-request-handler-diagnostics.md`

## Purpose

Add diagnostics query vocabulary for live evidence completion projection state.

## Scope

- Name the completion diagnostics domain.
- Keep vocabulary separate from mutation commands.
- Preserve unsupported-state behavior.

## Acceptance Criteria

- [x] Completion projection diagnostics has a stable domain label.
- [x] Domain label maps to read-only diagnostics.
- [x] Unsupported labels remain explicit.
- [x] No task/provider/SCM authority is added.

## Validation

- `cargo test -p nucleus-server live_evidence_completion_query_vocabulary -- --nocapture`
- `cargo check --workspace`
- `git diff --check`
