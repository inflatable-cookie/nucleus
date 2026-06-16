# 085 Add Runtime Scheduler Acceptance Queue

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Define scheduler acceptance-queue types without executing work.

## Scope

- Add queued runtime request types.
- Represent admission decisions and rejection reasons.
- Link accepted work to task, project, adapter, command authority, and event
  metadata refs.
- Keep all runtime effects inert.

## Out Of Scope

- Spawning processes.
- Running commands.
- Starting provider adapters.
- Worktree checkout or branch mutation.
- Background worker runtime.

## Promotion Targets

- `crates/nucleus-server`
- `crates/nucleus-core`
- `docs/roadmaps/g01/007-server-control-api-and-runtime-sequencing.md`

## Validation

```sh
cargo test --workspace
```

## Decisions

- Scheduler acceptance queue types live in `nucleus-server/src/scheduler.rs`.
- The first queue is in-memory and inert.
- Admission requires a project ref and event metadata refs.
- Command effects require command authority refs.
- Adapter and agent-session effects require adapter refs.
- Queue admission is not execution.

## Closeout

Added `RuntimeSchedulerQueue`, scheduler request ids, request kinds, attached
refs, admission decisions, rejection reasons, and queued item records.

Tests cover accepted command effect admission, missing command authority,
missing adapter refs, and missing event metadata refs. No command execution,
process spawning, provider startup, worktree mutation, background worker,
retry loop, or scheduler runtime was added.
