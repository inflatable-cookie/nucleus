# 043 — Declared review stages

Status: retired (Tom, 2026-10-06); kept as the historical evidence contract
Owner: Queue runtime maintainers
Created: 2026-10-04
Decision owner: Tom ("Approved 043. Continue", 2026-10-04, relayed by the Project-a Chatterbox)
Source: lead 9b13212f (Project-a). Governing refs: [Spec 033](../033-formal-pr-reviews.md) (review identity),
[Spec 036](../036-role-reassignment.md) (independence), [Spec 037](037-structured-review-verdicts.md)
(verdicts, immutable history), [Spec 039](039-operator-rereview.md) (exact-head re-review),
[Spec 040](../040-merge-hold-release-prompts.md) (holds), orchestration contract (slots,
durable operations). Queue's contract 008 export and contract 009 shadow-stream
producer are retired ([Spec 029](029-portable-records.md), [Spec 034](034-shadow-run-stream.md));
the contracts themselves remain Nucleus's current ones.

## Retirement

Tom ordered removal after repeated review churn on 2026-10-06. This supersedes
the execution and recovery rules below. `queue.stages` no longer admits or
schedules work. The ordinary worker → independent exact-head completion review
→ merge → archive path replaces it. Stage operator controls refuse without
side effects. Historical declarations and stored reports remain readable and
immutable; they never silently qualify an intermediate review for merge.

No unfinished staged task remains: all 27 were done by 2026-10-16, when the
runtime parking guard and the step-removing `amend_brief` path were deleted
(audit round 3). Intake still refuses a declaration at submission, amendment,
lead check and review entry, and task creation itself refuses a staged brief,
so no intake path can create one; a replay of a stored historical submission
still returns its task. Tasks are never exported, so only a pre-2026-10-13
backup restore could bring back an unfinished staged task; that restore is
outside this contract. Completed signing is not replayed. No export or shadow
output carries stage data; the removed Queue fixtures for contracts 008/009
pinned that omission.
Old local journals remain readable and unchanged. The detailed model below
describes historical records only.

### Execution code removed (2026-10-13)

Spec 050 step 1 deleted the retired execution and repair code: stage dispatch,
advancement, invalidation, publication recovery, merge-only-revision recovery
and legacy verification in `core/resolution.ts`, `core/engine.ts` and
`server/stages.ts`, the five stage-control actions, and the stage gates and
prompts that only served them. Historical stage data is unchanged: task, run
and outcome records still parse, appear in detail and outcomes, and travel in
backups. A new submission that declares
`queue.stages` is still refused, as is an amendment that adds one.

## Current retirement ruling and fixture boundary

Tom's 2026-10-06 ruling retires declared-stage execution and recovery after
repeated review churn. Its scope is bounded: new `queue.stages` declarations
refuse (the parking of unfinished declared tasks ended on 2026-10-16 with the
last of them); the ordinary worker, independent exact-head completion review, merge and archive
path then applies. Existing stage records, callbacks, verdicts and reports
remain readable and immutable. They do not dispatch work, replay signing,
authorize an intermediate review to merge, or create a control exception.
Queue remains paused and dispatch holds remain intact. This ruling retires
the execution and recovery assertions below; it does not retire ordinary
callback authentication, reviewer independence, pass gates, signed-artifact
checks, merge checks, or read-only inspection of authentic historical proof.

## Retired fixture migration map

The fixture dispositions below were audited by exact test title before any
fixture was removed. `E` means the assertion requires a declared stage to
dispatch or advance and is replaced by the retirement park/no-run tests.
`C` means the assertion requires a stage control or recovery to act and is
replaced by the no-write refusal test for all five controls. `I` means it
asserts staged input/output invalidation or preservation; that staged
transition is retired, while input, callback, artifact and history evidence
that remains meaningful is retained in the read-only history/proof tests
listed below. `O` means its cross-cutting ordinary wait, hold, identity or
review safety remains covered by the ordinary suites named below. `P` means a
disposable fixture replays a historical stage chain as executable work; that
replay is retired, while the immutable snapshot and read-only classifier tests
remain.

The current replacement coverage is `historical steps never dispatch, recover,
or regain stage-control authority`, `a parked declared-stage task never merges
without an ordinary exit`, and the owner-conversion tests in
`test/retired-steps.test.ts`. Ordinary
independence and review-gate behavior remains in `test/review-independence.test.ts`
and `test/review-verdicts.test.ts`; dispatch-hold behavior remains in
`test/review-continuation.cases.ts`; generic callback and task/run identity
coverage remains in the ordinary callback and review-entry tests. On
2026-10-13 (Spec 050 step 1) the execution code and the test files named below
were deleted; this map is the historical audit of that disposition.
Historical-declaration schema coverage remains in
`test/declared-review-stages.test.ts` and the compiled-identity and
fixture-integrity cases in `test/declared-stage-identity.test.ts`.

### `test/stage-engine.test.ts` (deleted 2026-10-13)

Each title below is an obsolete staged-execution or staged-control case; its
single-letter disposition above accounts for its assertion.

| Case | Disposition |
| --- | --- |
| `Spec 043 dispatches the declared stage roles on the exact candidate` | E |
| `Spec 043 an intermediate ready_to_merge advances exactly one stage and never merges` | E |
| `Spec 043 digest reconciliation restores an accepted terminal review and enters verification without re-review` | C |
| `Spec 043 restore_stages restores an accepted terminal review and enters verification without re-review` | C |
| `Spec 043 dispatchStage heals a task parked past an advanced terminal review` | E |
| `Spec 043 refuses terminal review restoration when its accepted head differs from task.prHead` | C |
| `set_prerequisite_wait during a live declared stage blocks the next stage dispatch` | O |
| `Spec 040/043 dispatch hold drains a live stage callback and starts the next stage once on release` | O |
| `Spec 040 a merge-only hold still allows a declared reviewer stage to launch` | O |
| `Spec 043 a stale candidate invalidates the earlier review and re-runs it` | I |
| `Spec 043 a callback replay advances once and later late callbacks are refused` | O |
| `Spec 043 concurrent processing of one review completion advances only its bound stage` | O |
| `Spec 043 concurrent stale-result handling invalidates one attempt once` | I |
| `Spec 043 concurrent processing of one work completion advances only its bound stage` | O |
| `Spec 043 a failed verifier does not advance and never merges` | E |
| `Spec 043 an insufficient row permitted vs not decides advancement on a verifier stage` | E |
| `Spec 043 a goal that is not met closes goal_unmet and leaves a dependent waiting` | E |
| `Spec 043 a declared stage keeps its slot request and resumes on release` | O |
| `Spec 043 a reviewer that breaks stage independence is refused` | O |
| `Spec 043 a verifier stage dispatches its own declared profile on a different model` | E |
| `Spec 043 a verifier profile that shares the canonical model enters the named operator wait` | E |
| `Spec 043 a declared verifier profile absent from the catalog waits without a fallback` | E |
| `Spec 043 acceptance refuses a callback whose model breaks stage independence` | O |
| `Spec 043 stage state survives a service roll mid-stage without a duplicate run` | I |
| `Spec 043 a declared publication stage runs its role and advances the frozen candidate` | E |
| `Spec 043 incomplete evidence blocks a stage before it runs` | E |
| `Spec 043 a callback from a run that is not the stage run is refused` | O |
| `Spec 043 a canonical stage prompt names the stage, its frozen subject and its gate verdict ids` | E |
| `Spec 043 a staged reviewer callback naming only an earlier stage verdict is refused at the bridge` | O |
| `Spec 043 every gate id needs one individual verdict row before a staged review is recorded` | O |
| `Spec 043 changes_required also requires complete evidence for each permitted-insufficient verdict` | O |
| `Spec 043 rerun_stage re-runs a failed canonical stage fresh on the same head, then the verifier follows` | C |
| `Spec 043 a released canonical stage run without an accepted result redispatches once with the pending reviewer instruction` | C |
| `Spec 043 a blocked task whose current stage is bound to a released run does not dispatch until it is returned` | C |
| `Spec 043 a released stage run with an accepted result still advances and is not redispatched` | C |
| `Spec 043 a released stage run that cannot dispatch shows the waiting reason` | C |
| `Spec 043 reopen_stage reopens an advanced canonical stage, invalidates it and every later stage, and re-runs them in order` | C |
| `Spec 043 reopen_stage is refused with a live run, after merge intent, for a non-advanced or later stage, or when the subject changed` | C |
| `Spec 043 a gate-only plan amendment keeps earlier advanced stages and invalidates only from the changed stage` | I |
| `Spec 043 a publish stage declared output digest change does not invalidate earlier stages and the terminal review freezes the signed head` | I |
| `Spec 043 a publish-stage digest change outside its declared outputs still invalidates from the stage that froze it` | I |
| `Spec 043 restore_stages recovers the pilot records after a re-dispatched boundary stage` | C |
| `Spec 043 restore_stages is refused on a real source change and after merge intent` | C |
| `Spec 043 restore_stages does not reconstruct reopen or plan-change archives` | C |
| `Spec 043 the #1963 shape is refused at prepare advancement and names the planner wait` | E |
| `Spec 043 the same prepare advances when its declared outputs and the next subject are readable` | E |
| `Spec 043 a publish stage with present declared outputs still advances` | E |
| `Spec 043 a publish stage with a missing declared output does not advance` | E |
| `Spec 043 a review does not advance into a next review whose subject paths are unreadable` | E |
| `Spec 043 a parked stage wait parks normal dispatch until the operator reruns the failed stage` | C |
| `Spec 043 rerun_stage clears the parked wait and dispatches a fresh prepare run` | C |
| `Spec 043 a dispatch-time unreadable subject fails the current stage and rerun_stage can clear the wait` | C |
| `Spec 043 a plan change supersedes a parked stage wait and re-runs the work stage` | C |
| `Spec 043 a plan amendment clears a declared-stage attention and re-evaluates` | C |
| `Spec 043 a goal-only amendment leaves a declared-stage attention in place` | C |
| `Spec 043 compares the union of asymmetric prior paths and advances 7/7/5 without re-review` | I |
| `Spec 043 a changed path omitted by the next stage still invalidates its frozen review` | I |
| `Spec 043 a missing path omitted by the next stage parks before any review redispatch` | I |
| `Spec 043 repeated unchanged same-head invalidations stop before another stage run` | I |
| `Spec 043 a gate-only plan change resets the unchanged-invalidation no-progress sequence` | I |
| `Spec 043 same-content recovery preserves only genuine current-gate canonical and verifier reports` | I |
| `Spec 043 a current gate amendment cannot reuse an earlier selected review row` | O |
| `Spec 043 publish output changes carry across the ingest head and final review freezes the signed head` | I |
| `Spec 043 one-time digest cascade reconciliation restores the authoring chain and keeps replayed results in history` | C |
| `Spec 043 one-time digest cascade reconciliation runs for a blocked staged task` | C |
| `Spec 043 does not reconcile a false digest cascade when a frozen path outside outputs changed` | I |
| `Spec 043 reconcile_declared_publication reconciles an already-signed publication at a head that differs from task.prHead` | C |
| `Spec 043 reconcile_declared_publication admits a signed receipt only when the owning brief declares its path` | C |
| `Spec 043 reconcile_declared_publication applies a pending output-only brief amendment and admits the declared artifact` | C |
| `Spec 043 reconcile_declared_publication refuses a brief amendment that changes more than declared outputs` | C |
| `Spec 043 reconcile_declared_publication refuses an output amendment that also changes the goal` | C |
| `Spec 043 reconcile_declared_publication checks a declared output no frozen subject names` | C |
| `Spec 043 reconcile_declared_publication refuses a whitespace-padded filename that would normalize to a declared output` | C |
| `Spec 043 reconcile_declared_publication refuses a new signed artifact the brief does not declare` | C |
| `Spec 043 reconcile_declared_publication fails closed on a missing declared output and an unexpected head` | C |
| `Spec 043 reconcile_declared_publication refuses a live run and an incompatible accepted review` | C |
| `Spec 043 a blocked reconciliation result is not an authority and never advances publish` | C |
| `Spec 043 a work stage that pushes a new head records it as the task PR head and the next review freezes it` | E |
| `Spec 043 a work stage that completes at an unchanged head still advances and leaves task.prHead in place` | E |
| `Spec 043 reconciles a false digest_changed after a work-stage head push and dispatches the next stage once` | C |
| `Spec 043 does not reconcile when the open PR head matches neither recorded head` | C |
| `Spec 043 does not reconcile a genuine digest change outside declared outputs` | C |
| `Spec 043 does not reconcile over a completed changes_required re-review of the re-dispatched stage` | C |
| `Spec 043 a stage-plan amendment in changes_requested reconciles before dispatching, never a plain revision` | C |
| `Spec 043 a mid-run amendment inserting a stage before the live review reconciles instead of stranding on a stale state` | C |
| `Spec 043 a mid-run amendment redefining the live review retires its result instead of judging it by the new definition` | C |
| `Spec 043 a mid-run amendment to a later stage still applies the live review result` | C |
| `Spec 043 reconcile_merge_only_revision restores the authentic chain and dispatches one fresh terminal at the merged head` | C |
| `Spec 043 reconcile_merge_only_revision recovers an already-invalidated successive tail from the prior carried head` | C |
| `Spec 043 reconcile_merge_only_revision refuses a consumed input change and a modified signed artifact in a merge` | C |
| `Spec 043 reconcile_merge_only_revision refuses a linear head move, a sideways merge and a publication head that is not an ancestor` | C |
| `Spec 043 reconcile_merge_only_revision fails closed on a missing authentic run and changed review evidence` | C |
| `Spec 043 reconcile_merge_only_revision refuses a live run, a changed plan and a superseded identity` | C |
| `Spec 043 reconcile_merge_only_revision keeps exact path identity for whitespace siblings and refuses signed-artifact renames` | C |
| `Spec 043 reconcile_merge_only_revision refuses a task mutation during the awaited proof` | C |
| `Spec 043 reconcile_merge_only_revision accepts the live #1963 shape with unrelated incoming-main changes under shared roots` | C |
| `Spec 043 reconcile_merge_only_revision still refuses a modified signed artifact and a non-base merge in the live shape` | C |
| `Spec 043 #1999 merge-only recovery preserves GLO ownership, waits under dispatch hold, then binds one fresh terminal to c1aa` | C |
| `Spec 043 #1999 owning-document recovery rejects tampered unions, lost branch blocks and forged lines` | C |
| `Spec 043 #1999 owning-document recovery checks every path in the 266-path merge delta` | C |
| `Spec 043 #1999 owning-document recovery refuses non-text, mode, symlink, delete and rename changes` | C |
| `Spec 043 owning documents cannot cover consumed inputs; declared Markdown outputs still need exact union proof` | C |
| `Spec 043 #1999 owning-document recovery refuses missing Git blobs and ambiguous merge ancestors` | C |
| `Spec 043 #1999 merge-only recovery refuses consumed GLO and declared signed-artifact changes` | C |
| `Spec 043 #1999 merge-only recovery refuses branch-only edits and whitespace paths outside exact base bytes` | C |
| `Spec 043 reconcile_merge_only_revision requires the genuine retained revision callback` | C |
| `Spec 043 reconcile_merge_only_revision binds a stale structured revision head through its original verified result association` | C |
| `Spec 043 reconcile_merge_only_revision records verification_required for a legacy stale callback without its original verified result association` | C |
| `Spec 043 normal verified merge automatically preserves the active chain under hold and launches one terminal after release` | C |
| `Spec 043 normal merge input change invalidates its earliest consumer once and preserves prepare identity` | I |
| `Spec 043 normal unchanged-input linear move remains owned with a structured proof refusal and no producer replay` | C |
| `Spec 043 a stale accepted completion requires genuine legacy verification even when callback identity matches` | C |
| `Spec 043 normal #1999 full delta and large owning-document proof automatically preserve the original chain` | C |
| `Spec 043 actual-shape legacy #1999 holds one verification intent, accepts its genuine exact-head callback, and launches one fresh terminal` | C |
| `Spec 043 legacy verification unknown delivery retains one durable run across reopening and warm roll` | C |
| `Spec 043 released blocked legacy verification retries only explicitly and preserves the old authenticated attempt` | C |
| `Spec 043 authenticated post-merge additions preserve existing artifacts and refuse consumed, existing or undeclared changes` | C |
| `Spec 043 an authenticated prepublication author correction reaches fresh canonical and verifier without merge proof` | E |
| `Spec 043 legacy preflight cannot revive a blocked publisher or an incomplete original review` | P: the synthetic callback records are not authentic historical proof; keep the actual immutable snapshot classifier tests instead. |

The actual immutable snapshot classifier cases and the pure schema,
subject-set, history-snapshot, callback-binding and read-only classification
cases remain where they do not dispatch a stage. The generated blocked-publisher
fixture is not a substitute for a retained authentication record.

### `test/declared-stage-identity.test.ts` (trimmed 2026-10-13 to the declaration-reader and fixture-integrity cases)

| Case | Disposition |
| --- | --- |
| `stale review invalidation refuses a mutation during its awaited union comparison` | I: the checked cursor/invalidation is stage-only and retired; normal revision callback binding and immutable historical identity cases remain. |
| `normal initial worker acceptance durably binds the original callback before its leading stage advances` | E: it expects initial stage advancement; ordinary initial worker/completion identity remains in the ordinary callback and review-entry suites. |
| `normal authenticated revision records old callback candidate and actual verified result separately and survives reopening` | I: it writes stage-result associations during stage execution; saved-association distinctions are covered by generated synthetic history fixtures. |
| `a mutation during normal revision verification cannot bind its callback under a newly sampled task version` | O: this test reaches the guard through a retired stage result; the ordinary awaited review-entry recheck remains in `test/review-entry.test.ts`. |
| `proof capture detects cursor, retained model, workspace, callback and supersession changes after await` | I: the synthetic capture depends on a live stage cursor; callback-identity distinctions and immutable proof inputs remain covered by synthetic history tests. |
| `structured detail action follows the live hold and run without changing pending instructions or evidence` | C: its `dispatch_stage`/`inspect_proof` actions name retired controls; the current park and no-write refusal remain tested. |
| `reviewed blocked-retry routing retains current authority and separates authenticated diagnostics` | O: stage-specific retry metadata retires; ordinary blocked-review continuation and explicit retry behavior remain in `test/review-continuation.cases.ts`. |

### `test/declared-stage-production-proof.test.ts` (deleted 2026-10-13)

The whole file went with the execution code; the read-only proofs it offered
no longer have a subject. The original consumer snapshots were replaced on 2026-11-10 by generated
synthetic histories in `test/fixtures/stage-histories/`.
`test/declared-stage-identity.test.ts` checks the retained identity distinctions
against those scenarios; it makes no claim of consumer-history proof.

| Case | Disposition |
| --- | --- |
| `#1963 frozen history gates survive the full disposable authenticated merge lifecycle without producer replay` | P: synthetic active stage replay is retired; the actual immutable #1963 classifier refusal was deleted with the recovery code. |
| `#1999 frozen history gates survive the full disposable authenticated merge lifecycle without producer replay` | P: synthetic active stage replay is retired; the actual immutable #1999 read-only preflight was deleted with the recovery code. |
| `#2094 frozen history gates survive the full disposable authenticated merge lifecycle without producer replay` | P: synthetic active stage replay is retired; the F2 proof test was deleted on 2026-10-13 and its fixture removed with it. |

The brief fixtures in `test/briefs.test.ts` were already converted to refusal
and plain-amendment expectations. Their unrelated ordinary prompt fixture
defect remains an honest failure and is outside this migration.

## Problem

Recurring multi-stage flows (Project-a's source workflow: input preparation, independent
source-stage review, canonical review, fresh verifier on identical frozen inputs,
authorised publication, final exact-head review, release) need a planner action between
every stage today. Waiting is shown as generic slot reasons or treated as recovery failure.

## Rulings (Tom, 2026-10-04)

- Opt-in, approved and versioned stage definitions. No auto-approval, no turning
  insufficiency into a pass, no signing or receipt waiver, no capacity change.
- Advancement is authenticated, independent, gated, durable and exactly-once; changed
  inputs invalidate only dependent stages; only the terminal stage carries merge authority.
- Waiting states are explicit, never recovery failures.
- Pilots are separately approved, exactly scoped briefs (Project-a BA3/BA4 first); no mass
  conversion. Project-a owns pilot stage definitions; Queue owns this contract and runtime.

## Model

- **Declaration.** Brief frontmatter `queue.stages`: an ordered list, part of the approved
  brief and its digest, changed only by `amend_brief` (re-checked). Absent means today's
  single review flow, unchanged.
- **Frontmatter shape (step b).** Each stage is a strict mapping with `id`, `kind`,
  `subject`, `role`, `independence`, `gate`, `actions` and `wait`; `profile`, `evidence`
  and `outputs` are optional.
  `subject` is `{head: candidate, digests: [{path}]}`: the candidate head is captured at
  stage entry and each named repository-relative path is hashed then. `independence` is a
  list of earlier stage ids. `gate` is `{pass: [verdictId], insufficient: [verdictId]}`;
  ids are unique and cannot occur in both lists. `actions` is a list of `push`, `comment`
  or `{publish: registeredTarget}`. `outputs` (a `work` or `publish` stage only) is a list
  of repository-relative paths or path prefixes the stage's own run is authorised to
  change. `evidence` is `{pins: [{name, sha256}], maxRuns: 1}`.
  `wait` is a list of `{kind: operator|source_rights, name}`. Stage ids are unique, and the
  last stage is `review` or `verify`.
- **Stage fields.** `id`; `kind` (`work`, `review`, `verify`, `publish`); `subject` (the
  exact candidate head plus named content digests, by path and sha256, taken at stage
  entry); `role` and `independence` (distinct agent from named earlier stages, and the
  Spec 036 model policy); optional `profile` (a `review` or `verify` stage's own reviewer
  route); `gate` (named Spec 037 verdict ids that must be `pass`, and which
  rows may stay `insufficient` without blocking advancement — they never become `pass`);
  `actions` (what the stage's agent may do: push, publish to a named registered target,
  comment only); optional `outputs` (paths or prefixes a `work`/`publish` run may change);
  optional `evidence` (external pins and hashes, and a one-run limit);
  `wait` (named operator or source-rights waits the stage may enter).
- **Per-stage profile and model independence.** A `review` or `verify` stage may declare an
  optional `profile: {id, reason}`. It is validated exactly like a `reassign_roles` reviewer
  request — named profile present in the catalog, enabled for the reviewer role, in an
  available subscription group, with an explicit reason and not an opaque provider-default
  model — at brief check, `amend_brief` and stage dispatch. When a stage names a profile its
  model must differ, by the same normalized Spec 036 model key, from every stage it names in
  `independence` and from the author whose head is under review. A stage profile is a declared
  route, never a preference: an unusable or model-violating one enters a named operator wait
  with the reason, is never replaced by the task-wide reviewer request or another same-model
  fallback, and acceptance refuses a callback whose reported model violates the rule. A stage
  without a profile keeps today's task-wide selection unchanged.
- **Advancement.** An authenticated callback for the current stage's run, whose verdicts
  satisfy the gate against the exact recorded subject, advances one stage in one durable
  operation. Replays, late callbacks and doubles are no-ops. A wrong agent or a role that
  breaks independence is refused.
- **Explicit dispatch hold (Spec 040).** A dispatch hold on an already-dispatched, unmerged
  task leaves its live stage run in place. Queue observes and applies that run's authenticated
  callback, including the one-stage advance, but does not record or launch the next fresh
  stage run until release. Release resumes the current stage once through the ordinary
  dispatch path. A merge-only hold does not fence stage review.
- **Work-stage re-run.** A `work` stage that a plan change, invalidation or `reopen_stage`
  makes current again re-runs the retained worker for genuine work. The task's earlier
  completion never satisfies the fresh attempt: Queue dispatches the retained worker on the
  same workspace, branch and PR with a stage-scoped instruction naming the stage and its
  declared `outputs`, records that run as the stage run, and advances only on its
  authenticated completion. Only the first `work` stage on initial dispatch is fulfilled by
  the worker that produced the candidate PR. A declared-stage fault (an unreadable subject
  path, incomplete evidence, or a stage parked on a missing declared path) never blocks
  plan re-evaluation: a newer approved plan that changes a stage definition supersedes it,
  and the task leaves the fault and re-evaluates instead of waiting for an operator to
  clear it. A goal-only amendment changes no stage definition and cannot fix the fault, so
  it leaves the task parked.
- **Invalidation.** A new head or a changed named digest invalidates the stage that took it
  and every stage after it; earlier stages' records stay as they were. Only invalidated
  stages re-run.
- **Merge authority.** Only the terminal stage's exact-head review can lead to merge. A
  `ready_to_merge` from any other stage advances, never merges. Spec 040 holds still apply.
- **Goal gate (Project-a #1816 → #1817, 2026-10-04).** Merge authority and goal
  satisfaction are separate. A brief may declare `queue.goal` (named verdict ids, or
  a terminal stage's gate) for what dependents need. A task that merges with those
  verdicts not `pass` (for example an approved evidence-only record whose live
  eligibility failed) closes as done with outcome `goal_unmet`. It never satisfies a
  `dependsOn` or a `set_prerequisite_wait` on it. Dependents stay
  `waiting_prerequisite`, owned by that task, until a later task that does meet the
  goal is named as their prerequisite or the operator re-points them. No
  dependent is released automatically on a `goal_unmet` outcome. A brief without
  `queue.goal` keeps today's done-means-satisfied behaviour.
- **Wait states.** The board derives waits from current facts in this order: an open linked
  Spec 032 decision (`needs_operator_input`), unfinished prerequisite (`waiting_prerequisite`),
  current refused task-slot request (`waiting_capacity`; it resumes
  on release without recovery budget under #172), an explicit declaration, a live QA-capacity
  prefix, then a merge hold (`merge_hold`) only when the task is otherwise ready to merge
  (phase `verifying` or `merging`). Before merge intent the primary wait is the
  dispatch-blocking cause; a merge hold is a secondary flag on the board and in task detail.
  A dispatch hold is a Spec 040 badge, not a wait. Stale capacity or prerequisite reason text
  cannot create a wait. The board shows the state, its owner and next action.
  `needs_source_rights` remains an explicit declaration. An operator answer advances only the
  named stage and inputs; it never signs or waives a receipt.
  The `waiting_prerequisite` owner is one bounded line (Queue #486, 2026-10-29). A task may
  legitimately carry a large prerequisite fan-in (`dependsOn` accepts 100), and the unfinished
  ids joined into the owner overran its 240-character projection bound: one valid 13-dependency
  final gate refused every board, detail and health publication. The owner now keeps whole
  prerequisite ids in declaration order until the bound and names the remainder as `+N more`;
  it never slices an id. Nothing is dropped from the task: `dependsOn`, the retained
  `waitsFor` and the dependency-wait reason keep every identity and reason, dispatch still
  reads the full list, and an unclosable prerequisite still makes the wait the operator's.
  A projection fault stays fail-closed; this bounds the fact, not the reporting.
- **Retained prerequisite wait.** `queue.task` action `set_prerequisite_wait` records
  `{waitsFor, reason}` on an already-dispatched, unmerged task before merge intent. An empty
  `waitsFor` clears it. The wait leaves the PR, worker, workspace, phase and merge hold alone.
  Recording while a run is live is allowed: the wait is versioned and visible immediately and
  does not interrupt that run. It takes effect when the run releases, before any next
  dispatch, including the next declared stage, so a short readiness, PR-reconciliation
  revision, or in-flight stage run cannot race a reviewer slot.
  While any listed task is unfinished, ordinary reconciliation and coordinator recovery pause
  once the current run has released. When all are done, Queue sends one owner notice and
  resumes normal handling on a later pass.
  A `changes_requested` task remains parked until an explicit `move to=work` or `retry_resolution`;
  a supported pre-PR `restart role=worker` continuation also counts as explicit owner action.
  These actions refuse while the wait is still open and clear a released wait as part of the
  accepted continuation, recording `prerequisite_wait_resumed`. Prerequisite completion alone
  never launches a revision automatically. `set_dependencies` remains pre-dispatch only.
- **Portability** (nucleus contracts 007/008/009 at `4a3ec1b`, 2026-10-04). Stage
  definitions are not exported as a parsed copy: they live only in the brief's
  `queue.stages` frontmatter, carried by `brief.text` and its digest. 008 outcome
  `stageRuns?`: `[{stageId, runId, subject {head?, digests [{path, sha256}]}, result:
  advanced|invalidated|failed, verdicts? [verdictId], reviewId?, at}]`, absent without
  stages. 009 lifecycle decisions `stage_advance {stage, nextStage, subject, verdicts, run}`
  and `stage_invalidate {fromStage, reason: head_changed|digest_changed, subject}` (recorded,
  not qualified, per option B). 009 fact `wait_state {task, state, owner, decision?}`
  emitted on entry to and exit from each wait; `decision` only for `needs_operator_input`.
  Enum values are pinned by the values guard at nucleus `4a3ec1b`.

## Implementation

| Step | Task | Depends on |
|---|---|---|
| a | Wait-state model and board labels, replacing generic slot reasons | #172 |
| b | Stage schema and validation in brief parsing, `lead.check` and `amend_brief`; no runtime | — |
| c | Stage engine: per-stage dispatch, gate evaluation, exactly-once advancement, invalidation, terminal-only merge | a, b |
| d | Export `stageRuns`, stream `stage_advance`/`stage_invalidate` and `wait_state` entry/exit, pinned to 008/009 at `4a3ec1b` | a, c |
| e | Stage-aware reviewer prompts, per-stage callback validation and the `rerun_stage` operator control | c |
| f | The `reopen_stage` operator control for an advanced stage whose evidence proved inadequate | e |
| g | Complete per-subject verdict matrices for staged reviewer callbacks | e |
| h | Declared publish outputs, partial plan invalidation and the `restore_stages` operator control | c, f, g |
| i | Work-stage completion: declared-output existence gate, next-stage readability preflight and the planner-owned missing-path wait | c, h |
| j | Released stage run without an accepted result: close the attempt and dispatch a fresh run when the task is already eligible | c, e |
| k | Work/publish stage result head is recorded as `task.prHead`; one-shot reconcile of a false `digest_changed` after that miss | c, h, i |
| l | Carry declared-output excuses across an authorised head chain; one-time reconcile of false digest cascades | h, k |
| m | Reconcile a stage-plan amendment before changes-requested dispatch and guard stale-index controls | c |
| n | Accept full stage matrices without bloating bounded projections | e, g |
| o | Revalidate stage-result ownership atomically after awaited checks so concurrent application can settle one attempt only | c |
| p | Compare asymmetric frozen subjects and bound unchanged invalidation loops | c, h, o |

## Acceptance (step c)

Tests for callback replay, service roll mid-stage, slot release, stale candidate, wrong
reviewer, independence violation, a verifier profile that shares the canonical model,
a violating callback refused at acceptance, failed verifier, late or double callback, publication-head
change, incomplete evidence, an insufficient row allowed versus not allowed, and an
intermediate `ready_to_merge` never merging.

## Acceptance (step d)

Settled `stageRuns` stay in the outcome record for tasks with declared stages, and stage
definitions stay in `brief.text`. Queue's contract 008 export and contract 009 shadow
stream, which once carried stage decisions, were retired on 2026-10-31; the contracts
remain Nucleus's current ones, and stored outcomes and stage history still parse.

## Step (e): stage-aware prompts, per-stage verdicts and stage re-run (2026-10-05)

The first Project-a Spec 043 pilot (#1889, PR #2509) exposed three gaps. This step closes
them without changing the stage model above.

- **Stage-aware reviewer prompts.** Every `review`/`verify` stage run's prompt names the
  stage id and kind, the frozen subject (the exact head and each named path with the
  sha256 recorded at stage entry), the gate's `pass` and `insufficient` verdict ids, that a
  `ready_to_merge` from a non-terminal stage only advances and never merges, and the
  stage's independence and configured profile or model. The Spec 037 structured-verdict
  rules apply per stage; a staged brief must not also set root `queue.reviewVerdicts`,
  `queue.reviewPassGate` or `queue.reviewContinuationIds` (Project-a #1982, 2026-10-05:
  root keys duplicating the terminal gate demanded terminal ids from the canonical
  stage's callback). The brief check refuses the combination, and already-dispatched
  staged tasks skip the root opt-in, pass gate and merge-gate re-check: every stage
  callback validates only against its own stage gate, and only the terminal stage's
  own gate carries merge authority.
- **Per-stage callback validation.** A staged reviewer callback is validated at the bridge
  and again at the completion gate against its own stage's gate. A verdict id that belongs
  to another stage is refused, as is a `ready_to_merge` that omits any required `gate.pass`
  id. Step (g) extends this to the complete gate matrix for both verdict-recording statuses.
  Both are refused before acceptance so the live run can re-report; the stage is not
  recorded failed for a verdict bookkeeping error. This is the fix for the pilot's canonical
  stage, which reported the previous stage's `source-staging-integrity` verdict and was
  recorded failed.
- **Re-run a failed stage.** `queue.task` action `rerun_stage` (versioned, with an operator
  `reason`) is available while the current declared stage record is `failed`, its frozen
  subject is unchanged and no run owns the task. It archives the failed attempt's record
  immutably in the stage state's `history`, records a fresh `running` attempt at the same
  index and subject, and returns the task to `awaiting_review`; the normal stage dispatch
  then launches a fresh agent (never one that ran a stage the stage is independent of, and
  never the author) on the stage's declared profile or the task-wide reviewer route. It
  never advances or skips a stage, changes sources or a digest, or sends the retained
  worker a revision. A changed subject is not re-run: ordinary invalidation re-runs the
  stage that froze it.

Acceptance (step e): the canonical stage prompt names its gate ids and subject; a callback
with only an earlier stage's verdict (or a `ready_to_merge` missing a required pass id) is
refused and the run can re-report; and `rerun_stage` after a failed canonical dispatches a
fresh same-route run on the identical head, after which the declared verifier follows on
success.

## Step (f): reopening an advanced stage (2026-10-05)

The same pilot exposed that an earlier stage can advance on evidence that later proves
inadequate. Spec 043 invalidates a stage only on a new head or a changed named digest, and
`rerun_stage` (step e) only re-runs the *current* stage when it is `failed`; a task blocked
at a later stage therefore had no supported way to revisit an earlier decision. This step
adds the operator control without changing the stage model above.

- **Reopen an advanced stage.** `queue.task` action `reopen_stage` (versioned, with
  `stageId` and an operator `reason`) reopens an `advanced` stage at or before the current
  index when the frozen subject (head plus named digests) is unchanged, no run owns the
  task, and there is no merge intent or merged commit. It never advances or skips a stage,
  changes sources or a digest, or sends the retained worker a revision.
- **Effect, in one transaction.** The named stage's record and every later stage's record
  are archived immutably in the stage state's `history` with the operator's reason and
  identity, and marked `invalidated`; the current index is set to the named stage and a
  fresh `running` attempt is recorded on the identical frozen subject. The task returns to
  `awaiting_review`, so normal stage dispatch launches a fresh run on the stage's declared
  profile or the task-wide reviewer route. A fresh reviewer is never an agent that ran that
  stage, an independent earlier stage, or the author. Later stages re-run in order only
  after the reopened stage advances again; earlier stages keep their records.
- **Recording.** A `stage_reopened` event names the reopened stage and every invalidated
  stage id, and the request records the operator reason. The stage state keeps the archived
  records, so the decision stays auditable without a new pinned lifecycle decision.

Acceptance (step f): the #1889 shape (canonical and verifier advanced, publish blocked)
reopens `canonical-review`, invalidates `canonical-review`, `verifier` and `publish`, and
dispatches a fresh canonical run on the same head; the verifier re-runs only after the new
canonical advances; a reopen is refused with a run owning the task, after merge intent, for
a non-advanced or later stage, or when the frozen subject changed.

## Step (g): complete per-subject verdict matrices (2026-10-05)

The Project-a Spec 043 pilot (#1889, 2026-10-05) showed that a staged reviewer could report
only the six `gate.pass` rows while grouping 48 `gate.insufficient` subjects as ambiguous
or N/A. The stage gate accepted that partial review because insufficient ids were optional.
The existing Spec 037 verdict rows can represent every subject individually, so completeness
is enforced at the staged callback boundary.

- **Complete matrix.** A staged reviewer callback with `ready_to_merge` or
  `changes_required` must contain exactly one row for every id in that stage's `gate.pass`
  and `gate.insufficient` lists. Missing ids, duplicate ids and foreign ids are refused
  before acceptance so the same run can re-report. `gate.pass` ids must still be `pass` to
  advance. A `gate.insufficient` id may be `pass`, `insufficient` or `not_applicable`, and
  its individual row must carry non-empty evidence. Blocked and error callbacks do not
  record a verdict matrix. Non-staged reviews keep their existing Spec 037 behavior.
- **Prompt and record.** The staged reviewer prompt lists every pass and insufficient id,
  requires one individual row per id with evidence, and says grouped or partial reports are
  refused. Accepted advanced and failed stage records retain every verdict id and result;
  the immutable review record retains the complete rows and evidence.

Acceptance (step g): a gate with six pass ids and 48 insufficient ids refuses a two-row
`ready_to_merge` callback and a 53-row callback, refuses a duplicate id, and accepts 54
individual rows with the full matrix retained. `changes_required` also requires the complete
matrix and individual evidence for every permitted-insufficient row. Legacy non-staged
reviews are unchanged.

## Step (h): declared publish outputs, partial plan invalidation and restore (2026-10-05)

The Spec 043 pilot #1889 (744cc4ae, PR #2509) showed that an authorised publication could
invalidate the reviews that preceded it, and that a gate-only brief amendment could reset
work that had already passed. This step closes both without changing the stage model above.

- **Declared publish outputs.** A `work` or `publish` stage may declare
  `outputs: [repository-relative path or path prefix]`. A frozen digest change is excused
  when its path is declared by an advanced work or publish stage at or after the record
  that froze it, and that authoring stage's result head is an ancestor of or equal to the
  current head. This carries authorised changes through a later declared head move while
  keeping changes outside the union of declared outputs invalid. A declaration never
  excuses an external head move. The next stage's frozen subject is taken at the new head,
  so terminal review still judges the exact signed head. `outputs` is refused on a `review`
  or `verify` stage.
- **Partial plan invalidation.** On a plan digest change the engine compares stage
  definitions by id and keeps advanced records for stages whose definitions are unchanged,
  archiving and invalidating only the first changed stage and everything after it
  (consistent with `reopen_stage`). A goal-only amendment changes the digest but no stage
  definition, so every record is kept.
- **Recovery control.** `queue.task` action `restore_stages {taskId, version, reason}`
  (operator, versioned) re-evaluates the most recent head/digest invalidation under the
  current plan. If the invalidation predates its explicit batch, it reconstructs the latest
  ordinary head/digest invalidation from the invalidated rows in `stageState.records` and
  its `stage_invalidated` event; if the first row was overwritten by an immediate re-dispatch,
  the surviving next-stage row supplies the proven advanced boundary. Legacy history archives
  are also supported. It then backfills the batch. Reopen and plan-change archives are not
  recovery candidates.
  When the archived records would not have been invalidated it restores them from the
  recorded invalidation, adopts the current plan digest, sets the current stage to the first
  non-advanced one and returns the task to normal dispatch. It never re-runs a restored
  stage, changes a source or re-signs. It is refused while a run owns the task, after merge
  intent, and when any frozen subject outside the declared outputs still changed.

Acceptance (step h): the #1889 shape (a publish output changes a prepare-frozen path)
advances to terminal review at the signed head without re-running publish and without a
`stage_invalidated` decision; the same change outside the declared outputs still invalidates
from the stage that froze it; a gate-only plan amendment keeps the earlier advanced stage
and re-runs only the changed stage; `restore_stages` on the #1889 shape resumes at the
terminal review at the signed head, and is refused on a real source change and after merge
intent; a pre-index history/event archive is recovered, while reopen and plan-change
archives are refused.

### Restore an already accepted terminal review (2026-10-06)

When invalidation reconciliation or `restore_stages` restores every stage through an
advanced terminal review, Queue resumes at `verifying` using that stage's recorded reviewer
run completion. The completion must match the terminal record's stage, exact `prHead`, review
id and verdicts; Queue preserves those verdicts and does not dispatch the review again. If the
terminal record's head differs from `task.prHead`, Queue parks the task for attention with
both heads in the reason. `dispatchStage` applies the same hand-off to an already parked task
whose `currentIndex` is at the end and whose terminal record is advanced, so the task has a
forward path without repeating a valid terminal review. The hand-off restores
`currentIndex` to the terminal stage, matching normal terminal acceptance so
the existing merge eligibility gate recognizes the restored advanced record.

## Step (i): work-stage completion on declared outputs and readable subjects (2026-10-05)

Project-a #1963 (f808686a, PR #2582, head 8ea65fc2) showed that a `work` stage could advance
on an administrative identity-readiness callback that produced only refusal evidence, not
the candidate. The next stage then failed closed with an unreadable subject and left the
task in a generic `awaiting_review` with an unreachable review. Nothing tied a stage's
completion to the files the next stage needs.

- **Output existence gate.** A `work` or `publish` stage that declares `outputs` advances
  only when every declared output path exists and is readable at the run's result head, or,
  for a declared prefix, at least one readable file exists beneath it. Otherwise the stage
  records `failed` with the missing paths. This also covers the leading work stage the
  engine normally fulfils from the worker that produced the candidate: it is not advanced
  until its declared outputs exist.
- **Next-stage readability preflight.** Before any stage advances, Queue checks that the
  next `review` or `verify` stage's declared subject paths are readable at the advancing
  head. If they are not, the advancing stage does not advance; it records the same
  `failed`-with-missing-paths outcome, so Queue never advances into a review that cannot
  read its subject.
- **Clear, planner-owned wait.** A stage blocked this way enters a named
  `needs_source_rights` wait recorded in the stage state, owned by the task's planner (its
  origin), whose reason and next action name the stage id and the missing paths. The task
  parks in `changes_requested` and no declared stage dispatches; this is a visible wait,
  never a recovery loop and never a generic `awaiting_review`. The dispatch-time
  unreadable-subject fallback records the current stage `failed` with the same wait, so
  the condition has an exit: `rerun_stage` on the failed stage and `reopen_stage` on an
  earlier advanced stage both clear the wait when the planner provides the paths. A stage
  that failed before it could freeze its declared subject records an empty digest set and
  adopts the now-readable subject on its fresh run; `missingStageOutputs` and
  `missingStageSubjectPaths` are the pure checks, and an unreadable worktree makes every
  declared path missing rather than treating absence as proof.

Acceptance (step i): the #1963 shape (prepare advanced by identity-only readiness, canonical
subject paths absent) is refused at prepare advancement with the missing paths and a
planner-owned wait; with the declared outputs and the next subject present it advances; a
`publish` stage with present declared outputs still advances; a review whose next review's
subject paths are unreadable does not advance; a dispatch-time unreadable subject records
the current stage `failed` so `rerun_stage` clears the wait; and a parked stage dispatches
nothing until the operator reruns or reopens it.

## Step (j): released stage run without an accepted result (2026-10-05)

Project-a #1982 (fd96ffa9) showed that a staged reviewer run can release without an accepted
stage result — the callback was refused by a brief misconfiguration the planner later
corrected — and an operator `retry_resolution` that returns the task to `awaiting_review`
then stalls: the current stage record stays `running` bound to that released run, so stage
dispatch treats it as still in flight. No supported control exits the state: `rerun_stage`
requires `failed`, `reopen_stage` requires `advanced`, and `retry_resolution` already ran.
The same shape parks other open staged tasks in `blocked` (current stage `running`, bound
to a released run); any operator return to dispatch would hit the same dead state.

- **Close and redispatch.** When a staged task is already eligible for stage dispatch and
  its current stage record is `running` with a `runId` whose run is released or absent, that
  attempt is not in flight. Queue archives it in the stage state's `history` (keeping its
  `runId`, any verdicts, and the reason `stage run released without an accepted stage result`)
  and dispatches a fresh run for the same stage at the same frozen subject. A pending
  reviewer instruction (`pendingReviewReason`) is delivered to that fresh run exactly once.
  Independence and profile rules apply unchanged. The recognition lives in `dispatchStage`,
  so only a task already eligible (for example `awaiting_review` or `changes_requested`
  after an operator or coordinator return) takes the fresh run; a `blocked` task with the
  same shape stays parked until it is returned.
- **Accepted results unchanged.** A released run whose result has already advanced or failed
  the stage is handled as today. This step only covers a released (or absent) binding with
  no accepted stage result.
- **Visible wait.** If the fresh run cannot dispatch (for example no independent profile is
  available), Queue shows that waiting reason instead of a silent stall.

Acceptance (step j): the #1982 shape (`awaiting_review`, canonical `running` bound to a
released run, a pending reviewer instruction) dispatches one fresh canonical run and
delivers the instruction once; a blocked task with the same shape does not dispatch until
it is returned; a stage whose released run has an accepted result is unchanged; two engine
passes do not dispatch twice; and an unusable declared profile after the close shows the
waiting reason.

## Step (k): record a work-stage result head as the task PR head (2026-10-06)

Project-a #1984 (bafd3ae9) showed that a declared `ingest` work stage could push a new
candidate, report `ready_for_review`, and advance, while `task.prHead` stayed on the
previous head. `stageFrozenSubject` then hashed the new tree against the old head, so
`excusedDigest` did not fire and earlier reviews were invalidated with `digest_changed`.
The next review froze a head the PR no longer had. The miss was a misplaced `update`
argument: `completion`, `prHead` and `prUrl` sat on the resolution-changes object
because it was built in a variable, which bypasses TypeScript's excess-property check.

- **Record the result head.** A work or publish stage that advances applies `completion`,
  `prHead` and `prUrl` as task fields in the same transaction as the stage advance. The
  next review or verify stage freezes that head. A digest change confined to the stage's
  declared outputs stays excused. Resolution `update` refuses task-only keys on its
  changes argument so a later variable-built object cannot drop them again.
- **One-shot reconcile.** An open staged task whose latest recorded invalidation is
  `digest_changed`, and which has an advanced work or publish record whose `subject.head`
  differs from `task.prHead`, is reconciled when the verified open PR head equals that
  record's head and the restored records would not be stale under the current plan. Queue
  sets `prHead` to the verified head, restores the records that invalidation archived,
  returns `currentIndex` to the stage after the work stage, closes a re-dispatched
  earlier-stage attempt that never ran, and clears the head-changed attention and its
  recovery episode. One `stage_head_reconciled` event names both heads and the restored
  records. The next pass dispatches the following stage at the new head. The repair runs
  once and is a no-op after the head is recorded.
- **Leave genuine faults.** If the open PR head matches neither recorded head, a named
  path is unreadable, or a digest outside the declared outputs still changed, Queue
  changes nothing. Attention already set keeps a precise reason when the PR matches
  neither head, and when restore would still be stale it names the stage and the
  unmatched path. A re-dispatched earlier-stage review that already completed
  (`changes_required` / `ready_to_merge`, record `failed` or `advanced`) is left in
  place; Queue does not restore the archived records over it.

Acceptance (step k): a work stage that pushes a new head records `task.prHead` and the
next review freezes it, while earlier reviews whose changed paths are that stage's
declared outputs stay advanced; the #1984 shape restores those records, sets `prHead`,
and dispatches the next stage once; a PR head that matches neither recorded head, or a
digest change outside declared outputs, is left in place, the latter with a reason that
names the stale stage and path; a completed `changes_required` re-review of a
re-dispatched earlier stage is not overwritten; a work stage that completes at an
unchanged head behaves as before.

## Step (l): carry authorised outputs across declared head moves and reconcile false cascades (2026-10-06)

Project-a #2011 and #1984 showed that a later `publish` stage can move the candidate
after an earlier `work` stage changed declared outputs. Requiring every output-owning
stage to have produced the exact current head discarded the earlier stage's excuse,
invalidated reviews back to `prepare`, and could cause Queue to redispatch completed
work.

- **Authorised output chain.** When the current candidate is the result head of the
  latest advanced work or publish stage, a frozen digest change is excused if any
  advanced work or publish stage at or after that record declared the path and its
  result head is an ancestor of or equal to the current head. Queue proves ancestry in
  the task repository. A non-ancestor result head, a changed path outside the union of
  those outputs, or an external head move still invalidates.
- **One-time cascade repair.** An open staged task with trailing `digest_changed`
  invalidations is reconciled only when its verified open PR head equals the current
  head, the current head is the latest advanced work/publish result, and every changed
  frozen path across the archived attempts is covered by the authorised output chain.
  Queue restores the earliest genuine stage records and their verdicts, including the
  publish record; closes re-dispatched attempts without accepted results; retains a
  later accepted re-dispatch in history instead of replacing the restored record; and
  resumes at the first stage after the restored advanced prefix. It clears the related
  attention and records one `stage_invalidation_reconciled` event naming restored
  stages and covered paths. A path outside the output chain keeps the invalidation and
  precise attention.

Acceptance (step l): the #2011 stage shape lets ingest's frozen-input output and
publish's manifest output survive the publish head move, then dispatches final review
at the signed head; a genuinely undeclared path and a non-ancestor authoring head still
invalidate; the false cascade restores prepare through publish once, keeps an accepted
re-dispatched canonical result in history, closes a prepare attempt without an accepted
result, clears attention, and dispatches final review; a second pass does not reconcile
or dispatch again; the single work-stage cases from #253 and #240 remain unchanged.

## Step (m): reconcile a stage-plan amendment before changes_requested dispatch (2026-10-06)

Project-a #2023 showed that after a stage-plan amendment, `changes_requested` dispatch read
the new plan at the old state's index and launched a plain revision, so the plan change
was never applied: the new-plan stage at the stale index had a non-revision role, the
`stage_plan_changed` reconciliation in `ensureStageState` never ran, and the non-stage
revision's report parked the task.

- **Reconcile first.** When the declared plan digest differs from the stage state's and
a stage definition changed, `changes_requested` dispatch reconciles through
`ensureStageState` and dispatches through the stage engine instead of choosing a role.
A goal-only amendment changes no stage definition and keeps the ordinary revision path.
A staged brief with no stage state likewise dispatches through the stage engine, as the
`awaiting_review` branch does.
- **Stale-index guard.** `rerun_stage` and `reopen_stage` refuse while the plan digest
differs from the stage state's, so an operator control cannot act on the new plan at the
old index; the next pass reconciles first. The remaining indexed reads are safe:
`dispatchStage` re-reads freshly ensured state, stage callbacks match on stage id, and
restore matches records by stage id.
- **Mid-run amendments.** A stage completion arriving after a plan amendment reconciles
before reading the current stage, so a still-current stage still matches instead of
stranding on a superseded-stage attention with a stale state. When the amendment
redefined the running stage in place (same id, new definition), the result applies only
if the run's own attempt is still the live running record; otherwise it is retired as
superseded rather than judged by a definition it never ran.

Acceptance (step m): the #2023 shape (failed review in `changes_requested`, amendment
inserts a work stage before it) records `stage_plan_changed` and dispatches the inserted
stage with its identity, never a plain revision without a stage.

## Step (n): accept full stage matrices without bloating bounded projections (2026-10-06)

Project-a #1997 reported a complete 436-row canonical matrix whose serialized verdict list
was rejected by the old 48,000-byte cap, even though it was below the unchanged 500-row
limit. Partial callbacks cannot substitute for one authenticated whole-matrix report.

- **Report bound.** A verdict list may occupy up to 4 MiB of serialized UTF-8 JSON. This
  accommodates 500 rows with 120-character ids, 600-character subjects, up to 1,000
  characters of evidence and the existing 4,000-character optional note (about 2.9 MB
  for ASCII JSON), while leaving most of the 16 MiB service frame available for report
  fields and transport framing. The authenticated `/report` and `/complete` callbacks
  and the worker fallback accept up to 5 MiB so the verdict bound and ordinary report
  fields fit together; other callback endpoints keep their 64 KiB limit.
- **Read projections.** `uiTasks`, board cards and compatibility snapshots keep stage,
  review and run metadata but clear full verdict arrays. `queue.detail` and its immutable
  review records retain the complete verdict evidence.

Acceptance (step n): an authenticated 436-row stage matrix with `id === subject` and
1,000-character evidence is accepted in one report; an exact 4 MiB verdict list is
accepted and one byte over is refused; 501 rows and incomplete stage coverage remain
refused; run, reviewer-role and coordinator-generation checks remain unchanged; and a
stored 436-row review stays below the 128 KiB board budget while task detail retains it.

## Step (o): apply a stage result once from its live attempt (2026-10-06)

Concurrent `advance` passes could both validate one completed stage against the same
snapshot, await subject or PR checks, and then each increment the freshly read
`currentIndex`. The second pass could therefore attach the first run's result to the next
stage and skip its independent review. The same stale-index pattern existed in review,
work and stale-review-result transactions.

- **Atomic ownership check.** After awaited checks and inside the result transaction, Queue
  re-reads and matches the current plan digest, stage index and id, running stage record
  and its `runId`, task `currentRunId`, and stored completion event and status. It applies
  the record, cursor, review evidence and event only while that exact attempt still owns
  the current stage. A competing pass that has already settled or superseded the attempt
  is a no-op.
- **Dispatch once.** The next stage dispatch follows only a transaction that applied the
  result, so a losing concurrent pass cannot launch a duplicate run.
- **Shared guard.** Work/publish completion and stale-review invalidation use the same
  atomic ownership rule; they cannot overwrite a newer stage or duplicate their history
  and lifecycle events.

Acceptance (step o): deterministic concurrent application of one review completion and
one work completion each records one stage advance, leaves the cursor on the immediate
next stage, preserves the source run binding, and dispatches that next stage once; review
evidence and stage events are each recorded once.

## Step (p): compare asymmetric frozen subjects and bound unchanged invalidation loops (2026-10-06)

Project-a #1963 showed that the current stage's narrower digest declaration was being
treated as proof that paths frozen by earlier reviews had changed. A seven-path
canonical/verifier subject followed by a five-path publisher therefore invalidated
unchanged reviews and repeatedly dispatched canonical and verifier at the same head.

- **Compare the prior-path union.** Before stale-stage evaluation, Queue freshly hashes
  every path in the current stage subject and every path frozen by an advanced or failed
  record. A path omitted by a later declaration is compared using its worktree content;
  omission alone is not a change. A changed, missing or unreadable frozen path remains
  stale. Output authorization can excuse a changed digest only under the existing
  declared-output chain; it never excuses an absent path. External-head, exact-head and
  independent-review guards remain in force.
- **Bound no progress.** Before dispatch, Queue counts only consecutive `digest_changed`
  invalidations that start at the same stage and retain the identical candidate head and
  frozen subject. A plan/head change, an explicit `reopen_stage` or `rerun_stage`, or a
  different frozen subject starts a new sequence. After two unchanged invalidations it
  parks the task with attention before a third dispatch, preserving any live run binding.
  The reason directs the operator to inspect and restore the stage.
- **Reuse accepted evidence narrowly.** Same-content invalidation recovery runs only
  under the stage plan digest already recorded. It preserves an advanced review only
  when its original released reviewer run and accepted report identity still exist, the
  frozen subject exactly matches the current declared paths and head, and the current
  gate and evidence pins pass. `ready_to_merge`, row counts or a partial earlier report
  never manufacture a missing verdict or reading result. Authorized-output recovery
  continues through its separate path and retains its existing digest and ancestry
  checks.

Acceptance (step p): the engine advances the seven/seven/five subject flow without
re-review; a changed omitted path invalidates from the stage that froze it; a missing
omitted path cannot be excused and parks before review dispatch; repeated unchanged
same-stage/head `digest_changed` invalidations stop before another run, while a plan
amendment after one prior digest invalidation dispatches the amended stage; a genuine
exact-subject accepted canonical/verifier pair is reused once under the current plan and
gates; and an earlier selected verdict does not satisfy an amended gate that requires
the full reading.

## Step (q): reconcile an already-produced declared publication (2026-10-06)

Project-a #1999 showed a stranded recovery shape with no supported exit. A `publish` stage
changed its declared output (`manifest-glo.json`) after the accepted post-ingest
canonical/verifier pair, but its readiness callback was lost, so the publish record stayed
`running`. Queue invalidated the pair with `digest_changed`, and neither `restore_stages`
nor the automatic authorised-output reconciliation could restore it: both require an
advanced work or publish record at the result head as proof that the changed path was
authorised, and no successful publisher callback existed. A `retry_resolution` then
re-dispatched at the old head. The publication was already produced and signed; the
missing piece was a genuine authenticated record of it, not another publisher operation.

- **Operator control.** `queue.task` action `reconcile_declared_publication` (operator,
  versioned, with a reason and an optional exact `expectedHead`) is available on an
  unmerged staged task with no run owning it. It requires a trailing `digest_changed`
  invalidation whose unadvanced work/publish record is a declared stage with authorised
  `outputs`, and whose recorded result head is the frozen candidate it retains
  separately. Every later invalidated record must be a review or verify stage. It is
  refused while a declared-publication reconciliation run already owns the task. When the
  brief was amended to declare the signed artifacts but the stage state has not yet
  absorbed that amendment, the control applies the pending amendment itself, so an
  operator can run it directly after `amend_brief` without an intervening pass that would
  re-dispatch the stale pair. Only an amendment that changes declared `outputs` and no
  other stage field, and leaves `queue.goal` unchanged, is accepted; any broader change
  (including a changed goal, which would judge the restored evidence under a different
  goal) fails closed.
- **Proof before dispatch.** The control verifies the open, ready PR, the queue-owned
  branch, a clean retained worktree and the exact head through the ordinary PR identity
  check; the expected signed head is the operator's explicit `expectedHead` or the
  verified PR head, and it must descend from the producer's frozen candidate. It
  revalidates the prepublication chain's original released reviewer runs, accepted report
  identities, gates and evidence pins, and compares every actual path Git reports changed
  between the frozen candidate and the expected head against the declared outputs of the
  eligible work/publish chain. The changed paths are read NUL-separated and compared
  exactly, with no trimming or newline splitting, so a whitespace-padded filename can
  never normalize into a declared output; a new signed receipt, review or callback
  artifact needs an explicit brief declaration and no arbitrary file is excused. Every
  declared output of the eligible authoring chain must also be present and readable at the
  result head, even when no frozen subject names it. A change outside declared outputs, a
  missing or unreadable declared output, a changed expected head or an incompatible
  accepted review fails closed with no mutation. Every awaiting check is re-run against
  the live store and worktree before the intent is recorded.
- **Genuine run, then guarded restore.** The control records only the intent, the
  expected head and the operator reason, then dispatches one reconciliation run on the
  retained worker for the producer stage. Its prompt forbids re-signing, re-issuing,
  publishing, pushing, editing receipt pointers or replaying the publisher, and asks it
  only to confirm the identity and existing output and report `ready_for_review`. A
  blocked/error result is not an authority. On that authenticated callback Queue re-runs
  the whole proof against the live store and worktree and refuses to record when the task
  changed during the awaited checks, so no proof becomes stale across an await. Only the
  authenticated `ready_for_review` callback records the producer's advancement and output
  head into the recorded invalidation, merges any trailing output-only plan amendment into
  the authenticated reconciliation, and only then does the ordinary guarded output-chain
  reconciliation restore the eligible prepublication pair and resume at a fresh
  exact-signed-head terminal review. Nothing is advanced, restored or signed from the
  control or from recovery narrative.

Acceptance (step q): an already-signed publication whose verified head differs from the
stale task PR head and the producer's old frozen candidate reconciles using the explicit
or verified expected head, dispatches one reconciliation run on the retained worker,
records publish advancement only from its authenticated callback, restores the
prepublication pair without re-signing, re-issuing or editing any output, and dispatches
the terminal review at the signed head once; a declared receipt prefix admits a new signed
artifact while the same artifact without an owning declaration is refused; a pending
output-only brief amendment is applied by the control and merged by the authenticated
callback, while an amendment that changes more than declared outputs, or that also
changes `queue.goal`, is refused; a
declared output no frozen subject names still must be present, and a whitespace-padded
filename never normalizes into a declared output; a real change outside
declared outputs, a missing declared output, a wrong or diverged head, a live run, an
incompatible accepted review and a blocked reconciliation result all fail closed without
advancing publish; the control requires a reason and rejects a stage id; and a late repeat
of the same report cannot re-sign anything.

## Step (r): recover an authentic staged publication across a proven merge-only revision (2026-10-06)

Project-a #1963 (f808686a, PR2582) advanced a genuine signed publication — prepare,
canonical, verifier and publish at the signed head, with the terminal review accepted at
that signed head. A later owner revision merged current main into the retained branch
without changing any consumed input or any signed artifact. Queue saw the head move as an
external `head_changed`, invalidated the publication chain, re-dispatched a derivative
canonical re-review, then invalidated the whole chain again with `digest_changed` at
prepare because the destroyed publish record no longer excused the publisher's own
manifest output. `restore_stages` reconstructs only the latest invalidation batch, so it
could not restore an advanced publisher whose result head is an ancestor of the current
head rather than equal to it. The old terminal verdict could not approve the new head.

- **Merge-only revision proof.** `queue.task` action
  `reconcile_merge_only_revision {taskId, version, reason}` (operator, versioned)
  reconstructs the authentic advanced chain from the stored records whose result head is
  an ancestor of (or equal to) the latest authentic advanced work/publish result head. It
  requires the genuine stored retained revision callback (the retained worker's released,
  non-superseded `ready_for_review` completion run from the publication head) and binds
  it to the verified actual result: its own completion head must be the current head, or
  the normal handler must have durably recorded that run's completion as the task's
  accepted completion at the verified head, so a stale structured callback head is
  accepted only through the recorded verified result and never from its summary. It
  proves the verified open, clean, local and pushed candidate has that revision's merge
  on its first-parent history: the merge's first parent is the publication head and its
  second parent is an ancestor of `origin/main`, so only the current integration base
  contributed the incoming delta. It rejects changes to every exact frozen consumed
  path and treats signed publication artifacts as owned only when they are exact
  declared output paths or lie beneath a declared output prefix from the authentic
  advanced authoring chain. A path's parent directory never grants ownership of its
  siblings. Every other path in the actual diff must have the same tree entry at the
  verified candidate and the merge's second parent, including bytes, mode and presence;
  this admits a shared-directory sibling changed by main while rejecting a branch-only
  edit that merely resembles an incoming change. The only additional proof scope is an
  operator-supplied owningDocumentPaths list of at most eight exact normalized Markdown
  paths under docs/. Each declared path must be an already-existing changed regular
  file, and cannot be consumed by the preserved chain. Queue reads its exact blobs
  at the publication head, the unique merge ancestor, the incoming second parent and
  the candidate. All four entries must be mode 100644, UTF-8 text under 512 KiB, with
  the candidate must byte-match Git's
  merge-file --stdout --union result, or that result with exactly one terminal LF
  appended when the union lacks it. Queue rejects a second ancestor, missing blob,
  binary or invalid UTF-8 content, mode/type/add/delete/rename/copy changes, lost branch
  lines, forged lines or other byte changes. This is exact proof scope only: it grants
  no authority to change consumed source/rights or brief bytes, and it never changes the
  original review subjects or skips the fresh terminal review. A new path is admitted
  only when its exact content is already in the verified base. If an artifact's
  ownership is ambiguous, recovery fails closed: name a consumed file as an exact
  frozen subject path, or a signed artifact as an exact output path or narrow output
  prefix. Such a declaration identifies ownership; it does not waive source or rights
  bytes.
  NUL-delimited `--name-status -z` Git paths and literal pathspecs preserve exact path
  identity, so a whitespace sibling such as `manifest.json ` can never be folded into
  the declared `manifest.json`. Frozen prepublication hashes are checked only through the authentic
  publisher's declared-output chain, never called a current input change. A missing
  object, a rewritten history, a plain fast-forward that did not merge, a merge whose
  second parent is not the integration base, a missing or superseded revision callback,
  an unbound stale revision callback whose summary alone claims the head, a
  changed consumed input or signed artifact, a changed plan or evidence, an absent or
  superseded stored identity, a live run, and a merged task all fail closed.
- **Effect, in one transaction.** The authentic advanced prepare/canonical/verifier/publish
  records and their original heads, receipts and history are restored; every derivative
  attempt, including the old terminal at its signed head, is archived immutably in
  `history`; only the consumed head/digest derivative invalidations are dropped; the
  proof and any exact owning-document paths are recorded on the stage state; and the
  current index resumes at the stage after
  the publisher. Queue then dispatches exactly one fresh independent terminal review at
  the exact current head under the original terminal gate. It never re-prepares, re-signs,
  re-issues, pushes, replays a receipt, relabels the derivative canonical report as
  terminal, or reuses the old terminal verdict to approve the new head. The proof-input
  task version, head, plan digest and invalidation identity are captured before the
  awaited proof and re-checked in the mutation transaction, so a task change while
  proving cannot be blessed under a freshly sampled version.

Acceptance (step r): the #1963 shape (head_changed owning the advanced publisher and old
terminal, then digest_changed owning prepare and a derivative canonical, with consumed
paths under shared `syllabus/` and `system/` roots and unrelated incoming-main changes
beside them) restores the genuine chain. The full #1999 regression carries all 266
changed paths, including the shared calibration ENG sibling and the exact append/append
composition at `docs/knowledge/domain/source-documentation.md`. That file is admitted
only when its candidate blob equals the union of the signed, unique-common-ancestor and
incoming blobs with at most one missing terminal LF; all other incoming paths still
match the verified second-parent tree. The original GLO manifest, frozen source and
rights, and explicitly declared receipt, review and callback artifacts remain
byte-identical. Restoration under the retained dispatch hold launches no terminal;
only owner release dispatches one fresh terminal at the exact verified head, with the
original review gate and subjects. Tampered union bytes, removal of either branch block,
extra lines, a consumed document declared as an owning document, unsupported
file types or path normalization, binary/mode/symlink/rename/delete changes, missing
objects or an ambiguous common ancestor all refuse without dispatching. A consumed GLO
manifest change, a modified/deleted/renamed declared receipt, review or callback, a
branch-only edit to the ENG sibling or whitespace sibling, a linear or sideways
non-merge head move, a merge whose second parent is not the integration base, a missing
or superseded revision callback or stored identity, a stale structured revision
callback that is not the recorded accepted completion at the verified head, a changed
plan or review evidence, a live run and a task mutation during the awaited proof all
refuse without dispatching. A duplicate control after recovery is a no-op that retains the original decision and exact terminal approval.

## Successive merge-only revisions (2026-10-06)

The first accepted merge-only recovery records both immutable publication identity
and the exact head it carried forward. A later retained revision starts from that
carried head. Its authenticated callback and stored normal-result association must
bind the newly verified PR head; the revision merge must have the carried head as
first parent and the current integration base as second parent. The initial
publication head remains the identity of the publisher and the original signed
chain, while each new merge is proved only against the preceding carried head.

The original legacy verifier receipt stays bound to its original callback, intent
head and chain digest. Once that association is genuine, an unchanged-input merge
does not require another full legacy verification or preparation run. Each new
head still requires its own clean, pushed Git proof and one fresh exact-head
terminal review; an earlier terminal result remains immutable history. The exact
owning-document proof uses the previously carried blob, its unique common ancestor
with the new integration base, that base's blob and the candidate blob. Other
incoming paths must match the current integration tree exactly. A changed consumed
input invalidates its earliest dependent stage; a changed signed output refuses
preservation. No path can replay publication or signing work.

Automatic authenticated callbacks and the existing `reconcile_merge_only_revision`
control share this proof, including after restart or when the tail was already
invalidated. Dispatch holds remain authoritative: accepted proof may restore the
chain under hold, but only release starts one terminal review. Duplicate callbacks,
restarts and awaited-proof races cannot create a second terminal.

Tom's delivery ruling (2026-10-06) is that ordinary successive merges which leave
consumed inputs and signed bytes unchanged preserve genuine completion. Queue
machinery must not create preparation or review churn to satisfy its own state
model.

Acceptance (successive revisions): authenticated normal callbacks from the real
retained worker carry the original seven-stage chain across both two-merge and
three-merge histories, with actual first-parent and second-parent Git proof and
the large append-only owning-document union. Under a dispatch hold, automatic
restoration, restart/duplicate delivery and explicit recovery of an already
invalidated tail all preserve the same original chain and dispatch exactly one
terminal after release at each new head. Changed consumed bytes invalidate from
the earliest affected stage; changed signed bytes refuse without bypass or
producer replay.

## Reusable subjects

An approved brief may declare `queue.subjectSets: {version: 1, sets: {name:
{head: candidate, digests: [{path}]}}}`. A stage opts in with `subject: {ref:
name}`. For example, canonical, verifier, publisher and terminal can reference
one set containing hundreds of exact paths. Each stage still declares its own
kind, role, independence, gate, actions, evidence, outputs and waits. There is
no default set or implicit inclusion.

A reference may explicitly add dependencies with `addDigests: [{path}]`.
It cannot replace or remove a shared dependency. Duplicate paths, unknown
references, whitespace around names, unsupported versions and mappings that
combine a reference with an inline subject are refused. Sets contain only
inline subjects, so cycles and nested references are refused at admission.

Brief admission and runtime reading use the same compiler. All consumers see
resolved inline definitions. Equivalent inline and referenced declarations
have the same plan digest and stage comparison, and existing inline briefs
retain their digest and meaning. An unused set or a renamed set does not
change stage identity; changed resolved inputs do. Subject sets remain local
brief facts, omitted from submission queue fields, without expanding portable
008/009 records.

## Verified result identity

The normal authenticated worker, authoring-stage, reviewer and retained-revision
completion boundaries append a host-local result association. It distinguishes
the run's candidate and callback head from the verified clean retained worktree
and pushed open PR result. It binds the callback digest, run, actor, workspace,
model, reporting brief version, accepted plan version/digest and compiled subject
set. A stage record links its accepted event to this association. Replayed
results keep the original association; a later push cannot replace its head.
The compact board and portable 008/009 records omit this internal proof history.

Work, publish, intermediate review and terminal review share one transactional
outcome application. It checks the captured task/run identity after awaited
external checks, then records the result association, stage outcome and next
cursor together. The terminal still approves only its exact verified head.
A changed cursor, callback, retained identity or superseded run cannot settle an
old attempt under a newly sampled version.

Merge-only recovery no longer treats `task.completion` and the current
`task.prHead` as an association for a stale structured callback. It consumes the
original verified association instead. Legacy records and history remain intact;
a legacy callback with an exact result head can still prove that head, but an
unbound stale callback or headless authoring result cannot gain authority during
recovery. A leading worker's accepted event is retained even after a later
revision replaces the task's current completion. Missing original proof remains
a visible refusal requiring genuine authenticated evidence, never a migration
that manufactures a verified result.


## Normal merge decisions

A released normal retained revision with an original verified result association
uses the same byte, ancestry, ownership and authenticated-chain proof as
`reconcile_merge_only_revision`. It can preserve a current advanced chain before
any derivative invalidation occurs. The preserved producer and reviewer records
keep their original run, report and head identities; only the stage after the
publisher resumes at the new verified head. A dispatch hold permits the proof
and state decision, but launches nothing until release.

An authoring stage may explicitly declare `preservedOwningDocuments` using the
same normalized exact Markdown paths as the existing recovery control. The
compiled plan permits at most eight such documents. Normal continuation uses
that proof scope with the reviewed Git union and single-terminal-LF check.
Consumed paths remain ineligible regardless of declaration. Existing non-document publication outputs remain immutable.
Existing inline briefs without this field keep their original semantics.

A real consumed-byte change selects its earliest consumer and invalidates that
stage and downstream records, preserving earlier identities. A recorded
invalidation increments the host-local generation once. An unchanged-input head
that cannot prove the supported base merge stays owned for proof inspection;
it never supplies permission to replay a producer. The recorded decision names
the reason, verified head, subject identity, preserved chain, earliest step,
next action and owner. Detail renders those fields directly. Merge proof state
also retains the merge commit, integration parent and observed origin/main.

Compatibility: current-chain proof removes the requirement for a derivative
invalidation before merge-only preservation, and replay consumes the recorded
decision rather than requiring another recovery episode. Original callbacks and
legacy histories remain intact. In particular, #1999's old structured callback
and task completion both name 04914 while the observed PR names c1aa; neither
is rewritten to supply missing verified-result authority. Legacy verification
without an original association remains a refusal pending genuine bounded
verification evidence.

## Bounded legacy verification

Read-only `classifyLegacyMerge` runs the production identity, chain, Git topology,
exact input/output and owning-document proof. An otherwise provable legacy merge
without its original result association returns `verification_required`. It
never creates an association, changes an old callback, supplies missing reading
credit or accepts a blocked publisher. Missing objects and incomplete original
review matrices still refuse. Closed tasks with removed retained worktrees
cannot be re-proven by substituting another checkout.

The existing `reconcile_merge_only_revision` control records one host-local
verification intent bound to the unchanged head, current plan, original revision
run/event/callback digest, advanced-chain digest and exact document scope. Under
a dispatch hold it records the intent and launches nothing. Release uses the
existing configured coordinator verification role and durable run reservation;
it bypasses pre-merge verification because this run establishes legacy result
provenance, not terminal approval or merge authority.

The prompt permits inspection only. A fresh authenticated `verified` callback
must name the requested unchanged head and supply both
`legacy-callback-identity` and `legacy-advanced-chain` judgments as `pass`.
The report bridge and completion gate accept these judgments only for the run
bound to that pending intent. The leading initial admission's provenance and
all original stage gates, evidence, producer/reviewer identities and independence
must remain provable. The new receipt is distinct from the old callback and
cannot manufacture a missing original readiness report. PR verification and
production proof run again; the atomic apply rechecks the captured task/run and
original chain before recording the fresh receipt. The same merge preservation
path then restores the eligible chain and requests one fresh terminal at that
exact head, without any producer, pair, ingest or signing replay.

The intent binds its run before delivery. Restart or an unknown create/send
outcome retains that run for inspection instead of launching again. An explicit
`retry_resolution` may request another bounded attempt only after a released,
authenticated blocked/error verification result; uncertain delivery must be
resolved first. Old attempts and callbacks remain immutable history. Head, plan,
actor or proof changes require inspection, not a blind retry. Detail projects the
recorded decision and current hold/run into the supported next action while
preserving pending instructions and evidence.

Implementation compatibility: shared subject compilation replaces repeated
admission/runtime expansion; verified result receipts replace inference from a
later task completion or PR push; shared outcome application replaces separate
work/publish/intermediate/terminal advancement branches; normal revision and
operator recovery share merge preservation instead of requiring derivative
invalidation and a planner restoration ritual. Legacy inline briefs, role
routing, gates and portable outcome facts retain their meaning. Internal proof
receipts, generations and decisions are additive host-local state.


## One merge continuation, without producer replay

Normal retained-revision callbacks and explicit merge recovery use the same
proof. A verified carry point refers to the original authentic publication
chain; it is not a new producer or reviewer result. Each later merge must have
its own released retained-revision callback and exact verified result identity,
first-parent carry point and integration parent. A genuine legacy verification
continues to authenticate its original immutable chain at the historical head;
it does not approve a later head or substitute for a later callback.

Authoring outputs declare write scope, not that every emitted file is signed.
A changed, nonconsumed Markdown document under `docs/` that is explicitly within
that scope uses the existing exact four-blob Git union proof automatically.
The same proof applies to an explicit owning-document scope. No parent directory
owns its siblings and no documentation path is exempt from byte proof. Sources,
rights and other inputs in the preserved chain remain byte-identical. Existing
receipt, signature, review, callback, manifest and trust outputs cannot be
modified, renamed or removed. A consumed document never qualifies for union.

A retained merge revision may finish with linear commits adding new regular
files inside its already declared output scope. The underlying merge and its
integration parent are still proved separately. Every post-merge change must
be an addition, must be nonconsumed, and must fall inside that explicit scope;
changing any existing file fails. The clean pushed result and its authenticated
callback bind the whole tip. These additions receive no inherited review credit:
the preserved chain resumes at one fresh exact-head terminal, where the existing
publication and source gates still apply. Neither automatic continuation nor
recovery dispatches a producer, signer or replacement review pair.

Acceptance included the frozen F2 #2094 history: actual canonical/verifier gates,
six-receipt publisher and signed-head terminal, a main merge of the owning
knowledge document, and a separate declared merge-validation addition. The
original stage/run identities survive under hold, release dispatches one terminal,
and repeated merges and restart do not replay preparation, ingest or signing.
(Historical acceptance record: the execution code and the #2094 fixture were
deleted on 2026-10-13; the sanitized history remains in the 2026-10-05 capture
records cited by this spec.)
Undeclared additions, existing-output edits, consumed edits, signed receipt edits,
false callback identities, incorrect parents and proof races still fail closed.


An authenticated ordinary review correction before a publication is not a
merge-preservation request. Queue records its verified result head separately
from the original prepare result and applies ordinary frozen dependency
staleness before the next review. A fresh review certifies only the corrected
subject; the old prepare and failed review remain history. Merge topology is
required when carrying a published chain, not to admit genuine author changes.
