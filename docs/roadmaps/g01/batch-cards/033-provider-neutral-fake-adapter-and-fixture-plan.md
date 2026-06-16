# 033 Provider Neutral Fake Adapter And Fixture Plan

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft provider-neutral fake adapter and fixture plan.

## Scope

- Define fake SCM and forge adapters for contract tests.
- Define fixtures for Git-like and Convergence-like workflow semantics.
- Define projection sync fixtures without live credentials.
- Define command policy fixtures without process spawning.
- Identify which Rust crates should own fixture-only types or builders.

## Decisions

- Fake adapters are required before real SCM/forge implementation.
- Git-like and Convergence-like workflow fixtures are both required.
- Command policy fixtures must describe requests, decisions, and sanitized
  evidence without spawning processes.
- Fixture builders must stay dev-only or test-support only.
- Production crates may expose shared vocabulary, but not stable fake adapter
  builders yet.

## First Fixture Profiles

SCM/forge fixture profiles:

- Git-like commit/branch/pull-request workflow
- Convergence-like snap/publication/gate workflow
- generic forge polling and webhook workflow
- credential failure and repair workflow
- conflict and review workflow

Command fixture profiles:

- read-only inspection allowed
- management-state write approval required once
- source-code write approval required every time
- network command explicitly scoped
- destructive command blocked or approval required every time
- command succeeded with summary-only evidence
- command failed with artifact refs
- command blocked by policy
- command timed out

## Out Of Scope

- Implementing fake adapters.
- Running live Git, forge, or Convergence commands.
- Implementing server storage.
- Implementing command execution.
- Building UI.

## Evidence Questions

- Which fake adapter events are needed first?
- Which workflow semantics fixtures prove the model is not Git-shaped?
- Which conflict and review workflow fixtures are required before implementation?
- How should command evidence fixtures stay sanitized?
- Where should fixture builders live without becoming production APIs?

## Stop Conditions

- Fake adapters depend on live provider credentials.
- Git-only fixtures define the provider-neutral behavior.
- Command fixtures spawn processes.
- Fixture builders leak into stable production API prematurely.

## Promotion Targets

- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/contracts/007-server-boundary-contract.md`
- `crates/nucleus-scm-forge`
- `crates/nucleus-command-policy`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```
