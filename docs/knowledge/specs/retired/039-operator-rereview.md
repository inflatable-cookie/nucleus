# 039 — Operator re-review after an insufficient approval

Status: retired (2026-10-15); `move to=review` ([Spec 050](../050-owner-task-controls.md)) replaced it. The payloads below no longer parse
Owner: Queue runtime maintainers
Created: 2026-10-02
Decision owner: Tom
Governing refs: [Spec 033](../033-formal-pr-reviews.md) (formal review identity),
[Spec 036](../036-role-reassignment.md) (reviewer independence),
[Spec 037](037-structured-review-verdicts.md) (immutable review records),
[Spec 017](../017-external-pr-review-entry.md) (review entry)

## Problem

An accepted `ready_to_merge` report can fail an exact-head review requirement,
for example when its reviewer skipped required private-server proof and relied
on a prior head. A merge hold stops merge intent, but Queue needs an operator
control that invalidates the approval and requests the missing proof at the
current PR head.

## Control

`queue.task` adds the operator action:

```json
{
  "taskId": "task-id",
  "version": 12,
  "action": "rereview",
  "reason": "Run the required private-server cases at this head, zero skipped",
  "reviewer": { "profileId": "reviewer-profile", "reason": "Independent exact-head review" }
}
```

`reason` is required. `reviewer` is optional. Its requested profile is
preflighted for catalog presence, availability, reviewer role, task
scope, available subscription group and Spec 036 independence. It becomes
the required reviewer request for this re-review.

## Preconditions

- The task is dispatched and unmerged, with an identified PR and retained
  worker.
- The phase is `awaiting_review`, `changes_requested`, `verifying` or
  `merging` before merge intent.
- Merge intent is absent and every task run, including recovery, is released.
- An accepted `ready_to_merge` or `changes_required` review exists in the
  current resolution or immutable reviewer-run history.

The PR is verified before changing task state. The fresh review is pinned to
the verified current PR head, including when it moved since the old review.

## Effect and history

In one task transaction, Queue:

- Appends a `reviewSupersessions` record containing the old accepted review,
  its run and published review/comment IDs, reviewed head, verification,
  mechanical verification, timestamp and operator reason. Existing reviewer
  runs and structured review records are unchanged.
- Emits `review_superseded` with the old review identity, reviewed head,
  current PR head and reason.
- Clears the active review, verification, mechanical verification, reviewer
  binding and integration turn, and returns the task to `awaiting_review`.
- Stores the reason for exactly one reviewer run and dispatches a fresh
  reviewer agent at the verified PR head. The prompt repeats the reason and
  requires the reviewer to perform all required proof at that head.

The task's `held` and `mergeHold` values are preserved. Existing review
history remains available with supersession reason and evidence. The action
refuses after merge intent, while any run is unreleased, or without an
accepted review.

## Acceptance

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | `merging` task with no merge intent and an accepted review | A fresh reviewer run starts at the verified current PR head |
| 2 | Old review, verification and mechanical verification | Retained in `reviewSupersessions`; old review run is unchanged; `review_superseded` records review ID, head and reason |
| 3 | Merge intent exists | Refused without changing review evidence |
| 4 | Any run is unreleased | Refused without changing review evidence |
| 5 | Optional reviewer request is invalid or lacks independence | Preflight refuses before any task mutation |
| 6 | Merge hold is active | It remains active while the fresh review runs |
| 7 | Reviewer prompt | Includes the operator reason and exact-head proof instruction |

## External owner revision on a workerless review-entry task

A review-entry task (Spec 017) has no retained worker, so ordinary `rereview`
refuses it: the retained-worker assertion and the retained-worker advanced-head
retry both require an agent and profile that review entry never created. When
the actual project owner revises the source directly and pushes the revised
head to the same open PR, `rereview` accepts a narrowly tagged
`externalOwnerRevision: {previousHead, head}` extension to record that revision
and request one fresh independent review on the same task and PR.
No implementation worker and no synthetic callback exists on this route.

```json
{
  "taskId": "task-id",
  "version": 4,
  "action": "rereview",
  "reason": "Direct-owner revised source after the spent native batch; review the exact new head",
  "externalOwnerRevision": { "previousHead": "<recorded old head>", "head": "<inspected new head>" },
  "ownerAgentId": "current-owner-thread",
  "reviewer": { "profileId": "reviewer-profile", "reason": "Independent exact-head review" }
}
```

`ownerAgentId` is the authenticated acting thread. Without `relayed` it must be
the current project owner thread of the task repository (Spec 042), observed
live, idle and permission-free; a freely supplied actor grants nothing. With
`relayed: true` and a recorded authorization `note`, the acting thread is an
authorized relay and the receipt names the note. An optional `reviewer`
request keeps ordinary named-reviewer routing and must differ from every
declared author model. The request is refused with `retainedReviewerRunId`:
a spent historical reviewer run is never reused, replenished or rerun.

### Preconditions

- The task is an existing review-entry task: `entrypoint: review` with
  immutable intake provenance, null initial worker identity and no author
  creation intent, before merge intent and terminal closeout.
- Recorded evidence exists at the old head: a genuine accepted review, or a
  genuine authenticated released blocked/environment result. Queue never
  invents a verdict where neither exists.
- `previousHead` equals the recorded old review head exactly.
- No unreleased run, live recovery, unresolved incident or attention, active
  disposition, pause or uncertain operation owns the task.
- The full inspected new-head proof reuses review-entry verification: same
  registered workspace, branch, repository and open non-draft PR; clean local
  branch, pushed branch and PR head all equal to `head`; planning lineage
  intact; the new head descends from the recorded old head; declared PR author
  and repository permission re-proven. The proof is dated; Queue state and the dispatch fence are rechecked in the
  transaction. No distributed atomicity is claimed.

### Effect and history

In one transaction, Queue records a distinct `external_owner_revision` receipt
(event plus a typed resolution record) before any review effect: authenticated
actor and authorization, reason, exact old/new head, task/PR/branch/workspace
identities, approved brief digest/version, original author declarations, the
inspected proof and the observed dispatch fence owner and generation. The
immutable intake operation and review-entry record are never rewritten, and no
worker completion, run or ticket is fabricated. An old accepted review is
appended to `reviewSupersessions` with its old head — approval of its old head
only; an old blocked report stays blocked history and supplies no verdict.
Current approval credit, verification and integration turn clear, the review
head pins to the new head, and the task returns to `queued` with the reason as
its pending review context.

An existing dispatch hold is required. The observed fence is preserved unchanged:
recording a revision is a held transition, review admission waits for the fence owner's separately authorized
normal release, and a fence that changed during the proof refuses. After release, fresh review-entry admission re-runs verification at the new
head and the pinned-view route below selects one independent reviewer with the
ordinary author-model exclusions. A lost reply reconciles the original operation and
receipt; it can never create a duplicate transition or reader.

### Acceptance (external owner revision)

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Authorized revision with matching proofs, dispatch fence held | Receipt recorded, old approval superseded at its old head, task held at `queued`; after the fence owner's release, admission re-verifies and exactly one fresh reviewer binds with no implementation worker |
| 2 | Stale version, mismatched old head, moved PR or fence drift | Refused before any receipt, approval or phase effect |
| 3 | Dirty, diverged or unverifiable source | Refused; no guessed head and no forced base reset |
| 4 | Active or permission-bearing actor or author turn, unreleased run, merge intent, pause or disposition | Refused without touching history |
| 5 | Non-owner actor without a recorded relay; forged PR author | Refused; relay receipts name the note |
| 6 | Old accepted review or old blocked report | History unchanged; no new-head pass and no verdict invented |
| 7 | Dispatch fence | Owner/generation preserved; no reader before explicit release; foreign change refuses |
| 8 | Lost or repeated reply | Reconciles to the original receipt; at most one transition and one reader |
| 9 | Ordinary retained rereview, pre-binding reconciliation and absent option | Behavior unchanged |
| 10 | Spent native reviewer run | Never replenished or rerun; combining with `retainedReviewerRunId` refuses |

### Exact inert recovery reconciliation inside an external owner revision

A pending recovery scaffold with no bound run, agent, action or writer is
still a refusal under the preconditions above: without an explicit request,
existing behavior stays unchanged. When the operator supplies the additive
`reconcileInertRecovery: { recoveryId, incidentId? }` object on the same
tagged `rereview` (schema-restricted to that route, with the ordinary
authenticated actor, reason and relay requirements), Queue may reconcile the
EXACT requested scaffold — and, only when supplied and re-proven corrected,
its EXACT original incident — in the SAME durable transaction as the
revision receipt. There is no generic reset, no recovery worker, no old-head
retry and no approval carry.

For a requested scaffold Queue proves, from native durable records and
identity-bound adapter evidence, pending status with the exact id, 64-hex
key and current coordinator generation, null run/agent, no accepted action
binding, inactive recovery with no current run, no unreleased or
recovery-role run, no unsettled task-control operation or unresolved
operation effect (the binding intake is provenance, not authority), no live
coordination notice, and no unresolved disposition or effect. Absence of a
PID is not proof; missing or uncertain evidence refuses. A pending record
with actual authority is never read as inert.

Released runs can still owe effects. Exact inert reconciliation consumes the
shared recovery-effect projection for run delivery, review delivery,
continuation, publication and hooks at initial admission, after awaited proofs
and inside the receipt transaction. An uncertain released run, reserved or
uncertain review delivery/continuation, hash-only publication intent, malformed
or contradictory publication record, or unfinished/unsuccessful hook refuses
without closing the scaffold or incident, issuing credentials or creating a
reader. A settled publication requires a finished released reviewer, its
authenticated accepted callback, exact task/run/head and publication identity,
and the findings body hash. Settled publications, delivered reviews and
successful terminal hooks remain history and do not fence a new receipt.

Queue311 reuses the read-only `recovery-effects`, `review-publication` and
`enclosing-operation` modules from Queue318/PR436 source commit `c3bb22c9`.
Its wider lifecycle adoption remains Queue318's scope. This guard does not
turn a retained metadata key into blanket authority or an automatic retry.
Omitted reconciliation retains its existing behavior.

For a requested incident Queue matches the exact id, the `repository_identity`
cause, `reconciling` status and the original stale-checkout detail
(`Prospective merge requires a clean synchronized integration base:
Integration checkout is on a different branch`); only that class qualifies.
It then reuses the canonical integration identity the new-head proof just
established to positively prove the predicate corrected — registered
checkout clean, on the selected base branch, head equal to the proven
synchronized base and remote ref, with authorized planning lineage — without
running an old-head prospective merge and without taking review or CI
credit. A clean status alone, without this verifier, stops with its precise
gap. Arbitrary faults, CI failures, semantic findings, provider errors,
foreign work and escalations never reconcile.

The receipt guarantees an exact immutable Git head and authenticated owner
scope with dated source, actor, permission and tool observations. It is not an
external writer reservation, terminal quiescence, or remote-at-commit proof.
After actor/tool observations, Queue re-queries the canonical open PR and
permission, then takes one fresh origin advertisement of branch and integration
refs. The receipt records separate PR/ref observation timestamps and exact tips. Already observed activity, permissions,
unknown tools/effects and drift refuse. A tool observation proves liveness, not
history: on a thread observed idle with no active turn or permission, a tool in
a terminal state (completed, failed or canceled) owns no live effect, whatever
its renderer type. Each call is judged by its latest state, matched by call ID in time order: a later terminal entry settles an earlier running one, and one call ID with conflicting tool or command identity, or two states at one instant, refuses. A running or status-less tool, a running shell, a gapped or
unverified page, a tail without completeness evidence, or a tool without call
identity or time still refuses. A page with older entries omitted counts only
when it reaches back into an earlier turn than its newest entry, so the latest
turn is complete (the Spec 016 coverage rule). Review
admission after the fence release applies the same rule (2026-10-13).
Every refusal before the receipt transaction is definite: the path reads
evidence and commits once, with no external send. A clean advance of the integration base past the receipt's base is not drift: admission accepts the receipt base or any descendant of it, while the exact head, branch, PR, directory and brief must match. A rewound or diverged base refuses. Later external changes are future drift:
fresh admission, authenticated reporting and premerge independently re-prove
canonical source identities. Drift invalidates current credit and requires a
new receipt and independent review. Queue serializes only its own task controls,
run reservations and durable creation intents, with full run-set and exact
scaffold/incident rechecks in the receipt transaction. Original scaffold and
incident fields are retained in the receipt, alongside the corrected base.

The premerge and pre-merge-intent re-proofs separate a temporarily unavailable
observation from a positively changed fact, because a busy owner, a pending
permission, an unfinished owned tool or an unreadable external read says nothing
about the source. A repository permission proof that does not positively
establish write permission (`permissions.push: false`, or an absent
`permissions`/`permissions.push` field) belongs to that same unavailable class:
it proves nothing about the source. A canonical PR response that omits or
malforms its author, state, draft/merged status, repository, branch/head or URL
identity is the same kind of unknown read: it keeps the review and waits, so an
unread field is never mistaken for a changed one; only a concrete different
value or a positively read closed/merged/draft/deleted PR is drift. A temporary observation keeps the accepted exact-head review
as history and current evidence, sends no merge, and records a self-clearing
`external_unavailable` wait that `next` reads; only a positive refusal of the
head, ref, base, directory, reviewed input, receipt, brief or author declaration
clears credit. The existing parked `restart` is the bounded owner recheck: it
re-proves those facts and either resumes verification or requalifies exactly the
original accepted and published review derived from its own
`review_result_applied` event, authenticated callback receipt and settled
publication record, which the forge verifies again, creating no reader, receipt
or review. It requalifies only a clear whose recorded statement positively named
a temporary observation, and a positive source change actually observed by an
earlier real pre-send reviewer continuation stays intervening evidence even if
the source later reads unchanged again; the recorded history of that same review
leaving the current slot stays exactly as it was. An unsettled later run is a custody fence
that refuses the recheck until its own authenticated result or supported
retirement settles it; a settled no-verdict reader is history (Spec 017). A
normally assigned coordinator's own unreleased delivering recovery run is the one
exception, and only through the same strict reporting binding: the canonical
actor proof still proves that actor idle, permission-free and tool-free with its
identity and workspace unchanged, requires the fresh observation to equal the
bound run's workspace and any recorded coordinator workspace (a missing or
conflicting workspace is unavailable and retires/restores nothing), exempts only
the bound run, and leaves every sibling run fencing. A later supersession at or after the cleared approval owns
the head and refuses requalification even when it names that same review; only
supersession history recorded before the approval is earlier lineage (Spec 017).

### Queue-owned pinned review source

New dated receipts use a typed `Run.reviewSourceView`, never a replacement of
`Task.workspaceId`, branch, directory or immutable intake. After separate fence
release and fresh canonical admission, Queue reserves one run, one UUID
creation identity (the request correlation token) and one caller-selected
workspace ID in Paseo's `wks_` plus 16 hex namespace; the installed protocol
refuses any other ID before the client sends it. The installed supported `workspaces.create`
worktree source names the exact head, unique branch and slug. Queue verifies
the returned workspace, canonical object store, origin, head and tree before
issuing the run's authentic callback credential and agent creation intent.
The unchanged author declaration is supplemented with dated actual source-owner
model observations; every observed author model and agent stays excluded. An
unknown observed source-owner model cannot admit a reviewer. The reviewer
reads/builds/checks its own view. The Git object/tree is immutable;
working files are mutable, so admission, reporting and continuation verify the
tracked files/index against the pinned tree. Owned build outputs are allowed.
The original source remains canonical for remote identity and expected-head
merge gates; no historical approval transfers to the new reader.

Lost workspace replies reconcile only the same workspace ID/slug creation. Missing or
ambiguous creation stays unknown; no duplicate create is attempted. A view
reserved before 2026-10-13 used the raw creation UUID as its workspace ID, which
the installed protocol refused before sending. Such a reservation is retargeted
once, in one audited `review_view_retargeted` transition, to a namespace ID
for the same run, creation ID, branch and head. That requires a complete
inventory with no workspace matching its ID or slug, no agent creation intent
or credential, and the exact current task, run, head and receipt. The same run
then creates normally. Anything else keeps the reconciliation above. An existing
verified view with no agent creation intent may finish that same run's first
creation. Once agent intent exists, exact task/run labels reconcile delivery;
absence is never permission to replace it. Callback authentication remains
bound to the real run and its actual workspace, head, receipt and brief.
Terminal cleanup includes only the explicitly owned view under normal Git,
released-run and foreign-resource guards. Original source/history stay preserved.

### Material ruling superseding the previous design

Tom's exact ruling, relayed by Effigy source owner `58c` on 2026-10-13:
"We don't control Paseo - we cannot rely on adding anything to Paseo for anything in effigy."
It supersedes the previous producer-reservation/terminal-liveness claims and
permits this bounded Queue-only redesign on the same task and PR. Prior brief
versions, reviews and rulings remain history. No daemon/SDK/producer changes,
checkout/fork/owner discovery, consumer controls or inferred authority follow.
Effigy 151 is only a prospective consumer; 152 is cancelled and excluded; 005
holds, resources and spent allowances remain untouched. Fresh proofs use the
actual current base, not a whole-tree equality claim or reported consumer CI.

Authority: Tom's standing ruling, decision `21b67fc0` v2 (verbatim: "You
have blanket approval, stop asking for it!"), authorizes implementation,
independent review/CI, normal merge and supported plugin-only delivery of
this bounded prerequisite; the Effigy owner (`58c`) confirmed continuation
under that ruling on 2026-10-13 for exact inert-scaffold reconciliation
plus the original `repository_identity` reproof and closure, focused
regressions, independent review and normal merge/delivery with no repeated
approval. This closes the follow-through gap left in completed Queue #310
(PR #427), not duplicate intake or source work.

Tom's subsequent exact continuation ruling on 2026-10-13: "Agreed - the top tier
model can keep going and the chatterbox can choose to continue, which we want
to do here". Owning Chatterbox `a05c44ca` chose continued work by the existing
Sol6.1 author on Queue311/PR428 to address review `5507460348` at `e4d9062f`.
That review's `unsettled_effect_refusal` verdict is a failure; its other
recorded verdicts and all earlier reviews remain authentic history. This
disposition permits this shared-effect correction and fresh independent review
and checks. It grants no approval carry, new model selection, private run
binding, budget reset or consumer authority. The normal authenticated retained
worker route and the generic owner controls in [Spec 050](../050-owner-task-controls.md)
remain responsible for execution; a brief alone never creates a run.

| # | Scenario | Required result |
| --- | --- | --- |
| 11 | Exact inert scaffold with authenticated released blocked report | Historical closure plus new-head receipt atomically; fence stays; zero worker/reviewer creation until release, then one genuinely independent new reader |
| 12 | Exact inert scaffold plus old `repository_identity` fault | Closure only with the positive corrected-integration predicate; old approved head truthfully superseded; new head not approved |
| 13 | Idempotent lost/repeated operation | One closure, one receipt, one reader |
| 14 | Actual bound/reserved/uncertain recovery, run, creation, action, callback or effect; non-pending or wrong id/generation/key; unknown history; current or unreleased writer; active permissions or tool | Refused with the exact gap; state, history and fence unchanged |
| 15 | Unrelated, mismatched, reappeared or changed incident; still dirty, wrong-branch, diverged or unpushed integration base; failed inspection | Refused; no arbitrary fault clears and no clean-status guess counts |
| 16 | Task, source, head, brief, owner, fence or operation drift at any await or transaction; no accepted old report; false author provenance; unavailable or same-author reviewer; generic or omitted reconciliation | Refused or unchanged; the 310 nine-family regression stays green |

## Answered carry escalation admission

An escalated coordinator recovery can end by asking for exactly one thing: a
full substantive review. The motivating case is a `needs_attention` task with
an eligible mechanical review carry whose escalation report asks for a full
review because the original reviewer's scope digest is absent, so no
mechanical proof can ever be built. The question is answered, but neither
existing control admits it: the ordinary rereview fallback refuses escalated
incidents, and `resolve_escalation` reads the same needs_attention episode as
live work. Ordinary `rereview` therefore accepts one optional exact
`answeredCarryEscalation` tuple that names the episode and, when every proof
passes, closes it as part of the ordinary supersede-and-requeue transition.

This remedy was prepared as an unauthorized draft and then implemented under
an actual implementation authorization: asked by the Project-a source owner
(f9e9051d) whether to implement, independently review and deliver exactly
this prepared lead (22190ba3), Tom answered verbatim "Approve the fix"
(2026-10-13), relayed by that source owner to Queue owner a05c44ca. The
authorization covers this one finite remedy — the control, its proofs and its
delivery gates — and no generic attention clearing, approval carry, budget
reset or consumer-side action.

```json
{
  "taskId": "task-id",
  "version": 9,
  "action": "rereview",
  "reason": "The answered escalation asks for one full substantive review",
  "reviewer": { "profileId": "reviewer-profile", "reason": "Independent full review" },
  "answeredCarryEscalation": {
    "incidentId": "...", "recoveryId": "...", "recoveryRunId": "...",
    "escalationEventId": "...", "escalationDigest": "<full receipt digest, 64 hex>",
    "originalReviewRunId": "...", "originalReviewEventId": "...", "originalReviewHead": "<40 hex>",
    "originalPublicationKind": "comment", "originalPublicationId": 1,
    "revisionRunId": "...", "revisionEventId": "...", "candidateHead": "<40 hex>"
  }
}
```

### Preconditions

A read-only gate proves every identity before any transition, re-proves after
every await and repeats inside the transaction. Every failed proof refuses
without mutation and without a wake:

- The task is dispatched, unmerged, in `needs_attention` with attention, over
  a mechanical review carry in `eligible` or `superseded` whose exact
  candidate revision (run, event, head) and original accepted review (run,
  event, head, publication) the tuple repeats.
- The named incident is the current escalated episode, bound to the named
  escalated recovery and its run, with incident detail and recovery summary
  agreeing.
- The recovery run is this task's finished, released `escalate` report with an
  accepted receipt whose stored digest equals both the named digest and the
  completion's own digest. The digest is read from the authenticated store,
  never reconstructed from prose.
- No review exists at the carried candidate head; the whole run set is
  released and settled with no uncertain delivery, unresolved publication,
  hook or operation; merge intent is absent.
- The original review passes the retained-reviewer proof (authenticated
  receipt, workspace, profile identity, Spec 036 independence), and the
  candidate revision's own callback is authenticated at the carried head.
- Every retained author, reviewer and recovery thread observes idle without
  permissions or errors in the task workspace; the open PR still carries the
  exact carried candidate head, proven clean, local and pushed.
- Ordinary pause, hold, fence and disposition guards apply, and the named
  reviewer request passes the ordinary independence preflight.

### Effect and history

In one transaction Queue resolves only the named incident and recovery
(detail `Escalation answered by the operator: …`), settles the episode's
pending attention notices, marks the carry superseded, appends the ordinary
immutable review supersession of the old approval at its old head, binds the
named reviewer request, clears current review credit, and returns the SAME
task, PR, brief and workspace to `awaiting_review`. Recovery and native
budgets and existing holds stay untouched; old callback, checkpoint,
rejected-report and recovery evidence remain; and exactly one post-commit
wake dispatches one fresh full reviewer at the verified current head. No
reviewScopeDigest backfill, mechanical carry, inherited reading or verdict is
created. A lost response or repeat reconciles on the task version and can
never dispatch a second reader. Escalations without the tuple, unrelated
incidents, `resolve_escalation`, and ordinary non-escalated fallback behavior
are unchanged.

### Enclosing-operation exemption (Queue317 corrective)

The durable `queue.task` executor runs an external-effect `rereview` inside
its own `task_control` operation, which is `running` while the admission
checks run. That exact operation is the executing admission, not an
unrelated unresolved effect, so the gate excludes ONLY it — after proving,
from the stored operation record on every check (initial, post-await and
in-transaction), that it is this task's running `rereview` admission with
the exact version and payload. The enclosing identity travels as trusted
internal executor context, never as caller input: no control field, prose
reason or broad `task_control` exemption can name it, and a wrong task,
action, payload, version, settled state or unknown ID excludes nothing and
refuses. Direct-engine calls without an internally bound operation keep the
full guard. Foreign, pending, uncertain (`needs_attention`) and mismatched effects stay fenced.

This is corrective follow-through on the Queue314 delivery above, under the
same actual authority already recorded there — Tom's verbatim
"Approve the fix" (2026-10-13) for this one finite remedy, through
implementation, independent review and genuine live delivery. Queue owns the
correction and delivery; no new authority is claimed and no consumer
semantics change.

### Acceptance (answered carry escalation)

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Authenticated answered carry escalation with absent original reviewScopeDigest | One new full review is requested, the matched episode closes, all old histories stay, no approval credit is restored |
| 2 | Wrong, stale, new, current or partial incident/recovery/event/candidate lineage | Refused before any mutation |
| 3 | Missing, malformed or tampered escalation receipt or report | Refused without mutation |
| 4 | Unreleased or uncertain runs, unresolved publication, hook or operation | Refused without mutation |
| 5 | Active or permission-bearing author, reviewer or recovery thread | Refused without mutation |
| 6 | Paused, held, fenced or disposition-owned task | Refused without mutation |
| 7 | Head, local, pushed, open-PR or profile drift, including after awaits | Refused; version, run and gate rechecks cover races |
| 8 | Lost response or repeated operation | Reconciles to the original transition; at most one reader |
| 9 | Ordinary fallback without the tuple; omitted option elsewhere | Behavior unchanged; unrelated incidents cannot be cleared |
| 10 | Durable executor's own running operation | Admitted once through the verified internal enclosure; foreign, pending, mismatched or caller-asserted effects still refuse without mutation |
