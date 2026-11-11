# 044 — Saved reviewer progress

Status: retired (2026-10-14)
Owner: Queue lifecycle maintainers
Decision owner: Tom (2026-10-07, remove automatic review loops)
Governing refs: `docs/knowledge/contracts/orchestration.md`

## Checkpoint contract

An authenticated `review_in_progress` callback saves bounded
`checkpoint: {covered, remaining, notes}` on the current unreleased reviewer
run at its exact head. Queue stores an immutable run record, an owner-only
checkpoint file and a receipt association to the authenticated callback. It is
not a completion, verdict, pass, review record or merge authority. The receipt
says `continued: false`. Duplicate callbacks return the same durable receipt.

Legacy automatic continuation intents remain immutable history and are inert:
nothing writes one and nothing settles one, and an old record still parses. One
left unsettled still refuses a new reviewer delivery, as a fail-closed check.
Restart, unpause, hold release, checkpoint limits, provider retry, callback
reminders, role replacement, recovery and the retired scheduler cannot create
or replay a reviewer turn.

## Legacy checkpoint proof boundary

An authenticated checkpoint written before PR407 may lack the callback and
brief metadata added to new records. Explicit continuation may use that record
only when all of those fields are absent and read-only checks prove the old
producer's transaction: the canonical owner-only checkpoint file equals the
latest run record; one exact ordered `review_checkpoint` event binds its task,
run, head, ordinal and budget to one accepted receipt with the same event ID,
task and run; and the receipt hash is well formed with `continued: false`.
The event, receipt, run record and saved file must all fit the old producer's
atomic write shape. Missing, duplicated, malformed or conflicting evidence
refuses with a provenance diagnostic. A partial or malformed PR407 record does
not fall back to this proof.

For a Queue-held brief, the immutable version texts and digests must match the
complete ordered `submitted` and `brief_amended` event history. The current
reviewer run must name the latest pinned version, and all brief events must
precede its checkpoint in both event order and time. An amendment after the
checkpoint refuses even if a later amendment restores the earlier text. A
task without a Queue-held brief must have no brief version or amendment
history. The old receipt hash remains an authenticated opaque value: the
callback body was not retained and its hash is not recomputed from the saved
checkpoint. Derived proof exists only during authorization; it never fills in
historical records, receipts, callbacks or credentials. New-format records
continue to require their strict PR407 metadata and digest checks.

## One operator-authorized continuation

An operator may issue one `queue.task` action `continue_review` with the current
`taskId` and `version`, exact `reviewRunId`, full `reviewHead`, latest
`checkpointOrdinal`, `reviewAuthorizationReason` and bounded `reviewInstruction`.
These fields are rejected on other actions. The action is a durable serialized
task operation. Coordinators, callbacks and automatic passes have no
continuation path.

Before reserving delivery, Queue requires the ordinary `reviewing` phase; the
same current unreleased reviewer run with no completion; reviewer-only
authenticated provenance for the latest checkpoint; an unchanged brief; an
available assigned profile; actual author/model independence; the original
agent and workspace; and a permission-free idle live thread running the same
model. Queue rechecks the exact open PR, branch, base, local worktree and full
head through existing repository proofs. Pause, dispatch, disposition, merge
intent, unresolved task effects, a changed callback/run/checkpoint/brief/profile,
or any identity race refuses delivery.

The explicit reason and instruction, task version, checkpoint identity and a
stable message ID bound to task/run/head/checkpoint are persisted before
messaging. Duplicate or concurrent calls for that checkpoint cannot send
twice. Delivery uses only the original reviewer in the original workspace and
model; no run, reviewer, ticket or credential is replaced. The prompt includes
the preserved covered and remaining checkpoint and asks for the normal final
callback on the same run. It cannot authorize edits, publication, merge, or
approval. A later `review_in_progress` checkpoint parks again and needs fresh
operator authorization.

A positive adapter refusal before messaging marks that authorization as
`refused` and leaves the checkpoint eligible for a fresh operator
`continue_review` at the current task version. Queue reruns every gate, retains
the same checkpoint-bound message ID, and records the refusal in task events.
This is a new authorization for the still-undelivered checkpoint. A reserved,
delivered, or uncertain intent cannot be retried with new authorization; an
unknown outcome remains held and may only be reconciled from same-intent
evidence.

## Explicit author return from an idle checkpoint

An operator may instead issue `queue.task` action `return_checkpointed_review_to_author`
with the same five fields as `continue_review`: current `taskId` and `version`,
exact `reviewRunId`, full `reviewHead`, latest `checkpointOrdinal`,
`reviewAuthorizationReason` and a non-empty `reviewInstruction`. Other actions
reject these fields. It is a durable serialized external-effect operation and
has no coordinator or automatic path. It sends nothing to the reviewer.

Queue requires the same gates as continuation (ordinary reviewing task, no
pause/dispatch/disposition/merge/effect fences, the current unreleased
callback-free reviewer run, latest authenticated checkpoint with its receipt
and provenance, and the original reviewer identity, workspace, model and
independence) with three differences. A Queue-held brief may have changed since
the checkpoint; the return then records the current brief version and digest as
the owner's revision authority. An unsettled reviewer delivery (reserved or
uncertain) refuses. The retained author must be idle and permission-free in the
task workspace with no other unreleased run. Open PR, exact head and the
retained author's clean, pushed worktree are rechecked through the existing
proofs. A resolved incident does not block; an unresolved or escalated one
refuses.

After every await, Queue reruns every gate, and the final decision happens in
one store transaction. That transaction revokes the reviewer's credentials,
marks the run `superseded` and released, keeps its checkpoint file, receipt,
callback digest and history unchanged, and records a
`checkpointed_review_returned_to_author` event. The event carries the
checkpoint ordinal, head, brief version and digest, reason, and a digest of the
instruction. It is separate from reviewer findings. It then calls the ordinary
operator revision path with the instruction as the one pending revision
instruction. The next revision runs on the same retained author and workspace
through the normal delivery and uncertain-send rules. Nothing in this path
writes `changes_required`, `approved`, a pass, gate credit or a skip-review.
The reviewer's original reporting authority is gone, so any late callback from
that run is refused. Normal independent exact-head review still follows the
revision's result.

## Uncertain delivery

If Paseo's send result is unknown, the durable delivery remains held. Queue
never interprets idle state, PID disappearance, age, restart, or missing timeline
entries as proof that delivery did not occur. Repeating the same action can
inspect that same message ID: only that occurrence's own positive evidence — the
exact timeline message carrying its message identity — may reconcile it as
delivered. A final authenticated callback is that run's result and a checkpoint is
saved progress: neither can say which unknown send reached the reviewer, because a
checkpoint's ordinal is assigned when Queue receives it and an earlier checkpoint
can be delayed behind a later send. Neither settles an unresolved occurrence.
If evidence is absent or unavailable, the hold remains and no send is attempted. Reminders, recovery,
unpause and hold release do not clear or replay it.

A genuine final authenticated callback from the same run settles through the
normal exact-head review path. It is not stranded by the retired continuation
authorization predicate. A continuation and its checkpoint contribute no
verdict, pass, pass-gate credit or approval. Unfinished reviewer coverage is
never returned to the author as an author defect. Fresh reviewer bridges retain
the existing responsibility contract: `author` with `changes_required` for a
real author defect, `environment` with `blocked`/`error` for an external
impediment, or `reviewer` with `review_in_progress` for unfinished coverage.
A `ready_to_merge` report omits `reviewResponsibility` entirely; any value on
an approval is refused. The reviewer prompt states this rule for both modes.
Closed reports remain immutable. Genuine complete reading, exact-head proof,
source and rights checks, and reviewer independence remain required.
