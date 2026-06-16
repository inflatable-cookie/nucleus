# 030 SCM Forge Conflict And Review Workflow Policy

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft SCM/forge conflict and review workflow policy.

## Scope

- Define first-pass review workflow states for management-state changes.
- Define conflict workflow for simultaneous task and project edits.
- Separate Git merge conflicts from semantic Nucleus conflicts.
- Define how branch/worktree sessions connect to review requests.
- Promote durable rules into SCM/forge, task, and storage contracts.

## Out Of Scope

- Implementing merge algorithms.
- Implementing forge API clients.
- Implementing PR creation.
- Implementing conflict UI.
- Selecting exact SCM libraries.

## Evidence Questions

- Which conflict classes can the steward resolve mechanically?
- Which conflicts require human approval?
- How should review requests map back to task links and work sessions?
- When should Nucleus merge directly versus open a review request?
- How should rejected or abandoned review work be retained?

## Stop Conditions

- Git file conflicts and semantic task conflicts are treated as one thing.
- The steward can silently resolve meaningful task conflicts.
- Pull request ids replace Nucleus task or work-session ids.
- Abandoned review work can be deleted without an audit trail.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `crates/nucleus-scm-forge`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft SCM/forge conflict and review workflow policy.
