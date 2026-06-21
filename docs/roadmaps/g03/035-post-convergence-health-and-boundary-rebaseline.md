# 035 Post-Convergence Health And Boundary Rebaseline

Status: completed
Owner: Tom
Updated: 2026-06-21

## Purpose

Refresh code-health and server-boundary evidence after the Convergence tranche,
then choose the next implementation lane without adding provider, SCM, or UI
behavior by accident.

## Governing Refs

- `docs/architecture/implementation-gap-index.md`
- `docs/architecture/implementation-audit.md`
- `docs/architecture/engine-orchestration-boundary.md`
- `docs/contracts/022-engine-orchestration-boundary-contract.md`
- `docs/roadmaps/g03/034-convergence-exit-and-next-lane-selection.md`

## Goals

- [x] Refresh post-Convergence doctor and module-pressure evidence.
- [x] Audit server provider/front-door pressure caused by recent effect gates.
- [x] Select one bounded non-Convergence implementation lane.
- [x] Avoid provider execution, SCM mutation, remote transport, and proof UI
  expansion.

## Execution Plan

- [x] Health evidence refresh batch.
- [x] Server provider boundary pressure audit batch.
- [x] Next engine-boundary migration selection batch.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/118-post-convergence-health-evidence-refresh.md`
- `batch-cards/119-server-provider-boundary-pressure-audit.md`
- `batch-cards/120-next-engine-boundary-migration-selection.md`

## Boundary Audit

Current pressure:

- `nucleus-server/src/lib.rs` remains error-sized as the broad crate root.
- `nucleus-server/src/codex_supervision.rs` remains error-sized as a broad
  Codex supervision front door.
- `nucleus-server/src/control_envelope_dto.rs` is error-sized and mixes request
  envelope, query DTO, query mapping, and protocol validation code.
- `provider_records.rs` is not the immediate problem; it is still small and
  proves that grouped provider record front doors are viable.

Selected next implementation lane:

- `036-control-envelope-request-boundary-split.md`

Reason:

- it reduces a current doctor error
- it is server-boundary work, not a new product feature
- it can be done as a behavior-preserving module split with existing tests
- it avoids more Convergence/provider effect work

## Acceptance Criteria

- [x] Current doctor/module pressure is reflected in architecture docs.
- [x] Server provider/front-door pressure has a concrete next action or an
  explicit defer decision.
- [x] The next selected lane is not Convergence-specific.
- [x] No provider write, process spawn, SCM mutation, remote transport, UI
  panel, or task mutation behavior is added.
