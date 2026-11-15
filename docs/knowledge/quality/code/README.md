# Code-module quality tables

The product-code ratings: 588 modules in `N1.csv`–`N6.csv` (N1 orchestration 96, N2 task lifecycle
81, N3 state and planning 57, N4 machine and workspaces 104, N5 service and hosts 78, N6 shared and
client 172), rated at commit `136cf0de` on 2026-11-13. The method is in [CHARTER.md](CHARTER.md).
Calibration, distribution, recurring defect classes and the target are in [SUMMARY.md](SUMMARY.md).

**Target (Tom, 2026-11-14):** floor 5 now, then 6, then 7.

## Columns

| Column | Meaning |
|---|---|
| `module` | Repo-relative path, or a group name for a tight file group. |
| `files` | The files the row covers, `;`-separated. Each product file belongs to exactly one row. |
| `loc` | Non-blank lines at the rated commit. |
| `churn30` / `churn90` / `fixes` | Commits touching the files in 30 and 90 days, and fix-like commits in 90 days, at the rated commit. |
| `O` `T` `F` `P` `Pr` | Ownership, Typed facts, Failure, Proportion and Proof, each 0–2. |
| `score` | The sum, 0–10. |
| `action` / `reason` / `evidence` | Disposition (`keep`, `simplify`, `consolidate`, `harden`, `split` or `delete`), its one-line reason, and `path:line` evidence at the rated commit. |

## Re-rating

A PR that splits, consolidates or deletes a rated module updates its rows here. It removes or replaces
the old row, adds a row per new module with the charter's five parts and evidence at the PR head, and
notes the commit. Scores are never edited without a re-rate. Code that has moved since `136cf0de` keeps
its old row until its module is next changed. Re-rating changes the row count: the 588 rows above are
the `136cf0de` sweep, and these tables carry every row added or replaced since.

## Re-rates

- nucleus#1199 (floor 5, 2026-11-14): `core/store/store.ts`, `core/store/store-tasks.ts` and
  `core/store/store-maintenance.ts` were split into one owner per mechanism; `store-maintenance.ts` no
  longer exists. The store rows in `N3.csv` were re-rated at that PR's head.
- nucleus#1204 (floor 5, 2026-11-14): `hosts/paseo/plugin/bridge.ts`,
  `hosts/t3code/adapter.ts`, `bin/queue-cli.mjs` and `bin/nucleus-subscribe.mjs` were split or consolidated
  into one owner per mechanism, and `bin/nucleus-dependencies.mjs`, `bin/nucleus-dispose.mjs` and
  `bin/nucleus-promote.mjs` were deleted. Their rows in `N5.csv` were re-rated at that PR's head, and
  `hosts/t3code/state.ts` was re-rated with them because an intent entry gained its typed kind and thread.
- nucleus#1205 (floor 5, 2026-11-14): planning operation settlement, source reconciliation,
  pre-dispatch repairs and submission intake now have separate owners; runtime promotion is split
  from the planning facade and the board surfaces share counters and settings. The affected `N3.csv`
  rows and the touched brief helper were re-rated against the code at the PR head.
- nucleus#1208 (floor 5, 2026-11-14): intake and result application were split and consolidated
  along their named seams — worker intake (`core/intake/callback-intake.ts`) from run intake
  (`core/intake/run-callback-intake.ts`), with the shared report-shape, report-ready and
  proof-settlement rules in one owner each (`report-shape.ts`, `report-ready.ts`,
  `proof-settlement.ts`) and the lifecycle wait sentences in `thread-waits.ts`. PR refusals are
  typed (`WorkerSourceRefusal`) instead of classified by message. Review entry decodes one canonical
  PR and names its own refusal codes; PR adoption reads one typed plan. Their N2 rows were re-rated
  at this PR's head. `core/git/git-refusals.ts` is new there: the ready-report refusal codes and the
  one queue branch-name shape, thrown by `git-proof.ts` and `git-stash.ts` (their N4 rows keep their
  scores and gained the new loc), and compared as one named text in `core/recovery/retry-routes.ts`
  (its row is unchanged).
- nucleus#1206 (floor 5, 2026-11-14): the project editor and settings profiles were split by screen,
  form, repository and save-queue responsibility; task holds, attention phases and prerequisite
  reason facts now use shared owners. The changed N6 rows were re-rated at this PR's head.

- nucleus#1207 (floor 5, 2026-11-14): the question service and ladder were split by joint review, delegation, supersession, reviewer consult and escalation settlement; their N1 rows were re-rated at this PR’s head.

- nucleus#1218 (floor 6, 2026-11-14): the six floor-5 verbs rows were split or simplified by their
  named seams, and each resulting module was re-rated at this PR's head. `core/verbs/brief.ts` (9) now
  composes an amendment while `brief-routing.ts` (8), `brief-proof.ts` (10) and
  `brief-amendment.ts` (9) own the routing diff, the proof declaration and the delivery; the
  routing module's 8 is honest — the queue frontmatter is still diffed as untyped records compared by
  JSON text, and it is covered only through `amend_brief`. `core/verbs/dispatcher.ts` (9) keeps the
  ordered control switch and its documented record-only catches, with `control-outcomes.ts` (9),
  `owner-authority.ts` (10), `receipt-acceptance.ts` (10), `budget-extension.ts` (10),
  `no-automatic-retry-record.ts` (9) and `author-revision-cap.ts` (9) as their own owners.
  `core/verbs/disposition/hook-evidence.ts` is 9: it decodes hook records once, but still compares
  refusal prose; its boundary tests live in `test/disposition-hook-evidence.test.ts`. The amendment
  sweep uses an intent index but still revisits retained history, hence its 9. `owner-effects.ts`
  remains 7: it owns key decoding while force still slices incident keys.
  `core/verbs/owner-stop.ts` (10) keeps the stop and its hold, `deferred-verbs.ts` (9) owns recorded
  verbs and their replay, and `reviewer-auto-continue.ts` (10) owns automatic continuation with a
  retry window read from fence facts rather than refusal words. `core/verbs/restart.ts` (10) keeps
  admission while `restart-worker.ts` (7), `restart-review.ts` (10), `restart-episode.ts` (8),
  `executor-report.ts` (10) and `stalled-turn-stop.ts` (9) serve the shapes; `restart-worker.ts` and
  `restart-episode.ts` are the two honest 7s and 8s — their continuation rules still overlap the
  move-to-work author path and resolution's own episode re-arm. `core/verbs/retry-effect.ts` (10)
  keeps the order while `retry-effect-replay.ts` (9), `retry-effect-ordinary.ts` (9),
  `retry-effect-recovery.ts` (10) and `retry-effect-archive.ts` (9) own the halves; the effect key is
  decoded once by `splitOwnerEffectKey`. `shared/task-version.ts` (10) is the one typed stale-version
  refusal, and its N6 row was added there. The `core/questions/agent-asks.ts` row
  was re-rated at the same score because its duplicate brief-amendment answer now has one owner in
  `QuestionSupersession.answerOpenAgentAsks`.

  The owner-path hint revision re-rated `forge/reviews.ts` (6), `review/pr-adoption.ts` (10),
  `review/review-continuation.ts` (6) and `workspaces/unused-workspace.ts` (7). Their existing
  responsibilities and remaining defects are unchanged; the refusals now carry task versions.

- nucleus#1219 (floor 6, 2026-11-14): the milestone QA runner was split along its named seams — request
  identity and the atomic admission claim (`project-qa-admission.ts`), placement, checkout identity and
  scratch (`project-qa-placement.ts`), the host-run envelope (`project-qa-scheduler.ts`), supervisor
  handoff (`project-qa-launch.ts`), observation and re-attachment (`project-qa-reconcile.ts`), lost-run
  recovery (`project-qa-recovery.ts`), settlement and its notice (`project-qa-settle.ts`), teardown retry
  (`project-qa-teardown-retry.ts`) and retention (`project-qa-retention.ts`), with the shared declarations
  and fixed numbers in `project-qa-context.ts` and `project-qa-defaults.ts`; the three module-global
  supervision maps now have one owner (`project-qa-gates.ts`), and `project-qa.ts` is the public verbs and
  their composition. Settlement retention left the board read for the hourly retention pass. QA admission
  refusals carry a typed code on the request record (`project-qa-refusals.ts`, `shared/schema/qa.ts`)
  instead of being classified by diagnostic text, which `project-qa-schedule.ts` reads, and a settlement
  notice that cannot be delivered is recorded on the run. `core/qa/proof-execution.ts` no longer exists:
  refusals (`proof-refusal.ts`), receipts and declarations (`proof-records.ts`), dispatch admission
  (`proof-admission.ts`), the source proof (`proof-source.ts`), the selector evidence reading
  (`proof-selector-evidence.ts`) and the proof wait and autorun policy (`proof-wait.ts`) each have one
  owner, and the `proofExecutorAgents` re-export through QA is gone. The affected N4 rows were re-rated at
  this PR's head; the `qa-fence` rows in N4 and N6 were re-rated because no caller reads a fence message as
  a fact any more. Modules touched only to import from the new owners keep their rows.

- nucleus#1223 (floor 6, 2026-11-15): the lifecycle modules were re-rated at the PR head and each
  resulting module carries its own row. Retry routing became typed decisions
  (`recovery/retry-routes.ts`, 9), recorded evidence (`recovery/retry-evidence.ts`, 9) and one ordered
  application (`recovery/retry-orchestration.ts`, 9); the queued wait projection reads Queue's declared
  waits instead of a reason regex (`recovery/wait-context.ts`, 10); the ask service reads one decoded
  lifecycle per ask (`questions/agent-ask-events.ts`, 10) while `questions/agent-asks.ts` keeps its
  remaining routing/wait/resume seams (8); external merge passes one typed acceptance job
  (`merge/external-merge.ts`, 9), records an observed merge once (`merge/external-merge-record.ts`, 9)
  and owns the check park in named facts (`merge/external-merge-check.ts`, 8); closeout and its recovery
  read one stale-base rule (`closeout/closeout-base-refresh.ts`, 10, `closeout.ts` 10, `recovery.ts` 9);
  a hook occurrence's refusal kind is decoded once (`hooks/hook-refusal.ts`, 10) and `hooks/hook-replay.ts`
  reads it (8); the archive takes one typed request and refuses with a typed teardown code
  (`workspaces/owned-workspace-archive.ts`, 8) beside one thread-inventory owner
  (`workspaces/owned-workspace-threads.ts`, 10). `core/workspaces/repository-archive-gate.ts` had no
  product callers since 1173 and is deleted with its row, and its test proved only that dead path.
