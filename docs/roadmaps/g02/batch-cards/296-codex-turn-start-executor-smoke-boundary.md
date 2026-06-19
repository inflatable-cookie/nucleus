# 296 Codex Turn Start Executor Smoke Boundary

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../065-codex-turn-start-transport-executor-handoff.md`

## Purpose

Add the stopped-by-default smoke boundary for a real Codex `turn/start` write.

## Scope

- Require explicit operator confirmation.
- Require complete authority, envelope, persistence, and diagnostics evidence.
- Keep a no-execution path for environments without Codex auth or transport.
- Record outcomes without raw payload retention.

## Acceptance Criteria

- [x] Smoke execution is blocked by default.
- [x] Operator confirmation is required before any real write.
- [x] Missing auth, transport, or policy records produce blockers.
- [x] Task mutation remains blocked.

## Validation

- targeted Codex/server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop and ask before running any real Codex provider write.
