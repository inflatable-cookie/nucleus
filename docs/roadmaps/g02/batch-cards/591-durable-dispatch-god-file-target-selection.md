# 591 Durable Dispatch God-File Target Selection

Status: completed
Owner: Tom
Updated: 2026-06-20
Milestone: `../124-health-and-runway-rebaseline.md`

## Purpose

Choose the next small set of durable dispatch/provider files to split after
the request-handler and DTO test pressure is reduced.

## Scope

- Inspect the highest remaining doctor errors.
- Select only files where a mechanical split improves ownership.
- Defer files where splitting would create churn without clearer boundaries.

## Acceptance Criteria

- [x] The next split targets are named with reasons.
- [x] Deferred god-file findings are recorded with reasons.
- [x] Adapter-specific SCM plan work remains paused until the selected health
  work is done or explicitly accepted.

## Selection

Selected next:

- `provider_durable_executor_dispatch_outcome_linkage.rs`: top doctor error;
  embedded tests can be split mechanically.
- `provider_durable_dispatch_outcome_persistence.rs`: second doctor error;
  embedded tests can be split mechanically.
- `provider_git_dry_run_execution_persistence.rs`: third doctor error; embedded
  tests can be split mechanically.

Deferred:

- Codex supervision and durable smoke files remain behind this pass. Splitting
  them may require more ownership review than a test-module extraction.

## Validation

- `effigy doctor`
- `git diff --check`
