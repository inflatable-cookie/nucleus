# 022 — Nucleus projects without manifests

Status: implemented
Owner: Nucleus runtime and protocol maintainers
Created: 2026-09-26
Decision owner: Tom
Governing refs: Northstar Spec 042,
[Spec 015 prospective merge](015-prospective-merge-pre-merge-hooks.md),
[Spec 018 Nucleus-owned closeout](018-queue-owned-closeout-and-durable-outcomes.md)

## Goal

Tom approved on 2026-09-26: project repositories carry no Nucleus files at all.
Nucleus's behaviour for a repository comes from Nucleus's own store, not a
`.paseo/queue.json` in the repository. Manifests remain only for legacy
repositories until they migrate. This replaces Spec 042 item 3's manifest
`validation` field idea, which is dropped.

## No manifest means Nucleus closeout

`classifyCloseoutAuthority(null)` returns `queue`, not `agent`. A repository with
no manifest at the task's synchronized commit behaves like
`{ v5, closeout: "queue", hooks: [] }`: Nucleus-owned closeout, nothing written to
the repository, brief mode allowed. v1–v4 manifests keep their exact behaviour.
v5 stays accepted but is no longer needed.

**Planning identity reads the pushed head.** Brief capture records the pushed
integration head (`origin/<base>` after a fetch) as the planning commit and reads
manifest eligibility there, not from whatever commit the shared local checkout has
checked out. Consumer-b's cutover was refused because that checkout was still one
commit behind. Handoff capture keeps its committed-file rule.

**Who changes (checked on 2026-09-26).** Of the repositories Nucleus has used, four
have no manifest and currently get `agent` closeout. `nucleus` (11 of 11
closeouts), `effigy-catalog-pack` (2 of 2) and `underlay-effigy-bundle` (1 of 1)
used it to commit closeout logs, roadmap updates and handoff status.
`project-h` (1 closeout) wrote nothing. Under the new default they stop getting
those commits. A repository that should keep its closeout agent sets the project
override below. Tom ruled on 2026-09-26 that all three go lean, with no override.
Their documentation migrations land before g01.053 is rolled to the live service.

## Project settings

A `repository_settings` table in Nucleus's store, one row per repository, never purged and
host-neutral:

| Field | Content |
| --- | --- |
| `repository` | Normalised origin (`owner/name`), plus the local path as a hint; the same identity as outcomes, lanes and task numbers |
| `closeout` | Optional override for a repository with no manifest: `queue` (default) or `agent` |
| `validation` | Optional prospective-merge command (g01.054) |
| `updatedAt`, `note` | Last change and an optional operator note |

- Set through an operator RPC and CLI (`repository.set`, `repository.get`, `repositories`),
  and documented in the Nucleus skill. `repository.set` patches: only the fields named
  in the input change, an explicit `null` clears one, an absent field is untouched,
  and it returns the full resulting settings (papercut 3fbf11d1). There is no board
  editing in this version.
- A manifest, when present, still governs that repository; the project closeout
  override applies only when there is none.
- Closeout authority is read at the synchronized commit, as today. For a
  repository without a manifest, the authority is the project override when set,
  otherwise `queue`.

## Project validation command (Spec 042 item 3)

`validation` is `{ argv, timeoutMs, maxOutputBytes }`, an explicit argument list
with no implied shell, set by the operator. `timeoutMs` may be up to 1,800,000
(30 minutes): a fresh-checkout validation installs dependencies and runs the full
CI, which already takes about ten minutes for project-k. The run holds the
repository's integration turn while it lasts. Output past `maxOutputBytes` never
stops the run: Nucleus keeps a bounded beginning and end of each stream inside that
same cap, with a marker naming the observed, retained and omitted byte counts,
and the exit code decides. A capped stream never reads as complete output.
(Hooks differ: their output is their result, so a hook past its
limit is terminated.) It applies to repositories with no
manifest or a v5 manifest. Repositories on v1–v4 keep their manifest hooks and
never get a second gate.

- **When:** at the prospective merge, after an accepted review and before the
  merge, in Spec 015's Nucleus-owned candidate checkout: the exact reviewed head
  merged onto the current integration base. It inherits 015's freshness rules: a
  moved base or head reruns it and spends no revision round. A settled result
  is reused only while the environment that produced it is unchanged: the
  Nucleus build identity and the repository settings revision must still match.
  A settled result for an older PR head is recorded as superseded and cannot
  block review of the current head; validation runs again for that head.
  A changed build or a later settings write reruns an ordinary settled result; a
  lost or timed-out run stays held until an explicit retry. An unchanged
  environment still reuses, so automatic passes never loop.
- **Contract:** exit code 0 passes. A non-zero exit is a semantic refusal that
  returns to the worker as one revision round, with a bounded tail of the output
  as the finding (Spec 007's semantic loop). A timeout, a launch failure or a
  candidate left changed is an operational hold for the operator, not a revision.
- **Environment:** the candidate checkout as the working directory, with Nucleus's
  minimal hook environment. Installing dependencies is the repository's concern:
  the command must work in a fresh checkout (Tom, 2026-09-26).
- **Record:** the argv, its digest, exit code, duration, output tail, Nucleus
  build and settings revision are stored on the task and in the outcome row's
  `validation` field. The stored tail is the durable finding a refusal carries:
  when the executor's `maxOutputBytes` cap cut a stream, it keeps a bounded
  beginning and end around the marker and counts inside the same 2,000-character
  bound, so a long failure's beginning is not lost at this last step (Task #388).
- A project with no validation command merges on independent review and GitHub's
  merge checks, as today. Per-task validation stays opt-in: the setting defaults
  to null and no default command is ever stored there.

## Milestone QA runs (task 104)

Full QA no longer runs per task. The operator or a planner asks Nucleus to run a
repository's full QA on current `main` at a milestone (`project.qa.run`) and
sees the result in the QA runs tab, whose run detail is the one QA detail; the
project plan carries the latest result as one compact line linked to it
(`project.qa.get`, `project.qa.list`).

### Scheduled milestones

Tom's 2026-10-09 compile-only opt-in requires a recurring milestone trigger.
Scheduling is a separate, explicit repository opt-in, not inferred from any
stored validation text (the per-repository validation policy is retired,
Tom, 2026-11-09; the repository's AGENTS.md Validate section is the only
source). Preserve the configured QA argv or stages when
setting `qa.schedule` through `repository.set`:

```json
{"repository":"owner/repo","qa":{"argv":["effigy","qa"],"timeoutMs":7200000,"schedule":{"afterMerges":5,"maxIntervalHours":24}}}
```

`afterMerges` is required (1–1000); `maxIntervalHours` defaults to 24 (1–24).
Omitting `schedule` from the full replacement QA setting, or setting it to
`null`, disables scheduling. Repository-set patch semantics still preserve an
omitted `qa`; changing another setting never changes stages or enables
QA. Use the actual registered origin: consumer-b's policy opt-in is
`consumer-b/consumer-b-v2`, not its stale inflatable-cookie alias. This feature
changes no repository setting automatically.

Nucleus admits current `main` through the same `project.qa.run` implementation
when enough newly untested main merges accumulate, or when the interval from
the last main run's submission passes with such merges pending. Without a prior
main run, the interval starts when the enabled schedule is first observed.
Idle repositories do not run. Admission keeps the existing host budget,
request identity, detached supervision and one-run-per-repository guard,
including an active release-line QA. Pause, disabling the schedule, settings
changes and project ownership are rechecked after awaited fetches and before
claim. Scheduling does not restart Paseo, Colima or a repository's runtime.

### QA admission fence

Papercut 26636095: an install owner swapping a shared tool (the Effigy binary,
an installed skill) needs a bounded interval in which no new milestone QA
starts. Tom ruled on 2026-10-22, answering the design question: "Build as
designed (Recommended)" (QA admissions only), "Operator + relay
(Recommended)" (who may set or clear it) and "10 min default, 2 h cap
(Recommended)". The Northstar planner raised no objection, and the Nucleus
Chatterbox shaped the constraints below.

- **Control.** `project.qa.fence` sets, replaces or clears one host-wide fence:
  `action` `set` or `clear`, `expectedRevision`, a `reason` for `set`, optional
  `minutes` (default 10, at most 120), `caller`, and for a relay `relayed: true`
  with the operator's authorization `note`. Only the operator (`caller`
  "operator" or "operator (board)") or an explicit relay writes it; a project
  owner alone, or any other caller string, is refused with nothing written.
- **Revision and expiry.** Every write must name the stored revision, so a
  stale client cannot replace or clear a newer fence and a retried write is
  refused rather than applied twice. The expiry is absolute: nothing renews it,
  only an explicit `set` replaces it. Expiry is read lazily and writes nothing;
  it survives a service restart because it is a stored absolute time.
- **Enforcement.** Only a new run is fenced, inside the atomic admission claim.
  An accepted request replays its run and a request joining an active run for
  the same repository is admitted, because neither creates work. A refused
  admission leaves a durable `refused` request whose diagnostic starts "QA
  admission is fenced", with no QA run and no host reservation; a request
  already preparing when the fence lands is refused at its claim. Admitted,
  queued and running QA is never touched.
- **Scheduler.** While the fence is in force the scheduler mints no new request
  identity, so the merge batch waits whole. A scheduled request refused by the
  fence is a lifecycle refusal: the batch signature stays open and the next
  identity is a new generation, minted after expiry or clear.
- **Inventory.** The write and `project.qa.fence-status` return, from one
  transaction, every unsettled QA custody item on the host: QA runs not
  finished (all rows, not the latest-per-repository index), finished runs with an
  escaped descendant that no recorded exit proof covers (a proof covers only the
  identities its host run recorded, not a later retry's), requests still preparing
  however old, and milestone host runs queued, admitted, running or settled
  while still holding capacity. A row that cannot be decoded is listed as
  unreadable, never dropped, and the read never throws. An unreadable stored
  fence record fails closed: admissions stay fenced and the board says so until
  the operator sets or clears the fence at revision 0. The snapshot proves an empty QA interval only while the same fence
  stays in force.
- **Not covered.** Task validation runs and Effigy client host runs are not
  fenced, and the fence proves nothing about binary compatibility or OS
  settlement. The release contract says what an install owner does about them.
- **Board.** The header shows the fence in force with its reason, setter and
  countdown, and a Clear button that writes as "operator (board)" on the
  current revision. The QA runs tab shows the inventory and its Run QA button
  reads "QA fenced"; the server refusal, not the disabled button, is the
  enforcement.

A host-local index records main-branch merged outcomes; cancellation and
release-branch merges do not count. Existing retained tasks can establish the
branch during migration; purged/imported outcomes without branch provenance
are not guessed. Outcomes remain immutable. Green coverage requires each
merge commit to be an ancestor of the exact passed main head, not just an older
timestamp. Late outcome records are reconciled against that head. A run also
records which merges it actually attempted, so an unchanged failing head is
not rerun on a timer; new untested merges can trigger a new milestone.

The current project owner receives a durable result notification, including
run/head/state/exit/failed step and merges not covered by the last green run,
with task, PR and merge identities from outcomes. Notifications wait for an
idle owner, preserve uncertain delivery and follow ownership changes. Disable
or dormancy prevents delivery. Unresolved admission is reconciled under its
original request ID; neither a lost reply nor restart authorizes resubmission.
A definitely refused unchanged batch remains diagnosed until its configuration
or merge batch changes. A refusal caused solely by a post-fetch lifecycle fence
proves no admission: once eligible, Nucleus uses a new durable request generation
for that same batch, preserving the refused request and never replaying it. Up to 1000 uncovered merges are reconciled; exceeding
that bound requires owner attention rather than silently truncating accounting.

A red result or unresolved admission starts one failure episode. The owner is
reminded at `maxIntervalHours`; after 24 hours an existing operator decision
escalates it to Tom. This does not create a worker, content fix or review loop.
A later green main result ends that episode and withdraws its still-open
automatically created decision. Scheduling grants no task or merge approval,
changes no source or signing authority, and never replays an old lost run or
an independently gated live attempt.

- **Checkout:** a Nucleus-owned linked worktree of the repository's *registered
  checkout*, exactly as a Paseo task worktree is, detached at the fetched
  integration head (`origin/<baseBranch>`), under the Nucleus data directory
  (`project-qa/`). Its `.git` pointer resolves to the registered repository's
  common directory, so repository setup that derives its primary checkout from
  Git — Effigy's `worktree:rust:seed`, the Northstar `paseo:worktree` helper,
  `primaryCheckoutRoot` — sees the same primary a task worktree sees, including
  its warm build caches and its local vault. The registered working tree is
  never switched, dirtied or built in: Nucleus only registers the worktree's
  administrative entry and checks out files under its own data directory, and
  detaches the entry again when the run settles. Nucleus prepares the relative
  sibling layout before setup — project members, literal relative sources
  declared in `paseo.json`'s Northstar `paseo:worktree prepare` setup call, and
  the registered primary's Effigy dependency-link ledger. Each source resolves
  relative to the primary checkout root through a Nucleus-configured checkout,
  exactly as the repository's own helper resolves it, so the helper accepts the
  links Nucleus placed. This is Paseo's worktree contract without registering the
  QA worktree in the user's task worktree root or borrowing task worktrees.
  Task checkouts are a separate path: they share this parser and resolver but
  place only declared links, with no project members and no setup (see the
  [orchestration contract](../contracts/orchestration.md#orphan-worktree-after-a-timed-out-create)).
  Nucleus runs the exact commit's
  `paseo.json` `worktree.setup` before QA and `worktree.teardown` after it settles.
  The linked worktree gives per-checkout setup effects, such as
  Effigy container scope, a unique QA identity. A setup error is an operational
  hold with its output tail; it is never reported as a QA failure. Teardown
  also runs when setup or QA fails and while reconciling a lost run.
  (Before this, Nucleus backed the worktree with a private clone. The repository's
  own helper resolves sibling sources and the primary's ledger and caches from
  the worktree's Git primary, so a private clone forced a cold, unregistered
  primary: consumer-b's `effigy worktree:rust:seed` then built a toolchain-keyed
  Cargo cache from cold instead of seeding from the registered checkout's warm
  one. Layout parity is the fix; a private primary and a registered primary
  cannot both be what setup sees.)
- **Admission:** through Nucleus's host scheduler as a heavy run, with one run
  per repository at a time. A second request while one is running returns the
  running one — including a concurrent one: the claim is one atomic store
  transaction after the read-only fetch, and the in-process fence is shared
  process-wide, so two callers that fetched together still serialize at the
  claim and the loser returns the winner's running row. While admission holds
  the run, the record reads "Waiting for QA capacity (position N)"; a wait
  is never a failure or a stall, and a Nucleus scheduler `capacity_timeout`
  becomes a typed "capacity unavailable" hold, never a QA failure. The
  scheduler's host-run ID links the project record to its durable settlement
  and queue-wait, wall and CPU telemetry; unavailable metrics remain null,
  never zero. A whole staged run is admitted once (Task
  #121): its stages never re-queue between themselves, and each stage's
  timeout starts at that stage's own launch. The run's host envelope covers the
  setup hook, every stage's own timeout and the teardown hook, so a slow setup
  or an earlier stage can never consume a later stage's window; the stage
  timeouts together stay within `PROJECT_QA_TIMEOUT_MAX_MS`.
- **Command:** the repository's `validation` setting when set, else the
  default `effigy qa`. The fallback stores nothing: the per-task setting stays
  null unless the operator opts in. The run records argv, digest, exit code,
  duration, output tail, base, host-run identity and capacity state. The
  scheduler record is the source of queue-wait, wall and CPU telemetry.
- **Step output:** setup, QA and teardown are recorded as separate steps on the
  run (`steps`), each with its own command, exit code, signal, timeout and the
  head and tail of its own stdout and stderr. A stream past the step's
  `maxOutputBytes` keeps a bounded beginning and end inside that same cap, and
  both excerpts carry one marker naming the observed, retained and omitted byte
  counts, so a capped step never reads as complete output (Task #388). Each step also records its process
  group id, the leader's start identity, the termination signal and whether its
  process group was empty afterwards. Timed-out steps get the configured
  `terminationGraceMs` (30 seconds by default) to handle SIGTERM before Nucleus
  sends SIGKILL to the group; an output-limit kill uses the same path. While
  the leader is Nucleus's own unreaped child its group id cannot be reused, so the
  group is signalled directly; the start-identity proof is required only once
  the leader has exited. A step that fails that proof while its leader runs
  would otherwise never be signalled or settle.
  These steps share the validation executor, so repository worktree hooks use
  the same process-group termination and identity checks. The run's shared `outputTail`
  re-states the first failing step's own output last (`failedStep` names it), so
  a long teardown can never evict the failing step's error the way it did when
  one flat tail held every command's output, and it says when it is only the end
  of a longer detail. Since Task #121 each step's
  stdout and stderr — already capped at the step's `maxOutputBytes` — is written
  to a mode-0600 log beside the run under the QA root
  (`<runId>.<step>.stdout.log` and `.stderr.log`), and `project.qa.get`
  returns each step's log path and byte counts beside the short head/tail
  excerpts. QA stages trim passing test lines before failure lines inside that
  cap and say so in the marker, with the observed, retained and omitted byte
  counts; every other step keeps a bounded beginning and end. On 2026-10-01 Project-d's run `1b5ac3c3` lost the
  clippy error locations because the excerpt is only about 250–512 characters
  a stream, however large `maxOutputBytes` was. Logs are removed with the
  run's retention, never earlier. A log that cannot be written is reported in
  two places: a diagnostic line in the run detail and a structured
  `logWriteErrors` entry (`{step, stream, error}`) on the run. The list is
  bounded to the newest 16 entries and is separate from `outputTail`, so later
  output can never truncate it (Task #136).
- **TAP failure index (Task #290):** while each QA stage streams, Nucleus records
  failed and cancelled test identities, title, first available source location,
  and TAP summary counts separately from the verbose failure blocks. The spec
  reporter's trailing failing-tests section feeds the same index and log, with
  one identity per failing test (its inline progress mark carries no
  diagnostics and is not a second identity). The
  index retains every observed identity across stages. Source locations are bounded
  at 4,000 characters on the wire; `locationTrimmed` marks any shortened
  location. If summary counts exceed
  observed identities, the index reports the missing count and marks itself
  truncated. Diagnostic excerpts share a bounded budget across stages; identity
  lines remain in the failures log even when they exceed that budget. The log
  counts cases with trimmed diagnostics. `diagnosticsTruncated` records any
  dropped diagnostic or summary text. The planner notice names up to 20
  identities and counts the rest. `project.qa.get` and the QA detail views expose
  the index and truncation flags. Standalone
  pipeline execution uses the same collector on its retained output. An index
  inventories failures; it does not attribute them to owners or establish that
  a milestone is fixed. Failure-first retention evicts old ordinary lines with
  a moving head and periodic compaction, so a stream of short lines stays
  linear-time while its retained output stays within the existing byte cap.
- **Detached supervisor (task 114):** the setup, QA and teardown pipeline runs
  in a detached supervisor process that outlives the service, because Nucleus
  rolls its service on every merge to its own repository. The service claims the
  run, resolves the sibling links from Nucleus's records, writes a per-run plan
  under the QA root and spawns the supervisor; the supervisor's exit code is
  advisory, and the per-run file is the record. Before each step starts it
  records which step is in flight; as each step settles it writes that step's
  command, exit code, signal, timeout and the head and tail of its own stdout
  and stderr beside the checkout, and it writes the final result when the run
  settles. The service owns the store and never reads it from the supervisor.
  On 2026-09-30 a roll mid-run lost consumer-b's 7b323d2d and 5181dfcb with
  `steps: []` and `durationMs: 0` after setup had completed; the per-step file
  makes that impossible.
- **Re-attach, or loss only when proven:** a restarted service finds the running
  supervisor by its recorded pid *and* the run's random identity token, which
  the supervisor carries in its own argv. A pid alone is recycled, and a process
  start time is not precise enough to tell a reuse apart (`ps` start times
  resolve to one second on macOS), so the pid is trusted only when the live
  process's command line carries this run's token — which no recycled pid can
  have. A command line this host cannot read is `unknown`, never dead: the
  service keeps re-attaching and retrying, because a transient read failure must
  never reap a live run. The plan the service writes before spawning carries the
  token, so the identity exists before any pid is trusted. If the service rolls
  after spawning but before recording the pid, the run is resolved by looking
  for a live process carrying the run's token — found keeps it running however
  long it takes, and only a completed scan with no match proves the supervisor
  is gone. A scan that could not read every candidate (a failed listing, or a
  `/proc` read the host refused) is unknown, not absence. No elapsed time ever
  stands in for that proof. The stale-heartbeat stop policy is owned by
  [Spec 035](035-host-run-scheduler.md); Nucleus still proves the supervisor and
  child process tree dead before settling the run lost. With a current heartbeat,
  the run keeps running: the new service mirrors settled steps onto the record,
  keeps the Nucleus scheduler reservation by host-run ID, and records the
  supervisor's result when it lands. A progress-mirror store write that fails
  does not stop supervision: the run keeps its host reservation and live
  command identity, and the next poll retries the mirror (Task #136). A run is
  reconciled as lost only
  when the supervisor is proven dead — the pid is gone, or it now runs a
  different command line — and the lost report names why.
- **A lost run keeps its shape:** reconciliation keeps every step the supervisor
  had recorded, names the step in flight as `interruptedStep`, and records the
  real duration from `startedAt` instead of zero, so "lost during setup" and
  "lost during qa" can be told apart. Teardown still runs from the retained
  checkout and keeps its own separate step record, and the checkout is removed
  when teardown settles.
- **Authority:** none. A milestone QA run grants no merge authority and gates
  no task; a non-zero exit is a recorded `failed` result, not a revision round.
- **Record:** durable history in `project_qa_runs` (schema 32); the latest row
  per repository key is the board-read current run, via the bounded
  `project_qa_latest` index (schema 33) so the board never scans the history.
  A `running` row no live backend owns (restart or crash between intent and
  settle) is reconciled to a hold and its Nucleus-owned checkout removed on the
  next read or request — the recorded pid is never signalled, so the Run
  control never sticks disabled. The periodic sweep also picks up running rows
  after a restart, so a supervisor that settled while the service was down is
  recorded without waiting for a board read.
- **Request delivery (Tom, 2026-10-07):** a lost `project.qa.run` response
  is not permission to submit another milestone. Its payload is
  `{repository, baseBranch?, expectedHead?, requestId?}`: `repository` is a
  trimmed nonempty string up to 1,024 characters; `baseBranch` defaults to `main`
  and must start with an ASCII letter or digit followed by letters, digits, `.`,
  `_`, `/` or `-`; `expectedHead` is 40 lowercase hexadecimal characters;
  `requestId` is trimmed to 1–160 characters. The CLI generates and prints the ID before
  connecting; callers can supply their own durable ID. Nucleus records normalized
  input, service-instance UUID, PID and receipt time before repository lookup or
  fetch. Admission links that record to the QA run in the same transaction.
  Reusing an admitted ID returns its original run, even after settlement; changed
  input, a pending request or a refused request never launches a replacement.
  `expectedHead` refuses a fetched or already-active run at another head.
- **Read-only delivery lookup:** `project.qa.request-status {requestId}` returns
  its request and linked run without fetch, reconciliation or scheduling; the
  trimmed ID is 1–160 characters. `{repository, since, expectedHead}` (repository
  trimmed nonempty up to 1,024 characters, `since` an ISO datetime, expected head
  a 40-character lowercase commit ID) returns request records for that exact
  submitted repository string and every matching historical QA run by canonical
  repository path/origin, head and admission time. It refuses more than 100 rows
  rather than hiding records; narrow the window. Missing old request records do
  not prove non-delivery. For requests preceding this contract, first establish
  that the original service instance has retired, then check the complete
  exact-head admission history. Lookup never retries or settles a record.
  Admission is durable before scheduler delivery, so an admitted record must be
  followed by its run ID.
- **Interrupted preparation (2026-10-22):** a request records the writer lease
  that took it (`processOwner.owner`, the runtime's single-writer identity) as
  its `ownerInstance`. The lease is taken only when the previous owner's
  process is gone, and the admission claim sets `admitted` together with the QA
  run, so a request still `preparing` under another owner while this runtime
  holds the lease can no longer be claimed and claimed no run and submitted no
  host run. The recovery sweep (start-up, board reads, and the scheduler before
  it reconciles its pending request) settles such a request as `refused`, with
  `settledAt` and a diagnostic starting "QA request preparation was
  interrupted"; its id, input, owner, pid and receipt time are kept. The
  current owner's own preparations, admitted and refused requests, and a record
  whose owner binding does not decode are never touched, and nothing is
  replayed. The claim admits a request only while it is still this runner's
  own `preparing` record, so a settled request never turns admitted. Using a
  new request ID afterwards is a fresh submission, not a replay. The scheduler
  treats the refusal as a lifecycle refusal and resumes its batch once under a
  new generation.
- **Teardown retry (task 134):** when a run settles `hold` with
  `failedStep: teardown` — teardown failed but its `qa` step's result is
  intact — the operator can retry teardown alone (`project.qa.retry-teardown
  {id, reason}`, RPC and CLI, and a "Retry teardown" control with a required
  reason in the QA runs tab). It is refused unless the run is settled, its
  `failedStep` is `teardown`, its Nucleus-owned checkout is still retained and no
  supervisor is live. The retry spawns the same detached supervisor in a
  `teardown_retry` mode that runs only the *recorded* teardown command, through
  the same hook executor, process-group termination and per-step logging; it
  never reruns setup or QA and never rewrites the `qa` step's result, exit code
  or output. The new attempt is appended to `steps` and the original failed
  attempt stays. On success the checkout and its sibling links are removed and
  the run settles to the state the `qa` result implies (`passed` for exit 0,
  `failed` otherwise), keeping the whole teardown history; a failed retry stays
  `hold` with the new attempt recorded and the checkout retained, so the
  operator can retry again. Each attempt uses its own
  `<runId>.retry-<n>.plan/supervisor/result.json` files, so a retry is durable
  across a service roll and never overwrites an earlier attempt's evidence. The
  checkout is removed only by a teardown that succeeds, never by Nucleus on its
  own initiative.

- **Command:** the repository's `qa` setting (`repository.set` `qa: {argv, timeoutMs, maxOutputBytes}`, timeout up to 2 hours), else `effigy qa`. It is separate from `validation`, which also runs on every task's prospective merge, so a repository can set a milestone command (project-k: `effigy ci:fresh`, one hour) without bringing back per-task full QA (project-k planner via Northstar, 2026-09-30).
- **Stages (Task #121):** the `qa` setting also accepts `stages:
  [{name, argv, timeoutMs, maxOutputBytes?}]`, 1 to 8 stages whose names are
  unique and slug-shaped (`setup` and `teardown` are reserved for the run's own
  steps) and whose timeouts total within `PROJECT_QA_TIMEOUT_MAX_MS`. A staged
  setting replaces the single `argv`/`timeoutMs`; it cannot set both. When
  `stages` is present the stages run in order in the one owned checkout after
  `setup` and before `teardown`, each as its own recorded step built by the
  same host-run supervisor, termination and scheduler path as the old single
  `qa` step. The first failing or timed-out stage stops the run and
  `failedStep` names it; teardown still runs. `terminationGraceMs` applies to
  every stage, each stage's `maxOutputBytes` defaults to the run's setting, and
  an existing single-argv setting is unchanged — it records one `qa` step. In
  Project-d's case a clean-checkout compile stage and a test stage are recorded
  independently, so a 14-minute cold compile can be told apart from the Studio
  suite. The host-run envelope spans setup, every stage and teardown, so a slow
  setup or an earlier stage can never consume a later stage's window; each
  stage's own timeout starts at its launch. Nucleus runs the repository's
  worktree `setup` hook too, but hiding the compile there is not acceptable
  because workers run that hook as well. One parent host-run admission covers
  the whole staged setting and takes the heaviest stage class in any order, so
  a light first stage never admits a later heavy stage as light
  ([Spec 035](035-host-run-scheduler.md)).

## Acceptance oracle

g01.053:

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | No manifest, no project override | Nucleus closeout: no closeout run, workspace, hook or commit; outcome row written |
| 2 | No manifest, project `closeout: agent` | Agent closeout exactly as today |
| 3 | v1–v4 manifest, with or without a project override | Unchanged; the manifest governs |
| 4 | v5 manifest | Unchanged Nucleus closeout |
| 5 | Brief submission to a repository with no manifest | Accepted, as before |
| 6 | `repository.set`, `repository.get`, `repositories` | Round-trip; repository identity matches outcomes, lanes and numbers; survives restart |
| 7 | Default switch while a no-manifest task is mid-closeout | A closeout already running under agent authority settles under it; later closeouts use the new default |
| 8 | Brief capture while the shared checkout is behind origin | Planning commit and manifest eligibility come from the fetched `origin/<base>` head |

g01.054:

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Command exits 0 | Merge proceeds; result recorded on the task and in the outcome row |
| 2 | Command exits non-zero | One semantic revision round with the output tail as the finding |
| 3 | Timeout, launch failure, or the candidate left changed | Operational hold; no revision round spent |
| 4 | Base or head moved during validation | Stale result discarded; rerun on the fresh candidate |
| 5 | No command set | Merge on review and GitHub's checks, unchanged |
| 6 | v1–v4 manifest repository with a command set | Command ignored; manifest hooks govern |
| 7 | Command changed between runs | Each run records the argv digest it used |
| 8 | Nucleus build or settings revision changed | An ordinary settled result is discarded and validation reruns; a lost or timed-out run remains held for explicit retry |
| 9 | Same command, build and settings revision | Settled result reused; the command does not run again |

Milestone QA (task 104):

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Run on a behind checkout | The command runs detached at the fetched `origin/main` head in a Nucleus-owned checkout, never the registered checkout's working tree or a task worktree; the checkout's `.git` resolves to the registered repository's common directory and the registered working tree is untouched |
| 2 | Second request while one is running | Returns the running run; no second run starts |
| 3 | Admission holds the run | The record reads "Waiting for QA capacity (position N)"; the settled result is not a failure |
| 4 | Run settles | State, duration, output tail, per-step output, base, argv digest and admission telemetry are recorded; the board shows them |
| 5 | No milestone QA command set | The run uses `effigy qa`; the per-task validation setting stays null |
| 6 | Non-zero exit | A recorded `failed` result; no merge authority, no task gated, no revision spent |
| 7 | Repository setup needs relative sibling repositories | Nucleus prepares project members, literal relative sources from the Northstar `paseo:worktree prepare` call and the primary's dependency-ledger sources before `worktree.setup`; each source resolves relative to the primary checkout root through a configured checkout, and the registered ledger is not rewritten |
| 8 | Setup exits non-zero | A recorded `hold` with the setup output tail; the QA command does not run |
| 9 | QA passes or fails | `worktree.teardown` runs before the run settles |
| 10 | A running QA record has lost its backend | Teardown runs from the retained Nucleus-owned checkout before it is removed and the record becomes a `hold` |
| 11 | `project.qa.get` with `{id}` | Returns that exact QA run; `{repository}` keeps its latest-run behavior |
| 12 | A failed teardown leaves sibling links, or a rerun follows a moved source | A rerun replaces the stale link with the configured source; the source checkout itself is never touched |
| 13 | Setup fails and teardown prints far more afterwards | The failing step's own stderr is present in the recorded result, `failedStep` names it, and its step keeps the head and tail of its own stdout and stderr |
| 14 | A Nucleus service roll while QA is in flight | The detached supervisor keeps running; a restarted service re-attaches, records the real result and duration, and every step the supervisor recorded survives |
| 15 | The supervisor is killed mid-QA | The run settles as a `hold` that keeps the steps already recorded and names the in-flight step in `interruptedStep` |
| 16 | A lost run's teardown | Teardown runs from the retained checkout and keeps its own step record; the Nucleus-owned checkout is removed |
| 17 | Admission after re-attach | The restarted service joins by `queue:qa:<key>:<runId>`, the identity the run started with, and the record keeps that join |
| 18 | The recorded pid is alive but runs another command line (a recycled pid) | The run is reconciled as lost with its recorded steps; the unrelated process is never watched |
| 19 | The live process's command line cannot be read | The run stays running and is re-checked; an unreadable identity is never proof of death |
| 20 | A roll after spawning but before the pid is recorded, while the supervisor is slow to publish its state | The run is resolved by the live process carrying its token and stays running however long that takes; elapsed time alone never marks it lost |
| 21 | An identity scan that cannot read every candidate (a failed listing, or a `/proc` read the host refused) | The scan is unknown, not absence; the run stays unresolved and is re-checked later |

Milestone QA stages and full-output logs (Task #121):

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | A staged setting with two passing stages | Both run in order as separate steps under the run's one admission; every stage timeout starts at its own launch; the run passes |
| 2 | The first stage fails | The second stage never runs, teardown still runs with its own step, and `failedStep` names the first stage |
| 3 | A stage times out | Only that stage's process group is terminated (after `terminationGraceMs`), the step records the timeout and signal, and the next stage never runs |
| 4 | A single-argv `qa` setting | Unchanged: one `qa` step, no `stages` on the run record |
| 5 | A failing stage prints more than the short excerpt | Its bounded beginning and end (inside the stage's `maxOutputBytes`, with the marker and byte counts) is in the step's mode-0600 log beside the run, `project.qa.get` returns the log path and byte counts, and the log survives the run's settle |
| 6 | A staged setting names no cap on a stage | The stage falls back to the run's `maxOutputBytes` |
| 7 | A staged setting is malformed (duplicate, non-slug, reserved, 0 or 9 stages, or timeouts over the maximum, or mixed with `argv`) | `repository.set` refuses it; nothing is stored |
| 8 | A slow `setup` followed by a first stage that uses most of its budget | The next stage still receives its full configured timeout; the host envelope covers setup, every stage and teardown, never only the stage total |

Milestone QA log diagnostics and teardown-retry logs (Task #136):

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | A step's full-output log cannot be written and later output exceeds the run's output tail | The failure is reported in `logWriteErrors` (`{step, stream, error}`) and survives even when `outputTail` no longer mentions it |
| 2 | More than 16 full-output log failures in one run | `logWriteErrors` keeps the newest 16; the run record stays valid |
| 3 | A progress-mirror store write fails while the supervisor runs | The run is not settled as lost, keeps its host reservation and live command identity, and the next poll retries the mirror |
| 4 | A staged run whose teardown fails, then retries | Every stage's log is kept unchanged, the failed teardown keeps its own log, and the retry writes its own attempt-numbered log |

Milestone QA TAP failure index (Task #290):

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | A streamed TAP run starts with a failure whose diagnostics exceed 32 KiB, then reports at least 34 later failures and one cancellation | The compact per-stage index retains each identity, title, location when present, status and summary counts; verbose diagnostics remain within their existing cap |
| 2 | The compact index exceeds its identity bound, or a failure summary names identities absent from captured blocks | The durable run and detail report retained and omitted counts and mark the index truncated |
| 3 | TAP diagnostics or an identity contain the host-run token | The token is redacted from both the verbose failure log and compact index |
| 4 | A QA stage reports failures through the spec reporter instead of TAP | The trailing failing-tests section yields the same bounded excerpts, identities and summary counts, with one identity per failing test |
| 5 | A QA stage's output exceeds its `maxOutputBytes` cap | The retained log and step excerpts trim passing test lines before failure lines; the marker names the trimming shape with byte counts |

## Out of scope

Board editing of project settings, per-branch settings, secrets for validation
commands, dependency installation, and removing v1–v4 manifest support.

Milestone QA always runs in a detached supervisor. Injected inline executors belong only to test fixtures; TAP failure details come from the streaming collector, and cleanup has no pre-Spec-022 `.sources` directory.
