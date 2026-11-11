# Adopt an external PR through review entry

Use this route for an already-open external PR with no surviving authoring
worker. Do not fabricate a worker, callback or approval.
Review entry uses an existing isolated workspace. `shared_canonical` is
unsupported and returns `exclusive_writer_unavailable` before workspace
inspection or binding because Nucleus cannot enforce an exclusive-writer
reservation for a canonical checkout. Resolve the real plugin root as described
in SKILL.md; all commands below run there and connect directly to Nucleus.

A scoped review-entry authorization applies only to its named consumer PR. It
does not authorize shared-canonical intake, consumer acceptance tests, source-thread
changes, a fabricated approval, or another task or dispatch.

## One-command route from an approved lead

For a checked, approved Nucleus lead, the CLI builds the same brief submission as
`lead.promote-task`, reads the PR branch and head from GitHub, previews, and
submits under one stable key. If `--workspace` is omitted, it prepares an
isolated `checkout-pr` workspace and marks it intake-owned for closeout. When
passing `--workspace`, also pass `--workspace-ownership intake` if that workspace
was created specifically for this intake, or `--workspace-ownership external`
if it predates the intake. The route requires this explicit classification:

```sh
node bin/nucleus-review-entry.mjs --lead LEAD_ID --pr PR_NUMBER \
  --workspace HOST_WORKSPACE_ID --workspace-ownership intake \
  --authority 'operator-authorized scope' \
  --models provider/model --github-author AUTHOR_LOGIN \
  --authoring-system SYSTEM --attested-by OPERATOR \
  --provenance 'how author identity was checked' --preview

node bin/nucleus-review-entry.mjs --lead LEAD_ID --pr PR_NUMBER \
  --authority 'operator-authorized scope' \
  --models provider/model --github-author AUTHOR_LOGIN \
  --authoring-system SYSTEM --attested-by OPERATOR \
  --provenance 'how author identity was checked' --key STABLE_INTAKE_KEY
```

Add `--repository ORIGIN` for a lead covering several repositories. `--models`
accepts comma-separated concrete provider/model IDs. Supply `--workspace` to
reuse a suitable existing isolated workspace; otherwise the route prepares a
`checkout-pr` workspace for the PR. The command always previews before starting
the durable operation. A read-only `--preview` requires an existing workspace;
without it, previewing would need to create one. It
does not merge current main into the PR. Planning stays pinned to the current
checked integration tip, while the PR branch and head are read from GitHub. After
submitting, inspect the operation receipt as described below.

## Inspect and prepare

1. Resolve the named PR and canonical local repository. Inspect Nucleus ownership,
   PR state, author, exact head, source branch, target branch, checks and scope.
   Continue an existing owning task instead of submitting a duplicate. V1 needs
   an open, non-draft, unmerged, same-origin PR and repository write permission;
   forks are unsupported. Failed CI is evidence for review/revision, never an
   excuse to bypass merge gates.
2. Obtain the operator's concrete author-model set. Store provider/model IDs,
   GitHub author, authoring system, attestor and provenance. A declaration such
   as Grok 4.6 can be recorded as `xai/grok-4.6`; it is operator-declared, not
   runtime-observed. Tool names such as Cursor cloud or Grok Bot alone do not
   establish a model. Do not infer unknown models, reuse another PR's declaration
   without evidence, or override reviewer independence.
3. Inspect canonical planning. In handoff mode, promote the PR's bounded scope
   and a seven-section committed handoff through normal Nucleus planning. For
   a Nucleus-held brief, use the exact checked Nucleus lead or approved draft and its
   stored approval/provenance; do not create a repository handoff or copy brief
   text into the repository. Review entry checks the current source, digest,
   version, approval, successful check and planning commit, then consumes that
   source atomically with task binding. A loose brief file or digest alone is not
   checked approval. Record the takeover request, external evidence, reviewer
   acceptance criteria, allowed revision scope and required validation. The
   initial agent is a reviewer; `worker_mode: implementation` defines only a
   later revision worker's contract. Resolve planning identity/number collisions
   without silently changing another PR's scope.
4. Reuse a suitable isolated Paseo workspace on the existing branch. If absent,
   the takeover request permits preparation through Paseo `create_workspace`
   with `isolation: worktree`, `mode: checkout-pr`, the canonical repository
   `path` and exact `prNumber`. Inspect the returned workspace ID, directory,
   branch and Git common directory. For this newly created intake workspace, set
   `workspaceOwnership: "intake"` in the input so successful closeout archives it.
   For a pre-existing external workspace, leave the default `external` ownership.
   Never infer intake ownership from a name alone. Do not use the canonical
   checkout as the review workspace. Create no agent. Preserve dirty work and
   active leases; do not reset, clean or archive resources to
   satisfy intake.
5. Publish and validate planning before pinning intake. The planning commit must
   be an ancestor of both current integration tip and PR head. When needed,
   merge that published planning into the existing PR branch, resolve only
   planning integration and push normally, preserving external commits. Product
   conflicts or broader changes need a scoped ruling. Recheck remote/local/PR
   head equality and the clean, synchronized integration checkout afterward.

Intake itself creates no workspace, worktree or branch. Preparation above is a
separate action under the named takeover request, not a relaxed identity check.
An explicit shared-canonical request returns `exclusive_writer_unavailable`
without inspecting the checkout, starting an operation, binding a task or
contacting an agent. Do not retry in shared mode or switch the canonical branch
to make it fit. For isolated intake, the origin author is checked even when it
is not attached to the selected workspace.

Submit while your own turn is still running: that is the supported route. A
positively read active or uncertain source writer — your own origin thread, or a
thread mid-turn in the selected workspace — does not refuse intake. The handover
is accepted durably with its exact identity, the task shows an `origin_busy`
wait naming that activity, and ordinary admission re-proves the same exact source
and launches one independent reviewer once the writer yields. Never wait for an
idle moment, retry the submit for timing, or submit from a detached session. Do
not expect a reviewer during the active turn, and do not treat an unreadable
activity, a foreign Nucleus ownership label, a dirty workspace or a moved
head/base/declaration as accepted: those keep their own refusal or hold. The
reviewer runs in the task's workspace. Nucleus owns that workspace after handover
and waits for the origin writer to yield before each send; it checks the clean
checkout, exact HEAD and open PR head at the send boundary. Later rounds reuse
the retained reviewer thread. No extra review workspace is created.

## Build and preview the input

Derive the canonical `submission` without dispatching a worker:

```sh
node bin/nucleus-submit.mjs --dry-run /absolute/repo/docs/handoffs/handoff.md
```

Copy its returned `submission` into a review-entry JSON file. Add:

- `workspaceId`, `prNumber`, `expectedBranch`: inspected existing identities.
- `workspaceMode`: omit or set `isolated`. `shared_canonical` is unsupported
  and returns the typed writer-reservation refusal.
- `expectedHead`: full clean local, remote branch and PR head SHA.
- `expectedBaseCommit`: full current synchronized integration SHA, not fork point.
- `authority`: the actual operator takeover instruction and its scope.
- `workspaceOwnership`: `intake` only for a workspace created specifically for
  this intake; otherwise `external` (the preservation default).
- `authorDeclaration`: `models` (concrete provider/model ID array),
  `githubAuthor`, `authoringSystem`, `attestedBy`, and `provenance`.

Use the real origin thread resolved from its Nucleus ticket or host identity; preserve the derived instruction
digest and planning commit. Never put placeholders into a live request.
For brief mode, `submission` carries the Nucleus-held text plus its checked
`planningSource` and exact `leadProvenance` from that Nucleus
record. The stored source is the approval authority; do not synthesize
provenance from brief frontmatter or author attestation.

```sh
node bin/nucleus-review-entry.mjs --preview /absolute/path/review-entry.json
```

Require `eligible: true` with no refusals. Read `pendingHandover`: a non-null
value names the source-writer activity that must yield before any reviewer runs,
so eligibility there means the handover will be accepted, not that a reviewer is
starting now. `null` means the preview proved readiness to execute. Repair any
named condition rather than weakening a gate. Preview reserves nothing; binding
rechecks the proof.
If head/base changes, inspect again and regenerate the pinned request.

## Submit and verify

```sh
node bin/nucleus-review-entry.mjs --key STABLE_INTAKE_KEY /absolute/path/review-entry.json
node bin/queue-cli.mjs operation-status /absolute/path/operation-id.json
```

The status file contains `{"operationId":"returned-operation-id"}`. Keep the
key and input stable after acceptance, including after a lost response; inspect
the same operation before retrying. A receipt is not yet task creation. Wait for
`succeeded`, then inspect `queue.detail` using the resulting task ID. Do not
create another task/key to evade ownership of a bound task.

Confirm `entrypoint: review`, the preserved workspace/branch and a first
`reviewer` run with no initial worker. A `queued` task carrying an `origin_busy`
wait after acceptance is the handover waiting for its writer to yield: leave it
alone, send nothing and resubmit nothing. It admits and starts exactly one
reviewer on the ordinary pass once a fresh proof observes that writer idle.
Capacity, pause and profile availability
may delay launch; preserve those settings. One ordinary task slot covers the
task through closeout. Nucleus selects an independent reviewer excluding declared
and subsequently observed authors. Changes requested create a worker in the same
workspace only after reviewer release. Approval follows ordinary verification, FIFO/prospective integration, merge,
sync and closeout. Inspect task detail and use normal resolution controls after
repairing the named cause; do not switch branches manually to clear a hold. Send
no duplicate prompts.

Report task identity and actual state. Successful closeout archives intake-created
isolated workspaces after normal clean-head, ownership and idle-thread checks.
Pre-existing external workspaces remain preserved; their cleanup needs a separate
deliberate disposition. Cancellation preserves all modes.
Completion of intake does not mean review or merge has completed.

## Attention-held intake

A refusal before binding settles `failed`. Fix the named condition, then repeat
the same key and input to reopen it. Do not create a new key to get around it.
A transient source-writer activity is not a refusal: repeat nothing, because
the accepted handover already waits for the writer to yield.

An operation in `needs_attention` is different. Its diagnostic is prose, not
proof. Reconcile it only when the operator asks for that exact operation:

```sh
node bin/queue-cli.mjs queue.review-entry-reconcile /absolute/path/reconcile.json
```

The file contains `{"operationId":"…","inputHash":"…"}`, copied from
`operation-status`. Nucleus refuses unless the stored input is unchanged, nothing
else is bound to the submission, branch, workspace or PR, and a fresh preview is
eligible. A refusal changes nothing. On success the same operation is `pending`
under its original key and ID. Admission reruns every proof and binds once. Read
`queue.operation-status` again after a lost response; do not resubmit. Reconciliation
never resets an operation generically, never approves on the operator's behalf,
and never edits the stored input.

## Revise a review-entry PR

After a review requests changes, Nucleus starts the revision worker in the task workspace. Use `move to=work` to return the task to its author with the findings as context; the worker changes and publishes the PR, then Nucleus requests a fresh exact-head review.

If a workerless review-entry PR has moved to a new head outside that revision route, `move to=review` refuses and names `move to=work` as the revision-worker route. Nucleus does not record a direct-owner head receipt or create a reviewer at the externally changed head.

Historical owner-revision rows and events remain readable for compatibility. They do not authorize a new head.

A PR that merged **outside** Nucleus before the first review run is reconciled by
the same task's owner `move to=closeout`, never by launching a reviewer to
manufacture evidence:

```json
{
  "taskId": "…", "version": <current>, "action": "move", "to": "closeout",
  "reason": "why the merged head is accepted as this external source",
  "qualification": "<what you accept, and the missing review evidence you are accepting>",
  "caller": "\"operator (board)\", or a relayed operator note"
}
```

- The task must still be queued with zero runs of any role, settled intake and
  both holds. `next` lists the move with
  `fill: ["reason", "qualification"]` and a note naming what is missing.
- Nucleus observes the merge at the forge: same canonical repository, branch,
  base and PR, a positively merged PR, its actual merge commit, and the bound
  workspace clean on that exact merged head. The merged head must descend from
  both the immutable intake head and the task's latest recorded head.
- Merge and closeout liveness checks task-bound workers, reviewers and proof
  executors, including retained runs. Planning owner, coordinator and caller
  activity alone does not block; task-owned uncertain effects still fence.
- The write records the merged head and commit BESIDE the unchanged recorded
  source head, plus one `operator_source` acceptance at that exact final head
  with the missing review evidence disclosed. The merge is an observed fact,
  never review, verification, proof or source-author credit, and it never
  becomes an acceptance on its own: without an explicit acceptance the held
  task is untouched, and an older head's ruling never applies to the final head.
- No reviewer, worker, workspace, executor or native proof is created. Both
  holds, pause, intake provenance, author declaration, branch and workspace stay
  exact, and a lost reply reconciles the same operation with one merge and one
  acceptance record.
- The recorded source head is final for this route: if the closeout waits for
  an earlier same-repository integration turn, later ticks re-record the merge
  and the phase only, never the recorded head.

Keep the same operation key and input after a lost response and read
`operation-status` instead of resubmitting; the receipt reconciles once.
