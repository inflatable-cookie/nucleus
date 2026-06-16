# 031 SCM Forge Adapter Implementation Readiness Plan

Status: ready
Owner: Tom
Updated: 2026-06-16

## Goal

Draft SCM/forge adapter implementation readiness plan.

## Scope

- Define the minimum contract gates before SCM/forge implementation begins.
- Sequence first adapter work without assuming Git is the permanent model.
- Identify test fixtures needed for projection sync, work sessions, conflicts,
  reviews, credentials, and webhooks.
- Decide which adapter behaviors stay type-only until server storage and
  command execution boundaries are ready.

## Out Of Scope

- Implementing SCM commands.
- Implementing forge API clients.
- Implementing webhook endpoints.
- Selecting a production credential store.
- Building UI.

## Evidence Questions

- Which Git operations are safe first implementation targets?
- Which provider-neutral tests should exist before Git-specific behavior?
- What fake adapters are needed for server and task workflows?
- Which work-session flows need filesystem fixtures?
- Which credential and webhook behaviors need only sanitized evidence fixtures?

## Stop Conditions

- Implementation starts before command execution authority is defined.
- Git-specific behavior leaks into provider-neutral contracts.
- Tests require live GitHub, GitLab, or forge credentials.
- Credential or webhook tests record raw secrets.

## Promotion Targets

- `docs/roadmaps/g01/001-foundation-and-research.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `crates/nucleus-scm-forge`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Next Task

Draft SCM/forge adapter implementation readiness plan.
