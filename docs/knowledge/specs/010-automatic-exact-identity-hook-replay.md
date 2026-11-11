# 010 — Automatic exact-identity hook replay

Status: implemented
Owner: Nucleus hook and lifecycle maintainers
Created: 2026-09-15
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/contracts/repository-hooks.md`,
`docs/knowledge/specs/002-durable-hook-retry-and-isolated-writes.md`

## Problem

Required integration-base hooks can become operationally stale when a clean
canonical branch advances between occurrence pinning and execution. Nucleus can
already roll some repaired occurrences under operator retry, but normal
reconciliation still creates Coordinators for a race whose identities and lack
of effect can be proved mechanically.

## Replay eligibility

Before creating a recovery Coordinator, Nucleus may mint a fresh occurrence on
the current clean synchronized integration base only when all of these facts are
exact:

- the task, repository, base branch, disposition and event remain applicable;
- instruction path, digest and submitted identity are unchanged;
- hook ID, target, mode, delivery, allowed paths, commit subject, program pin
  and normalized manifest semantics are unchanged;
- the prior occurrence has no commit, push or remote publication and no
  ambiguous process or delivery effect;
- the old isolated checkout can be proven unchanged or safely discarded;
- canonical local and remote integration heads are clean and equal.

This applies to required integration-base occurrences such as `task.blocked`,
`task.cancelled` and `task.closeout`. Reviewed-head `task.pre_merge`, pre-dispatch
validation and any changed or no-longer-applicable event are excluded.

A well-formed semantic `blocked` or `failed` result is never replayed as an
operational race. Dirty state, changed instruction or manifest, changed task
disposition, process uncertainty and remote ambiguity retain existing recovery.

## Durable execution

Persist a replay intent and lineage from the old occurrence before creating the
new occurrence. Integration writes remain serialized per repository. Restart
reconciles the same intent and occurrence without duplicate execution. Keep all
old attempts and evidence.

Allow at most two automatic base-advance replays for one logical event. Further
movement or any failed proof enters normal bounded recovery. A successful replay
means only that the hook result may be evaluated normally; base movement never
implies hook success.

## Telemetry

Count `automaticHookReplays` separately from Coordinator recovery, operator hook
retry and semantic hook refusal. Preserve attempt duration and lineage for task
detail and aggregate telemetry.

## Acceptance oracle

- A clean synchronized base advance with exact identities creates one fresh
  occurrence and no Coordinator.
- Concurrent tasks in one repository remain serialized; restart creates no
  duplicate occurrence or integration commit.
- Semantic refusal, dirty checkout, changed program/manifest/instruction,
  changed disposition and uncertain effect never replay automatically.
- Two exact replays are allowed; a third uses normal attention/recovery.
- Stored prior occurrences stay immutable and visible, and telemetry attributes
  the replay separately.

## Exclusions

No semantic retry, ignored mutation relaxation, repository-specific path rule,
manual database rewrite or recovery-budget expansion belongs to this work.

## Implementation

Implemented by g01.023. `server/hooks.ts` holds the closed exact-identity and
absence-of-effect predicate, the durable replay intent and lineage, the
per-repository section and the two-advance budget. The held transition is
re-driven through its normal emission path before any recovery Coordinator is
engaged, so an automatic replay only ever evaluates the fresh occurrence.
Telemetry derives `automaticHookReplays` from the durable lineage; task hook
history shows the old-to-new lineage and the count.
