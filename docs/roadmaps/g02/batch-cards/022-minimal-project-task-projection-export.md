# 022 Minimal Project Task Projection Export

Status: completed
Owner: Tom
Updated: 2026-06-17

## Milestone

`../007-management-projection-sync-foundation.md`

## Purpose

Implement the first export path for project and task management projection
records without involving SCM mutation.

## Governing Refs

- `docs/specs/002-git-backed-project-management-state.md`
- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`

## Scope

- Add a projection export service or helper that reads authoritative project
  and task records from server/engine state.
- Produce an in-memory export plan with target projection file refs and typed
  payload classes.
- Include only safe shared project/task fields already allowed by the project
  and task contracts.
- Exclude runtime streams, raw provider transcripts, secrets, terminal/browser
  attachment state, local client layout state, and local caches.
- Do not write files to disk yet unless the export target is a test fixture or
  explicit artifact boundary.

## Acceptance Criteria

- Export planning can produce `nucleus/project.toml` and
  `nucleus/tasks/<task-id>.toml` entries from stored records.
- Export output remains management-state only.
- Tests prove excluded local/runtime fields do not appear in export payloads.
- The service returns a plan that later SCM adapters can consume without
  assuming Git.

## Validation

- focused `nucleus-engine` or `nucleus-server` export tests
- `cargo check --workspace`

## Stop Conditions

- Stop if export requires changing task/project domain meaning.
- Stop if the implementation writes to arbitrary repo paths without a policy
  boundary.
- Stop if SCM commit/push behavior becomes part of the export card.

## Outcome

Added in-memory project/task export plans and a server helper that reads stored
project/task records to build the plan. No files are written and no SCM action
runs.
