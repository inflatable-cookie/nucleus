# 050 — Owner task controls

Status: implemented
Owner: Nucleus maintainers
Created: 2026-10-13
Governing refs: [vision](../vision.md), [orchestration contract](../contracts/orchestration.md)

## Purpose

Let a project's Chatterbox steer its own tasks with a few plain verbs, so a stuck
task needs one call, not a search for the right exception control and its
identity tuple. This is the first step of the Nucleus simplification Tom asked
for on 2026-10-13 ([vision](../vision.md#reviewer-choice-review-loop-caps-and-coordinators-that-act)).


## Owners can always get past a failed gate (Tom, 2026-11-04)

Tom, after a day of stalls: "the queue should have the tools to control state directly, this is way too brittle and finicky STILL after 3 rounds of rewrites. The gates and checks are useful under normal operation, but agents MUST have the tools to get past them when they fail like this. We're spending WAY too long trying to just get things moving".

Gates serve normal operation. No gate, fence, stale record or uncertain effect may leave a task with no verb that moves it: an owner or planner can settle or override it with a recorded reason.

### When something is stuck

Read `next`, then use `retry_effect` or `move` with `force: true` and a reason.
The project planner, Nucleus planner and operator may force; workers, reviewers
and coordinators cannot. A planner may force even when they also appear as a
historical participant of the task. Callers match the stored planner id, including
the 8-character UUID prefix Nucleus uses in planner references. A forced retry
records owner settlement without observing or sending the effect. A forced move
records the blockers it settles and releases the merge turn; stop releases the
turn too. A forced move to review may bind an unbound PR supplied as `prNumber` after verifying its task branch, base and canonical repository; a different bound number is refused. The resulting head still needs independent review. A blocked or errored revision's verified PR is identity only and leaves its block unresolved. `next`, the stop and the coordinator snapshot show the latest author report. A forced move to work, or an ordinary move to work, returns the retained author with the owner's instruction. Force to merge still uses GitHub's exact-head guard. When no applied
verdict exists at that head, only explicit operator source acceptance can replace
review: include the qualification and, for a relay, the note quoting Tom. A
merged PR may be moved to closeout on the observed merge. After that verified
merge, sync and closeout use the merge commit: no later step requires an open PR
or an applied verdict, and a merge with none is recorded on the task. A forced move attempts to observe and stop
participants before releasing them. If observation or cancellation is uncertain,
the move records that uncertainty and the owner’s reason and proceeds; a turn
may still be running. New participant identities remain subject to their gates.

Nucleus trusts local processes: the caller and its board or planner source are
recorded policy claims, not cryptographic identity. A local process can claim
another identity. Callback authentication remains separate and unchanged.

## Problem

`queue.task` has 51 actions. Most exist for one stuck state and need exact run,
event, head, checkpoint, incident or receipt identities as input; the
`answeredCarryEscalation` tuple alone has 13 fields. The next stall is usually
adjacent to the last, so the newest control refuses and another is added. In
the three weeks to 2026-10-13 Nucleus recorded 1,038 recovery escalations and 633
operator-directed resumes or revisions. Owners cannot change a live task's
route after dispatch, cannot route a coordinator by profile, and cannot undo a
worker exclusion.

## Principles

Task reads and owner verbs accept task references wherever they accept a task ID;
references resolve to the existing UUID before admission. Owner verbs may omit
`version` to admit against the current version, optionally naming an observed
`phase`; explicit versions keep the existing fence. Responses list changed task
fields. Queued brief routing edits apply atomically with the new brief or refuse
with every unsupported field named (Tom, 2026-11-10). See the
[Nucleus skill](../../../skills/nucleus/SKILL.md#holds-cancellation-and-brief-edits)
for the payloads and supported amendment fields.

- Callers state intent. Nucleus derives every run, head, checkpoint, incident
  and effect identity from the task, does the bookkeeping in the same
  transaction, and reports what it did.
- A verb is refused only by a hard invariant:
  - merge needs an accepted review at the exact current PR head;
  - a callback must be authenticated to its run and generation;
  - an uncertain external effect is observed before any retry;
  - runs, events, verdicts and outcomes are never rewritten;
  - operator settings (pause, limits, subscription groups, frontier requests)
    stay operator-owned. Capacity is not an owner verb at all, and its identity
    rule is the service boundary's implemented operator-only write
    ([service-boundary](../contracts/service-boundary.md#settings-only-capacity-writes-tom-2026-10-25)):
    a task's owner cannot reach it, relayed or otherwise.
- Reviewer independence is a selection preference, not a gate. An owner may
  route any reviewer, with a reason.
- Every verb writes one `owner_control` event: verb, caller agent, reason,
  phase before and after, and the derived identities it acted on.
- Open incidents, recovery episodes, reminders, carries and checkpoints that a
  verb makes obsolete are settled by that verb as superseded, keeping their
  history. No verb leaves a fence that blocks the next verb.
- A verb admitted against the version `next` showed keeps that admission while
  the task's only later writes were observations — the lifecycle pass recording
  the last observed time, activity, status or idle stamp. Every await then
  re-reads the current facts, so a substantive write still refuses with the
  fresh read named ([observation admission](#observation-admission)).
- A refused admission changes nothing. The fences a verb retires settle inside the
  same transaction as the action that succeeds, so a rolled-back settlement leaves the
  incident, recovery and version exactly as they were.
  Superseding an incident or recovery keeps its original explanation on the
  resolved record alongside the owner control's reason.
- `restart` and `move` use the same settlement plan for owners and
  authenticated coordinators. Saved activity names a required fresh observation,
  not a final refusal. The transition may settle its own reporting episode run
  from that run's recorded result without cancelling the turn delivering it.
  Other finished runs settle after a positive matching idle observation. A
  superseded participant with no recorded completion can also settle when fresh
  observation proves the bound agent in its workspace inactive, with no active
  turn or pending permission, and the existing owned-tool and effect safeguards
  pass. Settlement keeps history and never invents a completion.
- Where the requested verb permits displacement, a busy episode run can settle
  after full admission, durable turn cancellation and fresh rechecks of the task,
  run, episode and effects. A reporting result or cached activity grants no
  authority over an unrelated participant. Genuine activity or permission waits
  refuse where the verb does not permit displacement; missing, unobservable or
  conflicting identities and pending or unknown effects retain their protections.
  A refused admission cancels and delivers nothing; an unknown cancellation
  outcome preserves its durable record rather than authorizing settlement.
  Cancelling restart branches share one in-memory execution order: complete the
  delegated handler's admission, displace the episode, then apply with fresh
  binding and effect checks. Absent-worker admission includes inventory,
  workspace proof and the local resume guards. First checkpoint delivery also
  requires adapter capability, canonical source reads, the live exact PR and
  matching idle reviewer observation. Existing reserved, uncertain or delivered
  messages are inspected before displacement through the same evidence-recording
  reconciliation as direct continuation; inspection never cancels merely to
  inspect and never resends. Absent-resolution binding or recreation shares its
  inventory, workspace, capacity, merge and PR or clean-worktree guards with the
  direct handler; unavailable inventory is unknown, never an empty result.
  Source-view preparation and creation or sending remain effects. A later
  binding, hold, callback or effect change, or a remote cancellation or creation
  failure, can still prevent apply after cancellation; its durable evidence is
  preserved rather than promising atomicity with a remote turn.
- Settlement records a superseded episode's pending accepted action as not
  applied, so a stale retry never executes. The matching authenticated
  coordinator verb is instead recorded applied with its transition. Coordinator
  resolution retry settles other runs in its retry transaction while preserving
  the episode and incident its retry handler still owns. Release records the run
  and leaves its binding available to the ordinary thread archive path.
- The ordinary recovery pass settles a finished accepted run regardless of
  review-dispatch authorization: while that authorization holds, the recovery pass touches
  nothing except this settlement — and only with the exact coordinator
  identity and a workspace observed idle. The release transaction rechecks
  the run, episode and coordinator binding after observation; an idle result
  from a replaced binding cannot release the run or refuse its accepted action.

Where settlement or displacement needs a participant observation, it must
positively identify the bound agent in its recorded workspace. A failed or missing lookup never proves inactivity,
including an error saying `not found` or `missing`. A delivered reviewer turn
needs its own matching observation started after delivery was proven before it
can be called stopped. Pre-send idle state or an earlier inventory cannot stop
newly delivered work; a changed run during observation discards the read.
Delivered and uncertain messages are never automatically resent.

## Observation admission

`next` reads a version; the owner's control is accepted and then runs on the
task's lane. The lifecycle pass may observe the same task in between: it records
`lastObservedAt`, `agentActive`, `lastAgentStatus` and `idleSince`, and those are
the only task writes that leave `lastSubstantiveVersion` where it was. A control
is therefore still current when its version is the task's current one or an
earlier one with no substantive write after it, and a run set is unchanged when
every run differs at most in `lastObservedAt`. Every owner-verb admission and
post-await revalidation reads the current facts through that one rule
(`core/recovery/observation-advance.ts`) rather than comparing a number captured before
an await.

The guard is always the admission the caller was given, never a version re-read
following an awaited observation. A reviewed merge move keeps its admitted task
version and run set across both PR reads, participant observations and turn
cancellation, revalidating before displacement and again at the commit boundary.
Its own fence settlement occurs inside that guarded transaction. A substantive
transition during any earlier wait therefore refuses instead of becoming a fresh
baseline; observation-only updates still pass the shared admission rule.

The applied action is still one transition: one `owner_control` event, one
settlement, no second send. The version stays monotonic for readers and
stale-entry detection, and a request behind a substantive write — a reason,
phase, head, workspace, branch, route, hold, disposition, merge intent, run
state, completion, report, checkpoint or effect record — refuses with the read
to repeat and writes nothing. An observation-only change is never permission to
retry an unknown delivery or replay an effect; those fences are unchanged.

The owner-control writes that follow an awaited remote read revalidate the
admitted facts and derive their patch from the validated record: a lane
attachment re-reads after its repository-origin lookup, and a completion
subscription re-derives its terminal, recipient and override facts after its
recipient observation. An observation-only advance applies; a substantive
change — another lane or subscription edit, a terminal transition, removal, a
hold or a disposal — refuses before the guarded write and overwrites nothing. A
`retry_effect` that reaches a settled effect refuses with the effects that
remain and never replays one; a stale request keeps the ordinary refresh
refusal, and a settled archive is never borrowed as another operation's outcome.

The order is a control's own refusals first and the host wait second. When the
task's recorded host is disconnected, an applied control's durable operation
stays pending with that host named, and only a control the stored facts would
otherwise accept enters that wait: a stale version, a missing or foreign
invocation, an active disposition, a terminal or removed task and every other
refusal that reads the store run before it (`core/host/host-independent-refusals.ts`).
A forced control owes the same order with force's own gates — the authenticated
caller, the reason, which actions force settles, the recorded effect it names,
and the guarded-merge and merge-observation methods the resolution adapter
reports — so an unauthorized or stale force refuses too. Those two adapter
gates are presence checks on an adapter the engine already holds, not host
reads; a check that would observe the host still waits.
The order lives at the one place the wait is decided — `Engine.performTaskControl`
and the durable operation lane — not in each verb. A refusal that needs an
observation the disconnected host owns (a PR head, a live participant, a forge
merge proof) still waits and refuses when that host answers; an accepted control
never reroutes and never replays an uncertain effect.

The retained external-merge acceptance (`move to=closeout` with a
qualification) keeps its exact recorded task, run and project identity proofs;
it accepts an observed merge, not a routine transition or a rewritten record.

## Verbs

All take `taskId`, optional `expectedVersion` (refused only when given and
stale) and `reason`. The CLI fills `caller` from the calling thread’s Nucleus ticket or host identity and refuses a
call without either source. Any authenticated local caller may use them; the event
records whether the caller is the task project's owner thread.

A worker restart or move continues a blocked author's work; the observed
published head is source identity, not readiness. The continued-PR proof and
reservation in the [orchestration contract](../contracts/orchestration.md#pr-identity-from-reports)
keep the block and prior exact-head review as history. A recorded review of any
status fences the continuation only through its settled evidence — a released
reviewer run whose completion is that review's own event — never through its
verdict; with no review recorded the receipt check does not apply and the rest
of the proof still runs.

| Verb | Effect |
| --- | --- |
| `next` (read) | Phase, active run (the initial worker's task-row binding only while a live fact names it: a live worker phase, an unfinished stall, a `run_stalled` stop or an open worker-role incident; never once a revision of the same worker delivered a result, #381), the current stop or wait with its reason and evidence, holds, and every verb that applies now, with prefilled arguments and the refusal for each that does not. The view and the applying control are one task-scoped plan (Tom, 2026-10-27): a verb derives the subject and identities, names the observation its execution must make, and reports the runs and episode fences its transition settles or displaces, so the continuation the view offers is the one the transition applies and no verb is refused for a fence its own transition settles. Unknown delivery, pending authenticated delivery and blocking effects refuse the view. Saved activity instead names the fresh observation execution must make: the same identity, workspace, turn, permissions, tools and effects decide whether the run can settle or be displaced under that verb. Where the episode's own run needs observation, settlement requires a matching agent and workspace: a conflicting identity or workspace, a missing agent or an unreadable observation refuses before any cancellation or release, because none of them proves that this participant stopped. The episode's opening progress digest is the report guard and carries no review coverage or checkpoint receipt; recovery revisits a checkpoint that still has no continuation reserved or delivered from current facts, as its own lifecycle decision. It never refuses a verb because of bookkeeping that verb owns: a coordinator's reporting run and the episode a continuation resolves settle with the continuation itself, whether the request arrives through the authenticated report or a direct call. An available `move to=work` or `restart` also carries a bounded note quoting the recorded run-bound build output cleanup (or naming a run with no record) before the next run reuses artifacts |
| `stop` | Optional `role` (`worker`, `reviewer`, `coordinator`), required `reason`. Halts the task's live work now and parks it: every busy turn of the task's runs (or one role's), including the initial worker, is cancelled durably (`owner_stop_intent`, then `owner_stop_sent`), and an owner dispatch hold keeps anything new from starting. A live proof executor is the one exception (nucleus#1195): its turn is left alone until it reports or ends, the `owner_stopped` audit records it under `executorContinues`, and only the hold applies. The `owner_stopped` audit names every targeted run, including an already-idle retained run. An existing dispatch hold stands. Run state is left as it is. After Nucleus observes the exact retained participant idle with no active turn or permissions, `restart` is offered for that owner-stopped run; an idle run with no matching owner stop keeps its ordinary handling. Restart records the instruction under the hold, and explicit `release` delivers it once on the same authenticated run and thread. This preserves source and run identity. For other stop shapes, a subsequent `restart` or `move` derives its required observations and settlement from current facts; actual activity, identity and effect safeguards still apply. `release` lets dispatch carry on, and `route` with `now` replaces the role through its existing stop path. The hold also fences the task's own merge boundary (Queue #531): a task stopped while `verifying` or `merging` records no merge intent and sends no merge request until the fence is released, and a merge already requested when the stop arrives is reported in the stop result as one that may still land rather than as cancelled. Applies while Nucleus is paused. Refused only by a finished task or a durable side effect (round 4, 2026-10-19) |
| `route` | `role` (`worker`, `reviewer`, `coordinator`), `profileId`, optional `thinkingOptionId`, optional `now`. Sets that role's route for its next run in any unfinished phase, overriding a worker exclusion for the named profile. If the task is blocked or errored on a completed reviewer run, has a retained PR, and has no live reviewer, routing resumes the review on the selected profile; a proof-only task with a settled receipt and no verdict waits on the reviewer with no PR, and the same route starts a receipt reviewer at that commit. A live reviewer keeps the route for its next run. `now` also stops the role's active run and starts the replacement on the new route, keeping workspace, branch and PR; because it cancels a live turn, a route with `now` is accepted as a durable operation first, like `restart`, so a caller that times out can observe it. The worker route is the required worker request when one exists (an owner route or a required submission), else the profile that last ran; a soft request never overrides it. A required owner route remains effective until the owner routes again. `next`, `restart` with `fresh` and `move to=work` all read that route (consumer-b #658, 2026-10-20). A replayed `route now` operation owns only the turn it recorded: a stop already sent or settled is not resent, a turn that started later is never cancelled, and an unresolved stop is resent only to the same known turn (an unknown turn identity fails the operation, and the owner routes again). At the worker replacement ceiling, `route now` refuses; only an operator-relayed fresh worker restart passes the ceiling |
| `restart` | Optional `role` (derived from the phase when omitted; `worker`, `reviewer`, `coordinator`, or `executor`), `instruction`, `fresh`. `role: executor` is the proof-execution re-report continuation (nucleus#1195): an unreleased executor whose result never arrived is asked, after a fresh idle observation, to resend its report on its existing run and credential, once per run; it re-runs no selector and starts no run, so it never releases the owner's stop hold. `tell` also accepts `role: executor` for a live executor run. Stops a stalled or stopped run for that role and starts the next one: the same agent continuing (default) or a fresh agent on the worker route (`fresh`; see `route`). Covers missing callbacks, stalled turns, checkpointed reviewers (the continuation on the same run; refused while its incident reconciles), absent creations and blocked or errored results. Three questions stay apart. The episode's opening progress digest is the report guard and carries no review coverage or checkpoint receipt (exact source head, instruction source, merge state, phase, worker identity, latest results, current run and routes), so a report answers the work it was asked about while the same retained reviewer's checkpoint evolution at one head keeps the ordinary move authority. The loop's cross-reviewer coverage measure is separate and only bounds repeated recovery. Recovery revisits unfinished work from current delivery facts: a checkpoint on the current reviewer with no continuation reserved or delivered gets its own episode after the previous one resolves, subject to current facts, admission, the coordinator's permitted choice and the existing loop bound; a permitted retained restart delivers at most one continuation, while a replayed callback or repeated reconciliation authorizes none (papercut 95cc5f71; project-c #155, project-f #014, project-a-accelerator #3771/#3775; Tom, 2026-10-27). A checkpoint whose continuation was already delivered resumes once on the same reader when the owner positively stopped that delivered turn (Tom, 2026-10-27): the individual immutable `owner_stop_sent` occurrence — verb `stop`, matching task/run/agent/workspace, ordered after the delivered turn — is the authorization identity, so a replay reconciles one effect and a second stop is a new explicit owner act. No idle observation, no stop from `move`/`route` displacement, an uncertain cancellation, a foreign stop or an unroutable one authorizes a send; the original receipt, checkpoint and delivery stay byte-authentic, and the resumed turn grants no extra checkpoint, review credit, quota reset or automatic retry. A stop-backed resume is additionally bound to the brief its delivered turn read: the ordinary awaiting-checkpoint amendment is not carried across a stop, so a amended brief refuses the resume and names `restart role=reviewer fresh` (the amended-brief path stays for a checkpoint that never had a delivered continuation). Nothing is reconstructed from an episode's history: a legacy episode recovers from the same current facts, and where it cannot be shown to answer the current work the ordinary route asks again — the continuation gate still refuses a second delivery for a checkpoint already continued. While a valid checkpoint, the exact head and the reviewer identity still hold, the retained continuation is the supported action a coordinator takes: a fresh reviewer displaces the retained one and discards its coverage, so `restart role=reviewer fresh` or `route role=reviewer` with `now` is the deliberate replacement. Since Tom's 2026-10-27 ruling ("Preserve the reader for everyone", decision 029a631e) `move to=review` is no longer that replacement: it preserves and continues a valid reader at the same exact head for owners and coordinators alike, and refuses with the deliberate fresh choice named when the reader cannot continue (live evidence, project-f #014: repeated `move to=review` superseded valid retained reviewers and reset apparent progress through `currentRunId`; the ruling ends that churn). With nothing stopped, or on a parked task with no current run whose run shape is history or cannot be served (a stopped reviewer, the worker of a task parked past work, a worker shape with no retained worker such as a review entry, or a worker-profile remap park), it re-runs the parked step: a never-dispatched park, a blocked task behind its retained PR (with a reviewer `instruction`, a fresh review after the exact PR-head checks), or a parked resolution check, merged closeouts included. When nothing else applies it answers an escalation with its `reason`, on a finished task too; a coordinator's restart never answers one. Round 4 (Tom, 2026-10-19): this folds the former `retry_resolution`, `resolve_escalation` and `continue_review` On a blocked or errored task with a PR, an explicitly named `role: "worker"` continues the retained worker on that PR through the move-to-work transition, whatever run blocked; without a role the restart still routes by the blocking run (Tom, 2026-10-23: "Worker continues (Recommended)", after Project-c #125's worker restart dispatched a reviewer). `resume_worker` and the pre-PR resume stay closed to this shape (project-a #1655). When the task knows that PR only from a reported completion (no bound `prUrl` or `resumePrNumber`), the continuation binds it or refuses; see the orchestration contract, PR identity from reports (Project-d #117). A PR the branch lookup finds behind a blocked or errored report is recorded as identity only and arms no readiness confirmation (Queue #392, Tom, 2026-10-24), so this restart — or `move to=work` — is what resumes the same PR with the owner's instruction and the block as its context. At the worker replacement ceiling, a fresh worker restart passes it only when it carries the operator’s relay or is called directly by the operator |
| `move` | Displaces the runs its transition permits (round 4): after full admission, a matching busy turn is cancelled durably and the run settles with history kept. Unknown delivery, pending authenticated delivery and blocking effects refuse; fresh identity and participant checks still protect runs that cannot safely be observed, settled or displaced. A task or run change during the checks refuses before anything is cancelled. Cancellation is remote: if a callback lands while it is in flight, the move re-plans once against the fresh state, where the cancelled run is idle and settles, rather than refusing after stopping work. `to`: `work` (author revision with `instruction`), `review` (the valid retained reader at the current exact head is preserved and continued — Tom, 2026-10-27, decision 029a631e: a genuinely awaiting checkpoint delegates the ordinary retained-restart admission and delivery path on the same run, a turn that is still reading or already has its delivered continuation sends no new message, an unsettled delivery refuses inspect-only, an existing unfinished reviewer whose source, receipt, brief or participant binding cannot be proved is refused rather than read as absent (so a legitimate `amend_brief` never silently replaces a pinned reader), and a spent budget or closed agent names the deliberate replacement instead of being replaced silently; `restart role=reviewer fresh` or `route role=reviewer` with `now` is the explicit fresh choice, and with no continuable reader the move starts a fresh reviewer at the current head as before, superseding any accepted review, checkpoint or carry; on a workerless review-entry task, a changed PR head refuses and names `move to=work` to start the revision worker in the task workspace; on a task with no bound PR, it binds the PR and exact head the current authenticated ready result names, under the retained-PR proofs, in the same write as the review entry; see the orchestration contract, PR identity from reports), `merge` (only with an accepted review at the current head, with an explicit qualified owner acceptance — a required `qualification` over an authentic released verdict at that head — or, since 2026-10-20, with an explicit operator source acceptance of the exact published source head when no review evidence binds it, both recorded by the project owner thread, the operator at the board, or a relayed operator ruling with its note; an owner acceptance may name the exact PR `head` it accepts when GitHub's head has moved past the stored one), `closeout` (only when the PR is observed merged; a never-dispatched review-entry task whose PR merged outside Nucleus also needs the explicit exact-final-head operator source acceptance described below) |
| `complete` | `reason` (required) and optional `artifact` (`{key, version, digest}`, an exact lane document). Finishes a dispatched task that has no PR to merge (report-only or no-code) on the owner's call; no brief heading is proof of scope. Refused only by a terminal task, merge intent, an open PR (recorded or on the forge), a live run observed active or holding a permission, or a task that never dispatched. One transaction releases the finished runs and settles the superseded fences (attention, incident, recovery with its pending action recorded as refused, reminders, carry, checkpoint intent) with history kept, then records a `done` outcome marked `owner_completed` with the reason and artifact. `complete_report_only` is its alias |
| `proof` | Activates the task's brief-named author-side proof execution ([Spec 055](055-source-immutable-proof-executor.md)): one execution per distinct exact source head. Requires `queue.proofExecution` on the brief or handoff — an existing task binds it through `amend_brief` — an unused allowance at the current head, an idle task, an exact published PR head and an unheld, unpaused task; after an earlier execution, the new head must have an authenticated author revision and retained-reviewer source approval at that exact head. A proof-only task also lists `proof` in `task.next` after its exact release GO is answered, and Nucleus retries a transient busy or capacity refusal when the task is free. Once the one allowance is spent on a settled receipt, `proof` is unavailable with that reason. A repeat at the same head refuses. Creates one genuine Nucleus-created `executor` run on the same task with normal admission, runs only the brief-named selector against the exact head, and appends separate executor evidence. Earlier runs and receipts stay unchanged. It releases no hold, changes no source authorship, publishes no review, reaches no merge and leaves the distinct independent review still required. |
| `accept_receipt` | Operator-only acceptance of a settled passing proof-only receipt for a failed, done qualification, at its exact run, commit, selector and input pins. Records the reason and preserves the original failed result and reviewer verdict; no run or allowance changes. The board lists it for the operator; a relayed operator note may also authorize it. See [Spec 055](055-source-immutable-proof-executor.md). |
| `retry_effect` | Optional `effect` naming one entry from `next`; with `discard` for an occurrence held after checkout disposal, for `workspace_creation` when inventory proves a Nucleus-owned unpublished populate leftover or a Paseo locked-`initializing` worktree, or (papercut c7643943, 2026-10-22) for a done task's or a completed cancelled task's `workspace_archive` under owner authority, which waives only the content proofs, opens read-only directories inside the exact owned root for removal, and retires a worktree Git lost only after a positive orphan proof (orchestration contract, Owner content discard). Settles the obsolete fences first, then observes and binds or retries the recorded failed or uncertain side effect: hook occurrence, workspace creation or archive, runtime retirement, build-output cleanup, merged-task retention, review publication, planning base, or a disposition frozen at its workspace proof or archive (with an optional `workDisposition: "archive_if_empty"` when the recorded retained-by-replacement proof can no longer be produced; see [Recovering a disposition workspace step](#recovering-a-disposition-workspace-step)). Workspace creation observes found-done / absent / still-running / unknown / partial / conflicting before bind or replay; an unlocked dirty slug-matched tree at another path is conflicting; `discard` is the existing orphan-removal proof, not a new verb. A done task's `workspace_archive` retry while Nucleus is paused attempts nothing: it enters no cleanup lane, makes no adapter, Git or cleanup call and increments no attempt, and its receipt names the pause that still holds, keeps the stored failure as timestamped history instead of replaying it as a new observation, and reports any content discard the same call recorded as durable and retained for a later eligible attempt (orchestration contract, Workspace archive retry) |

A later worker replacement after a completed capability upgrade, whether
automatic or owner-directed, uses the current authorized route and a fresh source
and custody proof. If a retired worker has a completed latest upgrade and the
current stop offers owner verbs, Nucleus holds automatic worker creation at that
stop; an applicable owner restart, route or move resolves the stop before
creation can proceed. The earlier upgrade remains immutable history; it neither
authorizes changed source nor permanently fences a later disposition.


When an existing verb replaces a reviewer, its dispatch can include one bounded opaque owner instruction as attributed source context, separate from the replacement reason. Nucleus matches a successful task-control operation and its input hash, the owner audit identity, and one earlier reviewer's delivered instruction; it names that operation, caller, run, head and pinned brief. It does not parse the instruction or give it fresh authority. Changed source, brief or later author work makes it historical; missing or ambiguous provenance and newer unbound instructions are labelled unknown. The current brief and current owner instructions take precedence, and this context never authorizes another proof or supplies review credit.

Each completed reviewer `blocked` or `error` report remains attributed impediment evidence in the shared outcome, including its run, head, responsibility, event, report and actual retention state. A summary-only report also displaces an older current approval without becoming a verdict. A newer same-head impediment outranks an older author result; a newer participant or author result and a changed head take precedence. It is neither an accepted verdict nor a reason by itself to commission another review. The named proof or owner disposition remains outstanding; environment recovery continues through the existing verbs.

A recovery coordinator launches with the same plan as a snapshot: the stop it was asked about (before its own launch is recorded), the participant actually holding the task, the task's current review outcome and the decision still outstanding, the retained reviewer's workspace and unfinished checkpoint coverage (kept separate from any completed verdict), the holds, the author's latest recorded result, and each verb with its `available` state, args or refusal, projected by `core/recovery/recovery-context.ts` from `ownerTaskNext`. The prompt says it is observation only. The refresh is the helper's `next` argument, which calls `/task-next` with the run's credential, reads only the coordinator's own task and returns the current `task.next` view. It sends no report, and a non-recovery run is refused. Application still derives current facts when the coordinator reports, so a snapshot verb the task has since moved past is refused, and a valid verb (including `move to=review`) applies as it would without a snapshot.

`task.next` reports the task's current review outcome as `outcome`, derived once by `currentReviewOutcome` in `core/verbs/owner-verbs.ts` and shared by `next`, the launch snapshot and the credentialed refresh (Queue #477): `accepted` is the newest verdict Nucleus applied, proved by that run's own `review_result_applied` event and carrying its exact head, reviewer run and agent and publication id — the event and the authenticated run are the evidence, so a later deliberate transition that clears the task row's accepted slot (a fresh-review `move`, an author return, a revision resume) keeps the verdict as applied history with `superseded: true`, and it then grants no merge authority; `reported` is a reviewer result recorded on a run the task never applied, newer than every applied verdict (published evidence or an unpublished report), never the accepted verdict and never an earlier applied verdict; `reader` is the reviewer run actually holding the current head with no verdict yet, with any retained checkpoint ordinal kept separate; `authorResult` is the author's latest recorded result with `afterApplied` marking a return recorded after the newest applied verdict — a later `ready_for_review` result at the same head means the applied findings are history and that result's independent review is outstanding, never another author revision; `revision` is the author revision allowance charged to the work; and `decision` states what is still outstanding, including the exhausted author disposition beside a fresh reader of the same unchanged head. An accepted verdict at an earlier head is history for a changed source and never qualifies it. An exhausted automatic author revision allowance is the owner's disposition — return the author to work with the accepted findings, or dispose of the work — and is never evidence that another review is required. A finished or released run is history: `activeRun` names only a run that has neither reported nor been released — the recorded current run counts only while it is still live, so a reviewer whose result is recorded but not yet published and applied, a released current binding and a released recovery run are never presented as the active reader; their evidence stays readable through `outcome` and the stop. The `decision` is one outstanding decision chosen from current lifecycle facts, not a sentence per fact: a reviewer result awaiting publication and application, else the reader holding the current head when it is newer than the applied verdict, else a later same-head author result, else a live author revision, else the deliberate fresh review awaiting its reader, else the applied verdict's own branch; the applied findings and the allowance stay visible as evidence behind it. The coordinator prompt follows that projection rather than the mere presence of a verdict: an accepted review still holding the current slot is the verdict, a superseded applied verdict is history whose same-head reader is the review to finish (a deliberate fresh reader is never displaced, in either allowance state), a later same-head author result needs its own review, and an exhausted allowance is the owner's disposition only while the author return is the outstanding decision. A coordinator must report that an exhausted author return needs the project owner; it cannot supply the owner’s disposition. The outcome is observation, not review, merge or execution authority.

`route` stores reviewer and coordinator thinking overrides in their
`profileRequests` entries. Worker routes update the existing worker thinking setting.
Reviewer and coordinator overrides apply only to their next runs; they leave
the worker thinking setting unchanged. Omitting the override uses that role's
profile default (or the existing worker setting for a worker route). The
worker's effective thinking level is its request's level when that names one,
else the task's `thinkingOptionId` (papercut 4befc74b, 2026-10-19: a brief's
`profileRequests.worker.thinkingOptionId` was stored but never applied, so 28
Effigy workers ran at their profile default). Selection, validation, author
escalation and the routing panel all read that one value; a worker route keeps
it on the task, and two different levels in one submission or `set_routing` are
refused.
Submissions and `set_routing` preserve reviewer and coordinator thinking
preferences while stripping the route-only independence marker. A deferred
coordinator replacement keeps the live run's generation until release, then
advances the task and replacement run generation together at reservation.

For worker restarts, including blocked workers, stopped revisions and retained workers between runs, `fresh: false` continues the retained agent and `fresh: true` replaces it on the current worker route. Stopped reviewers follow the same choice, except a plain-handover reader without a checkpoint cannot carry its run-bound view to a new run: a default restart refuses and `next` offers the deliberate `fresh: true` replacement. A checkpointed reader continues on its existing run and view when its ordinary gates permit it. This Nucleus owner mechanism preserves Tom's 2026-10-27 preserve-or-refuse decision: a default never silently replaces the reader. Both worker choices retain workspace, branch and PR; a fresh handover reviewer has its own view. Absent creation has no retained agent; either mode observes inventory and retries creation under the same run ID. Stalled workers and reviewers apply the same agent choice after the durable stop observes inactivity. An escalated agentless recovery is looked up by exact identity before `restart role=coordinator` releases its absent run and rearms recovery; ambiguous or incomplete lookup preserves it. Coordinator resolution retry does not support `fresh: true` and refuses it before changing state; use `route role=coordinator` with `now` to replace the coordinator agent.

A restart's `reason` is audit text. It records why the owner acted, in the settlement detail and the replacement route reason, and it never becomes the worker's instruction: only the `instruction` field (or the existing pending or neutral continuation) reaches `run.instruction`. A continuation with no review findings is told the action and the latest authenticated blocked result, and never that a review defect exists (Tom, 2026-10-23: a worker restart must preserve its own context without inventing review findings).

Ordinary worker restart requires a retained agent and workspace observed idle,
error or closed, with no active turn or permission request. The shared eligibility
check covers blocked workers with or without a PR, retained initial workers and
revisions. `next` names the fresh observation restart requires, even when saved activity
shows the worker active or otherwise not idle. A revision's `running` status
and unreleased lease alone do not prove an active turn. Owners and authenticated
coordinators use the same offer: execution proves current identity and inactivity
or refuses on the real activity, permission, identity or effect fence.
Ordinary retained-worker restart does not require a complete tool timeline;
unavailable history, gaps or interrupted tool entries do not override that fresh
runtime observation. Settlement of a separate superseded run keeps its existing
owned-tool and effect safeguards. A positively observed closed participant needs
no historical tools after the turn, permission and identity checks; uncertain
effects still refuse. The [terminal participant liveness contract](../contracts/orchestration.md#terminal-participant-liveness)
also governs workspace archive retry and earlier run-bound output cleanup.
After observation, the handler rechecks task version, run bindings, pause and
pending delivery effects before settling anything. A refusal preserves task,
run, credential and authorization state. Expected liveness refusals carry the
actual wait or supported choice through the existing control error and durable
operation diagnostic. A failed observation before any restart mutation is a
definite refusal, not an uncertain continuation delivery.

Every control Nucleus's own pre-send fence refuses settles its durable operation
as refused — `failed`, with an execution-authored `preSendReceipt` and a
`reconciled` effect — never as an `uncertain` effect, whatever the refusal's
own prose says (Queue #544, 2026-11-01: the durable-effect fence's "its delivery
is unknown" wording settled a refused `restart role=reviewer` as an unknown
delivery, and that stale uncertain control then fenced ordinary review through
the recovery-effect projection). The fence is a read-only store projection, so
the typed refusal is the proof nothing was bound or sent; only an effect whose
adapter call may have started stays uncertain. A failed pre-send control is not
a blocking recovery effect. A legacy refused-but-uncertain operation whose
diagnostic is one of Nucleus's own fence-refusal messages for a run the task
still names, and whose journal shows no pre-send boundary, no retry and no
bound delivery, relabels through `operation-status` with
`reconcilePreSendInputHash`; the reconcile changes only the label and never
re-runs the control.

Restart does not deliver urgent steering into a healthy active worker, even with
`fresh`. Wait for idle, or use `route now` to durably stop and replace the role on
the selected profile. Routing without `now` selects a subsequent run. Selecting
the same profile does not preserve the same reader. Genuine stalled-run recovery
still uses its targeted stop; absent creation still reconciles inventory before
creating anything.

Holds, dependencies, lanes, brief edits, cancellation and supersession keep
their existing actions for now. `set_dependencies` stays the pre-dispatch
dependency correction under one hard boundary: a queued review-entry task that
bound an existing external workspace at intake counts as before dispatch until
anything about it has run (task 401, 2026-10-24). The verb then changes only
the dependency list, the derived wait reason, the version and its audit event —
task and number, PR, exact head, workspace, source, brief approval, author
declaration and holds stay exact — and it applies while Nucleus is paused without
starting a run. A bound historical run of any role (released or superseded
included), an execution agent, a completion, checkpoint, merge intent, accepted
review or owner acceptance, an unfinished operation, a non-terminal hook
occurrence or an unknown delivery still refuses with nothing written, and an
ordinary worker-created workspace stays immutable.

`amend_brief` validates Nucleus-held documents with the existing parser and title
schema. When accepted frontmatter supplies a title, the task title is updated in
the same write as the new brief version, digest, text and any gate changes. A
body-only amendment preserves the current task title. A live worker or reviewer is
told of the amendment as a message queued behind its current step; an open
`nucleus_ask` is answered with the new brief and any linked board decision is
withdrawn. A refusal writes nothing;
earlier brief versions, task identity, PR, runs and review evidence stay intact.
Future notices use the task's current title. The accepted frontmatter's
`queue.proofExecution` becomes the task's operative declaration in that same
write, so an existing task reaches the `proof` verb by amendment alone
([Spec 055](055-source-immutable-proof-executor.md#amendment-binding-queue-407));
before any executor reservation a change or removal follows the accepted brief,
and once one exists a change or removal is refused whole, leaving an exact
body-only amendment as the supported route.

Round 4 (Tom, 2026-10-19). A verb refuses only to protect four invariants: exact-head review before merge, callback authentication, durable side effects, and task and PR identity. Anything else in its way is the verb's job; see the orchestration contract. Verbs apply while Nucleus is paused (Tom, 2026-10-19). Task state changes at once; dispatch of new agents waits for unpause, as it waits for a dispatch hold. A verb whose effect is itself an immediate delivery records it instead (`resolution.deferredVerb`, events `owner_verb_deferred` and `owner_verb_resumed`), and the engine applies it against the task's current version once Nucleus is unpaused and the task unheld. This covers the same-run re-creation of an uncertain run. A continuation on an already-bound reviewer proceeds during pause, while dispatch holds still fence it. A recorded verb that no longer applies by then is refused once (`deferred_verb_refused`) and never retried. The owner's own `stop` hold yields to the owner's next `restart` or `move`, which releases it; any other dispatch hold stands. While paused, a workerless review-entry `move to=review` remains offered because `next` does not inspect the forge. Applying it still verifies the PR head and refuses a changed head with the revision-worker route; same-head review follows the ordinary paused dispatch behavior. A `retry_effect` review publication is recorded and applied once Nucleus is unpaused, with every proof re-run then. A hold's `release` always applies, on a merged or terminal task too, so a hold left there never strands it (Project-c #089); placing or renewing a hold still applies only before the merge is requested. Every task control's outcome is recorded in the 30-day `verb_outcomes` table (action, `applied` or `refused`, source `owner` or `coordinator`, target or role, caller or coordinator run, refusal reason), never as a task event, so the applied and refused rate is measurable without touching task history. An owner control is recorded by the control path, once: its deferred replay records nothing more, and a replay of the same durable operation is keyed to it. A coordinator action is recorded once per report, keyed to the report, whichever path settles it: the binding, the verb or recovery's refusal of an accepted report. The telemetry view's Task controls section shows both rates for its window (capped at 30 days) and repository, the per-action split and the most frequent refusal reasons with identities and numbers masked; the round-4 target is coordinator refusals under 10%.

A retained author's authenticated blocked or error report can support an ordinary
owner restart or move to unfinished accepted-PR work, whether the result is on
the task or a released revision run. Nucleus checks the current author and exact
receipt and proves the retained PR and worktree source before binding its head.
A missing structured head is not recovered from report prose. This identity
binding grants no readiness, review or merge credit, and does not waive live
participant or unsettled-effect fences. A rejected post-PR checkpoint is not an
accepted report. The review-receipt check is skipped when `resolution.review` is
absent; a recorded review of any status needs only its settled evidence (its
released reviewer run carrying that review's own event), so a `blocked` or
`ready_to_merge` review at the older head does not fence the continuation. An
existing stuck task recovers with an ordinary `restart role=worker`.

## Delivery

1. Delete the retired declared-stage execution code and its five actions. (Delivered 2026-10-13: the execution, repair and five stage-control actions are gone; historical stage records stay readable.)
2. `next` and the shared verb registry, caller identity and `owner_control`
   events.
3. `route`. (Delivered 2026-10-13: `queue.task` action `route` takes `role`, `profileId`, optional `thinkingOptionId` and `now`, and a required `reason`; it records the profile on the existing `profileRequests` field in any unfinished phase, lifts a matching worker exclusion, honours an owner-routed reviewer on an author model with a recorded waiver, refuses a worker profile on the retained reviewer's model (worker selection always filters it, with no waiver; `next` never prefills it), refuses an unavailable group with its retry time and eligible alternatives, and with `now` durably stops and replaces the role's live run. `set_routing`, `reassign_roles`, `exclude_worker`, `coordinator` and `replace_retained_worker` stay callable but are superseded in the skill.)
4. `restart`. (Delivered 2026-10-14: `queue.task` action `restart` takes an optional `role`, optional `instruction`, optional `fresh` (default false) and a required `reason`; it derives the role from the phase, settles the fences it supersedes, and starts the next run through the existing internals — the same agent continuing, or a fresh agent on the role's current route. It covers blocked and errored pre-PR workers, missing revision callbacks, stalled turns (the durable `stop_stalled_turn` continues the run once inactivity is observed), checkpointed reviewers (same-agent and fresh), stopped reviewers, absent worker/reviewer/coordinator creations (restarted under the same run ID after a complete inventory), pre-dispatch admission parks and stopped coordinator resolutions. Before its run fence, a restart settles finished runs of other roles (recorded completion, agent observed idle), so a completed-but-unreleased recovery run no longer fences the reviewer continuation (#3569); the fences settle inside the action's transaction, so a refused restart changes nothing. `next` lists it for every stopped, stalled, idle, checkpointed, blocked or errored run. The narrow resume, replacement, checkpoint-continuation, absent-retry and stalled-stop controls stay callable but are superseded in the skill.)
5. `move` and `retry_effect`. (Delivered: the `queue.task` action `move` takes `to` — `work`, `review`, `merge` or `closeout` — and a required `reason`, with an optional `instruction` for `work`; `retry_effect` takes a required `reason`, an optional `effect` key from `next` (omitted acts only when exactly one effect is pending) and an optional `discard` for an occurrence held after checkout disposal. Both live in the verb registry: `next` lists one `move` view per target with the plain refusal for each that does not apply, and one `retry_effect` view per recorded failed or uncertain side effect under a stable `effect` key. A `move` acts on the phase and the actual runs, never on attention or recovery flags, and settles the fences it supersedes — the open incident, escalated recovery, reminders, carry and checkpoint intent — with history kept. `move work` returns the task to its author for a revision, or starts a fresh author on the worker route when the author is gone, superseding a stopped or checkpointed reviewer lease. `move review` supersedes accepted credit, answered episodes and a checkpointed reviewer, and re-pins the verified PR head. `move merge` requires a `ready_to_merge` review at the exact current PR head, re-verified at the forge; it enters the ordinary verification turn, so a clean advance of the integration base is not drift and no exact-base equality is checked. Qualified owner acceptance (2026-10-17, delivered): `move merge` also takes an explicit `qualification` — the task project's authorized owner (Spec 042 owner thread), the operator at the board, or a relayed operator ruling with its recorded note accepts the exact current head over an authentic released published verdict. Nucleus derives the task, PR, head and review identities, appends one durable `ownerAcceptances` record (actor, authority, reason, qualification, bound review and publication ids) beside the untouched verdict, and writes one `owner_acceptance` event; `next` shares the exact eligibility rule and offers `move merge` with `fill: [reason, qualification]`. The ordinary verification, pre-merge hook gates, `requiredMergeReview` and Nucleus's GitHub review-requirement gate read the acceptance where they read reviewer approval; required checks and hooks still refuse into the ordinary revision loop, merge holds stay real until their holder releases them, a changed head invalidates the acceptance for merge (history kept), and an ordinary caller, coordinator action or unattributed caller is refused with nothing written. Operator source acceptance (2026-10-20, Tom's "Approve" on lead 87115b71, Supervisor relay 59f8bd7e relayed by the Project-c owner 0b355fd4): the same call records `kind: "operator_source"` when no review evidence binds the current head — no verdict, an interrupted or unfinished reviewer, an unpublished verdict, or a head a docs-only conflict resolution moved after the verdict. The record binds actor, authority, ruling, head and qualification plus the concrete `missingEvidence` derived from the shared rule; `next` offers the verb with a note naming that evidence; the record binds no review identity, never rewrites an interrupted or changes-required review as PASS, and a ready current-head approval keeps the ordinary path with publication reconciliation as the supported route. A source change invalidates it like any acceptance; the same gates, refusals and authority proofs apply. `move closeout` requires the PR observed merged, records the external merge and enters ordinary closeout; it never mints a review. Since task 408 the same verb also reconciles a queued review-entry task that never dispatched, which has no reviewed head at all: the merged head and commit are observed at the forge, proved to descend from the intake and recorded heads, and recorded beside the unchanged recorded source head together with one explicit exact-final-head operator source acceptance (`qualification`, recorded as the existing `operator_source` disposition) that discloses the missing review evidence; without that acceptance the task stays held and untouched. `retry_effect` observes the remote or local resource first through the existing handlers — a found-done effect is bound, a proven-absent one (including a creation refused before send) is retried once, a still-running or unreadable populate waits, a partial unpublished leftover (Nucleus-owned dirty populate or Paseo locked-`initializing`) is preserved until `discard` on the same identity, an unlocked dirty slug-matched tree at another path is conflicting, and an unknown or conflicting outcome refuses with what was observed. An applied retry first settles the fences it obsoletes — the stale incident, escalated recovery, reminders, carry and checkpoint intent — with history kept; a refused retry changes nothing. A refused move changes nothing too: `work`, `review`, `merge` and `closeout` settle their fences and finished runs inside the move's own transaction (closeout inside the accepted merge), and `move review` settles a finished run of another role whose agent is idle before its run fence. Every applied call writes one `owner_control` event naming caller, target or effect key and phases.)
6. Task detail renders `next` with a button per applicable verb; the skill
   leads its blocked-task guidance with `next`.

`move to=review` was pulled forward on 2026-10-13 (Tom: "do whatever you need to do to get this completed and unblock the rest of the board") as the `queue.task` action `move`. It takes `to: "review"` and a reason, with optional `reviewer` and `prNumber`. A routed task's retained `resumePrNumber` is a known PR even when a blocked/error report cleared its URL and head: omit `prNumber`, or supply that same number. A different number cannot override retained identity. `next` reads stored eligibility; the handler still verifies current source, PR identity and participant inactivity. A proof-only qualification with a settled receipt and no recorded verdict reviews that receipt: `move to=review` needs no PR, starts a receipt reviewer at `queue.proofOnly.commit`, and spends no executor allowance. Terminal or merging tasks, missing PR identity (except that proof-only receipt path), live or unobservable participants, uncertain effects and failed source or version checks refuse without partial settlement. See the bounded 2026-10-19 ruling in the [orchestration contract](../contracts/orchestration.md). When a valid retained reader is already reviewing the same exact head, the move preserves and continues it instead of superseding it (Tom, 2026-10-27); the supersession below is the fresh path that applies when there is nothing continuable to preserve. It supersedes the prior review credit, keeping it as history, settles any answered incident or recovery with the original detail retained, and on an ordinary task re-pins the verified PR head and returns to `awaiting_review`. A worker-less review-entry task whose PR head moved refuses with a plain message naming `move to=work` to start the revision worker in the task workspace. Automatic reconciliation still in progress refuses.


When an external merge happened but no PR identity was bound to the task,
`next` offers `complete` after the planner's stop; its ordinary open-branch PR
lookup and participant checks still apply. The owner's reason can name the
external merge. When a PR is bound, `complete` stays unavailable and `next`
offers the existing `move to=closeout` route: the exact-head review or operator
source acceptance there remains required (planner ruling for #976, 2026-11-09).

A dispatched task can also have its canonical PR merged outside Nucleus at a descendant while its clean Nucleus-owned checkout remains at the recorded earlier source. The owner uses `move to=closeout` with `qualification` and the exact final `head`: Nucleus observes the same merged, ready PR and merge commit at the forge, checks the supplied acceptance against that observation, and proves the final head descends from the retained source without fetching, resetting or modifying that checkout. The authenticated durable move, canonical workspace and repository, participant inactivity, tool and effect fences, task and run bindings are rechecked before the transaction. That transaction records the merge and exact-final-head operator source acceptance separately from the unchanged recorded source and old reports, reviews and proofs, and settles the existing owner-control fences and the durable operation result atomically. The runner finishes that operation normally, or reconciles the committed result after interruption without repeating the move. Independent holds remain; the owner’s own stop hold settles with the move. Unknown or changed source, identity, ancestry, participants, delivery or effects refuse without settlement; the merge itself and an earlier acceptance are never final-head approval. The ordinary same-head external-merge and never-dispatched review-entry routes keep their own boundaries. `next` offers the dispatched closeout as `fill: ["reason"]` plus `qualifyingFill: ["qualification", "head"]`: a qualifying field set is all or none. The reason alone is the ordinary same-head closeout; the complete pair is the descendant acceptance. `next` never infers the head from the recorded source or a stale merge status. The operator board renders the pair as optional fields, keeps Apply blocked on a partial pair, omits empty optional fields from the call, and submits the operator board caller (`operator (board)`) with the fresh task version. The authority is the board operator or the task project's owner thread (or a relayed authorization note); the move applies only when every bound participant is idle, permission-free and tool-free at observation. Tom’s 2026-10-30 ruling scopes merge and closeout liveness to task-bound workers, reviewers and proof executors, including retained runs. Owners, coordinators and submitting callers do not enter merely through planning identity; an execution-bound agent remains checked. Task-owned pending and uncertain effects still fence independently. Refusals write nothing.

For a finished-turn shell entry, idle status alone does not settle it because the
shell may outlive its turn. Nucleus also requires a complete live-process scan:
the run's MCP ticket must be absent, and no live process may have its working
directory in the task workspace or descend from such a process. An unreadable
process list, identity, parent or working directory keeps the participant held.
Refusals name the observed tool and kind.

A queued review-entry task that never dispatched can have its own PR merged outside Nucleus before the first review run, at a published head that descends from the recorded source (task 408, 2026-10-24; Project-c #143's shape: recorded `38c71155`, zero EVER runs, both holds, the same PR merged from `aec5512a` as `b77a799f`). It is the same unrun fact the dependency correction reads, so the same `move to=closeout` reconciles it and no new control exists: the applied move reads that one boundary through the authenticated durable `task_control` invocation executing it (task 404's enclosing-operation identity), and a direct caller keeps the ordinary dispatched-task refusal. It observes the merge at the forge — canonical same-repository PR/branch/base identity, a positively merged PR, its actual merge commit and the bound external workspace clean on that exact merged head — and proves that merged head descends from both the immutable intake head and the task's latest recorded head, so a diverged, rewritten or unrelated source is never adopted and a caller-supplied `head` is never accepted as fact. Execution participant liveness is checked before and after the forge read; the unrun boundary has no execution participants. Planning owner and caller activity does not enter that check. The one guarded transaction (task version, runs, boundary and invocation re-proved inside it) then records the observed merged head and commit beside the unchanged recorded source head — never overwriting it, so intake and provenance stay readable — and records one exact-final-head `operator_source` acceptance under the shared eligibility rule, with the actor, authority, ruling, disclosed qualification and the concrete missing evidence: this task never dispatched, so no reviewer, review, verification or proof exists at that head. Ordinary synchronization and closeout follow; nothing is dispatched, and no author, reviewer, executor, native, review, verification or acceptance credit is inherited or invented. Without that acceptance the verb refuses and the task stays held exactly as it was, naming the precise exit; an older head's ruling, the merge status itself and a missing approval never become final-head acceptance. Both holds and their owners, pause, `reviewEntry`, planning and source provenance, the author declaration, branch, workspace and history stay exact, and a lost reply observes the same durable operation with one merge and one acceptance record. A historical run of any role, a competing, forged, settled or mutated operation, a dirty or moved workspace, a stale version, an unmerged PR, an inexact merge commit or a non-descendant head refuses with nothing written. Automatic external-merge detection keeps excluding `queued`: a sweep may observe a merge, but it may never invent the exact-final-head acceptance this route records. The recorded source head is that route's decision and stays it: when the closeout waits in `merging` for an earlier same-repository integration turn, the automatic external-merge recovery on later ticks re-records the merge and the phase only, and never copies `mergeHead` into `prHead`, so the distinct heads and the acceptance at the merged head survive every tick.

Step 5 folded this action into the verb registry and added the other targets and `retry_effect` on top of it; its behaviour and tests stand.

The superseded narrow actions were thin aliases of the verbs for one day and were
deleted on 2026-10-15 (see the phase 2 step 5 delivery note).

An uncertain continuation settles only from exact delivery evidence (see
[Spec 012](012-durable-asynchronous-operations.md#reviewer-pre-send-refusal-inspection));
the historical inspection was deleted on 2026-10-19. A brief amended after the
checkpoint is carried in the continuation and re-pins the run. An unreported
reviewer mode or thinking level is unknown, not changed; a reported, different
value still refuses.

A retained reader continues from either legitimate placement of its own task
checkout (task 496). Paseo registers a Nucleus-created checkout under the project
rooted at the canonical repository when it finds one, and a project rooted at
that exact checkout is the same retained workspace, so the same run, agent,
workspace, head, checkpoint and callback binding continue in place under both.
A root equal to a checkout is never authority by itself: the recorded
task/run/workspace/directory binding and the checkout's own canonical Git source
(repository common directory, task branch, exact reviewed head) are proved in
the delivery preflight and re-proved as the last awaited proof, after the
awaited exact-head proof and the reviewer identity refresh. That proof re-reads
the workspace descriptor after its own awaited Git reads and then re-asserts the
Git evidence synchronously, and the refreshed identity is re-asserted after it,
so no send rests on placement evidence gathered before an await or on a
descriptor that changed during the proof itself. An unrelated root, a workspace
or repository that does not match, a moved or absent workspace and a changed
branch or head refuse before send. No refusal sends, replaces the reader or spends credit; a
positive pre-send refusal stays history and an ordinary later authorization may
deliver one new occurrence.

## A checkpointed reviewer that cannot be continued

The retained-agent continuation is one supported path, not the only one. Two
established causes end it, and both recover through the existing fresh-review
verbs rather than a new control: the reviewer spent its checkpoint budget, or
its own agent was positively observed closed. Reconciliation records the closed
observation on the run (`retainedAgentClosedAt`) with the same agent, workspace,
head and checkpoint identity, and keeps the lease, the checkpoint records and
receipt, the callback credential and the eventual verdict exactly as they were.
It releases nothing and launches nothing: the run stays the fence, so no verdict
is lost and no reviewer is replaced by a read. A failed, ambiguous or relocated
observation, an active turn, a pending permission, or a merely idle or errored
agent records nothing.

`next` then reports the closed observation with its run, agent, checkpoint and
head, refuses the same-run continuation for both causes, and offers
`restart role=reviewer fresh` (a fresh reviewer on the role's route at the same
recorded head), with `route role=reviewer` with `now` as the other deliberate
replacement. A spent budget keeps its own recorded stop, and a held task
keeps its hold; neither is overwritten. Since Tom's 2026-10-27 ruling
("Preserve the reader for everyone", decision 029a631e) `move to=review`
preserves the reader it can continue rather than replacing it, so for these two
causes the move refuses and names the deliberate `restart role=reviewer fresh`
instead of silently starting a fresh reader; the read view and the applied
control are the same rule. The owner's chosen verb settles the closed run
through its ordinary transaction, so the recovery is one `owner_control` event
with no duplicate delivery, and the fresh reviewer owns its complete independent
reading and verdict.

## Worker replacement ceiling

Nucleus permits eight worker retirements automatically. This is a loop breaker:
automatic failover and ordinary owner replacement stop at the ceiling, and
`route role=worker now` cannot pass it. To replace the retained worker after
eight retirements, the operator must directly issue or relay `restart
role=worker fresh`. A relayed restart records its operator note and arms the
existing replacement path; the ordinary worker replacement guard still checks
failure, route approval and eligibility. The ceiling stays in force for
automatic retries after that one armed replacement is consumed, until the
operator explicitly relays another fresh restart.

An ordinary owner restart, coordinator action, route request or explanatory
prose does not pass the ceiling. A refused restart changes nothing. Task rows
written before schema 54 (task 989) carried `extraReplacements` history and an
`authorizationId` on a replacement arm; the store strips the retired list on
every open and the arm field stays parseable. Neither grants or spends a
replacement.

## Acceptance

- An owner control admitted at the version `next` showed survives an
  observation-only lifecycle write before or during its awaited checks: the
  action applies once with one durable result, the existing run and fence
  history stays readable, and a substantive task or run change, an unsettled
  delivery or an effect still refuses with nothing written
  ([Observation admission](#observation-admission)).

- On a task in each of `needs_attention`, `blocked`, `error`, checkpointed
  `reviewing`, stopped `working` and `changes_requested`, `next` lists at least
  one applicable verb and that verb resumes the task with no other control.
- `route` changes the worker, reviewer or coordinator profile of a dispatched
  task without replacing the task, and the next run of that role uses it.
- No verb is refused by a stale incident, recovery episode or settled
  publication record.
- An authenticated coordinator's permitted reviewer restart settles its own
  reporting run from the recorded result and continues the retained reviewer
  without an intermediate `cannot`, repeated owner call or reporting-turn cancel.
- A completed-but-unreleased recovery run observed idle (#3569), or a superseded
  participant with no completion positively observed inactive in its bound
  workspace, can settle with the permitted restart or move. The existing turn,
  permission, owned-tool and effect checks pass, history remains, no result is
  invented, and a superseded pending action is recorded not applied. The shared
  plan offers the required observation even when saved activity still reads live.
- A busy episode run is displaced only where the requested verb permits it,
  after full admission, durable cancellation and fresh rechecks. Unrelated live
  or permission-blocked participants are not released by a reviewer continuation;
  unobservable or conflicting identities and pending or unknown effects still
  refuse. Failed admission writes no cancellation or delivery intent, and an
  uncertain cancellation or delivery never authorizes a blind retry.
- An authenticated headed blocked/error report stays blocked history, never
  review credit. A workerless review-entry task with a changed PR head uses
  `move to=work` to start a revision worker in its task workspace.
- A workerless review-entry reviewer whose concrete declared external authors
  all differ from its model continues through the ordinary retained restart from
  an authenticated checkpoint: exactly one continuation to the same
  run/agent/workspace/head, with no initial worker, duplicate reader or verdict.
  A colliding declared external author, missing or opaque author evidence, a real
  Nucleus author whose current model is unrecorded, an unknown or drifted reviewer
  runtime and a later recorded contributor collision each send nothing
  ([Spec 017](017-external-pr-review-entry.md#independence-and-first-revision-worker)).
- Each verb writes one `owner_control` event naming its caller.
- The eight-retirement ceiling stops automatic replacement and ordinary owner
  replacement. `route role=worker now` cannot pass it. An operator-issued or
  operator-relayed `restart role=worker fresh` can arm one replacement; after
  it is consumed, automatic replacement stops again until another explicit
  operator relay. Retired `extraReplacements` rows are stripped on open
  ([Worker replacement ceiling](#worker-replacement-ceiling)).
- Qualified owner acceptance (2026-10-17): on a task whose released published
  verdict is `changes_required` at the current PR head, `next` offers `move
  merge` with a required qualification; the project owner's call records one
  durable acceptance beside the untouched verdict and the task proceeds through
  the ordinary verification, merge, sync and closeout gates with no new review
  round and no fabricated reviewer pass. Authority refusals (ordinary caller,
  relayed without note, unattributed), a stale or unpublished verdict, a run that
  cannot safely settle or be displaced, and a forge head mismatch change nothing; a merge hold keeps the task
  waiting until its holder releases it; failed checks and hook refusals still
  return the PR to its worker; and the outcome records the reviewer verdict and
  the acceptance side by side.
- Operator source acceptance (2026-10-20): on a task with no review evidence at
  the current PR head — no verdict, an interrupted reviewer, an unpublished
  verdict, or a head a docs-only resolution moved after a stale approval —
  `next` offers `move merge` with a note naming the missing evidence; the
  authorized operator's call records one `operator_source` acceptance binding
  the exact published head, actor, authority, ruling, qualification and missing
  evidence, and the task merges through the ordinary gates with no publication
  -only callback and no fabricated verdict. Source drift after the acceptance
  invalidates it while its history remains, a fresh disposition binds a new
  head, holds and required checks stay real, and the board and outcome show the
  accepted risk beside any reviewer history.
- Named head (2026-10-22, papercut 209406f4, Project-c #112): when GitHub's PR head
  has moved past the stored head with no no-review refresh, an owner acceptance
  may name it with `head` (a full SHA). Nucleus adopts that head atomically with
  the acceptance and an `owner_head_adopted` event, and derives the acceptance
  at the named head: an old-head verdict, ready or changes required, is history
  and never makes the acceptance unnecessary or reviewed. Unnamed, a moved
  head refuses and names the head to pass; a misnamed head, a fence, an
  authority refusal or a head that moves before commit adopts nothing. A
  reviewed merge never names a head.
- Cases that needed bespoke code on 2026-10-13 each take one owner call:
  - a pre-dispatch task parked by admission, including review entry, whatever its attention flag says (#325);
  - a run whose creation is uncertain, with no agent or credential, restarted under the same run after a complete inventory (#151 run e9b1bd33);
  - a top-tier author continuing (#311).
- Transient admission conditions (origin author busy, capacity, route unavailable) wait instead of parking.
- Coordinators run only for stops they can act on (lean audit, 2026-10-15). A hold (`held`), Nucleus's own lifecycle step (`lifecycle`: integration turn, required checks, merge-outcome probe) and a read-only GitHub or git probe failing with a forge 5xx, truncated response or fetch race (`external_unavailable`) are waits: no coordinator run, no attention notice, no park. `waiting()` never yields `operator_needed` unless the task already carries a fault. A mutating call (merge, push, any non-GET `gh api`) is never treated as transient.
- Stops are typed at the source (lean audit, 2026-10-15). Every Nucleus `waiting()` and engine `note()` call names its stop reason, and `attention()` and `ensureIncident()` accept an explicit incident cause (stall and missing-callback paths pass theirs). Text classification remains only for text Nucleus did not author: exception and agent error messages, GitHub merge-gate text, and a restored earlier reason. The fallback incident classifier checks a stall before missing-callback words.
- `move to=review`, the stop-backed resume and the recovery bound (Tom,
  2026-10-27, decision 029a631e; the systemic repair was authorized in decision
  0971795e after a third of weekly usage was lost to reviewer churn):
  - a valid retained reader at the exact current head is preserved and
    continued by an owner's or a coordinator's `move to=review`; an awaiting
    checkpoint delegates the ordinary retained-restart admission and delivery on
    the same run, reading and already-delivered turns send no new message, an
    unsettled delivery refuses inspect-only, and a spent budget or closed agent
    is explicit rather than silently replaced;
  - an original delivered continuation stopped by the owner resumes exactly once
    on the same reader through `restart role=reviewer`; a replay sends nothing,
    the original receipt and checkpoint stay byte-authentic, and no uncertain
    cancellation, displacement stop, foreign identity or moved head authorizes a
    send;
  - three coordinator launches that move no work still stop the loop, and no
    routine retained restart, route change or bookkeeping success refills it;
    a launch recorded while the task's host or worker subscription group is
    unavailable is not charged, and does not reset earlier charged launches;
    only progress against the measured work — a higher cross-reader checkpoint
    maximum at the same head, a new head, changed instructions or a merge — does.
    A launch from before the work identity existed stays charged while a
    replacement reader's lower or equal checkpoint leaves that maximum unchanged,
    and undatable checkpoint history is never read as progress. Only the owner's one
    explicit `restart role=coordinator` re-arms, and only for an episode the bound
    itself stopped (escalated, at the limit, nothing parked to replay); it records
    one ordinary event inside that successful transition, so a maximal reason or a
    lost audit write cannot lose it. A coordinator report through the same shared
    plan never re-arms its own allowance, the current worker or reviewer run is
    never excluded from the restart's settlement fence, and a retained run's
    refusal or an unresolved delivery or effect keeps its ownership and rolls the
    settlement back. The counted launches, work basis and exhausted
    stop stay readable through `next` and task detail, with room reserved for that
    note under a maximal hold or control reason; no numeric setting, parallel
    ledger or per-checkpoint cap is added.
- An accepted owner stop is a visible held wait before any run settles (Queue #396, papercut 755cf03a; longhorn #054 / task 2af901a8, 2026-10-20). The producer record was already true — `owner_stop_intent` and `owner_stop_sent` around each turn actually cancelled, one `hold` write, and one `owner_stopped` line naming its targeted run IDs and cancellations, with nothing written when cancellation is unknown — and the derived reads already derived the stop from the fence. The stop now records the held stop (`held`, `Dispatch held; release to continue`) in the same control quantum as its fence. The phase and run state stay as they are: the run remains unreleased with no result, and `next` reports an owner-stopped initial worker as `stopped` after its idle observation rather than `running`. The matching audit plus idle observation offers `restart`; under the hold it records the instruction without delivery, and `release` delivers once on the retained authenticated thread. An idle worker without a matching owner stop does not get this shape. Reviewer and revision paths use the same stop identity, hold ordering and retained-run delivery. Reconciliation starts the completion-delivery grace as before, but while a dispatch fence stands it records only `idleSince`; it no longer overwrites the held reason or record. Fixtures cover restart under hold and one delivery after release, plus the no-owner-stop refusal.
- An owner stop ends with the task (Tom, 2026-10-26: "It keeps happening!" — #456 and Effigy #377 merged past their stop and stayed unarchived). Since Queue #531 the stop's dispatch hold also fences Nucleus's own merge intent, so a stopped task no longer merges through Nucleus's merge path; a merge requested before the stop, or one another actor makes at the forge, still lands, and once the task is `done`, the archive pass releases a dispatch hold whose reason begins `Owner stop:`, records `hold_released`, and archives the workspace. Any other dispatch hold on a finished task is a deliberate preservation and still keeps the workspace.
- A stop is a stop at the merge boundary (Queue #531, effigy#524 / task 5766f0ad, 2026-11-01). The owner stopped a task in `merging`; the stop placed its dispatch hold, and the next pass read the merge gate and recorded `merge_intent` anyway because the last fence before the request looked only at merge holds, so GitHub merged PR #660 seventeen seconds after the stop. One general rule replaces the kind-specific check: any hold fences merge intent. The pre-intent fence re-reads the task after every await in the gate; `claimIntegrationTurn` keeps any held, unmerged task out of the repository's integration turn and `integrationActive` does not count it, so a stopped task never stalls every later merge in its repository while the owner decides; and the wait names the fence's own kind — the merge wording for a merge hold, the dispatch wording for an owner stop. A merge already requested is unknown-delivery territory and behaves as it did: `merge_intent` stands, the ordinary uncertain-merge reconciliation runs, and the stop result says plainly that the merge was already requested at that head and may still land — in the held stop and in the hold's own reason — instead of implying that the stop cancelled it. Fixtures cover a stop placed from inside the merge-gate read (no intent, no adapter merge call, the held wait), a task stopped in `merging` before a pass (held, no turn claimed, no merge), and a stop that lands while the merge request is being sent (intent kept, and the disclosure recorded in the stop result and in the `owner_stopped` line's `mergeAlreadyRequested`).
- A `held` stop belongs to the hold fences (queue #371, 2026-10-19). The write that removes the last fence, by any release path, also retires the `held` stop record, and a queued task's hold text returns to its dispatch wait, so `next`, task detail and the board badge are true at once, paused or terminal, with no later quantum. Releasing one of two fences leaves the other fence and the `held` stop as they were. A stored `held` record with no fence left (a row released before this rule) is history: every read skips it and shows the next stop in precedence (incident, recovery, attention, run, prerequisite or dispatch wait), never a hold, and never rewrites the row. A legacy row whose `held` flag projects a fence keeps its hold.
- A coordinator may report `retry_effect` (optional `effect` key) besides `restart`, `route`, `move` and `cannot`. A refused action names the stop reason and the `next` refusals for that verb. Within the charged launch bound, the coordinator gets one more choice with that refusal and a fresh `next` verb snapshot; a second refusal or an exhausted bound reaches the project planner through the existing ladder. A parked restart ignores its own authenticated reporting run while settling the step. The retired `recoveryAction` and `replacementAgentId` fields are refused when the report arrives, so the same run can correct its report; the MCP report catalog no longer offers them, and stored records stay readable.
- A checkpointed reviewer whose agent is positively observed closed is reconciled in place: the terminal observation, not the lease, is recorded; `next` names the run, agent, checkpoint and exact head, refuses the same-run continuation, and offers `restart role=reviewer fresh` as the deliberate replacement while `move to=review` refuses and names that exit (it preserves the reader it can continue). A spent checkpoint budget behaves the same way and keeps its own stop, a held task keeps its hold, unavailable, ambiguous, live, permission-pending, idle or relocated observations write nothing, a late authenticated verdict still advances the task, and the owner's one recovery call settles the run with no continuation delivery and no invented verdict.
- An owner continuation discloses recorded run-bound build output cleanup (Queue #395, 2026-10-24). The failure it closes: a continuation reused a checkout whose earlier run's output a run-bound cleanup had already settled, and a later proof gate could mistake that earlier build, cache or test result for present output. An available `move to=work` or `restart` now carries a bounded note, the task detail shows the full bounded paragraph, and a replacement or retained-workspace worker's dispatch prompt carries it ahead of the sentence that tells it to preserve and resume existing work, quoting the task's recorded cleanup records with the run and workspace each belongs to. The note and paragraph read the record's own detail rather than its state: a recorded removal, retained `node_modules`, a symlink left in place with its target untouched, a skipped or uncertain root, and a run with no record are each stated as themselves, and `complete` is Nucleus's own cleanup obligation, not proof that anything was deleted, that a runtime or container exited, or that output is present now. Another workspace's record is told apart from the checkout being resumed and an omitted record is counted. The note is additive: the verb set, availability, prefilled args, the stop, the holds, custody and source instructions are unchanged, and nothing is rebuilt, reseeded, refunded, replayed or exempted. Published proof remains history; a fresh proof still needs its current identity and authorisation. See the orchestration contract's run-bound build output disclosure.
- No new check treats a clean integration-base advance as drift (PR #440).

## Phase 2: one model underneath the verbs

Approved by Tom on 2026-10-14 ("Go for it"). Phase 1 added the verbs over the old internals, so the old guards still refused underneath them. Phase 2 removes that layer:

1. **`complete`.** An owner finishes a task that has no PR to merge (report-only or no-code), with a reason and an optional artifact. It's refused only by a live run, an open unmerged PR, or merge intent. It supersedes `complete_report_only`'s brief-heading proof. (Delivered 2026-10-14: `queue.task` action `complete` is in the verb registry, `next` lists it when it applies, and it runs the one completion path with the alias. `complete_report_only` keeps its input shape and its owner-thread check, then calls `complete`. The outcome's `reportAcceptance` carries `kind: owner_completed`; `artifact` is optional. Worktree and planning-base checks, callback-receipt gating and the brief-history proof no longer refuse a completion; a stored `prUrl` or `prHead` refuses it, and so does a task that never dispatched. A pending accepted recovery action is recorded as refused in the shared settlement, so no verb can run a stale retry.)
2. **Observed liveness and one settlement.** Verbs decide liveness by observing the agent (idle, no active turn, no permission, same workspace), never from stored `active` or `idleSince` flags. One shared settlement clears every stale episode record a verb supersedes: attention, incident, recovery and its pending action (recorded as not applied, except a matching coordinator owner verb is recorded applied), reminders, mechanical and answered carries, checkpoint holds, `externalMergePreAttention` and finished runs of any role. It runs in the same transaction as the action. A worker route applies to the next revision. (Delivered 2026-10-14: the shared settlement retires the stale external-merge record and a pending legacy recovery action as not applied, `restart` and `move` decide a run's liveness by observing its agent, a worker route that differs from the retained profile makes the next revision a fresh agent on that profile in the same workspace, branch and PR, and a routed different-model profile replaces the retained worker once. End-of-task cleanup and `retry_effect` on a finished task apply the same observed-liveness settlement: a run whose agent is positively observed idle with no turn or permission is released with its history kept, and a never-reporting recovery run it owned closes the episode, so a lost run lease cannot hold a done task's workspace archive. Queue #339 generalizes the never-reporting branch to any task through the shared reconciler and owner-verb settlement: a run the callback binding proves superseded, freshly observed idle with the owned-tool and effect safeguards passing, releases once with its history kept, while a current result-pending run, a live or permission-blocked agent, and an ambiguous or uncertain effect stay held.)
3. **One reconciler.** (Delivered 2026-10-14: every task quantum advances ordinary task results before it reconciles coordinator state; an open recovery run no longer returns early and strands an accepted reviewer verdict. The current stop is a durable `{reason, detail, since, suggestedVerbs}` record using the Spec 050 reason enum, and `task.next` plus the board show it. Repeated observations of the same stop retain `since`; a lifecycle change clears the record. Transient origin, capacity, provider, route, workspace, prerequisite, PR-head and live-or-unverified worktree validation conditions wait with their reason and no owner verb, then ordinary admission or resolution clears the wait when it proceeds. Recovery rechecks such a wait itself only on a task that needs attention and is not owned by exhaustion failover. An exhausted worker with no replacement waits on the provider only when an unavailable group alone blocks it; otherwise it stops `route_unavailable` with `restart` and `route`. A task needing attention with no typed stop records `operator_needed`: Nucleus never reads a wait out of an agent's report text (2026-10-16). Stall detection records `run_stalled`. A coordinator can return one typed `coordinatorAction` (`restart`, `route`, `move` or `cannot`) for the current stop; Nucleus checks and applies verbs through the shared owner-verb registry, records the outcome, and does not start another run for that same stop. A stale coordinator report cannot block or overwrite an accepted result. The existing incident and recovery records remain readable. Legacy `recoveryAction` reports are refused at intake; stored ones stay readable history, and since 2026-10-16 nothing reads them for a decision (the old `retry` merge-evidence path is deleted) or writes them into a binding.)
4. **Delete the old machinery.** Incident and episode bookkeeping, reconcile-and-continue (Spec 049), answered carry, mechanical carry, superseded-incident closure, legacy checkpoint continuation, and their tests. (Delivered 2026-10-14: `server/reconcile-continue.ts`, `shared/reconcile-continue.ts`, `server/mechanical-review-carry.ts` and the legacy checkpoint-proof machinery in `core/review/review-continuation.ts` are deleted with their tests; the `Recovery` pass keeps only what the reconciler uses — coordinator-dispatch routing, observed settlement of finished recovery runs, the typed coordinatorAction handler, and escalations — and a pending accepted report without a coordinator owner verb is recorded as not applied. `assess_recovery`, `apply_recovery`, `preserve_mechanical_review`, `close_superseded_reviewer_incident`, the answered-carry tuple, the mechanical carry and its reviewer-input receipt prompts are gone; author escalation no longer waits on stale incident or recovery-episode records. Historical incidents, recovery episodes, carries, proofs and checkpoint records stay readable, and the store keeps their columns. Specs 014, 039 (partly), 044, 047, 048 and 049 moved to `specs/retired/` with `retired.toml` rules.)
5. **Remove the narrow actions.** The superseded `queue.task` actions become aliases of the verbs for one release, then go. Northstar is warned first. The skill and orchestration contract are rewritten around the verbs. (Delivered 2026-10-14: every superseded narrow action is a thin alias that reaches its verb, records one `owner_control` event naming the verb with the deprecated action beside it, and returns a deprecation note; `skills/northstar-queue/SKILL.md` and the orchestration contract's task-control rules are rewritten around `next` and the verbs. No action was removed in this step: every remaining narrow action either maps to a verb or keeps its own action because no verb expresses it, so nothing met the `no verb equivalent and no remaining use` condition. The alias window is one release; full removal follows after Northstar is warned.) Deleted 2026-10-15 on Tom's instruction ("delete the aliases now"), with Northstar warned first and no alias call recorded since step 5. The 20 superseded actions, their dispatch branches, the engine methods only they reached, their input fields, the deprecation notes and the alias table are gone. Two alias handlers no verb reached became `retry_effect` effects (`workspace_archive.<id>` for a rebind-displaced workspace before any intent, `adoption_handover`); the latter was deleted 2026-11-06 with worker adoption. `set_routing` and `exclude_worker` stay as kept controls. Later on 2026-10-15 (Tom: "go with your recommendation") four focused verbs folded into the owner verbs: `resume_worker` and `retry_validation` into `restart`, `revise` into `move to=work` and `rereview` into `move to=review`. `move to=work` without an `instruction` keeps the pending instruction or the review findings; `move to=review` preflights a requested reviewer profile; `restart role=worker` re-arms a pre-PR continuation parked behind a released prerequisite wait; `move to=work` and the worker `restart` shapes refuse an open prerequisite wait and clear a released one; `restart` replays validation for a settled pre-dispatch task in any parked phase with only released recovery history; and the owner-revision `move to=review` settles an inert pending recovery scaffold and any stale incident instead of refusing them. Historical-reviewer reuse (`retainedReviewerRunId`), the stopped-reviewer `revise` shape (`stoppedReviewerRunId`), inert-scaffold reconciliation (`reconcileInertRecovery`) and the held owner-revision reopen went with them. `retry_resolution`, `continue_review` and `resolve_escalation` stay. The named-agent `coordinator` action was deleted 2026-11-06 (Tom, map D30); `route role=coordinator` assigns.

## Recovering a disposition workspace step

A cancel or supersede disposition that stopped at its workspace proof or archive
is listed by `next` as `disposition_workspace.<workspaceId>`, with the recorded
occurrence's own result and, for supersession, the policy the fence records. The
`retry_effect` view carries a note naming the safe policy option when the
recorded one is `retained_by_replacement`. The effect identity is derived by the
store: only the task's own workspace, only while the disposition is still at
`needs_attention`, and only while the last recorded `workspace_proof` or
`archive_workspace` occurrence is uncertain. Thread stops, PR closes and hook
emissions never reopen this way. Beyond the workspace step, a parked fence's
own exits are `next` views too (Spec 003, nucleus#1000): `withdraw_cancel`
wherever the shared withdrawal rule allows it, and a same-kind re-run that
re-drives the parked step — a PR close or hook hold included — under the
recorded fence.

Calling it with a fresh task version and a reason reopens that one step and
re-runs it. The original supersession or cancellation is untouched history: kind,
replacement task link, reason, the requested `workDisposition` and every
previously recorded effect intent and result stay exactly as recorded. A step
already settled is read, never repeated — a thread whose `archive_thread` has a
definite result is not archived or released again, an already-emitted
cancellation hook is not re-emitted, and an unknown archive is observed before
any new archive request. The proof is re-run immediately before the effect, so
returned evidence is required for every retry; the disposition's normal
cancellation-hook and terminal-transition steps follow.

When the recorded `retained_by_replacement` proof cannot be produced at all — its
recorded replacement workspace was retired after that replacement merged — the
same call may add `workDisposition: "archive_if_empty"`. That is the existing safe
proof, not a new one: the clean queue branch, every local commit published on the
canonical origin (or an already supported exact PR head proof), ownership,
idle-thread inventory and retention gates still decide, so dirty, local-only,
unknown and foreign work stays preserved exactly as with any archive-if-empty
cancellation. The selection is one attributed transition appended to the
disposition's `proofPolicies` (selected policy, previous policy, time, the owner
identity, whether it was the board, the project owner thread or a relayed note
with its authorization note, and the reason) and recorded before the proof runs;
the original `workDisposition` is not overwritten and no retention claim about the
replacement is invented. Selecting it needs the same owner authority as other
later cleanup authorizations (board, project owner thread, or `relayed` with the
operator's `note`); a caller with none, a non-safe policy, a stale version, a
mismatched effect key, or a changed policy on the already-reopened step refuses
with nothing written. A replay after a lost reply keeps the first recorded
transition and writes nothing more; a recorded `task_control` operation whose
disposition already completed is answered by that settled task instead of
re-running the step; and an interrupted reopen leaves the fence in `preserving`
with its effects intact so the ordinary restart pass finishes the same step. No
worker, reviewer, coordinator, verifier, merge or task recreation is launched,
and the task's holds stay as they are.



`retry_effect` also lists `workspace_archive.<id>` for a completed cancelled task
whose Nucleus-owned workspace remains preserved. Calling it is a new cleanup
authorization from the project owner, board operator, or attributed relay
(`relayed: true`, `note` recording the operator authorization). It preserves the
original disposition and terminal result. The source, participant, hold, retention,
unknown-delivery and runtime proofs are owned by the
[terminal cleanup contract](../contracts/orchestration.md#terminal-workspace-cleanup).
An uncertain `task_control` operation for `retry_effect` remains a blocking
effect with its operation id and diagnostic in `next`. Retrying that operation
re-runs its named effect through the ordinary observer, or settles the old
operation when that effect is no longer pending. A later `move` or `restart`
settles the stale operation as superseded and records the owner control that
replaced it. Merge and closeout waits name the blocking operation or participant
and the reason, so a held integration turn always has an ordinary owner exit.

Only a blocking uncertainty gates a phase (nucleus#1159). An uncertain operation
whose host effect later evidence has answered — a workspace binding recorded
after the control was accepted, then a run used in that workspace — is delivered
with that evidence recorded, so it gates no review or merge and never needs a
human step. `retry_effect effect=operation.<id>` applies the same observation and
settles it without force; an operation nothing answers keeps its fence and
refuses with what is still unknown, never by resending it. A review phase
blocked on an uncertain effect past its bound (ten minutes, `blockedEffectAttentionMs`)
is attention, not a quiet wait: its stop names the blocking set, suggests
`retry_effect`, and the ordinary attention notice reaches the owner. The phase
itself is kept, so the answer resumes the same review rather than parking it.
Uncertain delivery observes the same intent. Only a positive present-workspace
observation permits another guarded call with fresh proofs and the same native
idempotency identity. Adapter refusals before the final archive boundary stay
held and can be retried after repair through the same verb. A task branch
missing from origin, or behind HEAD, does not hold the retry when a live
canonical-origin branch contains the exact HEAD; the disposition and adapter
proofs share that rule ([published source](../contracts/orchestration.md#published-source)).
No caller-supplied head or workspace proof tuple is accepted.

Every lifecycle refusal or wait that uses the shared recovery-effect projection
names the full blocking set in stable projection order, including each kind,
identity, state and diagnostic. `next` exposes the same effect identities as
`retry_effect` entries. Run delivery, reviewer delivery and continuation, and
attention-notice retries observe the recorded recipient timeline and never
resend on an absent or incomplete timeline; merge responses re-read the forge,
and held, refused or lost project validation returns through the existing operator retry
path. Retry is offered only when the current-head validation is held, refused,
or a running validation is proven lost; a settled result for an older PR head is
superseded and is not offered. The ordinary reviewer refusal names an ordinary review, while the
review-entry prefix is reserved for review-entry tasks. A blocking effect wait
does not create a recovery episode while this owner retry can re-prove it.

A structured owner content discard (`discard: true` with the ordinary `reason`
and owner authority) also applies here (2026-10-25, actual case: Supervisor
c5403fa7 relayed Tom's "Discard it" for a cancelled superseded donor). Nucleus
records the same durable decision bound to the exact task, workspace and
directory before any retirement effect, and the retirement preflight and adapter
waive only the clean-head and publication proofs; ownership, identity, PR,
participant, hold, retention and runtime proofs still run. A dirty workspace is
preserved without it, and an older retirement authorization or prose in the
reason or a note never stands in for the structured record. The cancelled phase,
original preserve disposition, reports and terminal result stay unchanged, and
unknown delivery observes the same record rather than granting a new one.


## Publication failure and held author return

`next` names an unpublished review's actual verdict, including `changes_required`.
`retry_effect review_publication.<runId>` reconciles that original authenticated
verdict using the exact-byte rules in [Spec 033](033-formal-pr-reviews.md). A failed
observation or mismatching body preserves the stop and recovery evidence; only a
successful reconciliation clears attention and retains the keyed publication
receipt even when a recovery adapter returns the remote ID without persisting it.
Re-applying an authenticated stored verdict completes its idempotent publication
before binding it when no publication record exists, and a successful owner retry
wakes the parked review lifecycle. Dispatch hold, pause and other unreleased runs fence publication. The authenticated reporting run is excluded from its own publication retry.
Since 2026-10-20 the publication-only continuation is not the only exit: an
authorized operator may instead record an explicit operator source acceptance
of the exact current head through `move to=merge`, which works with the verdict
still unpublished and never rewrites it (see the orchestration contract).

`move to=work` remains available for an owner-chosen revision under the shared
settlement principles above. A recorded reporting result can settle its own
coordinator run; other finished or superseded participants require positive fresh
matching inactivity, without inventing a completion. A busy episode run is
settled only through the move's permitted displacement after full admission,
durable cancellation and fresh rechecks. Unrelated participants retain the
applicable activity, permission, identity, tool and effect protections; unknown
delivery or an unreadable participant never proves inactivity. Settlement and
revision intent commit together after task-version, run-identity and effect
checks. The dispatch hold remains, and the author receives no native message
until a separate holder release. With no explicit instruction, pending author
instructions or the original unpublished changes-required findings are retained.
The original callback and publication intent are history, never approval, and
superseded recovery summaries/actions remain observable.

The same stored reviewer result cannot repeatedly clear a publication stop as a
late completion. Missing-result stops still accept genuine late callbacks, while
the existing incident/stop and recovery outcome bound repeated wakes and restart.
An explicit owner control re-evaluates through ordinary fences; Nucleus never
chooses an author return from a publication mismatch.


### Source approved while awaiting proof

An authenticated source approval at the exact head parks as `awaiting_proof`, with
one owner notice and no author retry or coordinator. The existing `proof` verb
may activate the brief's declared executor once at that exact head; a failed proof
followed by an authenticated author revision and retained-reviewer source approval
at a new head earns one new execution there. A repeated attempt at either used
head refuses, and every earlier run and receipt stays intact. All owner, allowance,
source, hold and admission gates remain in force. Settlement resumes independent
proof judgment as defined by [Spec 057](057-retained-change-review.md); it grants
no review credit by itself.

An operator source acceptance of that exact head (`move to=merge` with a
qualification) ends the wait: the recorded acceptance stands in for the named
proofs and the task enters ordinary verification. This covers a proof that can
only exist after the merge it would gate (Queue #520, 2026-11-01). The reviewer's
recorded approval and proof list stay as reported.


A same-head owner restart may retain an independent, idle reader whose earlier run
was positively stopped and superseded, even though that run has no completed
verdict. An unfinished same-head restart does not spend a retained revision round
or force a fresh reader at the revision-round cap. This is distinct from advancing a completed review to a new head under
[Spec 057](057-retained-change-review.md); it preserves the checkpoint, source,
delivery and custody fences rather than manufacturing a verdict for the old run.

### Report-only delivery

A brief opts in with `queue.reportOnly: true` and may name `queue.reportLane`.
The worker returns `report_ready` with the latest exact Nucleus lane document
reference. Nucleus releases the run and parks the task in `report_ready`; this is
not a blocker and invokes no blocked hook, reviewer consult, recovery coordinator
or escalation. The project planner, or Nucleus planner when absent, receives the
report and accepts it with `complete` and the artifact, or returns it with
`move to=work` and an instruction. A task without the opt-in cannot use this
result status. `complete` accepts only that task's exact delivered artifact;
it verifies the stored version and digest against the lane document text, while
later versions on the shared lane do not invalidate the delivery.

Nucleus reads those fields from an already-held brief with the draft schema, the
same reader lead check uses, so a lead-promoted body (approval in provenance,
not `queue_approval`) is honoured. Direct brief submission still requires
`queue_approval`. A lead whose report-only fields cannot be delivered (no
attached lane, or a `reportLane` that will not be on the task) fails
`lead.check` rather than dispatching.
