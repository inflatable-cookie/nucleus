# 084 Provider Readiness Overview Drilldown Read Model

Status: completed
Owner: Tom
Updated: 2026-06-22

## Purpose

Expose a read-only drilldown path from the Provider Readiness Overview to the
underlying provider read-intent projection so the desktop proof can show why a
provider is ready, blocked, or missing evidence without adding provider refresh
or credential behavior.

This lane keeps the current proof useful while staying inside the stopped
provider boundary.

## Governing Refs

- `docs/contracts/027-provider-auth-forge-execution-contract.md`
- `docs/roadmaps/g03/069-provider-read-intent-projection-control.md`
- `docs/roadmaps/g03/083-provider-readiness-overview-seeded-evidence-proof.md`

## Goals

- [x] Reuse the existing provider read-intent DTO as the drilldown source.
- [x] Keep desktop drilldown read-only and sanitized.
- [x] Let the visible proof surface show represented read families and source
  counts together.
- [x] Avoid provider refresh, credential resolution, provider effects, task
  mutation, raw provider payload retention, or durable UI design commitments.

## Execution Plan

- [x] Audit the desktop provider readiness panel and control client for the
  smallest drilldown route.
- [x] Add read-only provider read-intent drilldown consumption to the desktop
  proof shell.
- [x] Prove the seeded desktop state returns both overview and drilldown data.
- [x] Validate and close out the lane.

## Batch Cards

Ready cards:

None.

Planned cards:

None.

Completed cards:

- `batch-cards/315-provider-readiness-drilldown-surface-audit.md`
- `batch-cards/316-provider-readiness-drilldown-request-path.md`
- `batch-cards/317-provider-readiness-drilldown-rendering-proof.md`
- `batch-cards/318-provider-readiness-drilldown-validation-closeout.md`

## Acceptance Criteria

- [x] Desktop proof shell can request overview and read-intent projection data.
- [x] Drilldown rendering shows read families, statuses, evidence counts, and
  source counts without raw provider payloads.
- [x] Tests assert no provider control, credential repair, refresh, or mutation
  affordances are exposed.
- [x] Focused desktop and provider readiness validation passes.

## Closeout

The desktop proof shell now loads Provider Readiness Overview and provider
read-intent projection data together. It renders represented families,
statuses, evidence counts, and source counts from local stopped evidence while
continuing to expose no provider controls or effect paths.

## Stop Conditions

- Stop before live provider refresh.
- Stop before credential resolution.
- Stop before provider effects.
- Stop before raw provider payload retention.
- Stop before durable UI layout or design commitments.
