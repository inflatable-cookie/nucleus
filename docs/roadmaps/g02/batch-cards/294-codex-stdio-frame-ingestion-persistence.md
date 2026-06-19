# 294 Codex Stdio Frame Ingestion Persistence

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../065-codex-turn-start-transport-executor-handoff.md`

## Purpose

Persist first-response stdio frame source and decode evidence for Codex
`turn/start` without retaining raw streams.

## Scope

- Persist frame source refs.
- Persist decode status and sanitized summaries.
- Link decoded observations to event/receipt refs.
- Keep unsupported or duplicate frames visible.

## Acceptance Criteria

- [x] Frame/decode evidence survives process restart.
- [x] Duplicate and unsupported frames remain inspectable.
- [x] Raw stdio streams are not retained.
- [x] Task mutation remains blocked.

## Validation

- targeted Codex/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if live frame ordering needs a new stream sequence contract.
