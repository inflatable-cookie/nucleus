# 046 — Self-lifting merge holds

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-10-05
Decision owner: operator
Governing refs: [Spec 040](040-merge-hold-release-prompts.md) (hold owners and
release prompts), [Spec 020](020-briefs-stored-in-queue.md) (brief merge hold),
[orchestration contract](../contracts/orchestration.md) (merge hold)

## Problem

Spec 040 gave a merge hold a reason and an owner and prompts the owner when the
hold is the last blocker. A hold placed for a temporary issue still has no way to
name its own end, so the owner must remember to release it once the external
condition clears. Forgetting is exactly the failure Spec 040 exists to catch; a
hold that could lift itself would remove the memory requirement for the common
case where the condition is a task finishing or a known time passing.

## Decision

- `hold` on `queue.task` accepts an optional `until`, either a task ID or an
  offset timestamp (`2026-10-05T18:00:00Z` or `+01:00`). Anything else is
  refused at the contract boundary.
- A task-ID condition is met when that task reaches `done` under the ordinary
  prerequisite rule: a done task whose declared goal is unmet does not satisfy
  it, and neither does worker completion or a merged PR.
- A timestamp condition is met once the current time is at or past it.
- Nucleus reconciles a self-lifting hold on every pass over the held task,
  wherever it is: the condition is not limited to the reviewed last-blocker
  moment. Nucleus re-reads the task after a release so the same pass sees the
  hold cleared.
- When the condition is met Nucleus clears the hold, records the
  `hold_auto_released` event naming the condition and queues exactly one durable
  notice to the owner. The notice is not repeated for the same hold generation.
- A target that can never reach `done` — cancelled, removed before completion,
  missing, or done with an unmet goal — never releases the hold. Nucleus records
  one `hold_until_blocked` event per hold generation and prompts the owner with
  the condition and the reason it cannot clear, asking for `release` or
  `keep_hold`. This holds for a target removed before or after the hold is
  placed.
- A hold cannot name its own task as the condition.
- `keep_hold` renews the hold and leaves its `until` condition in force, so a
  renewed hold still lifts itself when the condition clears. `release` and any
  other release path clear `until` with the hold.
- An operator board hold is released and recorded the same way but never
  prompted; with no agent thread there is nothing to notify.
- `until` is an end condition on an existing hold, not new authority: it can
  only end a hold the caller was already allowed to place or renew, and it never
  merges, dispatches or advances anything by itself.

## Implementation notes

- `holdUntil` is stored on the task (`null` for an ordinary hold). Existing rows
  read `null` with no migration; nothing about a stored hold changes until a new
  `hold` names an end.
- `parseHoldUntil` normalizes a timestamp to UTC. The `hold` action stores the
  parsed `{kind:"task",taskId}` or `{kind:"time",at}`.
- Reconciliation runs in the engine's per-task quantum, beside the retained
  prerequisite wait, through `Resolution.reconcileHoldUntil`.
- The release notice is a `hold_release` notice delivered through the durable
  hold-notice path. It stays true after a later generation re-holds the task, so
  delivery is not superseded by a new hold; a pending prompt for a hold that was
  released before delivery is still superseded.
- Telemetry records `hold_auto_released` and `hold_until_blocked`.

## Out of scope

Self-lifting applies only to holds. It does not add brief or handoff frontmatter,
an operator board control, an `until` on `keep_hold`, or automatic revision,
redispatch or dispatch of a held task.

## Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | `hold` with `until` a live task ID | Hold records the condition; no release |
| 2 | That task reaches `done` | Hold released; `hold_auto_released`; one owner notice |
| 3 | Target done with an unmet goal | Not met; hold stays; owner prompted |
| 4 | `until` an offset timestamp in the future | Hold stays |
| 5 | That timestamp passes | Hold released; `hold_auto_released`; one owner notice |
| 6 | Target cancelled, removed or missing | Hold stays; one `hold_until_blocked` event and an owner prompt per generation |
| 7 | `keep_hold` after a live `until` | New generation; condition still in force |
| 8 | `release` (any path) | Hold and `until` clear |
| 9 | `until` on `release` or `keep_hold`, or unparseable | Refused |
| 10 | `until` the hold's own task | Refused |
| 11 | Operator board hold with `until` | Released; recorded; no prompt |
