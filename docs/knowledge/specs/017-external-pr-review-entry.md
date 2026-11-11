# 017 — Review entry for externally authored PRs

Status: implemented
Owner: Nucleus runtime and protocol maintainers
Created: 2026-09-21
Decision owner: Tom
Governing refs: [orchestration](../contracts/orchestration.md),
[repository hooks](../contracts/repository-hooks.md),
[service boundary](../contracts/service-boundary.md),
[durable operations](012-durable-asynchronous-operations.md),
[prospective merge](015-prospective-merge-pre-merge-hooks.md)

## Problem and authorization

A finished external PR has no Nucleus task or surviving authoring agent. Nucleus
needs an explicit review entrypoint, then its ordinary review, revision,
verification, merge, sync and closeout path.

Project-g Chatterbox supplied the request on Tom's direction. Tom approved the
implementation-spec step after the design response. This document approved the
original design, not dispatch, intake of motivating PRs or live acceptance runs.
On 2026-09-30 Tom answered decision `06b1f944-4638-429d-ad1d-25672a2e248f`
version 2 through the operator board: **"Authorize the Queue review-intake
fix"**. This authorizes the bounded Nucleus implementation in task #110. It does
not create an external approval, authorize automatic PR intake, or authorize
operating the motivating Project-d PR. Intake still requires a checked Nucleus
brief approval and fresh external identity proofs.

On 2026-09-30 Tom answered operator-board decision
`8f759587-b206-4161-91a6-f4687d22e1dc` version 2: **"Allow one isolated PR124
review workspace and finish the brief-mode intake fix"**. Tom also answered
"Yes" in chat that day. This supersedes the shared-canonical acceptance request
for task #110. It authorizes one isolated Nucleus-held-brief review workspace for
Project-d PR124 after this fix lands. It does not authorize operating Project-d in
implementation tests, inventing an external approval, changing the source thread,
creating another task or dispatch, or building a general workspace reservation
system.

Tom requested one general Nucleus repair on 2026-10-31, relayed by Consumer-b
project owner `5d5a609a-6d2e-4f10-85d1-48cc1f181a71` in message
`c062d973-067a-4614-b8e6-0eecc6fba7e6`: an external author submitting a finished
PR during their own turn must be accepted, and reviewer execution must wait for
the author to yield instead of asking the operator for a timing retry. Papercut
`5e627254-33f3-4a36-b8e7-edf112d1c583` records the stuck shape. This authorizes
implementation through normal Nucleus independent review and guarded integration,
not a consumer gate bypass: exact-head review, workspace, permission, author and
closeout protections are unchanged.

## Outcome and boundaries

- The first task agent is an independent canonical reviewer, with a real review
  run and authenticated reporting credentials. No placeholder worker is created.
  Preview and bind apply the same independent-review routing preflight as
  promotion ([Spec 030](030-routing-changes.md)) to declared author models and
  any required reviewer request, so a pairing that cannot be independent is
  refused before task binding. No initial worker is invented.
- Acceptance and execution are separate. An active or uncertain source writer -
  the origin author finishing the turn that produced the PR, in the selected
  workspace or elsewhere, or another thread mid-turn in that workspace - never
  refuses a handover and never authorizes execution. Intake binds the one task
  with its exact identity and records the wait visibly; the ordinary admission
  pass re-proves the same exact source later and launches the reviewer only once
  that fresh proof observes the writer yielded. A foreign Nucleus ownership
  conflict stays a refusal, because it is not activity.
- The task owns one existing workspace, one existing branch and one open PR.
  Reviews run in the task's one workspace, like ordinary Nucleus reviews. Nucleus
  owns that workspace after the accepted handover; before each reviewer send it
  waits for the origin writer to yield and proves the checkout clean at the exact
  open PR head. An explicit `shared_canonical` input
  is retained for compatibility but refuses with
  `exclusive_writer_unavailable` before workspace inspection, binding or agent
  intent. Intake never creates a workspace, worktree or branch, and never
  resets, cleans, rebases, pushes or renames the supplied branch.
- The lead-based CLI route may prepare an isolated Paseo `checkout-pr` workspace
  before preview and start when the caller omits a workspace ID. This is a
  separate Paseo action with a stable request ID; successful binding records the
  workspace as intake-owned for guarded closeout. The review-entry service still
  accepts only an inspected existing workspace.
- Changes requested create the first worker in that same workspace, after the
  reviewer releases its lease. Later cycles retain ordinary worker/reviewer runs.
- Existing exact-head, comment, independence, capacity, FIFO integration,
  prospective-merge, durable effect and closeout gates apply unchanged.
- Initial implementation exposes direct CLI/API intake and ordinary board/detail
  visibility. No new native intake wizard or general-purpose PR import belongs here.

If the external checkout/workspace no longer exists, the approved-lead CLI may
prepare a `checkout-pr` workspace before preview; direct API callers must arrange
an existing workspace first. A local path alone cannot substitute for an
inspected Paseo workspace identity. V1 accepts branches in the canonical
repository's origin, not fork PRs or alternate push remotes. `workspaceMode` is
optional and defaults to `isolated`. `shared_canonical` is unsupported until
Nucleus can enforce an exclusive-writer reservation; preview and start return the
typed refusal before reading the external checkout or changing ownership.

## API and immutable input

Use `queue.operation-start` with `kind: review_entry`, the existing stable `key`,
and a strictly validated payload:

| Field | Meaning |
| --- | --- |
| `submission` | Existing canonical submission identity, repository, base branch, planning commit, handoff/instruction, scope, dependencies, origin and notification fields. |
| `workspaceId` | Paseo workspace, inspected against its real directory and Git common directory. The lead CLI prepares an isolated `checkout-pr` workspace when none is supplied; direct API inputs still name an existing workspace. |
| `workspaceMode` | Optional `isolated` (default). `shared_canonical` returns `exclusive_writer_unavailable` before adapter calls or task binding. |
| `prNumber` | Positive PR number in the canonical origin repository. |
| `expectedBranch` | Exact existing source branch; becomes immutable `task.branch`. It need not have Nucleus's generated branch prefix. |
| `expectedHead` | Full commit ID; must equal clean local HEAD, remote branch and PR head. |
| `expectedBaseCommit` | Full current integration-tip commit at intake, not the historical fork point. Local integration tip and remote target tip must equal it during binding. |
| `authority` | Required operator takeover instruction, bounded by the existing operator-authority limit. |
| `authorDeclaration` | Required `models` list, `githubAuthor`, `authoringSystem`, `attestedBy` and nonempty `provenance` explaining the declaration. |

Reuse existing bounded strings, commit-ID syntax and payload/frame limits. Model
IDs must be concrete provider/model identities; `unknown`, `default`, tool names
and open-ended model sets are invalid. Canonicalize and deduplicate model IDs for
the operation digest and independence check. Reject `skipPRReview: true` and
worker identity or resume flags. No caller-supplied phase, run ID, completion,
review verdict or worker identity is accepted. Reject contradictory duplicate
identity fields in the outer operation envelope and payload.

Add `queue.review-entry-preview` with the same payload, returning `eligible`,
bounded resolved identity facts, a list of refusal codes with explanations and
`pendingHandover`. Eligibility is acceptance: a transient source-writer
condition is reported in `pendingHandover` as the exact activity a fresh
admission proof must first observe yielded, so an accepted handover is never
presented as readiness to execute. `pendingHandover: null` means the preview
proved readiness to execute now. An activity the adapter cannot positively read
as transient is unknown, so it refuses instead of waiting. Preview does not
persist an operation/task, reserve capacity or ownership, create
reporting files, emit hooks or contact agents with prompts. Git proof may fetch
remote objects/refs; it does not alter checkout files or local branches. Ordinary
transport failures remain typed unavailable responses, not fabricated absence.
Refusal codes distinguish `identity_mismatch`, `planning_invalid`,
`ownership_conflict`, `workspace_busy`, `author_identity_unverified`,
`permission_unverified` and `hook_incompatible`; include which proof failed and
bounded expected/observed facts. `permission_unverified` is the unavailable class:
a repository response that reports `permissions.push: false` or omits the
`permissions`/`permissions.push` field proves nothing about the reviewed source,
receipt or author, so the dated-owner canonical proof keeps the exact-head review
and waits for a fresh permission proof instead of clearing credit; a positively
unmatched author or source identity keeps its hard classification. The same rule
covers the canonical PR response: an omitted, blank or malformed author login,
`state`, `draft`/`merged_at` status, head/base repository, head/base branch,
head SHA or `html_url` is an unavailable observation (transient
`author_identity_unverified`/`identity_mismatch`) that keeps credit and blocks
the merge, never a different value read from nothing, and never a fallback to a
saved value; only a concrete different value, or a positively read
closed/merged/draft/deleted PR, is drift. Capacity, pause, dependencies and role availability
are launch waits, not permission to skip validation or claim an invalid PR.

JSON CLI preview and start use the shared direct client and operation-status contract.
The lead route reads the checked lead, builds the same submission provenance as
`lead.promote-task`, reads the PR branch/head from GitHub, and previews before
starting; an omitted workspace is prepared as a `checkout-pr` workspace first.
Start performs bounded local shape/instruction capture, durably accepts the input,
and returns a receipt without waiting for remote validation. Acceptance is not
binding, dispatch or review approval. Remote/Paseo unavailability remains pending
validation with bounded retry under existing operation scheduling; it does not
lose the operation or permanently declare the PR absent.

The key and normalized input digest reconcile repeated delivery. Identical retries
return the existing operation/task; changed input under the same key conflicts.
A changed inspected head/base before binding requires a corrected request and new
key. A bound task must be recovered or explicitly disposed of, never duplicated
under another key to evade an ownership refusal.

## Pre-binding refusal and operator reconciliation

A refusal raised before binding is definite. `ReviewEntryRefusal` settles the
operation `failed` whatever its explanation says: an origin reading "active or
uncertain turn" that the adapter did not positively classify as transient is a
refusal, not an unknown effect. Before binding, review entry only reads. No remote
write, branch change or agent contact precedes the binding transaction, so an
absent binding is the whole effect proof.

A positively read active or uncertain source writer is not a pre-binding refusal
(see "Author-turn handover acceptance" below): intake accepts the handover and
the task waits for a fresh idle proof. A foreign Nucleus ownership conflict, a dirty
or changed workspace, a moved head, branch, base, author or model declaration, and
an unreadable identity remain refusals with their own bounded facts.

Operator ruling, 2026-10-12 (Tom): an attention-held review-entry operation may
be rearmed only by an explicit operator request on that exact operation. Nucleus
never resets `needs_attention` generically and never mints an approval from
repaired conditions.

`queue.review-entry-reconcile` takes `{ operationId, inputHash }`, both copied
from the stored operation. It is operator-only and mutating.

- Returns the operation unchanged when it is `pending`, `running` or
  `succeeded`. A `failed` operation is refused; repeat its key with the same input
  to reopen it through acceptance.
- Proves complete absence, before the await and again inside the reopening
  transaction. The scope is this operation only. It covers:
  - any task (removed history included) that owns this operation, and the
    submission ID plus its tombstone;
  - any workspace, branch or PR identity bound to another task;
  - any recorded effect or result on this operation;
  - any non-failed operation on this submission, and any task-linked one;
  - any unfinished review entry (`pending`, `running` or `needs_attention`) on
    the same repository and workspace, branch or PR.

  Unrelated settled history is not scanned; its tasks are checked by identity
  instead. The unfinished set is bounded by the operation limit. It reads stored
  state only. The operation's diagnostic is never evidence.
- Runs a fresh preview, so PR head/base/author/permission, the exact current
  source approval and the handover condition all rerun under the same
  acceptance boundary as ordinary intake: a positively read transient
  source-writer activity is reported as `pendingHandover` and does not make the
  preview ineligible, while an unreadable, mismatched or foreign-owned condition
  still refuses. An ineligible preview refuses without changing state.
- Keeps the same ID, key, stored payload and input hash. It appends the prior
  attention record to history under `reviewEntryReconciliation:<operationId>`
  (attempt, attempt count, diagnostic, settled and reconciled times) and only then
  reopens the operation as `pending`. History is append-only. A first refusal
  stays readable after later rearming.
- The operation backlog bound still applies and refuses reopening when full.
  Pause does not gate review-entry intake today, and this change does not add a
  pause gate.
- Admission then reruns every intake proof and binds once. A rearmed handover is
  still accepted under its recorded wait, and the first agent is still the
  independent reviewer with no initial worker or callback.

A lost response reads through `queue.operation-status` for the same ID. Repeating
the reconciliation after it reopened returns the pending operation and appends no
history. Reconciliation refuses when absence cannot be proven. The refusal names
the blocking identity, and the history scan is bounded at 1,000 operations.

## Identity proof, races and ownership

Before task creation, verify all of these facts:

1. Canonical repository and workspace paths are real Git roots with the same Git
   common directory. The existing isolated workspace differs from the clean
   integration checkout. It is attached to `expectedBranch`, which differs from
   the integration branch.
2. Origin identifies the expected GitHub repository. PR is open, unmerged,
   non-draft, authored by the declared GitHub account, and has the exact source
   repository/branch and target repository/branch. Nucleus has the rights needed for
   its normal review, revision and merge path; a failed permission check is not success.
3. Tracked/index/untracked worktree status is clean under the existing canonical
   clean-worktree proof. Local, remote and PR heads equal `expectedHead`.
4. Local and remote integration refs are synchronized at `expectedBaseCommit`.
   Published planning is an ancestor of that base. For a committed handoff it
   must also be an ancestor of `expectedHead`; a Nucleus-held brief is not in the
   repository, so its PR head may predate planning. Handoff bytes and
   instruction digest match the pinned artifact. Brief mode instead proves the
   exact digest, version, checked Nucleus lead/draft approval and pushed planning
   ancestry; it reads and writes no repository handoff file.
5. The Northstar planning reference resolves unambiguously from the committed
   handoff when handoff mode is used, with the repository's existing
   roadmap/task-link rules. Brief mode uses its checked Nucleus source and pushed
   planning ancestry without reading a handoff. Required pre-dispatch hooks
   remain mandatory before reviewer launch.
6. No active turn, pending permissions, uncertain delivery or other live agent
   lease can write the supplied workspace *while a reviewer executes*. Check the
   origin author even when it is not attached to that workspace. An active or
   uncertain writer is the handover condition, not a refusal or an exemption: the
   handover binds durably and records the wait, and execution requires a fresh
   proof in which that writer is positively idle. No other Nucleus task/retained
   lease owns the workspace, canonical repository/branch pair or PR identity.
   Apply existing ownership protections to retained terminal records too.

Read external proofs asynchronously, then perform the final local ownership and
input/version checks and task binding in one Store transaction with no intervening
await. Every competing acquisition path, including normal task submission and workspace
binding, must enforce the same exclusions. Do not rely only on a check
before an await or only on the new intake path. Two concurrent inputs cannot both
bind one workspace, branch or PR.

Persist task creation, immutable import evidence, operation result/task ID and
ownership together. A crash cannot leave an unreported second task or consume a
receipt without a discoverable task. Never claim atomicity with GitHub: repeat
live head/workspace/lease proofs immediately before reviewer intent. Any subsequent
remote movement invalidates the reviewed-head gate and stops progression.

Before binding, deterministic mismatch leaves a failed operation with no task or
agent. After binding, mismatch holds the existing task with bounded evidence and
retains ownership. There is no silent head/base repin, automatic branch repair,
old-review import, retry of uncertain creation, or new-task replacement.

## Author-turn handover acceptance and deferred execution (task 493)

Previously stored reviewer credits remain historical evidence. An authenticated
exact duplicate reconciles its existing receipt; a new reviewer callback, including
a checkpoint, must be bound to the task workspace and the current exact head. For a
stopped reader without a checkpoint, a default restart refuses. `next` offers the
explicit `restart role=reviewer fresh`; move to review preserves an active reader
and refuses an idle one with the same exit. A valid checkpoint continues its
original run.
This Nucleus owner mechanism preserves Tom's 2026-10-27 preserve-or-refuse decision.

The external author submits the finished PR during the turn that finished it. The
origin thread is therefore active at exactly the moment intake runs, and when the
selected workspace is the author's own checkout that workspace is active too. The
original intake treated that activity as an ordinary busy refusal, so it failed
before binding and never reached the queued transient wait admission already used
for a bound task. The author was left with no supported route except timing it
manually.

Acceptance and execution are now separated at that one boundary:

- **Acceptance.** Preview and the durable `review_entry` operation accept a
  positively read transient source-writer condition. Everything else is still
  proven at acceptance: canonical isolated workspace, repository and Git common
  directory, branch, clean worktree, exact local/pushed/PR head, synchronized
  expected base, planning lineage, brief or handoff artifact, author and model
  declaration, repository permission, dependencies and unowned workspace/branch/PR.
  One task, one operation result, one brief/source claim and the exact identity
  bind together, and `pendingHandover`/the task reason and one `review_entry_bound`
  event name the activity that deferred execution.
- **Wait.** The task is `queued` with an `origin_busy` wait: a waiting stop with
  no suggested verb, because only the writer yielding clears it. The adapter
  names the origin author when it is the active thread, whether it is attached to
  the selected workspace or working elsewhere, so the reason identifies the
  handover's own blocker instead of a generic busy workspace.
- **Execution.** The ordinary admission pass is unchanged. It freshly re-proves
  the whole source against the recorded pin, refuses any transient writer activity,
  and admits only when the proof itself observes the writer yielded — then one
  independent reviewer launches, selected exactly as before. Yield alone is
  enough: no resubmission, owner verb, detached submission or timing retry.
  Head, branch, base, workspace or identity changes are handled by the existing
  gates and visible disposition; a stale pin is never reviewed and a new head is
  never silently credited.
- **Execution custody.** Admission is a decision, not the launch. The task's own
  lease observes Nucleus runs and task agents; it can never see the external origin
  author or another thread in the source workspace. Every fresh reviewer of a
  handover — whether the workspace is the author's own preserved checkout or a
  supported intake-owned isolated one — therefore re-proves the same two things at
  its own launch boundary: the writer's yield as the last awaited proof, and then
  the exact local source synchronously — the bound workspace still clean on the
  recorded review head. There is no await between that proof and the run-intent
  write.
- **Reviewer placement (Tom, 2026-11-02).** A review-entry reviewer runs
  in the task's workspace and follows Spec 057 Placement: a later round reuses
  the retained reviewer thread after Nucleus has moved the checkout to the exact
  head. Intake's `origin_busy` wait remains, and Nucleus re-proves writer yield,
  clean tree, exact HEAD and open PR head at each send. The accepted intake
  record remains the source of the task's identity; it does not create a second
  workspace. Revisions run as Nucleus workers in the task workspace. No round
  creates a pinned view; a stored one is history (see "Stored pinned review views"
  below).
The boundary stays fail-closed. An activity the adapter cannot positively read as
transient (a missing `busyTransient`) is unknown and still refuses before binding;
a foreign Nucleus ownership label, a dirty or changed workspace, unreadable forge,
author or permission observations, a moved head/base and a changed author or model
declaration all keep their existing refusal, hold or wait with their own evidence.
The handover wait adds no new retry mechanism, no caller-supplied activity
exemption, no shared-canonical mode, no source mutation and no duplicate task. A
restart during the wait preserves the same task, operation, source claim and
review-entry record, and the same fresh admission proof resumes automatically;
repeating the key reconciles the same acceptance rather than binding a second
task or sending a second reviewer.

## Task state and capacity

Add explicit backward-compatible task provenance: ordinary tasks default to the
existing entrypoint; imported tasks carry `entrypoint: review` and an immutable
`reviewEntry` record containing operation ID, PR/repository/branch/workspace,
verified head/base, planning artifact, authority, author declaration and check time.
These are imported facts, not an authenticated worker completion. Keep declared
external models separate from subsequently observed worker models.

The bound task starts queued for review admission. Branch/workspace reservation
prevents duplicate ownership while it waits, but it does not manufacture a worker
slot or ignore configured capacity. Dispatch recognizes this entrypoint, obtains
one ordinary global/project task slot, verifies current proofs and required hooks,
then enters `awaiting_review` and launches a canonical `reviewer` run. A handover
accepted under source-writer activity keeps its exact task, source claim and
identity and stays `queued` with a visible `origin_busy` wait: the ordinary
admission pass re-proves the whole source and launches the reviewer only after a
fresh proof observes the writer idle, so yield alone is enough and no resubmission
or owner retry is needed. Paused/held
state and dependencies prevent launch normally. Failing/pending CI can enter
review; it cannot pass the existing verification/merge checks.

`expectedBaseCommit` fences initial binding. If main advances before admission,
verify the new clean synchronized base and planning ancestry, record the dispatch
base separately, and pin the pre-dispatch hook occurrence to it. Preserve the
original import proof. A moving PR head remains a refusal; ordinary integration
base advancement is handled by existing current-base verification.

Once admitted, the same slot remains held through reviewer, changes requested,
worker revision, verification, merge, sync and closeout, including attention
holds. Role usage/profile assignments count actual reviewer/worker runs; no worker
assignment is recorded at entry. Do not add a separate reviewer task-slot pool.
Board/detail show review-entry provenance, current phase and authority. Telemetry
starts at import/review admission; external authoring time is unknown, not a
fabricated zero-duration worker run or recreated historical timeline.

Required `task.pre_dispatch` hooks run on the pinned, validated integration base
through the normal hook occurrence machinery before the first reviewer. They
receive the real task/planning identity without a fictitious worker. If a hook
requires an initial worker-only fact, refuse with the incompatibility; do not skip
it or insert placeholders. Hooks may use their normal owned scratch checkouts;
the prohibition on creating a workspace concerns the imported task workspace.

## Independence and first revision worker

Operator attestation is the external author evidence boundary. A GitHub username,
Grok Bot or Cursor cloud alone does not establish the author models. Require the
complete declared model set and its provenance; no generic independence override
exists in v1. Normalize aliases consistently with the existing model-independence
rule. An unresolved alias or unbounded author set refuses as
`author_identity_unverified`, before spending an agent run.

Reviewer selection excludes every declared external author model and every model
observed authoring subsequent revisions. Evidence remains labelled declared versus
observed; a declaration must not masquerade as a Paseo observation. Do not require
a fake `workerModel`, worker profile, worker callback or nonexistent transcript to
make the existing selector pass. Reviewer prompts identify imported provenance
and remain read-only with normal exact-head/run/comment requirements.

Reviewer independence is one finite policy with three boundaries — reviewer
selection, the retained restart and verdict verification — and all three read
one pure derivation (`taskAuthorModels`/`taskAuthorModelKeys` in
`shared/authors.ts`). The recorded evidence is the current Nucleus author (worker
model and profile), prior Nucleus authors (`workerModels` and retired workers),
the declared external models, every recorded later external author — observed,
or an unknown contributor when its receipt carries no observation — the
author-side proof executor's models (Spec 055), and every revision-run
contributor a store reader can supply. Authors are agents as well as models:
the reviewer is never an agent that authored worker, revision, proof-execution
or checkpoint work.

Normalization is part of that one rule: a blank or whitespace-only model, or a
final component of `unknown` or `default`, is opaque. A provider-qualified
`provider/unknown` therefore names no concrete model even though review-entry
admission accepts it as a declaration.

Absence of a Nucleus authoring worker is not an unknown author. A workerless
review-entry task's current author is its recorded evidence — the declared
models plus every observed later external author and recorded executor model —
so a reader whose model differs from all of them continues from an
authenticated checkpoint through ordinary `restart role=reviewer`, and a fresh
reviewer may be selected and verified the same way. Absence never manufactures
a worker, model or profile.

Unknown, and therefore refused at every boundary before any model is compared:
no recorded author at all; a task with a Nucleus author whose current model is
unrecorded; any declared, recorded or observed model that normalizes to opaque;
a later external revision whose receipt carries no source observation; and a
distinct bound revision contributor whose model was never recorded. An
authored task with no recorded current model is unknown even when earlier
external authors are known, and a revision run bound to the task's own recorded
author adds no author of its own. A known collision also refuses, except
through the existing owner-route waiver: a required reviewer named by `route`
may share the current author's model, and for a workerless entry the recorded
external authors are that current author, so the same marked request waives
them while an unmarked or optional request and any opaque model stay excluded.
A revision run's author is the task's current or retired Nucleus author, whose
model the task row records, so the verdict boundary sees every recorded
revision contributor without reading runs.

On authenticated `changes_required` for the current reviewer/head, wait for its
actual release, then use the normal worker pool, scope, subscription and
availability gates to select the first revision worker. Exclude the retained
reviewer's model. If no worker is eligible, retain the task and findings without
creating another workspace or weakening independence. Record one durable revision
run/agent intent, bind its reporting credentials and launch in the exact same
workspace/branch/PR. Confirmed creation binds the task's worker agent/profile/model
fields, never its coordinator identity. PR lookup uses immutable review-entry
provenance until a real worker readiness result exists; it must not synthesize one. This first revision is ordinary semantic revision work and
consumes the normal revision budget; it is not free administrative recovery.

Creation ambiguity uses exact run/agent reconciliation, never blind replay. The
same rules apply after restart. Successful readiness establishes a real worker
result and enters normal review. Retain eligible threads for later rounds; add all
observed author models to the exclusion set before the next reviewer decision.
A reviewer who authored a revision can never approve that head.

Approval proceeds through existing verification, public review-comment proof,
current-base and prospective-merge gates, FIFO integration, durable merge intent,
sync and hook-owned or coordinator closeout. The reviewer is first; its workspace
remains isolated from the canonical integration checkout throughout review and
revision. A synchronized fast-forward of the canonical base after binding may be
reverified at dispatch, but never relaxes exact PR-head identity or replays a
merge. After intake, a moved PR head must go through the Nucleus revision worker. If a workerless review-entry task has a PR head different from its recorded head, `move to=review` refuses and names `move to=work`, which starts the revision worker in the task workspace. Nucleus does not record an owner-authored head receipt or pin the changed head directly.

A PR that merges outside Nucleus before the first review run is reconciled by the
owner's existing `move to=closeout`, not by launching a reviewer to create the
evidence a merge already removed (task 408, 2026-10-24). The task is
`queued` with zero runs of any role, its intake operation settled, both holds
in place and the recorded source head older than the published merged head.
The move observes the merge at the forge (canonical same-repository
PR/branch/base identity, a positively merged PR and its actual merge commit, the
bound workspace clean on that exact merged head), proves the merged head
descends from both the immutable intake head and the task's latest recorded
head, checks the task's execution participants before and after the forge read,
and records the merged head and commit BESIDE the unchanged
recorded source head together with one explicit exact-final-head
`operator_source` acceptance and its concrete missing evidence. The merge is an
observed fact and never review, verification, native-proof or source-author
credit, and the acceptance is never inferred from it: without an explicit
operator acceptance at that exact merged head the task stays held and is not
advanced, and an older head's ruling is never promoted to the final head. No
run, reader, workspace, executor or native proof is created, both holds and
their owners, pause, `reviewEntry`, provenance, author declaration, branch and
workspace stay exact, and a lost reply reconciles the same durable operation
with one merge and one acceptance record. A historical run of any role, a
competing or mutated operation, changed ownership, a stale
version, an unmerged PR or a non-descendant head refuses with nothing written.

## Closing a merged task's external workspace entry (Tom, 2026-10-25)

Tom reported on 2026-10-25: "424 is done and merged but not archived. We REALLY
need to fix this properly". Nucleus never archived a workspace it did not create
(`preserveWorkspace`), so every done review-entry task in an external workspace
stayed in the Paseo sidebar indefinitely. That included the Supervisor's own
manual PR worktrees: #422, #424 and #427.

Tom was asked whether Nucleus should archive such a workspace's sidebar entry when
the task is done and merged, provided every thread in it is one of that task's
own idle threads. The folder and its files would stay untouched, and a workspace
holding anyone else's thread, such as his 1:1 sessions, would never be archived.
He chose "Archive entry, keep files (Recommended)": "At closeout of a merged
task: if the workspace holds only that task's own idle threads, archive the
sidebar entry and leave the folder untouched. Any other thread keeps it. I also
remove my own worktree folders straight after each merge."

The rules:

- **When.** The task is `done` with a recorded merge, and its bound workspace is
  external (`preserveWorkspace: true`).
- **Which threads.** Every thread Paseo lists in that workspace, archived
  included, is one of the task's own runs or attached roles, and is idle, errored
  or closed with no active turn or pending permission. Any other thread, or an
  unreadable or incomplete inventory, keeps the entry.
- **What is archived.** Only the Paseo catalog entry, with the task's own idle
  threads in it. The directory, its files, the git worktree registration and the
  branch are never removed, cleaned or rewritten.
- **Folder guarantee.** If the platform cannot archive the entry without
  removing the directory, the entry stays and the reason is recorded. A
  directory removal is never accepted as a side effect.
- **Record.** The task records the catalog archive as distinct from Nucleus's own
  workspace archive, and names the preserved folder.
- **Unchanged.** Cancelled and superseded tasks, unmerged tasks, worker-originated
  workspaces (a binding that is not a review entry) and Nucleus-owned or
  intake-owned workspaces keep their existing rules.
- **No overlap with disposition recovery.** A cancel or supersede disposition
  never offers the catalog archive through its own effect, and a disposition
  that stopped at its workspace proof or archive (Spec 050
  `disposition_workspace.<id>`) never applies to a preserved external workspace:
  that effect is derived only for the task's Nucleus-owned workspace at an active
  disposition fence, where the ordinary `archive_if_empty` or
  `retained_by_replacement` proof decides. A preserved external workspace keeps
  its separate `external_workspace_archive.<workspaceId>` effect and the gates
  above, so recovering a disposition can neither archive the folder nor weaken
  the catalog-only proof.

### How Nucleus implements it (task 428, 2026-10-25)

Paseo 0.13.0's archive is not catalog-only by contract, so Nucleus proves the
placement before it calls anything. The installed app is 0.13.0 with the reviewed
p6 patchset (`app.asar` sha256 `949ec1fd76dffaa1bc5542ab7f597fafce757718d112d87841bde37877d7b252`;
stock 0.13.0 `946e8bee9f87ed20f230ad82475d48ce212a9c413a99ba5b77cc70ff8ab28a7d`);
the only difference in this file is the reviewed per-agent archive timeout, and
`maybeRemoveDirectory` is byte-identical. The trace:

- `archive_workspace_request` → `Session.handleArchiveWorkspaceRequest`
  (`server/server/session.js`:2122 dispatch, 5649–5702) → `archiveByScope` with
  `paseoHome`/`paseoWorktreesBaseRoot` and scope `{kind: "workspace"}`, and a
  wire answer of `{requestId, workspaceId, archivedAt, error}` only — the
  service's `removedDirectory` is never sent to the client.
- `workspace-archive-service.js`:36–77 archives agents, terminals and the catalog
  record, then 186–190 `maybeRemoveDirectory` **returns false before any teardown
  when the backing is not Paseo-owned**. Only past that guard does it run
  `worktree.teardown` commands (196) or `deletePaseoWorktree` (215), which runs
  `git worktree remove --force`, removes the directory and prunes
  (`server/utils/worktree.js`:479–514, 713–771).
- `resolveWorkspaceBackingDirectory` (130–151) marks the backing Paseo-owned when
  the registry record has `isPaseoOwnedWorktree`, `worktreeRoot` and
  `mainRepoRoot`, or — for a `kind: "worktree"` record lacking them — when
  filesystem discovery finds its cwd under `<worktrees-root>/<hash>/<slug>`
  (`isPaseoOwnedWorktreeCwd`, `server/utils/worktree.js`:611–659, roots 559–575).
  A worktree kind can therefore be discovered as owned from the path alone, so
  presentation fields are not proof.
- The wire descriptor is a faithful projection of exactly those inputs:
  `workspaceKind` is the registry `kind` (`session.js`:4223,
  `describeWorkspaceRecord`), and `project.checkout` comes from the persisted
  placement (`workspace-registry-model.js`:85–118), which reports
  `isPaseoOwnedWorktree: true` only when the record also has `mainRepoRoot`, and
  reports `false`/`null` for a `kind: "directory"` record. `deriveWorkspaceKind`
  (11–17) derives `worktree` exactly when a main repository root is present.

Nucleus therefore refuses before the call unless the freshly refreshed descriptor
reports the recorded directory, a placement kind that is not `worktree`, a
`project.checkout` whose directory is that folder with
`isPaseoOwnedWorktree === false` and `mainRepoRoot === null`, and no Paseo-owned
Git runtime. No plugin-visible input can then reach a teardown command or
directory removal: the effect is the catalog record, its threads and its
terminals. A missing, foreign, owned, worktree or inconsistent placement is
recorded as a visible hold and nothing is sent; an unreadable descriptor is
never guessed.

Before the effect, every thread the daemon lists in the workspace (archived
included, walked to its positive end) must carry this task's `northstar.task`
label or be one of its recorded run/attached-role identities, must be idle,
errored or closed with no active turn or pending permission in both the
inventory and a fresh per-thread observation, and must not serve another task.
Paseo's archive also kills every terminal in the workspace
(`terminal-session-controller.js`:240–281 lists sessions by `workspaceId`;
`archiveWorkspaceContents` kills them), so a workspace the daemon reports as
holding a terminal keeps its entry. Paseo returns an empty terminal list when
its own enumeration fails, so that precondition is "the daemon reports no
terminals", not a proof from outside Paseo; the daemon-internal agents its
archive also archives (`agentManager.listAgents({includeInternal: true})`) are
Paseo machinery and are not part of the operator's listed-thread inventory.

After the answer the same entry is observed again. A gone catalog record, a
present folder and an unchanged Git common directory and branch are the only
success shape; a gone folder is a hard, visible failure with no success or
preserved-folder claim and is never replayed. The effect's durable identity is
`resolution.externalWorkspaceArchives` — distinct from `archivedWorkspaceIds`,
`runtimeRetirements` and `workspaceRetirement` — one record per workspace with
its stable `ns-catalog-archive-<task>-<workspace>` request id, the observed
catalog placement, the participants, the platform's own answer, the observed
folder state and the bounded retry. A `done` review-entry task stays a lifecycle
candidate until that record is `archived` or `failed`, an owner-named unknown
answer pauses the automatic pass (only an observation may settle it, and only an
explicit owner `retry_effect` replays it after observing the same entry still
present), and a missing entry is positively observed rather than inferred from a
timeout. The folder is never claimed archived and no Nucleus-owned workspace
archive, runtime retirement or source-publication record is touched.

### Other released pinned review views at closeout, after primary retirement

No round has a view any more. This terminal path remains for the stored views on
done tasks that are not archived yet.

When the task is merged and done, the remaining released pinned
review views are archived after their primary checkout has gone through Nucleus
closeout, under that same effect machinery plus the proofs below. The view keeps
its original run, receipt, head and brief binding, including a historical receipt
for an older head. A missing primary alone proves nothing: Nucleus requires the
primary's named archive history and its matching successfully retired runtime
scope, captured while that checkout existed. An archive observed absent without
an intent is not that proof. A scoped retirement can be proved before archive
reconciliation confirms the removal or afterwards; both records must follow the
scope capture. A confirmed archive under an owner-authorized
content discard can supply it, but makes no clean or published claim about the
discarded primary; the view still proves its own clean, published contents. A
preserved live source may advance or become dirty after review, but must not
alias the view. A primary that reappears after archive must pass its own Git
identity and clean-source checks and must not alias the view. Active review,
admission and reporting still require the live source.

Every terminal attempt re-proves the view and canonical repository identities,
cleanliness and current publication, and retains the normal custody, retention,
runtime and uncertain-delivery fences. Reconciliation of an already missing
view requires its exact archive intent and a readable, matching canonical Git
backing with the view head still published; absence alone never settles it.
This creates no review, receipt or new owner control.

### Revision: clean, merged worktrees may be archived (Tom, 2026-10-25)

The #428 implementation held every external workspace with a worktree
placement, because Paseo's archive can run worktree teardown on one. Nearly
every hand-made PR worktree has that placement, so the rule above did not
archive Project-c #148 (`wks_aa7b034537a4cd98`, with a second catalog entry
`wks_1ff74f983244d3e7` for the same path).

Tom was asked whether Nucleus should archive anyway when the worktree is clean and
its commit is already merged or published, since a deleted folder then loses
nothing. He chose "Archive if clean+merged (Recommended)": "Archive a merged
task's worktree entry, even if Paseo removes the folder, but only when the
worktree is clean and its commit is merged or on the remote. Anything unpushed
or uncommitted, or another person's thread, keeps it."

For a worktree placement, every other rule above still holds, and the archive
also requires:

- no uncommitted, untracked or ignored-but-unexpected changes;
- a HEAD reachable from the canonical remote: merged into the base branch or on
  an advertised remote branch.

If those proofs hold, a folder removal by Paseo's teardown is accepted and
recorded as such. Any failed or unreadable proof keeps the entry as before. A
non-worktree external workspace keeps the no-removal rule. Other catalog entries
registered for the same path are covered by the same proofs and the same
thread rule.

### How the worktree amendment is implemented (task 441, 2026-10-25)

The placement proof keeps its original shape for every non-worktree placement and
still refuses a worktree placement by default, so the pre-amendment refusal is
unchanged for any caller that has not proved a source. The archive path opts in
and then demands two more things before it sends anything.

The first is a same-path registration inventory (`Adapter.externalWorkspaceCatalog`):
the complete active workspace inventory is paged to its positive end and filtered
to registrations whose recorded directory is this exact folder (`.`/`..` and
separator normalization only, never prefix, slug or alias guessing). Paseo's wire
list has no archived filter, so an archived entry is not addressable there and is
not invented either. Any registration whose placement cannot be read holds the
whole pass, because it may be one Paseo can remove. A path whose registrations
disagree on placement also holds: removal permission belongs to the shared folder,
so one non-worktree registration keeps the no-removal rule for every entry and a
mixed set is never guessed into a removing archive. A complete inventory is
required before the first call; an unreadable one is a visible hold, not a
reason to call the bound entry alone (an adapter without the capability keeps the
pre-amendment single-entry behaviour).

The second is the source proof for a worktree placement, taken after every awaited
inventory and re-read after its own awaited fetch. It proves the folder's
canonical real path is its own worktree root, its Git common directory is the
recorded repository's, it is on the recorded task branch, its origin is the
recorded repository's canonical remote, and its HEAD is the exact commit just
observed. It then requires a clean tree: no tracked, index or untracked entry,
and no ignored branch boundary outside the disposable runtime roots Nucleus's own
build-output cleanup policy already owns (`node_modules`, Cargo `target`,
`.effigy`, `.northstar-cache`). Publication is proved with
`originBranchContaining`: the exact HEAD must be contained in a branch the
canonical origin advertises *after* the fetch, so a stale tracking ref, a deleted
branch, a PR number, the recorded merge alone or an unverified alternate origin
proves nothing. A deleted task branch is still accepted when the recorded base
branch advertises a head that contains this exact commit (`merge:<branch>`). A
second read of every fact after that fetch refuses a changed HEAD, status, branch,
common directory, origin or ignored set. Nucleus never resets, cleans, stashes,
rewrites or pushes to obtain the proof.

Every registration listed at the exact folder is inspected before a call that may
remove shared backing. Its threads, archived included, must belong to this task
(its label or a recorded run/attached-role identity) and be idle, errored or
closed with no active turn or pending permission in the complete inventory; the
target entry's live threads are freshly observed as well. A foreign or active
thread in *another* registration protects the folder, and so does a terminal in
any of them, because Paseo's archive kills its workspace's terminals and a
removal would strand the shared folder's. An empty additional registration is
allowed. Only this task's own entries are ever archived.

The durable identity is still `resolution.externalWorkspaceArchives`, now one
record per catalog registration at the folder with the same stable
`ns-catalog-archive-<task>-<workspace>` request id. The additive private fields
are `source` (the exact HEAD, branch, directory, common directory, canonical
remote, publication evidence and expected ignored roots the request relied on),
`folderRemovalAuthorized` (true only when that proof, or a recorded chain of one,
grants removal), `folderRemovedBy` (the entry whose authorized call removed the
shared folder) and `samePathRegistrations` (the complete inventory observed at
this exact folder). No public contract or Contract 010 shape changed, and older
readers of `resolution` still strip the field as before;
rollback compatibility past a review-entry record is not claimed.

A present folder must come back with the exact Git common directory, branch and
HEAD read immediately before the native call, on both placement kinds; the
worktree path additionally requires agreement with its recorded source identity.
That is the catalog-only success shape the original ruling named, restored for
both paths, so a native archive that tampers with a directory placement's HEAD is
a visible failure rather than a silent success.

A worktree entry whose native answer removes the folder settles as `archived` and
says so: `folderPresent: false`, `folderRemovalAuthorized: true`, and
`folderRemovedBy` naming the entry. It is never reported as preserved, and a
non-worktree removal is still a hard `failed` record with no success claim and no
replay. Once an authorized entry has removed the shared folder, a sibling
registration at that path settles through that exact durable chain (`source` is
not re-proved for absent files, `folderRemovedBy` keeps naming the first entry),
so a restart, a lost reply or an unknown answer never re-derives a clean state
from absence. A folder that is absent *without* such a chain is a visible
failure with no call. An unknown outcome on the shared path blocks every other
registration: while any entry at this folder is `intent` or `uncertain`, no
sibling is due or called, the pass only observes that one entry, a backed-off
unknown owes no catalog, thread or terminal read at all, and an owner
`retry_effect` naming a *different* registration is refused for the same reason.
A failed outcome stops that pass the same way, because the folder's state is then
not positively known either. A pre-effect hold is recorded against the
registration the pass was inspecting, so a sibling's cause is never written over
the bound entry's settled history and is never dropped. A settled entry never
blocks a sibling's own record, and one entry's success is never another's.

Tests drive the public lifecycle and the default adapter over disposable stores,
real isolated Git worktrees and catalog fakes: clean+merged+published worktree
accepted with and without removal; dirty tracked, staged, untracked and
unexpected ignored content held; expected ignored runtime material accepted;
clean-but-unpublished held; wrong or unknown remote held; a change during an
awaited inventory held; a native call that changes the preserved Git identity
failed on both the worktree and catalog-only placements; foreign, permissioned,
active, unreadable and partial inventories held;
a second empty registration archived; a foreign or active or terminal-bearing
second registration protecting the folder; a mixed-placement path held; a
teardown removal recorded as a removal; one removal plus a second registration
settling through the chain; a lost reply reconciled by observation and an owner
retry replaying exactly once; an unknown answer blocking a sibling registration
on later automatic passes (and, inside the recorded backoff, owing no read at
all) until an observation settles it; a sibling's pre-effect hold recorded on
that sibling rather than over the bound entry's history; an absent folder
without a chain failed; and the parent placement proof still refusing a worktree
placement on its own. `effigy
check`, the changed test files each alone and `qa:docs` were run; no live entry,
folder, database, native, install, settings or Paseo change was made.

## Bounded review workspaces during a long review (task 494)

Tom asked for this on 2026-10-31 (Chatterbox message
`4b549c83-0087-4a78-bc8d-4a151fda07c6`) after Consumer-b #794 (PR1069) showed five
sidebar entries for one task: two source registrations and three pinned review
views, one of them the live round. A review that needs several rounds used to
keep every round's checkout until the whole task closed out, because the terminal
archive was the only thing that ever retired a view. That is a workspace per
round, and the round's own history does not need it.

### Three separate things, three separate owners

- **Thread retirement** is `core/workspaces/thread-archive.ts`: Paseo's thread record for a
  reviewer whose verdict has been applied is archived once it is released. It
  never touches a checkout.
- **Catalog hiding** is Paseo's own workspace archive record: the sidebar entry
  goes and the folder may stay (`core/workspaces/external-workspace-archive.ts`, above).
  It is proved by placement, thread membership and, for a worktree, clean
  published source.
- **Physical checkout removal** is Git and Effigy: Paseo's `worktree.teardown`
  removes a Paseo-owned worktree, and Nucleus proves the Effigy runtime scope was
  retired afterwards. Nucleus itself removes only its own canonical checkout.

A pinned review view is a Nucleus-owned Paseo worktree: hiding its entry and
removing its checkout are one native effect, its thread is retired with it, and
its source of record is the task's own workspace.

### Stored pinned review views

No round creates a view, and on 2026-11-06 no open task had one: all ten stored
view runs belong to done tasks. So the mid-review cleanup this section used to
describe is gone (`nucleus#769`). So is every read on a live path: launch,
callback, restart, reconciliation, delivery and the prompt. `reviewSourceView`
stays in the run schema, so old rows still parse.

What stays is the closeout path above, because some of those views are not archived
yet. A done task's unarchived view is still a terminal archive target with its own
proofs, keeps its `retry_effect workspace_archive.<id>` exit, and holds that task's
retention until it settles.

One durable `archiveIntentWorkspaceId` exists per task, and an outstanding intent
is observation, never authority: it owes one catalog observation per recorded retry
interval and never authorizes another native archive by itself. A task removal
whose reply was lost can leave an intent on a nonterminal task that no reviewer run
names. The pass records what the catalog answers (listed, no longer listed, or
unreadable) as the visible retry cause on that workspace, and the owner's
`retry_effect workspace_archive.<id>` re-observes and reports rather than sending a
request it cannot prove. `core/workspaces/archive-intent.ts` derives this, and
`test/archive-intent.test.ts` proves it.

### One folder, one truthful registration per owner

Consumer-b #794's second source entry is a Paseo catalog registration, not a Nucleus
record: `wks_fab9d91e45c326d9` ("Video template review", project
`prj_5f6e41c54289b4d9`) and the task's own source `wks_0eafc799a5266b00`
(project `prj_1c4fcaf11decd914`) both name
`<retired-volume>/scratch/consumer-b/cover-sticker-feedback`. The duplicate existed
before Nucleus intake, and Nucleus did not create it; two projects rooted at one
folder is a Paseo producer/display boundary Nucleus does not own.

Nucleus's boundary is narrower and is now explicit: it binds the exact existing
registration, retitles only that one (`syncWorkspaceTitle`), and accounts for
every registration at the folder through the same-path inventory the closeout
archive already reads. It never adds a second registration for a folder that
already has one: before a directory workspace create (`createWorkspace`,
`recoverTaskWorkspace`) the complete inventory at that exact folder is read, a
positively listed registration that is not this task's refuses with every alias
named and nothing sent, and the task's own recorded registration at the folder is
reused instead of a duplicate. An unreadable inventory is not proof of a
duplicate, so ordinary creation is unchanged rather than blocked on a guess.

Nothing here merges, reparents, hides or deletes another owner's registration:
without a registration-only display route in Paseo that stays a product boundary
to report, never a deletion to perform. The remaining consumer-side cleanup (the
human's own entry, and the deployed closeout pass that archives the task's own
entry) is ordinary supported lifecycle work, not part of this repair.

## Changed review-entry heads after intake (Tom, 2026-11-02)

A review-entry task keeps its original intake identity and task workspace. When review requests changes, Nucleus starts its revision worker in that workspace; after the worker publishes, Nucleus requests a fresh exact-head review. A workerless task whose PR head moved outside that route cannot record or review the new head directly: `move to=review` refuses with the `move to=work` revision-worker route. There is no owner-agent or relayed authorization path for changing the recorded head.

Historical owner-revision rows and events remain parseable, but they do not authorize a new head or restore review credit. External merges before the first reviewer still use the same task's `move to=closeout` reconciliation and explicit exact-final-head source acceptance described under "Closing a merged task's external workspace entry".

## Preservation and compatibility

2026-09-21 operator amendment: intake-created workspaces may opt into normal
post-closeout archive with `workspaceOwnership: intake`; the input defaults to
`external`. Binding stores `preserveWorkspace: false` only for that explicit
declaration. Schema 14 preserves all existing ownership and fences older
readers. Archive still requires exact workspace/repository/branch/head identity,
clean files, released runs and idle task-owned threads. External branch history
remains preserved. Cancellation continues to preserve either ownership kind.
For default external ownership, normal success, cancellation, supersession and
failed intake never delete it or its branch. `shared_canonical` refuses before
binding or agent intent, so review entry never archives or changes the canonical
repository checkout.
Operational exclusivity is not deletion authority. Retain origin routing and
coordinator-first operational escalation after admission. Missing preflight
planning/author authority is a deterministic operator decision, not work for a
new recovery coordinator.

Extend task, operation, detail and reporting contracts together. Audit every path
that assumes an initial `agentId`, `profile`, `runId` or worker completion exists:
PR lookup, lease acquisition, review selection, revision launch, recovery, capacity,
telemetry, callbacks, disposition and cleanup. Optional worker fields must not
become a general bypass for ordinary tasks. Review entry is the sole route for finished external PRs.

Version the persisted schema before enabling writes that older binaries cannot
read (new operation kind/provenance). Upgrade fixtures must preserve existing task,
run, receipt, credential and configuration bytes except explicitly versioned
additive metadata. Older incompatible binaries must refuse safely; do not claim
rollback compatibility once review-entry records exist. A supported rollback needs
a compatible reader, never deletion of imported tasks or a live-database rewrite.

## Acceptance oracle

| Scenario | Required result |
| --- | --- |
| Complete unowned external PR | One task, one existing workspace/branch/PR, first agent is reviewer; no worker completion or initial worker. |
| Missing workspace, wrong repository, fork, detached/base branch, dirty checkout, local-only commit, closed/merged/draft PR | Refuse before task binding/agent intent with bounded facts; preserve all external work. |
| Planning missing, ambiguous, altered, unpublished or not an ancestor of head | Refuse; no hook bypass or detached planning exception. |
| Missing/opaque author models or mismatched GitHub author | Refuse before any agent; concrete attestation stays labelled external evidence. |
| Same key repeated, lost receipt, crash at binding | Same durable operation/task; no duplicate owner or agent. |
| Different keys race for branch, PR or workspace; race with ordinary task submission | At most one binds; loser cannot dispatch. |
| Head/base changes during preview or validation | Preview grants no authority; binding refuses stale supplied proof. |
| Head/workspace changes after binding or before launch | Hold the owned task; no silent repin or guessed author callback. |
| Pause, dependencies, capacity full, unavailable reviewer | Queued review entry retains identity; no initial worker or capacity bypass. |
| Review approved without a worker ever existing | Full normal verification/merge/sync/closeout succeeds with exact review evidence. |
| Changes requested, reviewer still active | No worker launch until release; then one eligible worker in the same workspace. |
| PR merged outside Nucleus before the first reviewer | The owner's `move to=closeout` observes the merged head and commit at the forge, proves descent from the intake and recorded heads, and records the exact-final-head operator source acceptance beside the unchanged source head; no reviewer, worker or proof run is created, and without that acceptance the held task does not advance. |
| Revision worker creation timeout/restart | Reconcile the same intent/run; no second worker from uncertain delivery. |
| Revision head changes or reviewer matches a declared/observed author | Old review invalid; require independent exact-head review. |
| Failing CI or changed integration base | Normal checks/current-base/prospective-merge rules hold; no merge shortcut. |
| Unknown merge response, closeout failure | Preserve intent and ownership; reconcile normal gates without repeating effects blindly. |
| Done/cancelled/superseded imported task | Preserve external workspace files and branch; normal terminal projections and notification semantics. A done, merged task's external workspace sidebar entry is archived under "Closing a merged task's external workspace entry" below. |
| Stored pinned review view on a done task | A terminal archive target with its own proofs and retry exit; holds the task's retention until it settles. The task workspace and review history remain intact. |
| Existing ordinary tasks, schema upgrade/restart | Behavior unchanged; identities, credentials, pool, limits, subscriptions and pause preserved. |
| CLI/API acceptance with slow Git or unavailable Paseo | Prompt durable receipt and visible pending proof; no dependency on UI-thread RPC completion. |
| Nucleus-held brief in an existing isolated workspace | Exact checked brief digest/version and planning ancestry bind once; reviewer starts first; no repository handoff is read or written. |
| `shared_canonical` review-entry input | Typed `exclusive_writer_unavailable` refusal before adapter inspection, binding, agent intent or branch mutation. |
| Active origin author during isolated intake | One durable task/source claim with the exact identity and a visible pending-handover wait; no reviewer runs while the writer is active. Yield lets admission re-prove the exact source and launch one independent reviewer in the task workspace, with no resubmission or owner retry. Writer yield, clean checkout, exact HEAD and open PR head are checked at reviewer send; a writer observed active blocks the send. |
| Active or uncertain writer with unreadable activity, dirty workspace, moved head/base, changed author/model declaration or foreign Nucleus ownership | Refuse or hold with bounded facts, an honest cause and no reviewer credit; no caller-provided activity exemption, no stale-pin review and no silent repin. |

## Implementation sequence and motivating-suite preparation

Two internal stages form one feature delivery, not independently enabled lanes:

1. Contracts, versioned persistence, direct preview/operation acceptance, immutable
   provenance, exact identity proof and ownership-race tests. Keep review-entry
   submission disabled until lifecycle integration is complete.
2. Review-first dispatch, first revision worker, independence, lifecycle hooks,
   recovery/preservation, visibility/telemetry and end-to-end fixture coverage.
   Enable only after the whole acceptance oracle and existing gate regressions pass.

The follow-up g01.048 task and
committed handoff carry Tom's 2026-09-21 implementation dispatch authorization. Unit/integration fixtures
are the first acceptance surface; no disposable live PRs/workspaces are implied.

For the supplied Project-g suite, separately inventory live PR/workspace and
model evidence; allocate unique roadmap/research IDs and put collision repair and
shared-file scope into each handoff. Commit planning, update branches under explicit
preparation authority, then pin the resulting heads. Suggested pilot is #349,
which the request says already has a roadmap task. Review/merge the suite serially
at first, rechecking current main between tasks. #350 needs an explicit reviewer
capability request for Contracts 015/038; #352/#353's reported CI failures must be
resolved before merge. These are supplied-case planning notes, not verified current
PR status or approval to intake any of the five PRs.

### Unavailable allocation observations

Allocation checks distinguish an unavailable observation from a foreign path.
Missing leaves retain their identity through the canonical existing ancestors.
Failed canonical-path or Git common-directory reads wait; empty or relative
Git output is not a directory identity. A positively foreign allocation still
refuses. Cleanup on a finished task retains the failure without changing its
finished phase (see Spec 058).
