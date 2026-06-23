# 443 Task Project Workflow Implementation Audit

Status: completed
Owner: Tom
Updated: 2026-06-23
Milestone: `../110-task-project-workflow-depth.md`

## Purpose

Audit current task, project, planning, timeline, and control code against the
promoted contracts before choosing new behavior.

## Governing Refs

- `docs/contracts/003-project-identity-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/014-structured-project-planning-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/contracts/023-task-backed-agent-workflow-contract.md`

## Work

- [x] Inspect `crates/nucleus-projects`.
- [x] Inspect `crates/nucleus-tasks`.
- [x] Inspect task/work-item/timeline surfaces in `crates/nucleus-engine` and
  `crates/nucleus-server`.
- [x] Inspect existing CLI/Effigy task/project query surfaces.
- [x] Record implemented, missing, blocked, and deferred surfaces in the next
  gap matrix card.

## Acceptance Criteria

- [x] Audit lists concrete files/modules, not broad impressions.
- [x] Audit does not introduce new code behavior.
- [x] Missing behavior is classified by governing contract or planning gap.
- [x] Next implementation candidate is evidence-based.

## Result

Audit evidence is recorded in
`docs/architecture/task-project-workflow-gap-matrix.md`.

Main finding:

- task/project workflow has enough task records, task commands, work items,
  runtime progress, review transitions, management projections, task timeline,
  and control-query surface to support a deterministic read-only readiness
  projection.
- scoring, autonomous next-task choice, goal records, planning sessions, and
  planning artifact promotion remain unimplemented and should not be inferred.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`

## Stop Conditions

- Contract surfaces conflict with implementation enough to require contract
  repair before a roadmap can continue.
- The audit reveals stale docs that would make implementation speculative.
