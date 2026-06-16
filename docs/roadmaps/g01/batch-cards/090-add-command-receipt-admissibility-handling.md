# 090 Add Command Receipt Admissibility Handling

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Handle command requests as receipts and admissibility checks without executing
runtime effects.

## Scope

- Return command receipts for recognized command categories.
- Reject unsupported or unsafe command paths explicitly.
- Reference scheduler admission where appropriate.
- Keep command mutation behavior narrow and documented.

## Out Of Scope

- Command runner.
- Provider process lifecycle.
- Worktree mutation.
- SCM mutation.
- Background workers.

## Promotion Targets

- `crates/nucleus-server`
- `docs/roadmaps/g01/008-local-request-handling-and-transport-readiness.md`

## Validation

```sh
cargo test --workspace
```

## Decisions

- State-shaped project, task, workspace, model route, and adapter registration
  commands return accepted state-mutation receipts.
- Accepted receipts do not mutate state yet.
- Agent session runtime commands remain rejected or deferred.
- Agent session start commands reference scheduler admission and fail until
  required runtime refs exist.
- No command runner, process lifecycle, worktree mutation, SCM mutation, or
  background worker behavior is introduced.

## Closeout

The local request handler now returns deterministic command receipts and
explicit runtime rejection paths.

Tests cover accepted state-command receipts without mutation execution and
runtime-session rejection through scheduler admission. No runtime effect
execution, provider startup, command runner, worktree mutation, SCM mutation,
or background worker behavior was added.
