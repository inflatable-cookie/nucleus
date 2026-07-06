# Deferred Lanes

Status: active
Owner: Tom
Updated: 2026-07-06

## Purpose

Track valid work that should return later without staying in the active
roadmap queue.

Use this file for lanes that are useful but no longer match the current
product focus. Do not use it as a dumping ground for vague ideas.

## Return Rules

- Reopen a deferred lane only when a current product workflow needs it.
- Recompile a fresh roadmap before resuming implementation.
- Keep old cards as evidence, not as automatic next tasks.
- Do not resume a deferred lane just because it is already specified.

## Deferred Items

### Accepted Memory Active Apply Executor

Status: deferred

Refs:

- `g03/136-accepted-memory-active-apply-executor-boundary.md`
- `g03/batch-cards/596-accepted-memory-active-apply-executor-boundary.md`
- `g03/batch-cards/597-accepted-memory-active-apply-storage-mutation.md`
- `g03/batch-cards/598-accepted-memory-active-apply-receipts-idempotency.md`
- `g03/batch-cards/599-accepted-memory-active-apply-diagnostics-control.md`
- `g03/batch-cards/600-accepted-memory-active-apply-validation-next-lane.md`

Return when:

- a visible project/task/agent workflow needs accepted-memory imports to become
  active server-local memory records
- the accepted-memory UI or steward flow needs reviewed projected memories to
  materialize into active context
- active apply can be kept server-local without projection, SCM/forge,
  embeddings/search, provider sync, automatic extraction, task mutation, agent
  scheduling, callback/interruption/recovery, raw payload retention, or final
  UI expansion

Do not return just to complete the memory subsystem.

### Planning Import Active Apply Executor

Status: deferred

Refs:

- `g03/125-planning-import-active-apply-executor-boundary.md`
- `g03/batch-cards/550-planning-import-active-apply-executor-persistence.md`
- `g03/batch-cards/551-planning-import-active-apply-executor-diagnostics-query-cli-effigy.md`
- `g03/batch-cards/552-planning-import-active-apply-executor-validation-next-lane.md`

Return when:

- project planning import/apply is part of a visible project workflow
- the app needs to apply reviewed planning artifacts into active project state
- the workflow can prove idempotency and repair before mutation

### Provider Live-Read Expansion

Status: deferred

Refs:

- `architecture/architecture-gap-index.md`
- `architecture/implementation-gap-index.md`

Return when:

- a concrete product workflow needs another provider read family
- credential lease, network authority, payload retention, and sanitized
  evidence policy are explicit

Do not return while read-only server/client workflow coherence is still the
larger blocker.

### Convergence Backend Execution

Status: deferred

Refs:

- `g03/034-convergence-exit-and-next-lane-selection.md`
- `../convergence`

Return when:

- Convergence has a stable backend execution surface
- Nucleus needs non-Git SCM execution as part of a concrete user workflow

Do not let Convergence become the active path before the core product loop is
usable.
