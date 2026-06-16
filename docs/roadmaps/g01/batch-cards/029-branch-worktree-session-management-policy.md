# 029 Branch Worktree Session Management Policy

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Define first-pass branch and worktree session management policy.

## Scope

- Promote branch/worktree management into the SCM/forge contract.
- Define primary worktree branch mode.
- Define per-thread worktree mode.
- Capture runtime constraints that affect testing and local execution.
- Add first Rust vocabulary for SCM work sessions.

## Out Of Scope

- Implementing Git commands.
- Implementing worktree creation.
- Implementing merge or pull request flows.
- Implementing UI controls.
- Selecting exact provider libraries.

## Decisions

- Branch/worktree management is a server-owned SCM work-session concept.
- Primary worktree branch mode is supported for simple single-session flows.
- Per-thread worktree mode is supported for parallel agent work.
- Runtime constraints must be modeled because parallel checkouts do not imply
  parallel runnable environments.
- Git is the first practical target, but the model remains SCM-adapter based.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/architecture/system-architecture.md`
- `crates/nucleus-scm-forge`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft runtime effect trait boundary.
