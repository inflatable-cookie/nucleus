# 109 Task Timeline Authority Map Control Parity

Status: completed
Owner: Tom
Updated: 2026-06-23

## Purpose

Add read-only control-envelope and CLI parity for task timeline and project
authority-map inspection.

This is the first implementation batch from the server/client hardening lane.
It should strengthen server-owned read models without moving authority into
the desktop client.

## Governing Refs

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/017-engine-host-authority-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/architecture/server-client-query-surface-inventory.md`
- `docs/architecture/server-client-gap-matrix.md`

## Goals

- [x] Add serialized read-only query DTO support for task timeline.
- [x] Add serialized read-only query DTO support for project authority-map
  publication.
- [x] Add `nucleusd`/Effigy inspection where the query shape is bounded.
- [x] Keep desktop proof UI optional and disposable.
- [x] Keep all mutation/effect boundaries closed.

## Execution Plan

- [x] Inspect existing server query/result types for task timeline and
  authority-map publication.
- [x] Add control-envelope DTOs and rejection tests for unsupported actions.
- [x] Add CLI query domains and typed output lines for sanitized read models.
- [x] Add Effigy selectors for the new CLI query domains.
- [x] Review Tauri IPC fixture need; no new fixture was required because the
  existing serialized envelope path covers these response body variants.
- [x] Validate focused server/CLI/docs surfaces.

## Batch Cards

Completed cards:

- `batch-cards/437-task-timeline-control-envelope-audit.md`
- `batch-cards/438-task-timeline-control-envelope-dto.md`
- `batch-cards/439-project-authority-map-control-envelope-dto.md`
- `batch-cards/440-task-timeline-authority-map-cli-effigy.md`
- `batch-cards/441-task-timeline-authority-map-validation.md`
- `batch-cards/442-task-timeline-authority-map-desktop-proof-decision.md`

## Acceptance Criteria

- [x] New surfaces are read-only and sanitized.
- [x] Unsupported/mutating actions fail closed.
- [x] CLI/Effigy support does not require provider execution.
- [x] Project authority-map DTOs do not imply authority grants.
- [x] Focused tests pass.

## Audit Result

Existing bounded surfaces:

- `TaskTimelineQuery { task_id }`
- `ProjectAuthorityMapQuery { project_id, expected_domains }`
- `ServerQueryResult::TaskTimeline`
- `ServerQueryResult::ProjectAuthorityMap`
- task timeline response DTO records
- project authority-map response DTO records

Missing surfaces closed in this batch:

- first control-envelope request DTO support
- unsupported-action rejection tests
- `nucleusd query task-timeline --task <task-id>`
- `nucleusd query project-authority-map --project <project-id>`
- root Effigy selectors for both queries

Current runtime posture:

- task timeline query is read-only and may return zero entries for seeded
  tasks with no orchestration events
- project authority-map query returns a deferred publication until persistence
  exists
- neither query grants client mutation, provider execution, provider writes, or
  authority-map mutation

## Desktop Proof Decision

No desktop proof panel is needed in this lane.

CLI, Effigy, and serialized control-envelope parity already prove the
server/client boundary for these read-only surfaces. The desktop shell remains
disposable, final UI direction is not settled, and another proof panel would
add churn without improving task/project workflow authority.

Next lane:

- task/project workflow depth, beginning with a contract-to-implementation
  audit before adding more behavior.

## Stop Conditions

- Task timeline query cannot be bounded without a task id source decision.
- Authority-map publication lacks enough server state to produce a meaningful
  read-only DTO.
- Implementation starts requiring final desktop UI design or remote transport.
