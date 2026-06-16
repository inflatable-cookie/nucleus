# 018 Git-Backed Project Management State

Status: superseded
Owner: Tom
Updated: 2026-06-16

## Goal

Draft Git-backed project management state semantics.

## Scope

- Promote the hybrid local DB plus repo-backed projection model.
- Define project steward agent authority for management-state sync.
- Define what project/task state is committable versus server-local.
- Define the first SCM/forge adapter boundary.
- Keep implementation, file format, and sync engine out of scope.

## Out Of Scope

- Git implementation.
- Forge API implementation.
- Steward agent runtime implementation.
- Final task file format.
- Conflict resolution UI.

## Evidence Questions

- Which state belongs in repo-backed project management files?
- Which state must remain server-local?
- What sync policies should be available per project?
- What may the project steward agent do without approval?
- Should the projection root be visible or hidden?
- How should forge issues and PRs link to Nucleus task identity?

## Stop Conditions

- Git becomes the only live runtime state store.
- Raw provider/session/runtime state is projected into repo files by default.
- The steward agent can silently rewrite meaningful history.
- Forge issue identity replaces Nucleus task identity.

## Promotion Targets

- `docs/specs/002-git-backed-project-management-state.md`
- `docs/architecture/system-architecture.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```

## Superseded By

- `docs/specs/002-git-backed-project-management-state.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/roadmaps/g01/002-management-state-and-scm-forge.md`

The broad Git-backed management-state card was split into the projection,
SCM/forge, credential, webhook, branch/worktree, conflict, and implementation
readiness cards tracked by roadmap 002. Git remains one SCM adapter path, not
the only SCM model.
