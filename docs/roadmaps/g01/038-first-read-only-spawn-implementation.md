# 038 First Read-Only Spawn Implementation

Status: completed
Owner: Tom
Updated: 2026-06-17

## Goal

Implement the first real bounded read-only local command spawn path.

## Scope

- Use the existing host-spawn readiness gate before attempting spawn.
- Execute only structured invocations that match the read-only command subset.
- Enforce finite timeout, bounded output, and no shell passthrough.
- Publish sanitized process supervision events and command evidence refs.
- Keep raw output out of default state and logs.

## Out Of Scope

- PTY or terminal rendering.
- Interactive stdin.
- Write-enabled commands.
- Remote process execution.
- Shell passthrough.

## Decisions

- Real spawn may begin only after all backend descriptors are concrete and the
  host-spawn gate reports ready.
- First implementation should be narrow and easy to delete or replace.
- Evidence and event publication must remain sanitized.

## Execution Plan

- [x] Add read-only spawn execution boundary.
- [x] Gate spawn attempts through host-spawn readiness.
- [x] Run bounded structured invocation without shell passthrough.
- [x] Publish sanitized supervision events and command evidence.
- [x] Reassess next command runner expansion.

## Closeout

The first real bounded read-only local spawn boundary is implemented in
`nucleus-server`.

Implemented surface:

- `run_local_read_only_spawn`
- `LocalReadOnlySpawnInput`
- `LocalReadOnlySpawnResult`
- `LocalReadOnlySpawnOutcome`
- `LocalReadOnlySpawnOutputSummary`
- `LocalReadOnlySpawnRejection`
- `LocalReadOnlySpawnError`

The boundary requires a ready host-spawn gate before execution. It reuses the
existing read-only command runner validation, rejects shell passthrough, runs
structured executable-plus-argv invocations, enforces finite timeout, captures
bounded stdout/stderr counts, and returns sanitized command evidence plus
deterministic supervision events.

Raw stdout and stderr bytes are not exposed by the result and are not persisted
by default. Evidence stores summary counts and status only.

The next lane should make this reachable through the server command runner and
smoke surfaces before expanding command classes.

## Acceptance Criteria

- A read-only command can run through the server path.
- Timeout and bounded output behavior are tested.
- Shell passthrough and PTY remain rejected.
- Raw stdout/stderr payloads are not persisted by default.
- The next lane is explicit.

## Cards

- `docs/roadmaps/g01/batch-cards/221-add-read-only-spawn-execution-boundary.md`
- `docs/roadmaps/g01/batch-cards/222-gate-spawn-through-host-readiness.md`
- `docs/roadmaps/g01/batch-cards/223-run-bounded-structured-invocation.md`
- `docs/roadmaps/g01/batch-cards/224-publish-sanitized-spawn-evidence.md`
- `docs/roadmaps/g01/batch-cards/225-reassess-command-runner-expansion.md`
