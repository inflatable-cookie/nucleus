# 031 SCM Forge Adapter Implementation Readiness Plan

Status: done
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
- Capture Convergence-style non-Git workflow semantics before Git adapter work
  starts.

## Readiness Gates

SCM/forge implementation may start only after these gates are satisfied:

- provider-neutral fake adapter can emit repository, worktree, change,
  workflow, conflict, review, credential, and webhook observations
- projection sync tests can run without live SCM or forge credentials
- Git-specific tests do not define the provider-neutral contract
- command execution authority is explicit before any local SCM command runner
  is added
- credential tests use references and sanitized evidence only
- webhook tests use sanitized verification evidence and local fixtures only
- non-Git workflow fixtures exist for at least one system where local capture
  is not the same as shared authority

## First Fixture Set

Initial fixtures:

- fake provider-neutral SCM adapter
- fake forge adapter
- Git-like fixture: commit and branch are the local and shared primitives
- Convergence-like fixture: snap is local capture, publication/gate is the
  review or shared-authority boundary
- projection record fixture set for task/project sync
- conflict fixture set for SCM file conflict versus semantic task conflict
- review fixture set for direct authority update versus review-request flow
- credential fixture set with missing, expired, denied, and available refs
- webhook fixture set with verified, rejected, replay suspected, and skipped
  by local-development policy evidence

## Implementation Sequence

First implementation sequence:

- build fake adapters and contract tests
- build projection import/export fixtures
- build provider-neutral work-session and review workflow tests
- add Git read-only inspection using a selected library or command-runner
  boundary only after command authority is written down
- add Git management-state write flows only after dirty-state, path scope, and
  approval gates are testable
- add forge polling before webhook ingestion
- add webhook ingestion only after verification and replay cache policy exist

Convergence-style behavior is an implementation-readiness check, not an
immediate implementation target. It proves the abstraction is not Git-shaped.

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
- How should an adapter expose non-authoritative snapshots versus
  authoritative publication, gate, or release workflow points?

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
