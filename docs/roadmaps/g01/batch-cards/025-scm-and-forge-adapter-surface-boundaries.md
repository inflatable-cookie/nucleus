# 025 SCM And Forge Adapter Surface Boundaries

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft SCM and forge adapter surface boundaries.

## Scope

- Define the first Rust crate or module boundary for SCM and forge adapters.
- Separate Git repository operations from forge collaboration operations.
- Define descriptive types for repositories, branches, commits, pull requests,
  issues, comments, sync observations, and webhook or polling refresh.
- Keep network, Git command execution, API clients, and auth implementation out
  of scope.
- Promote durable rules into the SCM/forge sync contract and architecture.

## Out Of Scope

- Implementing Git operations.
- Implementing GitHub, GitLab, or other forge clients.
- Implementing webhooks.
- Implementing credential handling.
- Implementing sync workers.

## Evidence Questions

- Should SCM and forge adapters live in one crate or separate crates?
- Which identifiers must be stable nucleus ids versus provider refs?
- How should branch, commit, PR, issue, and comment references attach to tasks?
- How should polling and webhook events become server-owned observations?
- Which forge surfaces are optional capabilities?

## Stop Conditions

- Forge issue ids replace Nucleus task ids.
- Git commands are implemented before adapter contracts settle.
- Provider auth material is modeled as ordinary projection state.
- Webhook payloads are treated as durable state without normalization.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/system-architecture.md`
- future SCM/forge Rust crate or module plan

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft SCM/forge conflict and review workflow policy.
