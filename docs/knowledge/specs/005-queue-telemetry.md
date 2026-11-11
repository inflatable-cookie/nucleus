# 005 - Nucleus lifecycle telemetry

Status: implemented
Owner: operator and Chatterbox
Created: 2026-09-13
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/contracts/durable-telemetry.md`

## Problem

Task age hid how much time was prerequisite or slot wait, active execution,
release delay, review, verification, integration, closeout or recovery. Hook-
owned closeout could remove coordinator runs while other recovery churn still
made a workflow slow. Nucleus had the durable facts but no comparable surface.

## Delivered shape

- Persist one generic stage boundary when Nucleus's mutually exclusive lifecycle
  stage changes. Keep existing schema and event storage.
- Reconstruct older records conservatively and label partial evidence.
- Derive hook attempt duration and intervention counts from hook records, role
  runs, notices and events.
- Expose per-task data in `queue.detail` and aggregate data in
  `queue.telemetry` with repository, scope, profile group, closeout
  authority and time filters.
- Render a compact task timing section and a native Telemetry page with p50,
  p95, completion, intervention, stage and recovery breakdowns.

This supports a direct comparison between repositories and windows using
hook-owned closeout and those using coordinator closeout: compare closeout and
hook stage distributions, recovery target/cause counts, completion rate and
intervention rate. Nucleus reports facts only; the operator decides whether a
configuration caused the observed change.

## Snapshot and headline repair (g01.022)

Spec 009 replaced per-filter recomputation with one coalesced bounded
snapshot. `queue.telemetry` derives each task once per durable store revision
and fifteen-second age bucket, filters and groups in memory, yields during cold
construction and keeps the legacy raw intervention rate beside three headline
categories: delivery exceptions, semantic review revisions and operator
administration. The native Telemetry page shows those categories compactly
alongside completion and raw totals, still using select-based filters.

## Acceptance

Focused tests cover exact stage accounting, partial history, creation and
recovery attribution, hook retry/hold counters, operator controls, aggregate
filters and percentiles, strict RPC parsing, the compact summary model, shared
snapshot coalescing and invalidation, category separation, and the 250-task and
50,000-fact responsiveness oracle (cold, warm, concurrency and unrelated-RPC).
Full typecheck, unit, documentation and Northstar validation must pass as one
batch. Dark-theme installed-bundle inspection confirms the new page and detail
summary fit desktop and compact widths.
