# 035 Agent Local Paths

Status: active
Owner: Tom
Updated: 2026-08-17

## Scope

Repository-local path registry for agents and orchestrator-dispatched workers.

Northstar greenfield repos use `002-agent-local-paths.md`. Nucleus keeps the
existing `002-harness-adapter-contract.md` and records agent path rules here
instead.

## Files

- tracked example: `.agents.local.env.example`
- ignored runtime file: `.agents.local.env`

The ignored file is path-only. It must never contain credentials, tokens, or
other secrets.

## Keys

- `AGENTS_WORKTREE_CONTAINER_DIR` — required before an agent creates a Git
  worktree manually
- `AGENTS_SCRATCH_DIR` — optional shared scratch location
- `AGENTS_ARTIFACT_DIR` — optional large local artifact location

All values must be absolute paths.

## Rules

- prefer harness-managed worktree and artifact locations when available
- if a manual worktree is needed and `AGENTS_WORKTREE_CONTAINER_DIR` is absent,
  ask the operator for an absolute container directory, create the ignored file
  from that answer, and stop rather than guessing `/tmp`, `TMPDIR`, or a
  repository-adjacent path
- do not store credentials or secret material in either file
