# 2026-06-21 G02 Closeout And G03 Rollover

Status: active
Owner: Tom

## Decision

Close g02 and open g03.

## Evidence

- G02 proved the server-owned path from task-backed runtime evidence through
  explicit review, explicit task completion, SCM capture, operator review,
  review decision persistence, adapter-neutral change-request preparation, and
  adapter-specific change-request planning.
- Git-like change-request plans now preserve branch, commit, push, and
  pull-request terms without executing effects.
- Convergence-like plans remain separate and preserve snapshot/publish terms.
- Unsupported adapters stay visible.
- Diagnostics summarize adapter-plan state without granting SCM, forge,
  provider, callback, interruption, recovery, or raw-output authority.

## Rollover

G03 starts with effect-gated Git change-request execution.

The first lane is not direct Git mutation. It starts with authority records,
command descriptors, stopped-by-default command requests, preflight records,
and read-only diagnostics.

## Open Risk

`effigy doctor` still fails on god-file pressure: 152 findings, 124 warnings,
28 errors. This is known health debt and should be reduced when touched, but
it does not invalidate the g03 Git authority lane.
