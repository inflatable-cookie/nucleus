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

- nucleus#1237 (floor 7, 2026-11-15; implementation commit `91c8a5b72a917dedda5d3fdc7238cfaee2ebcd42`): `merge-gates.ts` now shares one accepted-head predicate across both hook gates (7: O1 T1 F2 P1 Pr2); `integration-turns.ts` uses the shared blocking-effects selector (7: O1 T0 F2 P2 Pr2); `merge-phase.ts` now only restores durable merge intent, while unchanged-check recovery belongs to `CheckWaits` and hook replay lifecycle decisions sit beside hook replay proof (7: O2 T0 F1 P2 Pr2). `hook-replay.ts` is re-rated at 8 with lifecycle settlement included, and the `check-waits.ts` row records its added gate owner. Existing exact-head, integration-turn, merge-intent and automatic-replay boundary tests remain in place; no behavior or test assertions were changed.

- nucleus#1233 (floor 7, 2026-11-15): the three floor-7 dispatch modules were consolidated and re-rated at
  this PR's head. `core/dispatch/participant-tickets.ts` became one tidy file group:
  `core/dispatch/participant-tickets/index.ts` composes issuance, delivery and revocation over the meta-row
  owner (`records.ts`), the one issuance routine (`issue.ts`) and the task-planner scope
  (`planned-threads.ts`), so the three near-copy planner/task-planner/named-agent routines are gone, no
  caller builds or splits a raw meta key, a failed issuance in the caller's own call is recorded, and the
  wrong-host fallback agent registration is removed. `core/dispatch/routing-signoff.ts` and
  `core/dispatch/routing-grants.ts` merged into `core/dispatch/routing-signoff/`: `request.ts` owns the
  sign-off record both writers share and the typed decode of its event detail, `grants.ts` the grant store,
  `reconcile.ts` the per-task pass, and `index.ts` the public surface. The per-task pass no longer re-runs
  the queue-wide grant settle, so a sweep is linear in tasks. `core/dispatch/routing.ts` keeps its job and
  loses its duplicates: the model key is `shared/authors.ts`' one normalisation (which also gains the
  normalisation itself, and is re-rated for it) and availability comes from the store's typed rows through
  `shared/pool.ts`, never three raw queries. Ten rows replace the four old ones; scores are recorded per
  row above with their evidence at this head.

- nucleus#1231 (floor 7, 2026-11-15): Queue shares repository and open-task predicates and its record selection has a separate state owner. The remaining tab composition keeps proportion at 0, for a score of 7. Lead action hints come from the core read; status views and brief-frontmatter detection share one owner across the client, planning and store; the screen scores 9. Cancellation receipts are schema checked, migrate through the shared storage helper and report storage failures; the session fallback remains, for a score of 8. The new owners and affected shared rules have rows at this PR head. Boundary tests cover repository identity, terminal task errors and receipt parsing and migration.

- nucleus#1230 (floor 7, 2026-11-15): the two floor-7 backup and capacity modules were simplified along
  their named seams and re-rated at this PR's head. `backups` (9) now reads a snapshot file name in one
  place (`snapshotName`/`snapshotFileName` in `core/store/backup-worker.mjs`), which the listing, the due
  check and `core/store/data-home-retention.ts` all use; the daily and weekly link rule is one
  `linkPeriods` both publication paths call; the status file is read once into a status and its own
  failure, so an unreadable or corrupt status is reported instead of reading as healthy; the replaced
  admitted source refuses with the typed `BACKUP_SOURCE_CHANGED` code instead of a message comparison;
  and the four-branch stream-fault catalogue left product code for the pipeline's own stage slots, so each
  fault still lands where its component would and the faults, their codes and their messages now live in
  `test/support/backup-faults.mjs` (the `failIntegrity` boolean stays: a corrupt snapshot cannot be
  produced from a healthy store without one). Its ownership stays 1 because the client
  panel still derives a snapshot stem for display, which is its own N6 row. `capacity-slots` (9) decides
  and names the capacity limit in one place (`capacityLimitFor`/`capacityReason`), so the pool scope is a
  typed value rather than the `Global` message prefix; `capacityFor` is no longer an alias of a second
  copy; the duplicate-pass memo is one `memoFacts` owner for both the dispatch pass and the board batch;
  and the wait label rule is written once. Its proportion stays 1 because `slotAdmissionExempt` and
  `slotRequestDecision` still answer overlapping eligibility questions from different facts, which a
  structural PR must not merge. `core/store/data-home-retention.ts` (9) gained the worker's name reader,
  which was the duplicate its row named; its proof stays 1 because the prune itself is only covered
  through its planner. Boundary tests were added for the snapshot name reader, the unreadable status and
  the typed capacity limit, and `test/staged-backup.test.ts` now asserts the refusal code.

- nucleus#1228 (floor 7, 2026-11-15): the three floor-7 client modules were re-rated at this PR's head.
  `client/task/runs.tsx` was split along its named sections: the tab now composes prerequisites and the
  run-bound cleanup, the runs and their delivery (`client/task/runs.tsx`), the worker exclusions
  (`client/task/runs-coordination.tsx`) and the closeout facts (`client/task/runs-closeout.tsx`), with the
  live-versus-released run partition and the cleanup subject as typed functions in
  `client/task/runs-view.ts`. The terminal `done`/`cancelled` pair the tab wrote inline twice is now the one
  owner `TERMINAL_PHASES`/`isTerminalPhase` in `shared/task-state.ts`, and the tab's unused `state` and
  `compact` props are gone. `client/task/parts.tsx` was hardened: the event kind label, the actor its detail
  names and the bounded detail line moved to `shared/task-events.ts`, which is the one place the reading
  happens (its own row keeps typed facts at 1 because the event contract has no actor column), and the
  Overview summary with the pending operator question is now `client/task/summary.tsx`. `client/web/app.tsx`
  decodes each live frame through `client/web/live-channel.ts` with the same board schemas the RPC path
  parses, writes the board query through the poll's key and replace-or-merge rule
  (`client/board-state.ts`), and shows a stream error instead of swallowing it, which is the one silent
  failure the row named. The four resulting modules that carry direct boundary tests score 10 (runs, runs
  view, live channel, parts and summary); the two section owners score 9 because the board render tests are
  their only proof. `client/task/task-dialog.tsx`, `client/task/overview.tsx`, `client/task/activity.tsx` and
  `client/queue.tsx` were touched only to import from the new owners and keep their rows; the `client board
  state hook` row was refreshed for the named key and merge rule.

- nucleus#1222 (floor 6, 2026-11-14): the four floor-6 dispatch and host modules were split or
  hardened along their named seams and re-rated at this PR's head. `core/dispatch/prompts.ts` is now
  the barrel over `core/dispatch/prompt-text/`: the rule and block owners (validation, report, proof,
  review, workspace, task blocks), the run scope and callback (`prompt-context.ts`), the role dispatch
  (`run-prompt.ts`) and one module per role prompt. `core/dispatch/participant-lease.ts` keeps the
  lease and execution lease, and the withdrawn-question settlement is `core/dispatch/withdrawn-question.ts`;
  the settled-thread predicate it used to repeat is `core/machine/agent-settled.ts`, the host-gone fact
  is typed (`isAgentGoneRefusal` in `core/host/errors.ts`) and the closeout base refresh is one named
  reason. `core/dispatch/run-launch/reserve.ts` is the composition over `reservation-source.ts`,
  `run-intent.ts` and `reservation-admission.ts`. `core/host/adapter.ts` composes the capability groups
  in `core/host/contract/`. The `launch-funnel` row rises to 7 because the exclusion refusal it named as
  copied is one text in `shared/task-view.ts`, and `core/questions/native-questions.ts` re-rates because
  an unreadable answered-question read is recorded as unknown instead of being skipped. `shared/host.ts`
  keeps its row: its finding is the free-string status and error fields, which this PR did not change.
  The reservation family's rows name the serialized run-list stamps the admission still compares, so
  `reservation-source.ts` and `reservation-admission.ts` score 8 on their remaining typed-fact and
  proportion defects rather than 9. `hosts/paseo/adapter/host-questions.ts` re-rates to 9 because its
  failed answered-question read is a typed `{ok: false}` now, leaving only its title-prefix decision match.

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
- nucleus#1221 (floor 6, 2026-11-15): `core/store/store-operations.ts` and `core/store/store-projects.ts` were split by
  owner (operations, pre-send settlement, notices, messages, hook events, pending submissions; registry, repository
  settings, agents, limits, removal, merge, management), and `shared/schema/task-control.ts` and
  `shared/schema/resolution.ts` by seam (field bag with a strict entry point, cross-field rules, task.next observation
  shapes; workspace and merge field groups). The four rows in `N3.csv` and `N6.csv` were replaced by one row per new
  module, scored at this PR's head. Scores are not all 7 or more: `task-control-rules.ts` stays 7 with proportion 0
  and `store-project-management.ts` stays 7, both named in the rows; `resolution.ts` stays non-strict by design.
  The resolution record keeps its original parsed key order (workspace and merge groups spread at their old
  positions), so task digests do not change. Store member checks share one predicate, `repositoryMemberMatches`
  (`core/store/store-project-registry.ts`); the shared `projectRepositoryMatches` stays a separate rule for removal
  and management. `task-control-fields.ts` has its own row. Citations to `store.ts` and `store-maintenance.ts` in rows
  for unrelated modules predate this PR and are left for their next re-rate.
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
- nucleus#1220 (floor 6, 2026-11-15): `core/engine.ts` and `service/runtime-owner.ts` were split along their named seams — host-adapter routing, lane-key parse and profile catalogs from the engine; host-connections, store-maintenance and origin-review wrapping from the runtime. Their N2 and N5 rows, plus `service/t3code-host.ts`, were re-rated at this PR's head. Origin-proof wrapping method-calls `withHost` so a class owner keeps its host context. Engine loc is 1061 after merging #1218's owner-verb wiring into the composition root.
- nucleus#1224 (floor 6, 2026-11-15): report-run acceptance is one shared classifier; telemetry now has
  separate owners for task facts, reviewer calibration, task-control rates and snapshot aggregation;
  Git status and hook gates use their checkout and hook owners; transport phase and loss classification
  has one shared owner. The task-stop and task-view rows score 6 (O1+T1+F1+P1+Pr2): existing typed
  records and boundary coverage are sound, while historical stop text, waiting references and
  escalation holders still need compatibility fallbacks. Other resulting modules score 7 or more;
  their five-part sums, reasons and PR-head evidence are in the updated N2, N3, N4 and N6 rows.
  The shared service client names its typed errors so the transport classifier preserves roll recovery
  for draining, unavailable and elapsed timeout responses; its N6 row is re-rated as well.

- nucleus#1223 (floor 6, 2026-11-15): the lifecycle modules were re-rated at the PR head and each
  resulting module carries its own row. Retry routing became typed decisions
  (`recovery/retry-routes.ts`, 9), recorded evidence (`recovery/retry-evidence.ts`, 9) and one ordered
  application (`recovery/retry-orchestration.ts`, 9); the queued wait projection reads Queue's declared
  waits and owns the two dispatch-hold reasons it writes, so a released hold is never re-shown
  (`recovery/wait-context.ts`, 10); the ask service reads one decoded lifecycle per ask
  (`questions/agent-ask-events.ts`, 10) while `questions/agent-asks.ts` keeps its remaining
  routing/wait/resume seams (8); external merge passes one typed acceptance job
  (`merge/external-merge.ts`, 9), records an observed merge once (`merge/external-merge-record.ts`, 9)
  and owns the check park in named facts (`merge/external-merge-check.ts`, 8); closeout and its recovery
  read one stale-base rule that also spends the re-pins recorded under the previous event kind and uses
  the one named refresh reason (`closeout/closeout-base-refresh.ts`, 10, `closeout.ts` 10,
  `recovery.ts` 9); a hook occurrence's refusal kind is decoded once (`hooks/hook-refusal.ts`, 10) and
  `hooks/hook-replay.ts` reads it (8); the archive takes one typed request and refuses with a typed
  stage (`workspaces/owned-workspace-archive.ts`, 8) beside one thread-inventory owner
  (`workspaces/owned-workspace-threads.ts`, 10), and `workspaces/archive-failure.ts` (10) classifies a
  Queue-authored refusal by that stage, leaving message text to foreign failures alone.
  `core/workspaces/repository-archive-gate.ts` had no product callers since 1173 and is deleted with its
  row, and its test proved only that dead path. The rows for `terminal-workspace-retirement.ts` and
  `unused-workspace.ts` were refreshed because the archive call and the failure classification they use
  changed owner; both keep 7.
- nucleus#1225 (floor 6, 2026-11-15): `service/callbacks/host-run-endpoint.ts` (10) and
  `service/executor/host-run-supervisor.ts` (10) were re-rated at this PR's head. The endpoint now delegates
  each durable mechanism to its own owner — `core/host-runs/host-run-submissions.ts` (10) for the
  submission record, `core/host-runs/host-run-facts.ts` (9) for the `report` fact log and its journal
  identity, `core/host-runs/host-run-retained-output.ts` (10) for the capped retained streams — and answers
  a refusal with the code a typed `core/host-runs/host-run-refusal.ts` (10) carries instead of classifying
  message prefixes. The supervisor runs its command through `core/machine/process-exec.ts` (8), which now
  also owns contract 010's escaped-descendant settlement for host runs: the step stays live while it waits
  (pipes open, cancel still polled, timeout still applying), inventories escapees on every settlement tick
  while the group survives, and signals a descendant only after proving the pid still carries the recorded
  birth identity. The supervisor keeps only the run's durable wiring, which is why it is 10.
  `core/machine/escaped-descendants.ts` (10) owns that rule, including the two-condition absence proof —
  a readable identity listing with no escaped process *and* every recorded identity proven dead by its own
  pid-and-identity read, so a known descendant that execs a clean environment or whose identity cannot be
  read never counts as absent, an orphan a recorded escapee would hide is still found by the global listing,
  and the first clean instant survives faster polling — and it is covered directly by
  `test/escaped-descendants.test.ts` (known-live-omitted, dead or reused pid, unobservable identity, and a
  stale recorded pid that must not be signalled). `core/host-runs/host-run-files.ts` (8) grew
  `readCheckedHostRunFileRead`, which keeps a missing, a refused and a present file apart — only a proven
  missing component is absent — and the refusal code is now a field on the owner that refuses in
  `host-run-scheduler` (7), `host-run-admission` (7), `host-run-accounting` (8) and `host-run-settlement` (8);
  those four rows keep their remaining named defects. `core/host-runs/host-run-wire.ts` (9) also owns the
  cancel request's read and write, `core/host-runs/host-run-attach.ts` (9) reads the typed submission for its
  disconnect window, and `service/callbacks/host-run-serving.ts` (9) lost the duplicated answer evidence, a
  dead pre-front branch and a stacked docblock. `process-exec`'s 8 is honest: its default path still records
  an unreadable identity listing as an empty inventory and it still reads the leader's identity
  synchronously in the spawn handler.
- nucleus#1226 (floor 6, 2026-11-15): QA run kind now comes from its joined typed QA record, validation identity uses the canonical decoder, and the board and scheduler share one settled-run capacity predicate (`shared/host-run-capacity.ts`). The caller encoder and decoder moved to `shared/project-validation-caller.ts` so both the client and core use one owner without crossing the client-to-core boundary. Usage elapsed time and provider labels delegate to their existing shared owners. Pipeline Lead/Papercut presentation and selection moved into `client/board/triage-lead-card.tsx`, where one `triageKind` result drives the label and action. Failed web question refreshes preserve the last known requests and return an explicit error; successful empty reads still clear them. Boundary tests cover failed and empty question reads and the elapsed-window midpoint and reset.

  The four requested N6 rows all score at least 7: QA runs is 9 because typed QA records, canonical identity and shared capacity have single owners; usage is 8 because elapsed time and provider labels have shared owners, while unknown-duration wording still uses window names; Pipeline is 9 because the card owns classification and routing while column composition remains proportionate to the board; web questions is 8 because failures are explicit and preserve state, while task polling stays separate from the native observer. The changed native-question row is 8: its snapshot and failure-preserving refresh have one state owner, while polling sources remain distinct. The new triage card row is 10 because one classification result controls both label and selection. The shared capacity rule is 9 because the custody predicate has one owner and boundary coverage. The shared project-validation caller row is 9 because one exact encoder and decoder owns both strings, with plain-string inputs leaving schema proof at 1. `core/host-runs/host-run-capacity.ts` remains at 6 in N4: it consumes the shared custody rule, but its legacy QA/task SQL, casts and malformed-row skips plus task-191 memory special cases remain unresolved.
- nucleus#1227 (floor 7, 2026-11-15): the private host-run supervisor now recognizes the authority schema, clears its restart flag on every exit path and logs each cleanup failure (8: O1 T2 F2 P1 Pr2; warm-standby supervision remains duplicated beside the bridge). Paseo and T3 connection state cross the optional host-neutral adapter contract; the shared probe treats an absent capability as offline, and the Paseo entry no longer exposes a host-specific wrapper (Paseo entry 10: O2 T2 F2 P2 Pr2; core adapter contract 9: O1 T2 F2 P2 Pr2; T3 entry 7: O1 T2 F1 P1 Pr2, with its delegation and archive pagination seams retained). Paseo observations use `observationFromInventoryEntry` for both inventory and per-agent reads, inventory and MCP failures use named error types, and catalog feature failures are logged while retaining the existing empty-feature fallback (9: O2 T2 F2 P1 Pr2; the adapter still owns a broad native delegate surface). Advisory roll requests use `normalizeRepositoryOrigin`, report caught failures and register explicitly at runtime construction; their synchronous boolean port still runs bounded Git on the caller thread (9: O2 T2 F2 P1 Pr2). The unused `service/install/build.ts` re-export and its runtime package mapping were removed. `service/runtime-owner.ts` was re-rated at 8 because its explicit roll registration changed while its retained delegation and catch-to-null seam remain. The catalog fallback remains the same; logging the failed optional read is the named silent-failure exception. The Paseo-only probe and dead build path are the named removals.
- nucleus#1229 (floor 7, 2026-11-15): hook cleanup reads its rowid high-water mark through the store owner and all three reap paths use the shared asynchronous tree remover (N4, 7); the one-method retention adapter and the unused intake `.mjs` and declaration shims were deleted, with their callers and build aliases removed. Supervisor liveness now lives beside canonical start-identity proofs (N4, 9), including a boundary test for a recorded identity belonging to a different pid. Callback reminders share binding observation with dispatch, send notifications in the task host context and use one named missing-callback cause (N2, 8). The new cause constant is shared with lifecycle and responsible-fault readers (N6, 9). Deleted shim paths and runtime aliases are covered by a boundary test. The QA inspection and validation modules remain at 6: this task changes only their liveness import; their existing defects remain outside this task's scope.
