# 380 Provider Live Read Command Handoff Validation

Status: completed
Owner: Tom
Updated: 2026-06-22
Milestone: `../095-provider-live-read-executor-command-runner-handoff.md`

## Purpose

Validate the command-runner handoff lane and decide whether the next provider
step should be live execution, persistence, or a planning checkpoint.

## Acceptance Criteria

- [x] Targeted Rust tests pass.
- [x] Docs QA and Northstar QA pass.
- [x] Doctor remains error-free.
- [x] Next task is updated only in `docs/roadmaps/README.md`.
