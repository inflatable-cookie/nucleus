# 040 — Merge hold owners and release prompts

Status: implemented (task paseo-northstar-queue#151)
Owner: Nucleus runtime maintainers
Created: 2026-10-02
Decision owner: Tom
Governing refs: [Spec 020](020-briefs-stored-in-queue.md) (brief merge hold),
[Spec 032](032-operator-decisions.md) (decisions in the Tasks pipeline),
[orchestration contract](../contracts/orchestration.md) (merge hold)

## Problem

Agents place merge holds for temporary issues and are never prompted to
release them. A held task passes review, reaches the merge gate and waits on
"Merge held by operator; release to continue" with nobody told. On 2026-10-02
nine reviewed tasks sat behind forgotten holds and the board stalled (Tom).

A second fault compounds it: holds placed before #140 were stored without
`mergeHold`, so the board shows a merge hold while Nucleus treats the task as
dispatch-blocked and its revision or recovery never gets a slot.

## Rules

Merge holds are exceptions, not a submission default (Tom, 2026-10-07).
Ordinary authorized work proceeds from independent exact-head review through
normal merge gates without another planner approval. Use a merge hold only
for a specific external decision, explicitly retained publication authority,
or other condition those gates cannot establish. Its reason names that
condition and the evidence or decision that permits release. Reading the
reviewer report, inspecting its evidence, or waiting for required checks is
part of normal review and is not a separate hold reason. Planners omit
`queue.mergeHold` from routine briefs and release existing redundant holds
after checking fresh task state; source, rights, independent review and
publication obligations remain unchanged.

1. **A hold has a reason and an owner.** `hold` on `queue.task` requires a
   non-empty `reason`. The owner is the calling agent; a board hold's owner is
   the operator. A brief or handoff with `queue.mergeHold: true` also requires
   `queue.mergeHoldReason`; its owner is the submitting agent. Task detail and
   board show owner, reason and age. Existing holds without a reason get the
   origin agent as owner and the reason "not recorded". A hold is the task's
   shown state only while it is what the task waits on: a merge hold once the
   task is verifying or merging, a dispatch hold before it starts. Otherwise the
   phase shows — the board's status reads `Working · merge held` with the
   phase's own icon, and the Paseo workspace title reads `Working*: …` — so a
   held task's progress stays visible (Tom, 2026-10-26).
2. **Nucleus prompts the owner when the hold is the last blocker.** That moment
   is when a held task would otherwise claim the integration turn: accepted
   exact-head review applied, pre-merge gates passed, no attention. Nucleus
   records `holdBlockingSince` and sends one durable notice to the owner with
   the reviewed head, reason and hold age, asking for `release` or
   `keep_hold`. Notices dedupe per task, hold generation and reviewed head.
3. **Keep needs a fresh reason.** `keep_hold` on `queue.task` takes a required
   `reason`, starts a new hold generation and restarts the clock.
4. **Reminders, then the operator.** While the hold stays the last blocker,
   Nucleus re-notifies the owner every `holdReminderMinutes` (Nucleus setting,
   default 120). After `holdEscalationMinutes` (default 240) without a release
   or keep, the task appears in the Tasks pipeline's Decisions column as a Nucleus-raised
   item, "Ready to merge, held for <reason> since <time>", with Release and
   Keep actions. These carry operator authority; other Nucleus-raised items stay
   read-only. An operator board hold is never escalated to the operator, only
   shown.
5. **Dispatch and merge holds are independent fences.** A task may carry both
   at once, each with its own owner, reason, generation and optional `until`
   ([Spec 046](046-self-lifting-merge-holds.md)). Dispatch is blocked only by a
   dispatch hold; merge only by a merge hold. `hold` / `release` / `keep_hold`
   take `kind: dispatch|merge` (default: dispatch while queued, merge after
   dispatch). `keep_hold` refreshes the reason of either kind. Refusals name
   the kind and the right control. A brief-declared `queue.mergeHold` is a
   merge hold before and after dispatch and survives releasing a dispatch hold.
   The merge *request* is the one boundary both fences stand at (Queue #531): a
   stopped task places a dispatch hold, and a held task records no merge intent,
   so release the fence that is named rather than expecting one kind to speak
   for the other. `lead.promote-task` and `papercut.promote-task` accept optional
   `hold: {reason, until?}` and create the task with a dispatch hold in the
   same transaction. Schema 40 migrates a single legacy hold: queued + held +
   not `mergeHold` → dispatch; every other held row → merge. Existing
   single-hold behaviour is unchanged. A hold on a dispatched task with no
   kind is still a merge hold. An explicit dispatch hold on an unmerged,
   already-dispatched task fences fresh retained worker, reviewer, declared-stage
   and recovery runs. It does not interrupt a run already in flight: Nucleus still
   observes and applies that run's authenticated result, then waits for release
   before launching the next run. A merge-only hold continues to allow review.

## Implementation notes

- Prompts, reminders and escalation run from the integration-turn claim, which is where a
  held task would otherwise proceed: review accepted at the current head, no attention,
  phase `verifying` or `merging`. Verification and the merge gate run after release.
- A hold prompt is a durable notice of kind `hold`, id `task:hold:generation:head:n`, delivered
  to the owner's thread like other notices and superseded when the hold is released.
- `keep_hold` by the operator keeps the owner; by an agent it transfers ownership to that agent.
- A hold the task's owner places (by `hold` or `keep_hold`, a brief's `queue.mergeHold`, or
  `amend_brief`) stores the owner marker `task-owner` instead of the thread id, so it answers
  to whoever owns the task now; its prompts carry the same marker and are re-pointed at
  delivery. Operator and third-party holds keep their recorded owner.
- The escalated item is a Nucleus-raised card in the Tasks pipeline's Decisions
  column; it is the only Nucleus-raised
  item with actions, and it carries operator authority.
- Settings are `holdReminderMinutes` and `holdEscalationMinutes`, set in Settings → Dispatch limits and read back with `queue.capacity-state`; like every host-wide limit, only that surface writes them (see the service boundary contract, "Settings-only capacity writes").
- Schema 36 migrates held tasks past `queued` to merge holds and gives holds without a reason
  the origin agent as owner and the reason "not recorded".
- Schema 40 stores independent `holds.dispatch` / `holds.merge` fences and keeps the Spec 040
  legacy fields in sync (merge is the projected primary when both exist).

Times are first guesses (Tom, 2026-10-02) and are settings, not constants.

## One task owner

A task has one owner (Tom, 2026-10-26: "There should be one owner field so
reparenting is a single change"): `notificationAgentId`, recorded at submission as
the creator and the only field a reparent writes. Every reader of "who owns this
task now" resolves through it (`taskOwner`): attention, prerequisite and completion
origin notices, the stop view, the wait state, routing sign-off answers, and every
owner-placed hold (above). The creator (`originAgentId`) is history only. In the
completion membership a done transition freezes, a creator that nominated itself
and the owner's own subscription choice are the owner entry, delivered to the
current owner, never a literal copy of a thread that has since handed the task on.

`queue.reparent` changes the owner of open tasks, one write per task: the listed
tasks, or every open task of a project that one thread owns. The caller is the
operator at the board, the registered planner for the task's project (falling
back to the Nucleus planner), or the task's current owner handing it on (Tom,
2026-11-02). The only proof is that the new owner is a live,
unarchived planning thread, not a task worker, reviewer or coordinator; the old
owner may be archived or gone, and there is no preflight, plan file or version pin.
The write sets the owner and the owner's workspace, clears origin errors, moves the
outgoing owner's own completion subscription choice to the incoming owner and
records one `owner_changed` event. Reparenting to the current owner writes nothing.
Settled notices, frozen completion cohorts, history and third-party holds are never
rewritten. An archived or missing recipient Nucleus already records (a creator
nomination or its own subscription) can still be unsubscribed on that recorded
workspace binding; subscribing needs a live identity. The board's task detail has Change owner (this task, or every open task
of the project that thread owns); agents use `bin/nucleus-reparent.mjs` (named `bin/northstar-reparent.mjs` before the 2026-11 rename).

Schema 49 records every existing task's owner, marks holds placed by the owner or
creator as owner-placed and re-points their pending prompts.

## Out of scope

Self-lifting holds ("until task X is done", "until a time") are
[Spec 046](046-self-lifting-merge-holds.md). Telemetry records
`hold_ready_notified`, `hold_reminded`, `hold_kept` and `hold_escalated`.

## Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | `hold` without `reason` | Refused |
| 2 | Brief with `mergeHold: true`, no `mergeHoldReason` | Refused at check and submit |
| 3 | Held task passes review and gates | One notice to the owner; `holdBlockingSince` set |
| 4 | Same head, hold unchanged, before reminder time | No second notice |
| 5 | Reminder time passes | One reminder |
| 6 | `keep_hold` with reason | New generation; clock restarts; next prompt after reminder time |
| 7 | Escalation time passes | Tasks pipeline shows the item; Release merges, Keep needs a reason |
| 8 | Release by any path | Prompts stop; escalation item clears |
| 9 | New head pushed after a prompt | Clock restarts when the new head is ready |
| 10 | Legacy hold (`held`, no `mergeHold`) on a `blocked` task with a revision | Revision gets a slot; migration sets `mergeHold` |
| 11 | Queued task under an ordinary hold | Still blocks dispatch; no prompts |
| 12 | Brief `queue.mergeHold` then `hold` while queued | Dispatch fence added; merge fence stays; dispatch blocked |
| 13 | `keep_hold` on a queued dispatch hold | Reason and generation of that kind refresh |
| 14 | `lead.promote-task` / `papercut.promote-task` with `hold` | Task created already under a dispatch hold |
| 15 | Explicit dispatch hold on an already-dispatched task with a live stage callback | Callback advances once; no next stage run starts until release, then exactly one starts |
| 16 | Merge-only hold on a staged task | Reviewer stage still launches |
| 17 | Owner reparents one task holding an owner-placed and a third-party hold | One write: the owner changes; the owner-placed hold and its pending prompt answer to the new owner; third-party holds and settled notices stay |
| 18 | Bulk reparent of a project's open tasks owned by an archived thread | Every open task that thread owns in that project moves; other owners, projects and finished tasks stay; no liveness proof of the old owner |
| 19 | Caller is not the operator, project owner or current owner; or the new owner is archived, missing, the operator or a task worker | Refused before any write |
| 20 | Creator nominated itself for completion with `notifyOriginOnCloseout: false` | The nomination is the owner entry: after a reparent the new owner gets the completion notice and the archived creator nothing |
| 21 | Reparent to the current owner, or a repeated bulk request | Nothing written |


## Blocking hold derivation

Client labels and server stop selection use the same blocking-hold derivation.
A live fence is the hold in `blocked` and `needs_attention`, with dispatch taking
precedence over merge. In other phases, dispatch blocks pre-work and merge blocks
verification or merging; a hold beside active work does not replace its phase.
