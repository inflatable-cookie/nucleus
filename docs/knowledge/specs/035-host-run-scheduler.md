# 035 — Host run scheduler (Nucleus's side)

Status: implemented; the Effigy v2 custody protocol is approved, not implemented
Owner: Nucleus runtime maintainers
Created: 2026-09-30
Decision owner: Tom
Governing refs: contract 010 "Host run scheduling", imported as [host-run-scheduling-010](../contracts/host-run-scheduling-010.md) (originally Nucleus's)
(`docs/knowledge/contracts/010-host-run-scheduling.md` at nucleus `e28164c05530afb5da4071a2247598fc19c98993`),
which owns roles, the client wire protocol ("Client protocol v1"), authority,
the lifecycle, the supervisor and its result record, heavy and light classes,
capacity rules and the migration steps. This spec covers only what Nucleus builds
for migration step (a) and what it changes for (b) to (d).
[Retired Spec 031](retired/031-heavy-validation-budget.md) describes the
Effigy-owned mechanism this replaces. Nucleus's contract 009 producer that once
mirrored these events is retired ([Spec 034](retired/034-shadow-run-stream.md));
`host_run_journal` is the durable surface.

## Live heavy work on the board

The board projects queued, admitted and running heavy scheduler records from
the in-memory live set. A run is attached to a task when its working directory
is inside the task's retained workspace, or its scheduler id matches that
task's proof execution; a run without a task is a milestone QA run, which is a
card of its own (below). Settled
runs disappear. This is a read-only projection and does not scan scheduler
history or change admission, scheduling or task phases. Elapsed time is
rendered from the submitted or launched timestamp. A launched run past its own
run timeout is left out: its holder is gone, and settling it belongs to the
scheduler ("A reservation settles when its recorded process is gone" below). The
heavy-work strip is gone (Tom, 2026-11-01); a task's test run stays on its task
card (2026-11-01: 464 leaked Effigy admission records had filled the strip).

### Milestone QA cards (Tom, 2026-11-01)

Each milestone QA run is a card, not a task. The board projects the latest run
per repository (`core/qa/qa-board.ts`), and the project and lane filters apply.
Placement follows state: queued in Queued with its position, running in Working
with its open step and elapsed time, and any finished run that is not passing in
Attention with its failed step, exit code and last output lines. A passing run
sits in Closing and leaves the board five minutes after it finishes; the QA runs
page keeps the history ("Pass fades, fail stays"). A failure stays until a
passing re-run of the same repository replaces it or an operator dismisses it.
Failed, timed-out and held cards also show a Stale marker when their recorded
`base` is an ancestor of the checkout's local `refs/remotes/origin/<baseBranch>`.
The marker gives commits since the run and the run date. Missing refs and
rewritten or unrelated history show no marker. The board projection caches
branch heads and base/head comparisons, with a short head refresh window; it
does not fetch from the network.
Dismissal is `project.qa.dismiss { id, reason, caller }`: it records who
dismissed which run and never deletes the record. Card actions are cancel
(`project.qa.cancel`, live runs), re-run (a fresh `project.qa.run` with the same
repository and base and a new request ID), dismiss (finished, not passing) and
open details, which opens the QA runs page on that run. The fade is read from
the clock, so a card leaves with no store write: the projection advances the
board revision when the set of visible cards changes.

Tom (2026-09-30): "Effigy should be the runtime that executes QA, Queue and
Nucleus should manage who runs what when." Tom ruled the same day that heavy
runs fail closed when the scheduler is unreachable (contract 010).

## Live run presence: a terminal tab and a workspace label (task 530)

While a test, QA or proof run is live the operator sees it where they work
(Tom, 2026-11-01: "Both").

**The tab.** Nucleus opens one terminal tab per workspace and selector, named for
the run (`QA · qa:stage:rust`, `Testing · qa:changed`), in the workspace that
owns it: a task run in the task's workspace, a milestone QA run in the project's
main checkout workspace, because its private QA checkout is not a sidebar
workspace. When no workspace on that checkout is open, Nucleus opens one on it —
a Paseo workspace entry only, never a worktree — and it stays afterwards like
any workspace the operator opened (Tom, 2026-11-01: "Open one"). A task run
never opens a workspace: the task's own workspace is the only place it belongs.
The tab runs `bin/queue-run-terminal.mjs` against a pointer file
Nucleus writes under `<dataDir>/run-terminal/`. Nucleus launches it through
`/usr/bin/env` with `ELECTRON_RUN_AS_NODE=1`, so it also runs under Paseo's
Electron helper binary. It streams the run's live log as the log grows, prints
the service's final status line when the run settles, and then waits in the same
tab for the next run of that selector. A later run reuses the tab rather than
opening another, so Nucleus leaves no stream of dead tabs behind. If the follower
tab exits during a run, Nucleus logs that once and does not reopen it for that run
session; a later run session gets a fresh attempt.

**The live log.** A client-protocol run is followed through the retained
`runs/<id>/stdout` and `stderr` its supervisor writes. A Nucleus-submitted run had
no such files: each detached supervisor now tees every output chunk to a per-run
live log beside its own supervision files —
`project-validation/<hash>/live.log` and `<qa root>/<run id>.live.log` — capped at
512 KiB with the most recent bytes kept, and redacting the run's token across
chunk boundaries. The live log is a window, never the record: the step logs and
the result envelope stay authoritative.

**The label.** A workspace with a live milestone QA run carries the amber
"QA running" label; one with a live task, proof or other run carries the violet
"Testing" label. Both clear when the run settles. The workspace title belongs to
the operator and is never touched.

**Reconciliation.** One pass runs every two seconds from the live run set, for
launched runs only: a queued run has no live output to follow yet. Every pass
reads the daemon's own workspace inventory, which lists assigned labels, so a
service restart restores live runs and clears the label of a run that settled
while Nucleus was down. A pointer whose run is no longer live gets that run's
final status line from its own durable record, so its tab stops following too.

**Best effort.** Every daemon call is logged and swallowed: a failed terminal or
label call never affects admission, scheduling, the run or the task. A terminal
creation failure is retried on a later pass; an already-created follower that
disappears is logged once and not recreated for that run session. The projection
spends no admitted-run call budget or timing context and writes no state outside
`<dataDir>/run-terminal/`.

Tests: `test/live-run-presence.test.ts` (a fake daemon for open, reuse, settle,
restart and failure, plus the follower rendering a live log) and
`test/live-output.test.ts` (the live log's order, redaction and cap).

## Effigy candidate qualification for Queue #381

The generic admission adapter remains held pending independent exact-head
review, expected-head merge and operator installation; this ruling does not
describe a delivered client. Tom answered
"Option 1" on 2026-10-24, recorded in decision
`36702e5b-b6f0-47af-a158-4681b923c4ae` v2, relayed by Supervisor
`df8d9bc7-a38b-4efb-a051-8c21d63a193e` through Project-c ROOT message
`c59d9cf9-2cc4-4bc7-b435-78afae21cf83`.

This replaces only the producer's full milestone QA PASS prerequisite. The
qualifying authentic Effigy-owner handoff must contain:

- The full commit, absolute immutable artifact path and SHA256.
- The existing installation qualification receipt: gate clear, roots load,
  zero task-resolution diffs and zero hosts diffs.
- Targeted qualification for #381's heavy admit/deny, capacity,
  cancellation/crash and lost-follow admission/run-control surfaces. Effigy's
  owner chooses the exact selectors and names them in the receipt; Nucleus does
  not infer qualification or invent selectors.

Known unrelated candidate failures in Effigy #308–#311
(release/state/containers/CLI) remain **OUT-OF-SCOPE FAILURES**, never passes or
waived-as-pass results. Their work continues in parallel. No tag is required.

Nucleus's exact-byte interop, independent exact-head review, expected-head merge
and healthy actual delivery remain required. Tom retains actual installation
authority. This ruling authorizes neither cancellation of full QA nor
installation, admission/custody bypass or early hold release. It qualifies no
candidate by itself. Project-c #133/#143 keep both holds and the no-interim-native
ruling (decision `5e0f8a35-1719-41be-ba70-5f8536a5f3bb`); fresh resources and
separate native activations follow normal #381 delivery.

### Qualified producer packet (2026-10-24)

Authentic Effigy owner `a683cd79-0ab5-4576-9e15-2952a754a795` supplied message
`8c63bcb9-5a07-4e81-89e2-7ac96662e6a6` under decision `36702e5b` v2. This is
the final interop candidate. Nucleus verified artifact and receipt bytes before
use; it did not rerun owner selectors.

- Full commit: `efc1478990a97be03f243b0d4c89246b6be55997`
- Immutable artifact: `~/.local/share/northstar/release-audits/effigy/dev-builds/candidate-efc1478/effigy`
- SHA-256: `dc6a6e9e3829b553d61358db0875ee2fc5d107cd15194a257a6c4560edde8eae`
- `--version` prints `effigy v0.14.1+local.efc1478` (informational; select by path and hash)
- Receipt: `~/.local/share/northstar/release-audits/effigy/handoff-381/receipt.json`, SHA-256 `bd41c5acef3599686ecd7868b14985c816fd3d47d50c8fdc15823ad3f700753c`
- Owner installation qualification: gate clear; 47/47 roots load; zero task-resolution diffs over 1287 names; zero hosts-map diffs over 28 containers
- Owner-selected targeted qualification on these bytes: `test:run-control:cli` 16/16; `test:run-control` 13/13; `test:task-engine:admission` 17/17; `test:task-engine:kill-matrix` 13/13; foreground-tree milestone-path selector 39/39
- **OUT-OF-SCOPE FAILURES:** prior `eddefd2c`/`fcd25b0` milestone 109 failures in release/state/containers/CLI, tracked Effigy #308–#311. Owner reports #308 and JSON fixture PR #448 included; remaining work continues separately. None is a pass or a waived-as-pass for this handoff.

### Nucleus exact-byte interop (this PR)

Isolated private HOME, disposable fixtures, in-memory Nucleus store, no live
DB/consumers/native/GitHub, no Cargo, no install. Tests in
`test/effigy-run-control.test.ts` against the verified candidate bytes:

- Deny: unreachable admission socket → hook deny, workload marker absent, exit non-zero
- Admit and hold: durable `--run-id` heavy run keeps one live admission reservation until Effigy `run status` reports its own `checkout-journal` cleanup complete, then the reservation's accounting is retired (task 417; before it, a settlement was written)
- Nested heavy: parent group with a heavy child takes one hook call and one reservation; child marker is written
- Cancel: `run stop` on a live heavy run → Effigy state `cancelled`, accounting retired; crash `exit 17` → the producer's exit 17 is kept as the verdict, accounting retired
- Lost follow: killed `run logs --follow` reattaches at the delivered stdout offset, does not replay earlier bytes, exits with the run's real code 9

`run status --json` is `effigy.command.v1` wrapping `effigy.run.v1`. Live runs
send `state: "running"` with `exit_code: null`; Nucleus must not treat that null
as terminal. Terminal states include `succeeded`, `failed` and `cancelled`.
Capability still comes from `run --help`, not the `v0.14.1+local.efc1478`
version string.

The 3d5c3410 development pin remains early-implementation evidence only. It is
not this candidate and does not release the merge hold. Independent exact-head
review, expected-head merge and operator installation stay outstanding.

These tests injected an observer pinned to the candidate, so they proved the
candidate's surfaces, not the service's default observation route. Task #406
records the gap and the corrected route in "Runtime identity" below; nothing in
this section is a live-default or installed-machine claim.

## Runtime identity (task 406)

The interop above qualified the candidate's admission and run-control surfaces,
but not the route the live service actually took to observe a run. That route
had a real gap, and the injected observer hid it: `EffigyAdmissionEndpoint`
built `new EffigyRunControl({ binary: "effigy" })`, which inherited the
service's own `PATH`, while the RuntimeOwner constructed the endpoint with no
observer at all; the qualified test instead injected an observer pinned to
`efc1478`, so "the observer is the candidate" was a property of the test, not of
production. A worker running the candidate by absolute path does not pin the
service's observer, and a mutable `PATH` could hand Nucleus an older, unrelated or
unqualified build to read the journal of a run it never executed. Project-c #133
correctly stopped before native work when the machine's executable drifted.

**No pinned build (Tom, 2026-10-26).** The first answer below declared one
immutable Effigy artifact by the SHA-256 of its bytes. Every Effigy rebuild
then blocked heavy runs until the operator re-declared it and Nucleus restarted
(three times on 2026-10-26 alone: `efc1478` → `b94b106` → `9adacdd`). Tom:
"Agents are complaining that heavy runs are blocked by the effigy pin. Having a
pin at all makes this brittle - a minimum version, maybe, but pinning an exact
version means any change on my dev version of effigy forces a change in Queue,
and effigy will change a lot." He ruled that Nucleus trusts whichever Effigy
actually launched the heavy run, found from the process and never from PATH,
records that executable's path and hash with the run, and reads the run's
journal with the same executable; and that a minimum version is "Optional,
unset for now". What stays true: no PATH resolution, no caller-supplied path as
authority, trust only in a process the hook attests, and the executable that
ran the workload is the one that observes it.

- **Settings.** `settings.json` `effigyRuntime` is optional and carries only
  `minVersion` (`major.minor.patch`; build metadata such as `+local.9adacdd` is
  ignored). Absent is the normal state. The retired `{ path, sha256 }` keys still
  parse, so an older settings file keeps the service starting, and are ignored.
- **Workload attestation.** The Nucleus-owned admission hook runs under the
  Effigy that will run the workload, so it attests its own process ancestry by
  pid (bounded to four entries, each with its contract 010 start identity). It
  never supplies an executable path. The service resolves each ancestor's
  image itself (`/proc/<pid>/exe`, else `ps -ww -o comm=`), skips a pid that is
  gone or recycled, digests the image by content, asks it for `--version` by
  its absolute path (asynchronously, no shell, 5 s bound), and binds the first
  ancestor that answers `effigy vX.Y.Z`. The answer is remembered per image
  identity (path, size, mtime, inode; 32 entries, least recently used evicted)
  and concurrent questions share one call, so repeated admissions on one binary
  spawn nothing and a rebuild is asked again; a failed or timed-out call is not
  remembered. A launcher script that `exec`s Effigy is not an
  ancestor of its own (the image is Effigy); the hook's own interpreter and a
  shell answer otherwise and are skipped. A configured `minVersion` above that
  version refuses the admission with the version and the floor named. The
  producer's `effigy.admission-request.v1` is unchanged.
- **Durable binding.** A new admission is bound before it reserves, and its
  binding is written on the reservation's internal identity as `effigyRuntime`
  `{ path, sha256, version, workloadPath, boundAt }` with an `effigy_runtime_bind`
  journal fact, in the same durable write as the row itself: the executable the
  observer runs, its bytes and version at binding (provenance, not a gate) and
  the image the workload ran. Rows bound under the retired pin carry the declared
  artifact's path and no `version`, and keep observing through that path. The
  identity lives beside the record, not in it: contract 010's pinned record has
  no field for it, so the row, `host.run.list` and `host.run.capacity.release`
  keep the strict pinned shape (see Compatibility).
- **Observation.** The endpoint builds its client only from the binding's
  recorded path, and `EffigyRunControl` re-reads that executable before every
  `run status`, `run logs` and capability probe and again once the call
  returns. An executable that is missing, unreadable or no longer executable
  yields `unknown`: nothing is spawned, no success is invented, and the refusal
  is recorded once per distinct reason as `effigy_observation_refused`. Bytes
  that changed since binding — Effigy rebuilt in place — are not a refusal: the
  call runs, its answer stands, and the change is recorded once per distinct
  answer as `effigy_runtime_drift` on that run. A rebuild during the digest read
  is not one either: the read starts again from the path, up to three times, and
  only a file still moving after that refuses. The digest itself is remembered
  while the opened file's identity is unchanged (task 430, "Retired rows are
  observed on a bounded slow cadence" below).
- **Custody.** A new admission that cannot bind is refused before it reserves:
  it gets no slot, no reservation row, no identity and no workload, and the hook
  denies with the binding reason. A bindable admission reserves already bound,
  so there is no window in which a reservation nothing can observe holds
  capacity. Reservations written before this boundary keep the conservative
  shape: an unbound one is still admitted and its workload still ran, so it
  loses only observation, and its capacity stays held with a visible cause — the
  internal `effigyRuntimeRefusal` and that run's `effigy_observation_refused`
  journal fact (the pinned public record cannot carry the refusal) — until the
  same reservation can be read to a real terminal result and settles. No identity failure releases a slot, refunds a budget,
  replays a run, creates a second reservation or invents a settlement. An old
  reservation that can never be observed keeps its slot: that is the
  pre-existing shape of an unknown Effigy journal, and its disposal belongs to an
  existing Spec 050 owner verb or the phase 2 reconciler. This task deliberately
  adds no identity-specific release control, no old-row reconciliation, rebind or
  release, and `host.run.capacity.release` stays what it was — an operator
  release of a settled run's container or escaped-descendant capacity, which does
  not apply to an unsettled reservation.

### Approved correction and accounting policy (2026-10-24)

Tom requested the general admission correction: “Can you coordinate with the
queue supervisor to get it fixed please” (Project-e Supervisor relay `84bb5979`).
The correction must refuse a new admission before reserving capacity when the
workload cannot bind to the declared runtime; a successful reservation must
already carry its binding. Existing reservations, nested identity, idempotency
and conservative custody remain separate. The declaration is loaded at service
construction; saving settings alone does not replace a compatible service.

Task #411 implements the admission half. `reserve` verifies the declared
artifact against the hook's attested ancestry first and, on an unbound result,
returns the existing `settled` observation with `admission refused: <binding
reason>` — an observation kind the hook already denies on, so no wire shape
changed — and writes no reservation at all. A bound result submits with the
binding inside the reservation's own durable write (row and
`effigy_runtime_bind` fact together), so no unbound reservation exists to strand.
The failure shape the live project-e#182 rows showed — `running` with a runtime
refusal, an unreadable journal and held capacity — can no longer be created by a
new admission. Those rows, `6a82d60b`'s accounting disposition and any release,
rebind or reconcile of them stay exactly as decided: out of this task's scope.
(Since 2026-10-26 there is no declaration; settings carry only the optional
`minVersion`, read once at service construction.)

Tom selected “B: Authorize the general reviewed operator-only accounting
disposition; preserve workload outcome/custody UNKNOWN and all history”
(operator decision `6a82d60b`, version 2). This authorizes a general reviewed
accounting-disposition capability, not a disposition of any particular run.
Automatic paths remain fail-closed. Any later use requires separate exact-run,
epoch-bound operator risk acceptance through the delivered durable owner
surface. Accounting retirement must never invent a terminal result, exit,
empty descendants, runtime retirement, physical headroom or consumer permission.
Original uncertainty and later authentic evidence remain attributable.

The admission correction above is implemented by task #411, and the accounting
disposition by task #412 (next section). Neither makes a store edit, disposition
or release for any particular live run: #411 refuses to create a new unbound
reservation, and #412 delivers the operator surface that an existing one needs.
Public contract and strict consumer compatibility must be demonstrated before
delivery; an incompatible representation requires an explicit contract
decision. No private store edit, retroactive runtime binding, process signal,
forced release or live consumer proof is authorized by these rulings.

### Operator accounting disposition (task 412)

The general capability above is implemented as a supported owner surface for
any host run in the shape that had no exit, not as a disposition of one row.
The motivating shape (Project-e 182, runs `4cc8e391` and `6efa6476`): an admission
reservation admitted before a trusted runtime binding existed, launched with no
observation route that can ever report a terminal result, still running with
unknown outcome and, together, charged 9 CPU and 64 GiB in the recorded
snapshots. Queued `c12f0667` positively expired before launch and is not a third
holder. `NOTFOUND`, an expired journal, a CLI exit and age prove nothing about
the workload or physical quiescence, so no terminal result and no capacity
release existed that could honestly clear the accounting. Task #411 now refuses
to create another such reservation; this surface remains for the rows already
written and any historical equivalent. At the time of this task no automatic
path disposed of accounting; Tom's 2026-10-25 ruling recorded below subsequently
authorizes exactly one — the producer cleanup closure — and nothing else.

**The contract delta: accounting and runtime custody are two facts.** The
operator may retire one reservation's ACCOUNTING — the charge it adds to
admission totals — while its workload outcome, process, containers,
descendants, settlement and all history stay exactly as they were, explicitly
UNKNOWN. Since Tom's 2026-10-25 "Both release" ruling, a retired run no longer
holds its workspace (see "Workspace release on retired accounting" below). Generic approval is not this: each use needs the
operator's separate exact-run, current-epoch risk acceptance. Every default,
recovery and unlisted automatic path still never disposes of accounting and keeps
failing closed; the single automatic exception is the 2026-10-25 producer-cleanup
retirement recorded below ("Automatic accounting on producer cleanup").

**Representation.** The pinned contract 010 record has no field for this and does
not gain one. It is the retired system's strict record, it is what an older Nucleus reads and
what both affected method digests name, and its `capacityReleasedAt` means the
settled run's recorded capacity release. Writing a running row's disposition into
it would reinterpret that field for a shape contract 010 does not describe and
change the method digests again (#409). The disposition therefore lives beside
the row in the store's internal meta under `hostRunAccountingDisposition:<runId>`,
carrying the row's own epoch, exactly as the admission identity does. It holds
the durable operation id and input hash, the operator or relayed authority, the
exact-run acceptance, the operator's reason and the evidence observed at that
instant — state, launch, pid and start identity, containers, settlement, the
verified runtime or its refusal, budget and any prior release. The
`host_run_records` row, `host.run.list` and `host.run.capacity.release` keep the
pinned shape byte for byte, and the disposition is a `host_run_journal` event
(`accounting_disposition`), not a new record field. No migration is needed.

**Surfaces.** Two Nucleus-owned RPCs, not contract 010:

- `host.run.accounting.status { runId }` — the read. It answers the pinned record,
  `accounting: "charged" | "retired"`, `dispositionReadable`, the durable
  disposition when present and `runDigest`, the canonical digest of that exact
  pinned record. It is the confirmation read after a lost reply and the operator's
  view of the retired charge; it returns null for an unknown run.
- `host.run.accounting.dispose` — the write. It takes `runId`, a durable
  `operationId`, `expectedEpoch`, `expectedRunDigest`, `authority
  { caller, relayed?, note? }`, the separate `acceptance { scope: "exact_run",
  runId, epoch, unknownOutcomeRetained: true, reason }` and the operator's
  `reason`.

**Authority.** The operator's board identity (`operator`, `operator (board)`)
authorizes directly. A relayed write names the relaying caller, never the
operator, and must carry the operator's authorization note; a relayed write that
names the operator is refused as a forged relay, and a caller with neither is
refused. The acceptance is validated against the row itself: it must name this
run and this epoch and acknowledge that the outcome stays unknown.

**Validation before any write.** The row must exist; the acceptance must name it;
the current host-run authority epoch, the requested epoch and the row's epoch must
all agree; the run must be `running` with a launch and no settlement, so a queued,
admitted-never-launched, or settled run keeps its ordinary path; the row must not
already record a capacity release; and the pinned record digest the operator read
must still equal `expectedRunDigest`, so a row that changed (including one that
settled) refuses instead of being disposed of on stale evidence. The
reservation's own `request` journal fact must still be readable: an unsettled
run's journal is never pruned, so a missing one is unreadable evidence, not
history. The whole decision and write run in one transaction, so a competing
settlement or disposition cannot interleave inside it.

**Durability and idempotency.** The disposition and its journal fact commit in
the same transaction. A lost reply is resolved by repeating the same
`operationId` with the same input: Nucleus returns the stored disposition and
writes no second fact. A mutated retry under the same operation id, and a
second operation on an already disposed run, both refuse with nothing written.
A stored disposition that cannot be read or does not carry the row's epoch is
never replaced by a new one, and it never releases the charge: the run stays
charged until an operator disposition binds it. An older Nucleus ignores the meta
key and charges the run again; this build keeps the key for the row's life,
because a late settlement must not resume the retired charge, and rolling back
loses only the disposition, never a terminal result, custody or settlement. The
host-run rows stay Nucleus-local, so no wire or exported shape changes.

**What it never does.** It never writes a settlement, outcome, exit, signal,
step, container removal, escaped-descendant proof, cancellation, runtime
retirement, consumer or native permission, or physical
free/headroom claim; it never resets an allowance or clock and never replays or
signals the workload. Runtime custody stays where it was: the row keeps its
state, and containers and descendants keep their own recorded holds. The
workspace is released under "Workspace release on retired accounting" below. The pinned release method keeps its own
settled-only meaning and still refuses a running row.

**Totals, exactly once.** Capacity totals charge the reservation until the
disposition commits and stop immediately afterwards, independently of physical
samples, and admission may then use the freed room. Later authentic evidence
reconciles independently on the same run: a real terminal result settles the row
and is recorded as itself, open containers keep their custody hold and the
existing operator release, and the retired accounting does not resume charging
— so a late failure never becomes a success, the earlier UNKNOWN is never
laundered, and no second workload, reservation or disposition is created.

### A foreground run with no record (task 414)

Tom, 2026-10-24: "Project-e runs have died and blocked heavy slots again. This is
way too brittle!". The live shape: two heavy admission rows (`7a38a712` for
project-e `b9d6328c` at 21:11:12Z and `374d7b1a` at 21:23:51Z) were `running`,
runtime-bound after #411 to the qualified `efc1478` artifact
(`dc6a6e9e…`), both hook pids were absent, and neither row carried an
`effigy_observation` or `effigy_observation_refused` fact after launch. The
qualified artifact's own `run status <id> --json`, run in each reservation's
worktree, answered `ok:false` with `details {state: "not-found", recording:
"not-recorded"}` and the message "not recorded (foreground or expired); no live
holder or retained journal record was found", exit 1. `qa:stage` runs are
foreground Effigy runs that retain no journal row, so an abnormally ended
workload can never report `terminal`.

Two rules follow, and this task adds no third.

- **Structured before text.** `EffigyRunControl.status` parses the
  `effigy.command.v1` envelope first and reads `error.details.state` and
  `recording` before any text match. `state: "not-found"` with
  `recording: "not-recorded"` is an absence of evidence — the producer cannot
  tell a foreground run from an expired key, so Nucleus cannot either — and it is
  `unknown` carrying the producer's own message, never `expired`. Only a
  structured state or recording that names expiry or retention is `expired`,
  and a build that gives only text keeps its text reading: genuine retention
  expiry still holds.
- **A hold is never silent.** Every retained admission row records the exact
  reason it still holds capacity, once per distinct reason. An unobservable run
  or a launcher whose liveness cannot be proven writes
  `effigy_observation_refused`; a run the producer still reports `live`, a held
  task lock, or a genuine retention expiry writes `effigy_observation_retained`.
  Each note carries its kind, the reason, the observation time and the exact
  runtime path and SHA-256 that answered. `terminal` behaviour, settlement and
  the capacity release rule are unchanged.

**The custody gap this task reports rather than fills.** A `lost` settlement
(`launched: true`, no result) releases capacity, and Nucleus may write one only
when it can positively prove the workload's custody ended. Existing evidence is
not enough: `bindHook` records `processGroupId: pid` from the hook's reported
pid, nothing proves that pid was a process-group leader or that the Effigy
workload ran in its group, the bound Effigy process is not the workload command,
and an admission workload carries no Nucleus identity marker, so escaped
descendants cannot be enumerated the way they are for a Nucleus-spawned run. An
empty recorded group, a dead Effigy ancestor, a not-recorded journal answer and
hook death are therefore all consistent with a surviving workload, sibling or
escaped descendant. So this task performs no automatic `lost` settlement, adds
no proof tuple, control, signal or retroactive binding, and leaves the stuck
rows' exact-run relief to #412's operator accounting disposition. Closing the gap
needs producer or contract evidence Nucleus does not have: the actual workload
pid, pgid and start identity, or a producer-reported custody closure Nucleus can
verify. Task #415 consumes exactly that closure for journal-backed runs, below;
the foreground shape described here still holds its slot.

### Producer closure (task 415)

Tom's 2026-10-24 ruling (decision `b3538091` v2, "Effigy contract fix
(Recommended)") and papercut `55dfc179` route the producer's shipped precision
to Nucleus: `--run-id` runs are journal-backed, a journal record with
`cleanup: complete` is the producer's positive closure (Effigy 052 R5,
I-R7/I-R8) on its own, and `exit_code`/`signal` are the workload verdict rather than closure.
Nucleus now consumes that, consuming no unshipped producer field.

**What counts as closure.** Exactly one answer: a `run status --json` record
that names this reservation's own Effigy run id and selector, whose
`evidence_source` is `checkout-journal` and whose `cleanup` is `complete`,
read by the reservation's bound runtime bytes, in the reservation's own
checkout, for a closed workload-verdict state. Nothing else closes: not a
terminal exit code, not a signal, not exit 75, not the hook's death, not an
elapsed time, not an empty recorded process group.

**The verdict, and the one honest reading.** `succeeded` with exit 0 is Nucleus's
`passed` reading; every other verdict state (`failed`, `cancelled`,
`timed-out`) reads `failed`. Nucleus never invents a verdict the producer did not
report. The producer's own numeric `exit_code` and numeric `signal` are the
evidence, kept on the row exactly as reported; a Contract 010 result is not
written for an admission at all, so nothing needs to choose between them.
`hostSignalName` still maps a numeric signal to this host's POSIX name for the
verdict reading (and the old `SIGTERM`-for-a-null-exit default stays gone), but
no result record and no settlement carries it.

**A value reported is not a value withheld.** An absent `exit_code`/`signal`
(or an explicit `null`) is the producer saying it has nothing to report, and it
is read as that. A value it did report that Nucleus cannot carry as its own
verdict — a string, a boolean, an object, a non-finite or fractional exit code, a
signal that is not a positive integer — or two spellings of the same field that
disagree is malformed evidence, not an absent one: collapsing it to `null` would
let an invalid record read as a bare closure and, for an `interrupted` record,
retire a reservation's accounting on it. Malformed verdict evidence holds with
`verdict-unknown`, and its reason names the fields and the values the producer
actually reported. Nothing this classifier closes can therefore be rejected
later by the retirement record's own schema.

**What Nucleus did not observe is not written.** An admission is observed, not
supervised: Nucleus ran no host-run supervisor for it, so it holds no result
record, no workload process group, no start identity, no container and no
escaped-descendant fact for that run. Task #415 wrote the closure into the pinned
record anyway — the admission hook's own recorded pid as the run's `pgid`, and
empty `escapedDescendants` and `containers` lists — and the #415 text said
those empty lists "say exactly that". That was a local reinterpretation, and it
was wrong: an empty list Nucleus never observed states nothing about what outlived
the run, and the hook that Effigy ran is not the workload's supervisor. Task
#417 removes that settlement. The closure is now the producer's evidence and
nothing more, journaled on the row as `effigy_observation` with the run id,
selector, `checkout-journal` evidence, `cleanup: complete`, the verdict state,
the producer's own numeric exit code and signal and the exact runtime bytes that
answered. The pinned contract 010 record, `host.run.list` and
`host.run.capacity.release` are not touched: no `host.run.result`, no
`host.run.settlement`, no invented `escapedDescendants` or `containers` and no
`capacity_release` citing settlement evidence.

**Exact-run binding.** The record's `run_id` must equal the reservation's
Effigy run id and its `task` must equal the reservation's selector, so a
changed selector or a reused key that now names another task's run holds. The
call itself is made with the binding's verified bytes and in the reservation's
own checkout, so a record read from another checkout or by other bytes is
already refused by "Runtime identity" above. A nested durable foreground refusal
and a managed run's own answer stay refusals, and are held like any other
unreadable answer.

**Every hold is visible, once per cause.** An `unclosed` answer records
`effigy_observation_retained` with its own kind and reason:
`cleanup-incomplete`, `cleanup-absent`, `cleanup-unknown`,
`live-foreground`, `not-journal-backed`, `run-id-mismatch`,
`selector-mismatch` and `verdict-unknown` (which also carries a record whose
reported `exit_code`/`signal` Nucleus cannot carry as its own verdict, or two
disagreeing values). Each keeps the reservation's
capacity, repeats nothing on an unchanged tick, and adds its own cause once when
the producer's answer changes. A closed record whose retirement is refused or
whose durable write fails records that once as `effigy_observation_refused`
with kind `accounting-retirement-refused` and the reason, and the reservation
still settles through the ordinary path: nothing was retired, and the gone hook
is the settlement's own question. #415 held
a closed record whose reservation had no recorded launcher identity with
`launcher-identity-absent`; task #417 removes that hold with the result it was
needed for — accounting retirement needs no launcher identity, and inventory of
the hook is not workload custody.

**What does not change.** A still-live holder, a held task lock, exit 75, a genuine
retention expiry and a `live-foreground` answer keep their #414 holds until the
reservation's own run timeout; reserve-before-bind, runtime identity, nesting,
denial, cancellation, lost follow, idempotent observation and the operator
accounting disposition (#412) are untouched, and no Contract 010 shape, Nucleus
schema, selector, wrapper or consumer command changes. The behaviour that
changes is narrow and intended: a terminal exit with no producer cleanup closure
settles nothing and retires nothing, because an exit code is a verdict, not
closure; a producer cleanup closure retires the accounting instead of writing a
settlement ("Automatic accounting on producer cleanup"); and a reservation whose
recorded hook is gone settles "A reservation settles when its recorded process
is gone" rather than waiting out its run timeout.

### Producer contract direction (Tom, 2026-10-24)

Tom selected “Effigy contract fix (Recommended)” after the foreground custody
limit above was reported (Supervisor relay `4a8a4b4d`, recorded decision
`b3538091`, version 2). His chosen option asks the Effigy owner for workload
process-group and start-identity attestation plus a retained foreground terminal
or exit record; Nucleus consumes the resulting contract after the producer ships.
This is a producer contract-change request, not evidence that those fields or
foreground recovery exist, and not permission to derive custody from process
numbers. Effigy's approved Q-010 foreground class deliberately retains no durable
completion after all custodians are lost. The producer must therefore make the
contract change and compatibility boundary explicit; Nucleus does not invent an
admission or pinned contract 010 schema for it. No timer-based release or
unreviewed automatic settlement follows from this ruling.

Tom subsequently answered “Yes: accept the escaped-process risk, and Queue
releases automatically on the evidence” (operator board decision `d3bad004`,
version 2, 2026-10-24). This supplies the risk acceptance that the producer-change
selection alone did not grant. After the reviewed producer contract and Nucleus
integration ship, Nucleus may retire capacity accounting automatically only when
all four conditions hold: the reported workload-group count equals the fully
acknowledged workload events; every reported leader's ProcessIdentity no longer
matches a live process; every reported group is positively empty (`ESRCH`); and
no terminal result exists. Missing, partial, unacknowledged or otherwise
unverifiable coverage does not qualify, nor does an unreadable terminal lookup.

This accepts the possibility that an escaped process still runs. It is an
accounting decision, never an assertion of complete cleanup, terminal outcome,
absence of escaped descendants or physical headroom. Effigy gains no signalling,
reclaim or PID-based recovery authority. A producer terminal result with
`cleanup: "complete"` remains its separate positive closure. The reviewed
protocol must actually provide the coverage evidence even when no terminal
result exists; Nucleus cannot invent a count or treat missing events as an empty
set. This ruling does not retrofit earlier v1 reservations, activate the
unbuilt v2 protocol or alter the current journal-only observer repair. Concrete
producer delivery, compatibility review and normal Nucleus qualification still
precede use; the existing exact-run operator accounting route remains available.

The existing durable alternative is distinct: Effigy accepts a checkout-scoped
`--run-id` for supported selectors and records journal-backed custody. Managed
tasks and durable calls inside a foreground task tree retain their refusals;
Nucleus does not append a key to arbitrary commands or change a proof recipe
silently. Producer contract 052 I-R7/I-R8 defines `cleanup: "complete"` as the
closure signal, independently of workload success or failure. Retained and
Irreversible effects can be resolved; Residue and Unknown cannot. Workload
`exit_code` and `signal` describe the verdict, never custody. Nucleus's consumption
of that existing evidence still needs its own reviewed integration and may not
claim that a missing cleanup field, an exit code or an empty hook group proves
closure. Exact-run operator accounting disposition remains the interim relief.

### Related operator relay

Nucleus Supervisor `b885` separately relayed Tom's words “Accept - better to keep
things moving” (message `a408907f`, 2026-10-24): a surviving stray may briefly
overload the host, so exact-run manual accounting is not the desired steady
state. Preserve that relay beside the direct board ruling above. The executable
evidence rule is decision `d3bad004`'s four conditions, which explicitly cover a
run with no terminal result. The relay's phrase “producer-reported workload end”
must not be implemented as a requirement for a producer terminal message in that
branch, or as a claim that the evidence proves custody closure. A dead hook,
lost lease, timer or empty assumed hook group alone still qualifies for nothing.
Positive cleanup and the accepted-risk accounting disposition remain separate.

### Automatic accounting on producer cleanup (Tom, 2026-10-25)

Task #415's admission settlement wrote a pinned contract 010 result whose empty
`escapedDescendants` and `containers` lists and hook-launcher `pgid` claimed
host custody evidence Nucleus never observed. That settlement is removed, not
reinterpreted. Tom was told that the superseded #416 scope, as admitted, also
forbade automatic release, so every cleanly finished admission would hold its
heavy slot until an exact-run operator disposition. He was asked whether Nucleus
should instead free the slot when Effigy reports that exact run's cleanup
complete, recorded as an accounting retirement with the outcome and custody left
unknown, accepting that an environment's container may still be running. He
chose "Auto-free on cleanup (Recommended)". The removed #416 work
(`ns-436a9583-64e1-4f89-89b7-29b6ef8c30b6`, workspace
`wks_4c07dea108103cdd`) was read as a donor only: its hold-on-closure shape and
its durable once-per-answer observation note were reused where compatible, and
its scope decision is superseded by this ruling. Nothing in that workspace was
edited, and no uncommitted work there is claimed.

The rule: a launched admission whose producer record passes every #415 closure
gate retires its capacity accounting automatically. Those gates are this
reservation's own run id and selector, `checkout-journal` evidence,
`cleanup: complete`, a closed workload-verdict state, and the bound runtime
bytes in the reservation's own checkout. The retirement uses the same carrier as
the operator accounting disposition (#412). It is a `host_run` journal fact
naming the producer record, and the pinned contract 010 record is left
untouched. Nucleus writes no `host.run.result` or `host.run.settlement` for it, no
`escapedDescendants` or `containers` claim, no launcher `pgid` as a workload
group, and no `capacity_release` that cites settlement evidence. The producer's
verdict, exit code and signal stay on the row as producer evidence.

This accepts that a Retained effect or an environment container may outlive a
Complete cleanup (Effigy 052 R5/I-R7). It is an accounting decision, never a
claim of container removal, custody closure or physical headroom. Every #415
hold (`cleanup-incomplete`, `cleanup-absent`, `cleanup-unknown`,
`live-foreground`, `not-journal-backed`, `run-id-mismatch`,
`selector-mismatch`, `verdict-unknown`) and every #414 hold still keeps the
slot; #415's `launcher-identity-absent` hold retired with the result it existed
to fill. Nucleus-supervised settlement is unchanged. Decision `d3bad004`'s future
no-terminal rule stays separate and unshipped: this path is authorized by the
2026-10-25 cleanup ruling, not by that risk acceptance, and it consumes no
unshipped producer field.

**Implementation (task 417).** The observer keeps the producer record as
`effigy_observation` — once per exact answer, decided against the durable
journal, so a repeated tick, a restarted service and a reattached watch add
nothing while a changed answer records itself — and then asks the scheduler to
retire the accounting.

- **One private sidecar, two bases.** The retirement lives beside the pinned row
  in the same durable sidecar the operator disposition uses
  (`hostRunAccountingDisposition:<runId>`, bound to the row's epoch) and commits
  with one `host_run` journal fact (`accounting_retirement`). #412's stored
  operator records still parse byte for byte; the automatic record is a distinct
  representation (`queue.host-run.accounting-retirement`) so no reader can
  confuse it with an operator acceptance. It carries `basis: "producer_cleanup"`,
  the exact producer record (run id, selector, `checkout-journal` source,
  `cleanup: complete`, verdict state, Nucleus's passed/failed reading, the
  producer's numeric exit code and numeric signal, the bound runtime path and
  SHA-256, and when Nucleus observed it), the pinned record digest it was decided
  against, the evidence snapshot the operator path also keeps, and
  `acceptance: null`.
- **Honest provenance, never an operator.** The only authority it names is the
  policy ruling — `rule:
  "spec-035/automatic-accounting-on-producer-cleanup"`, `decidedOn:
  "2026-10-25"`, the chosen option — because nobody accepted this run's outcome.
  It never records an operator or relay caller, never fabricates an exact-run
  acceptance and never writes #412's manual record.
- **What it validates before writing.** The row exists, its epoch is current, it
  is `running` with a launch and no settlement and no earlier capacity release,
  and its recorded retirement is absent or unreadable-refused. The producer
  record must name this reservation's own Effigy run id and selector and must
  have been answered by this reservation's bound runtime bytes (path and
  SHA-256): a record of another run, another task or another runtime retires
  nothing.
- **Atomic, idempotent and conservative.** The sidecar write and the journal fact
  share one transaction, so a failed write releases nothing and records nothing.
  The retirement's durable idempotency key derives from the reservation, its
  epoch and the producer record (not the tick's instant), and an already-stored
  retirement bound to this row is returned as itself without a second write, so
  repeated observation, a restarted or reattached service, a concurrent pass and
  a lost reply cannot double-retire or re-charge a retired row. A stored
  retirement this build cannot read leaves the charge in place and refuses
  rather than replacing it.
- **What it reads.** `host.run.accounting.status` answers `accounting:
  "retired"` with the retirement in `disposition` — the operator's #412 record or
  this automatic one, told apart by `format` — and the pinned record and digest
  unchanged. The scheduler subtracts a retired reservation from capacity totals
  and nothing else; a queued admission may use the room.
- **Two facts stay two.** A later genuine settlement (a run Nucleus really
  supervised) still settles as itself, and a retired charge never resumes
  charging. This path writes no terminal result, no outcome, no container
  removal, no escaped-descendant proof, no process-group claim, no workspace or
  consumer permission and no physical-headroom claim, and it signals nothing.

### Workspace release on retired accounting (Tom, 2026-10-25)

Both accounting retirements leave the row `running` with its outcome and custody
unknown: the automatic producer-cleanup retirement above and the operator's
exact-run disposition (#412). `hostRunHoldingWorkspace` held a workspace for any
queued, admitted or running row. So each retired admission held its task's
workspace forever, and since #417 every cleanly closed admission blocked its
finished task's archive. On 2026-10-25, five done tasks were stuck that way:
three on producer-cleanup retirements and two on operator dispositions.

Tom was told that clearing the producer-cleanup ones was clearly safe, while
whether the work behind a hand-cleared slot really stopped was unknown. He was
then asked whether a manual clear should also let the workspace archive. He
chose "Both release (Recommended)": "A slot freed automatically on Effigy's
cleanup, or cleared by you, stops holding the workspace. Your 'keep things
moving' risk then covers deleting the folder of a run that might still be
alive."

The rule: a row whose stored accounting retirement is readable, under either
format, and names the row's own id and epoch no longer holds its workspace.
Archive and run-bound output cleanup then follow their own gates unchanged. An
unreadable retirement, one naming another run or epoch, and an unretired
queued, admitted or running row still hold. A never-retired settled row with
capacity still reserved also holds.

This accepts the risk that a still-live process behind an operator-retired run
has its working directory removed. It is not a claim that the workload ended,
that its custody closed or that its containers were removed. The pinned row,
its settlement, capacity rules and the retirement records are unchanged. No row
is migrated, and no per-run control or verb is added. Decision `d3bad004` does
not already cover this release; the authority is this ruling.

### Retired runs on the board (Tom, 2026-10-25)

Tom reported on 2026-10-25: "tasks aren't archiving again, failed runs are
backing up". The pinned contract 010 record keeps a retired run `running` for
good, and the board's QA runs tab read only the pinned `host.run.list`. So every
retired admission stayed in the Now list and in the tab's live count, and the
list only grew: 63 rows on 2026-10-25.

The board now joins a Nucleus-private bulk read, `host.run.accounting.list {}`. It
returns the unsettled rows that have a stored accounting retirement among
exactly the rows `host.run.list` returns, newest first, up to 1,000. Since the
age-out below, that set is bounded. Each entry carries:

- `runId` and `epoch`;
- `accounting`: `retired` when the stored retirement is readable and bound to
  this row's id and epoch, otherwise `unreadable`;
- the retirement's `format` and `disposedAt`;
- for the producer-cleanup basis, the producer's own attributed verdict, state,
  exit code and signal.

`complete: false` says the read did not return every candidate. The read writes
nothing, and `host.run.list`, the pinned record and every method digest are
unchanged.

On the board, a run is live when it is unsettled and the read does not name it
`retired` for its exact id and epoch, or when it is settled but still holding
capacity. Everything else is history. A retired run shows in history as
"Retired · outcome unknown · custody unknown". When the producer's cleanup
retired it, the label adds "producer reported" with that verdict. These keep
the run on Now:

- a run the read does not name;
- an entry for another epoch;
- an `unreadable` record, labelled "Running · retirement unreadable";
- a failed read, which shows a notice;
- a run beyond a partial read, which also shows a notice.

Retired is an accounting status. It is not process death, cleanup complete,
custody closure, a pinned outcome or free physical capacity.

### Retired runs age out, and dead foreground runs retire (Tom, 2026-10-25)

Tom asked whether freed runs could still stack up after the board change (#661).
Two real build-ups were found. First, `list()` keeps every accounting-retired row
visible beyond ordinary history, and history pruning only covers settled rows,
so the retired set only grows. Second, a dead foreground admission still needs
an exact-run operator disposition until Effigy v2 lands. Tom was asked two
questions.

1. Should freed runs leave the list on the same 4-day clock as finished runs,
   with their records staying in the database? He chose "Age out at 4 days
   (Recommended)": "Freed runs leave the runs list 4 days after their slot was
   freed, like finished runs. The list stays bounded, and #661's read only
   covers runs the board actually shows."
2. Should Nucleus free the slot automatically when a foreground run's admission
   hook is dead, Effigy has no record of it and nothing holds its lock? This
   extends his "keep things moving" acceptance, since a stray process could
   survive. He chose "Auto-free them (Recommended)": "When the hook is dead,
   Effigy has no record and nothing holds the lock, Queue frees the slot and
   records it as an automatic accounting retirement, with the outcome unknown.
   No more manual clears for this shape."

The rules:

- **Age-out.** An accounting-retired row stays force-visible in `host.run.list`
  only until 4 days (`HISTORY_RETENTION_MS`) after its own `disposedAt`. After
  that it is listed only as ordinary recent history would list it. A still-charged
  admitted or running row stays listed however old, and so does a still-charged
  queued reservation waiting for a slot. The pinned row, its state and its
  retirement record are never rewritten or deleted.
- **Bulk read.** The board's bulk accounting read covers the rows the list
  returns, not every unsettled retired row.
- **Dead foreground runs.** A launched admission retires its accounting
  automatically, with an attributed record, when all of the following hold:
  - its own admission hook is observed dead by recorded identity;
  - the reservation's bound runtime, in its own checkout, answers its own
    Effigy run id with the structured `not-found` and `not-recorded` state
    (#414's "no live holder or retained journal record");
  - no other evidence shows the run live: no live holder, no held task lock and
    no `live-foreground` answer.

  An unbound runtime, an unreadable answer, unknown hook liveness and any other
  state keep the hold as today; with the hook gone by its recorded identity they
  settle the reservation instead ("A reservation settles when its recorded
  process is gone").
- **What a retirement claims.** Like every retirement, it is accounting only. It
  claims no outcome, no custody closure, no cleanup, no container removal and no
  physical headroom. The workspace hold then releases under "Workspace release on
  retired accounting".
- **Separate from v2.** Decision `d3bad004`'s v2 conditions and the Effigy v2
  integration (#420) stay separate and stronger. This rule covers v1 foreground
  admissions now.

**Implementation (lead `a2115db9`).**

- *Age-out.* `HostRunScheduler.list()` force-includes an accounting-retired row
  only while its retirement's `disposedAt` is within `HISTORY_RETENTION_MS`.
  After that, ordinary recency decides. A still-charged admitted or running row
  stays force-visible however old (`hostRunCapacityCandidates()` plus
  `reservesCapacity()`). A still-charged queued reservation is not a capacity
  candidate — `reservesCapacity()` excludes `queued` — so `list()` also
  force-includes `hostRunsByStates(["queued"])`. An unreadable or other-epoch
  retirement fails closed: the row stays charged and force-visible.
- *Board read.* `host.run.accounting.list` derives from the same `list()`.
- *Absence answer.* The run-control classifier reads the producer's structured
  `state: "not-found"` and `recording: "not-recorded"` together as a distinct
  `absent` answer. Either field alone stays `unknown`.

  At the qualified producer bytes `efc1478`, `run status` resolves the run in
  the cwd's checkout root, then in known roots, and reads the producer's
  held-gate inventory (`Gate::foreground_holders`) before its journal. It
  returns that pair only when it finds no foreground holder and no journal
  record. The memory sentinel's inherited hold is in that inventory, so a dead
  hook with a sentinel still holding the gate reads `live-foreground` and holds.
  Unreadable or ambiguous custody reads `unknown` and holds. Nucleus runs the
  call with the bound bytes in the reservation's own checkout.
- *Retirement.* The admission endpoint retires accounting on that answer only
  after the hook is observed dead by its recorded identity.
  - It writes its own private record: `queue.host-run.accounting-absence-retirement`,
    with basis `foreground_absent`, policy
    `spec-035/automatic-accounting-on-foreground-absence` and acceptance `null`.
    The record names the run id, selector, checkout, runtime path and SHA-256,
    the hook identity and the producer message. It commits with one
    `accounting_retirement` journal fact.
  - The scheduler re-checks every binding inside its transaction, and a stored
    retirement is returned as itself.
  - The #412 and #417 record bytes are unchanged.
  - It records no settlement, result, inventory, release or custody claim. The
    reservation itself then settles through its own ordinary path ("A
    reservation settles when its recorded process is gone"), which carries this
    absence answer as the settlement's evidence.
  - The workload owner's death is not used as evidence: the sentinel can hold
    the gate after it.

### A reservation settles when its recorded process is gone (task 955)

A foreground admission has no closure of its own on the Effigy side, and the
hook Queue recorded is its whole foreground: the hook prints `admit` and then
holds until it is terminated, so its absence is the end of that foreground. A
reservation whose hook died therefore must not sit `running` with
`settledAt: null`. It did for up to the reservation's whole 24-hour run timeout
(task 527): on 2026-11-09, 56 admissions that had each finished in about two
minutes — their producer had already reported the run's own verdict and closed
its accounting — sat `running` and blocked the data move's drain proof until
each one's deadline. The gate was `expireAdmissionIfDue`'s
`launchedAt + runTimeoutMs` condition, not a regression in that day's merges.

A launched admission reservation now settles as soon as its recorded hook is
proven gone. Two observers apply the one rule, from the same stored identity:

- **The watch**, at its own tick, when it has just been refused by the producer
  (an unreadable journal, an answer that is not a closure): it reads the answer,
  records its cause, and settles. One `run status` reachable answer and one
  settle, never a hold that outlives its evidence.
- **The sweep** behind the scheduler's `tick()`, which the service's first pass
  after a start runs: it settles a hook-gone reservation whose producer already
  retired its accounting (#412 operator disposition, #417 producer cleanup, the
  foreground-absence retirement) and one past its own recorded run timeout. It
  leaves a reservation with no producer answer to the watch that owns it, so the
  sweep never settles a row one instant before its observer reads the result.

What a settlement is, and is not:

- **It claims nothing about the workload.** It is the pinned record's own
  `lost`: launched, no result, no process-group identity, no containers and no
  escaped descendants, because Nucleus observed none of them. The hook is not
  the workload, so hook absence never proves the workload died. One `hook_gone`
  journal fact (or `expiry` when the run timeout is what is due) records the
  reason, the dead hook identity and `custody: "unknown"`.
- **A producer's verdict stays evidence, never a result.** When the row already
  holds its bound runtime's own terminal answer — `checkout-journal`,
  `cleanup: complete`, state and exit code — that answer travels in the
  settlement's journal fact. It does not become the settlement's outcome or a
  contract 010 `host.run.result`: Queue supervised no command for an admission,
  and a launched non-`lost` settlement requires a result Queue would have to
  invent.
- **Capacity is released under the settlement's own reason** ("the admission hook
  is gone with no terminal result of its own", or "run timeout expired with the
  admission hook gone"). A row that already records a release keeps that
  release's instant and reason and gains no second `capacity_release` fact. An
  accounting retirement — #412's operator disposition, #417's producer cleanup
  or the foreground-absence retirement — is never rewritten, replaced or
  double-released: the settlement adds the row's terminal state and the
  retirement keeps its own record.
- **A producer that still says the run is live keeps the slot.** A `live`,
  `held-lock`, `live-foreground` or genuine retention-expiry answer, and a
  missing or `@unknown` hook identity, are not a gone process: the reservation
  holds, and its own run timeout stays the deadline that ends it.
- **Only positive absence counts.** A pid the kernel no longer reports is gone.
  A live pid is gone only when its contract 010 start identity differs, which is
  a reused number. An unreadable live identity, an `@unknown` recorded identity
  and a start-identity read the pass did not spend are all unknown, so a reused
  pid never keeps a dead run open and an unprovable one never closes a live run.
- **Ordinary and idempotent.** Nothing is migrated, hand-edited or special-cased:
  the rows already on the host settle through the same sweep after the restart,
  through the one settlement writer. Nothing is relaunched, and an unknown
  delivery is still not permission to retry. Start-identity reads are bounded
  per pass so a busy sweep never stalls the service, and anything left unproven
  waits for the next tick. A settled row is no longer a capacity candidate and a
  second pass writes nothing.

## Bounded history reads behind the pinned rows (audit A7/A8, task 435)

The host-run table is never purged, so reading it in full became a per-pass
cost: `store.hostRuns(10_000)` parsed all 1,393 rows (15 ms in the 2026-10-25
audit) on every pump, every 30 s maintenance pass, every `ProjectQa.list` and
every submit's history samples, and the board called it twice per refresh.

- **Served fairness.** `pump()` reads the last launch instant per repository
  with one grouped SQL query (`hostRunServedLaunches`) and only when a queued run
  exists; an empty pump reads no history row. The recorded order — priority,
  aging, then the repository that was served last — is unchanged.
- **Selector history.** A submit reads only the rows for its own selector and
  repository, filtered by an additive expression index on the record's selector
  (`hostRunSelectorSamples`). The index reads only well-formed rows, so an
  undecodable row is still stored, lists as unreadable and never stops the store
  opening (2026-10-26). A legacy QA or task row is still skipped exactly
  while a host run represents its id; that lookup asks for those exact ids
  (`hostRunIdsAmong`) instead of scanning every identity.
- **QA re-attachment.** `ProjectQa.list` selects settled rows that still hold
  capacity for escaped descendants not yet proven dead
  (`hostRunsAwaitingEscapedDescendants`) instead of parsing the table and
  filtering it. The released or proven-dead rows are absent, as before.
- **Retention sweep.** A maintenance pass retires output for one bounded page of
  settled rows (250) and persists the last rowid it finished
  (`hostRunOutputSweepCursor`, Nucleus-internal meta). At the end of the table the
  cursor wraps to the start, so a row that settles *after* the cursor passed its
  rowid is still reached within one cycle; a very old row waits at most one cycle.
  A restart resumes from the stored cursor instead of starting over, and a
  missing or unreadable value starts a full cycle. `service.health` publishes the
  failure beside the endpoint's own state.
- **One stuck run does not pin the sweep (task 443).** #435's page moved only
  when every expired row on it succeeded, so one run whose retained output was
  absent — `d230b0ff`'s settled run with an empty host-run directory — pinned its
  page for good and every later eligible run waited behind it. Rows are now
  independent: a page advances past the rows it attempted, and a refusal is
  recorded against that run alone in the durable failure set
  (`hostRunOutputSweepFailures`, Nucleus-internal meta) with its run id, its epoch,
  the reason, `firstSeen`, `lastSeen`, `attempts` and `nextRetryAt` — written
  before the cursor moves, so a pass that cannot store the set leaves the cursor
  where it was and no run is skipped unrecorded. The set survives a restart and a
  cursor wrap; a later good row or page never clears another run's entry, and
  only that run's own later success removes it. Recorded rows the page did not
  reach are retried from the set, at most 25 per pass and on their own bounded
  backoff (60 s doubling to a 10 min cap), so nothing is starved behind the
  cursor, retried once per pass or scanned in full. That first set kept only its
  100 most established entries and reported the rest as summary wording, which
  task 444 below replaces. A row that has gone or changed epoch stays visible
  with the observation recorded rather than being resolved. The marker itself is
  unchanged: a run is only retired when both streams were readable, so every
  `availableFrom` stays a true byte offset.
- **Absent output is classified, never invented (task 443).** The sweep
  distinguishes what a `null` size used to collapse: a stream that is absent now,
  an existing (possibly empty) readable stream with its true size, and a stream
  the verified traversal refuses (mode or owner, symlink, foreign inode,
  non-regular file, unreadable chain). A run with **no launch record** was never
  written — the supervisor is the only writer of `runs/<id>/stdout` and
  `runs/<id>/stderr`, and it cannot have run — so it is `nothing_retained`: no
  marker, no byte count and no failure. So is a run that **settled `lost`** with
  no result and no process Nucleus ever recorded (Tom, 2026-10-27, on the last live
  failure, a hand-launched `interactive:501` run lost on 2026-10-14: "It doesn't
  feel like that should constitute a failure?"): the loss is already its recorded
  outcome and no output was observed, so a recorded failure for it clears. A lost
  run that did have a recorded process keeps the rule below. A **launched** run
  whose streams are gone is `unknown`: bytes may have existed, so nothing is written or removed and the
  refusal names which stream is absent or which directory vanished. A **partial**
  run (one stream readable, the other absent or refused) keeps the offset it has
  and never expires one stream without the other. A marker that exists but is
  corrupt, unreadable or names another run is evidence, not a licence to re-derive
  gone offsets from whatever remains. Present-day absence is never reported as
  "never written" or as an empty stream, and no placeholder file or zero-size
  marker is created.
- **Every failure identity is durable; only the summary is bounded (task 444).**
  443's set was one Nucleus-internal meta value capped at 100 identities:
  `storeRetentionFailures` sorted the failures, sliced the first 100, stored only
  those, replaced the in-memory set with them and returned success with
  `omitted > 0`, and the pass then advanced its cursor. On 2026-10-25 the live
  service reported `100 retained-output failures (+30 more not listed)`: 30 run
  identities, their epochs and their retry history were gone, and nothing could
  reconstruct them. A summary may be bounded; the failure set may not.
  - **Durable rows.** Each unresolved failure is one row in the Nucleus-private
    `host_run_output_failures` table (schema 47), keyed by the exact run id and
    carrying the epoch it names, the reason, `firstSeen`, `lastSeen`, `attempts`,
    `nextRetryAt` and the observed stream states. There is no cap: the durable
    set is the truth, its size is the exact stored count, and the bounded page
    (250 rows) and due page (25 failures) bound the work, never the storage.
  - **Durable before the cursor.** Every row a page attempted that could not be
    established is written before the cursor moves. A refused write leaves the
    cursor where it was and reports why, so the pass is retried with the failures
    it already recorded still durable; every row on the page is still attempted
    after another row's write was refused, so one bad write never skips the rest
    of the page's expiry work. An unreadable stored row reports itself and keeps
    the cursor, rather than reading as resolved.
  - **Bounded reads.** The due page is an index range read on
    `(nextRetryAt, runId)` — the oldest 25 due failures, by their own backoff of
    60 s doubling to a 10 min cap — and the named sample is `(firstSeen, runId)`.
    A maintenance tick therefore never parses the failure set or the run history
    in full; a failure the sweep page did not reach is reached by the due page
    and never starved behind the cursor.
  - **Exact clearing.** A run's own later success removes only that run's row. A
    row that is gone keeps its recorded identity and a recorded observation; a
    row whose run now holds another epoch is never re-bound to the new row, so a
    new epoch's success cannot resolve an identity the sweep could not verify.
  - **Summary versus storage.** `retentionFailureSummary()` reads the exact
    `COUNT(*)`, `MIN(firstSeen)` and `MAX(lastSeen)` plus 5 named examples, and
    `examplesOmitted` says how many stored rows the summary itself withheld.
    `retentionError()` renders "N retained-output failures (M more recorded
    durably, not named in this 5-run summary): …" so a truncated answer can never
    read as an all-clear, and `service.health.hostRunEndpoint.retentionFailures`
    publishes the same exact total, sighting window and bounded sample (null only
    when nothing is unresolved). A store read that fails reports the failure
    instead of a zero count.
  - Retained-output failures live only in `host_run_output_failures`; the completed import of the old bounded meta value is retired (Tom, 2026-11-09).
- **Positive Project-QA ownership clears a false positive, and only that (task 444
  amendment, Supervisor `2b96d20c`).** Every one of the 100 live failures was a
  milestone Project QA run, not a missing generic host-run stream: milestone QA is
  submitted to the host-run scheduler with its own handler, and the QA pipeline
  writes its own per-step logs under the QA root. The generic supervisor — the
  only writer of `runs/<id>/stdout` and `runs/<id>/stderr` — never ran for those
  runs, so "launched and both streams absent" never meant missing bytes.
  Classification is provenance, never a prefix, a path or an absence: the exact
  host-run id must have a `project_qa_runs` row of the same id, the host run's
  caller must be exactly `qaCallerIdentity(key, runId)` for that row
  (`core/qa/qa-caller.ts`, the one owner of the canonical string the producer also
  uses), the two records must name the same repository, the QA row must pin the
  host-run epoch the run now holds, and both observed generic streams must be
  absent. Anything else — a forged prefix, a caller naming another run, no QA
  record, a mismatched repository, an unpinned legacy epoch, an unreadable QA
  row, a present or partial stream, any marker evidence — stays `unknown`, so its
  durable failure remains visible and counted. A positively owned run is cleared
  only by writing bounded durable reclassification evidence first
  (`hostRunOutputOwnerReclassifications`: the run id, epoch, owner, QA run id, key,
  repository, caller and the statement that Project QA owns the output) and then
  removing that one row; a run that was never a failure records no evidence. The
  evidence never claims QA logs exist, that QA passed, or that any byte count or
  offset is zero, and the sweep never reads, moves or redirects a QA step log. The
  sweep also never re-attempts it as a generic failure: the ownership check runs
  before any durable failure is recorded.
- **Merge-time project validation owns its output too.** Validation is the
  second Nucleus producer with its own supervisor and per-run state; the generic
  supervisor never writes `runs/<id>/stdout` or `stderr` for it, so every settled
  `check:merge` run past the retention hour looked like missing output (three
  live Project-e runs on 2026-10-26, with more arriving per merge). Ownership is
  provenance, as for QA: the caller is exactly `queue:validation:<task>:<head>`
  (`core/qa/project-validation-caller.ts`, the one owner of the string), the host
  run was positively submitted by Nucleus (its pinned `submissionSource`, or — for
  a row written before that field existed — its own journal's `host.run.submit`
  request, never a client submission and never an unreadable journal; an
  admission reservation is labelled `admission` beside the row and is refused),
  both generic streams are absent, and the named task durably records scheduling
  exactly this run at exactly this epoch and head: its live validation pin names
  all three, or a `project_validation_scheduler_recorded` event on the task
  carries the one exact string naming all three. Because that string is compared
  whole, an event for another head, a changed epoch or a run id alone never
  authorises the run. A pin that has moved on to a later validation only leaves a
  run provable when that run's own event carries the exact run, epoch and head; a
  run whose only surviving evidence is a superseded run-id-only event, a moved
  pin, a changed epoch, an absent journal or a client submission stays `unknown`
  and visible with the reason, so an existing failure clears only where ownership
  is established and never merely because the shape is a project validation. A
  cleared failure leaves reclassification evidence with
  `owner: "project_validation"`, the task id and head, and the same non-claims as
  for QA.
- **The submitted key survives a repository re-key (task 445).** The caller is
  minted from the run's one-run key and a contract-010 host-run row keeps it
  verbatim, because a settled run is history. A Spec 056 re-key moves the
  `project_qa_runs` row's *current* key and repository, so recomputing the
  canonical caller from the current key alone rejects the authentic producer of
  every run the re-key moved — the parent shape task 445 falsifies, and the cause
  of 17 of the 18 live errors seen on 2026-10-25. The check keeps 444's whole
  positive tuple (exact host-run id = QA row id, the caller as the exact inverse
  of the submitted key and id, the same repository, the pinned epoch, both
  generic streams absent) and resolves the submitted key only from durable,
  exact-run evidence (`core/qa/qa-caller-provenance.ts`):
  - the row's own `key`, while that key still names the row's own repository —
    the ordinary case, and the only one that reads nothing else;
  - `project_qa_runs.submittedKey`, the key the re-key recorded in the same
    transaction that moved `key`, never rewritten afterwards (a second re-key
    keeps the first recorded key). It is Nucleus-private: QA runs are operational
    history outside the contract 010 wire shapes, so no exported shape changed;
  - for rows re-keyed before that field existed, the applied `repository_rekeys`
    receipts that moved this repository, walked backwards from the current key.
    A step corroborates an earlier identity only when its `target` is the
    identity the row held, it happened at or after the run's submission (a run
    created after the step cannot have been submitted under the vacated key), it
    moved at least one QA row, and exactly one step moved the row into that
    identity. The walk is bounded to eight moves and ordered strictly backwards,
    so it terminates. The chain reconstructs each earlier repository identity,
    and its checkout whenever the step left that checkout alone, so the immutable
    host-run record must name both.
  - **An out-and-back move is a net no-op.** A step whose source is an identity
    the walk already holds is the far end of a round trip read backwards: the
    forward history left an identity, moved through a temporary namespace and
    came back to it. Rather than refusing "loops back", the walk drops every
    step of that round trip and continues from the identity the row returned
    to, ordered before the step that left it. A dropped step that moved the
    checkout leaves the pre-trip checkout unrecorded, so a trip that moved it is
    compared by identity alone; a trip that moved nothing leaves the earlier
    checkout exact and still compared in full. A longer cycle that returns to an
    identity the walk never reconstructed has no earlier level to anchor, so no
    ancestor follows from it: the walk reaches no evidenced ancestor and refuses,
    as before.
    Live shape, 2026-10-26: ten project-d QA runs submitted under
    `inflatable-cookie/project-d`, moved to `project-d-desktop` before per-run
    provenance existed, then sent through `project-d-desktop-relocating` and
    back, which recorded the already-moved key as the submitted one.
  **Identity binds; a moved checkout is the run's own fact.** Two repository
  checks are deliberately different. A current key is compared with the row's
  repository exactly — identity *and* checkout — as 444 required, and so is a
  receipt-derived ancestor whose step did not move the checkout (the receipt then
  reconstructs it exactly). A recorded `submittedKey` is compared by the identity
  the caller names: the host-run row must name that same origin (or, for a
  repository that had no origin, that same path). Its historical checkout path is
  not compared, because a Spec 056 step with an explicit target path moves the
  checkout — and the receipt records the *settings* source path, not this row's
  previous one — while a checkout that had already moved before the run was
  submitted is simply the run's own recorded fact. That is why a path-changing
  re-key with the recorded submitted key is verifiable (the production write this
  check reads), why a receipt-only row for the same step verifies by identity
  instead of a guessed pre-move path, and why neither lets another repository's
  identity authorise the row: a different origin is still refused, and the
  caller's key must still be the exact inverse for this exact run id.
  The accepted key is the submitted one, so the reclassification evidence names
  it and states the verified lineage or the recorded submitted key, alongside
  the row's current key. A prefix, a caller prefix digest, a matching checkout
  path, a guessed hash, an arbitrary earlier receipt, a name the current
  repository once held, a reversed or missing or corrupt or ambiguous history, a
  name reused later by another repository, a stale key on a later run, a foreign
  or another-run digest and a changed or unpinned epoch each stay `unknown` with
  the reason, and every genuine unowned absence stays a durable failure. The
  receipts are read at most once per sweep pass and only when some row's current
  key cannot answer, so an ordinary run and an ordinary pass read none; a
  receipt read that fails is the stated reason ownership is unknown, never an
  absence of evidence. The measured, bounded paging, the durable failure rows,
  the per-run retry cadence and the health summary are unchanged.
  `test/qa-caller-provenance.test.ts` proves the parent falsification and the
  acceptance/refusal matrix on real applied re-keys;
  `test/repository-rekey-qa-ownership.test.ts` proves the same through the public
  durable re-key and the default endpoint's sweep across a restart, for an
  origin-only rename and for a step that moves the checkout too, with the QA
  producer's own step logs untouched and no marker or byte count written.
- **Board read.** The board's pinned list and its retirement join came from two
  `list()` calls. `host.run.board` is a Nucleus-private, read-only additive read
  that returns exactly `host.run.list`'s pinned records and exactly
  `host.run.accounting.list`'s derived answer from one list call. The join is the
  same run-id and epoch binding, the same conservative `unreadable` answer and the
  same `complete` flag; both pinned reads, their schema and their method digests
  are untouched, and nothing is written.

The retention sweep's cursor, error summary, reclassification evidence and the
retained-output failure rows are Nucleus-internal (meta and the
`host_run_output_failures` table, schema 47); no pinned run record, contract 010
wire or digest changed, and the table is operational. The schema bump is
deliberate: an older build refuses a newer schema, which is what stops it
reopening this store and re-capping the failure set. The number is the next free
one after 437's task side storage (schema 45) and 438's planning history (schema
46), so an older build of either still refuses this store instead of re-capping
the set. It also means rollback is a store restore, not a binary swap — the store
takes its pre-migration snapshot on the first open at schema 47 — and no other
row's shape changed. Measured on an isolated 1,398-row audit-shaped store, with the parent
shapes implemented beside the new reads (receipt
`evidence/host-run-history-reads-20261025.json` in Git history): QA candidates 19.8-50.9 ms
down to 2.6-3.7 ms, a busy pump's served launches 17.5-55.7 ms down to
5.4-7.2 ms, one sweep page 19.2-41.5 ms down to 3.3-5.7 ms, the board's two
list calls 11.3-25.3 ms down to one 6.2-9.2 ms, and selector history 16.9-42.3 ms
down to 12.6-39.8 ms — the smallest gain, because this fixture's rows mostly
match the selector being read, so the rows parsed remain most of them. No target
is claimed as a guarantee.

## Retired rows are observed on a bounded slow cadence (task 430)

An operator retirement (#412) stops a reservation's charge but leaves its
outcome and custody UNKNOWN, so the endpoint kept observing the row every watch
tick: one `run status` spawn plus a digest of the whole declared artifact, once
per second, per retired row, forever. On 2026-10-25 Nucleus Supervisor `b86c7623`
reported the shape: Paseo Helper held a whole core and survived quitting the app.
Its evidence — not this document's — was the qualified candidate `efc1478` at
184,804,120 bytes and two operator-retired rows, about 740 MB/s of hashing of
bytes that could not change, on top of the one-second status spawns. The worker
that corrected it ran no live process or CPU probe.

Two costs were removed, and no identity check was weakened.

- **Cadence.** A row's watch now decides its next delay from the durable row and
  its stored retirement, on every tick and at reattach, instead of from one
  fixed interval. A charged row keeps the ordinary watch (`ADMISSION_WATCH_MS`,
  one second). A row retired on either automatic format
  (`queue.host-run.accounting-retirement`,
  `queue.host-run.accounting-absence-retirement`) has its final evidence and
  arms no watch, exactly as before. A row the operator retired
  (`queue.host-run.accounting-disposition`) keeps a watch, because its producer
  record may still arrive as late evidence, on
  `ADMISSION_RETIRED_WATCH_MS` (five minutes). A restarted endpoint reads the
  same cadence from the row, so reattach never turns retired rows back into
  one-second work.
- **Missing, unreadable and mismatched retirements stay charged.** A stored
  retirement this build cannot parse, or one naming another run or epoch, is not
  read as "nothing left to observe": the row keeps the ordinary watch and its
  charge. Only the two automatic formats stop a watch, and only an operator
  disposition slows one.
- **Late evidence is unchanged.** The slow tick is the ordinary reconcile on a
  slower clock, with the existing in-flight-per-row guard. A producer closure it
  reads is recorded once as `effigy_observation` and stops the watch; the
  scheduler returns the already-stored operator retirement as itself, so no
  second `accounting_retirement` fact is written, nothing is re-charged or
  re-settled, and the operator's record and pinned row are left byte for byte as
  they were. An absence answer on an operator-retired row retires nothing new.
- **Digest reuse.** `digestEffigyExecutable` remembers a digest only while the
  opened file's identity still matches: resolved path, device, inode, size,
  `mtimeNs` and `ctimeNs`. Every verification still resolves the path, opens it,
  and re-checks that it is a regular, executable file before consulting the
  memory. `ctime` is part of the key on purpose: a same-size rewrite with a
  restored `mtime`, a replacement and a mode change all move it. A miss reads
  the descriptor in bounded chunks, re-checks the descriptor's identity after
  the read, and re-resolves and re-checks the path before publishing, so a
  rewrite, swap or symlink retarget during the read never publishes a mixed-file
  digest as verified. Such a read starts again from the path, up to three times;
  a file still moving after that is refused. Refusals are never remembered, so
  recovery is observed on the next check. The cache is process-local and bounded
  (32 identities, least recently used evicted), and concurrent checks of one
  identity share a single read while each caller still compares the digest with
  its own declared SHA-256.
- **What did not change.** Before-and-after verification around every spawn,
  the `unknown`/`drift`/`unavailable` outcomes, the `effigy_observation_refused`
  notes, the public wire shapes, admission and capacity policy, holds,
  settlement, custody, replay and escaped-process handling. Metadata identity is
  an optimization under the existing immutable-artifact contract, not a new
  claim of file immutability, and no digest is cached as trust: only as bytes.

Tests `test/effigy-retired-observation.test.ts`,
`test/effigy-runtime-identity.test.ts` and `test/effigy-run-control.test.ts`
prove this through the default endpoint, watch loop and run-control client with
real spawns and counted reads: a charged row's watch, a retired row's slow
cadence and its stop after late evidence, both automatic bases stopping their
watch without another spawn, reattach, an unreadable and an epoch-mismatched
retirement, repeated and concurrent verifications sharing one read, replacement, in-place and same-size-with-restored-`mtime` rewrites,
`ctime` changes, symlink retargets, execute-bit loss, missing and unreadable
files, recovery, bounded eviction, reads that lose their file mid-read, and a
spawn that replaces its own artifact (refused). A controlled watch clock counts
25 charged ticks and two retired ticks per simulated second, while a reader
that remembers nothing hashes on every check. The fixtures measure both the
cadence and the reduction in digest work.

## A live hook's identity is re-read on a bounded cadence (task 450)

`reconcileOnce` proved the admission hook's death by pid plus contract 010 start
identity on **every** watch tick: the kernel liveness test (`kill(pid, 0)`), and
then `hostRunProcessStartIdentity` — a `ps -o lstart= -p <pid>` spawn on macOS —
once per second, per watched reservation. Nucleus Supervisor `b885f087`'s live
profile of the #449 service measured those identity `ps` spawns together with
the recovery worktree scans at about 1.2 s each of a 4.2 s busy 30-second
window; the #449 rebuild path was already gone. Every rule that decides what
happens to a reservation stays exactly as it was, and only the frequency of the
expensive half of one read changes.

- **Liveness is still per tick.** `pidAlive` is one non-blocking kernel call, so
  every tick still asks it. A pid the kernel reports gone (ESRCH) is `dead`
  immediately, inside the bound, and needs no identity read at all.
- **The identity read is bounded, and only a positive match is remembered.** A
  hook proved live at an exact pid, epoch and recorded start identity is not
  read again until `ADMISSION_HOOK_IDENTITY_REVALIDATE_MS` (20 s, inside the
  15-30 s bracket) expires, at which point the identity is read again. What that
  defers is only the recognition of a pid reused inside the bound; it can never
  exceed 20 s, and a reused pid is still `dead` at the expiry.
- **Only `alive` is ever cached.** A `dead` or `unknown` verdict is never kept: a
  mismatch, an unreadable identity, a permission-denied or ambiguous liveness
  answer and an `@unknown` recorded identity each go back to the host on the
  next tick, so no unknown is ever remembered as alive, as absence or as
  permission to retire. A cached `alive` cannot authorize anything itself: the
  cancel, observation, hold and accounting-retirement paths still run off a
  verdict reached in that same evaluation, and the proofs that do have effects —
  the foreground-absence retirement's own `hookDeath` check — ask again.
- **The proof never outlives its binding or its watch.** An entry is keyed to the
  reservation; it is dropped when the watch stops, when the endpoint stops and
  when `bind-hook` records a new pid or start identity, and a changed pid, epoch
  or recorded identity is compared before any reuse, so a proof made for one
  binding can never answer for another. The map has one entry per watched
  reservation and holds no history.
- **Everything else is unchanged.** Operator-retired rows keep the five-minute
  observation cadence, charged rows keep the one-second watch, producer closure,
  foreground absence, runtime binding and structured observer gates, the visible
  reason notes, reattach, cancellation, settlement and custody all behave as
  before. A restart proves the identity again rather than inheriting a proof.
- **Tests.** `test/effigy-admission-hook-identity.test.ts` drives the real
  endpoint and watch loop over an injected clock and injected process readers, so
  it counts the identity reads exactly: one per bound with a liveness test on
  every tick, the bound's exact boundary, the parent shape (a re-read per tick)
  reproduced in the same fixture, a reused pid recognised at expiry and never
  before, a vanished pid dead on the next tick from liveness alone, an unreadable
  or permission-denied identity holding as `unknown` and never cached, a rebound
  hook and a stop/start re-read, and the shipped readers proving a real live hook
  without observing it.

## Reviewed Effigy v2 custody protocol (task 420)

Tom's producer-change decision `b3538091` v2 and the escaped-process risk
acceptance `d3bad004` v2 asked the Effigy owner for workload group and start
identity attestation plus a retained foreground terminal record. The producer
delivered both under parent `6a84e627` (tracker and papercut `55dfc179`). This
section is Nucleus's side of that contract:
what Nucleus may read, where it records it, how it decides, and what it must never
claim. It changes no runtime behaviour by itself — the protocol is not
activated, no producer artifact is qualified and no reservation is retrofitted.

### What the producer merged, and what is not evidence

Effigy task `631ec2a1` merged as PR 473, merge commit
`21aec07ce08f5f10870b53fb9aa2f1908227df88`, exact reviewed head
`dfb7f948faf6ac7e901a0b611aef095cf8d0aae4` (the merge's second parent,
resolved and re-read in the producer checkout before this document was written;
independent review `8c6fb4f0`).
Nucleus read the owning contract text and the producer's own implementation at
that commit: contract 049 "Reported custody protocol (v2)" and 052 §3.1 "The
narrow terminal-record exception (effigy#325)"; the producer's
`src/runner/task_engine/admission.rs` (request, reports, acks, the durable-run
refusal); `crates/effigy-kernel/src/run/terminal.rs` (the `foreground_terminals`
row); and `src/runner/task_engine/status.rs` plus `run_control.rs` (`run
status`'s `foreground-terminal-record.v1` view).

That is a merged **source** fact, and it is all Nucleus may rest on. Owner
`a683cd79-0ab5-4576-9e15-2952a754a795` corrected the record (message
`b1366450`, following `32546d99`): v2 is **not installed** on this host; the
installed build `6e762f1` predates it and ignores `EFFIGY_ADMISSION_PROTOCOL`,
so it would answer a v2 launcher with a v1 request and no reports. No immutable
`325` artifact, SHA-256 or owner qualification receipt exists yet; the owner
will call back with one. Until that packet arrives, a merged commit, a tag, a
version string or an installed path is **not** qualified v2 bytes, and Nucleus
neither polls, queries, builds nor installs the producer. A "qualified v2
artifact" below means that future packet, verified by path and SHA-256 exactly
as the `efc1478` packet was ("Effigy candidate qualification for Queue #381").

### v1 stays the default; v2 is chosen per invocation

- **v1 is byte-identical.** With `EFFIGY_ADMISSION_PROTOCOL` unset or empty the
  producer sends `effigy.admission-request.v1`, writes no reports and no
  terminal record, and Nucleus's hook reads no stdin. `parseEffigyAdmissionRequest`,
  the `admit`/`deny <reason>` grammar, the 2 s connect, the 30 s reserve, the
  5 s confirmation cadence, the 60 s liveness window and the inherited
  `EFFIGY_ADMISSION_HOOK_TIMEOUT_MS=3600000` are unchanged.
- **The opt-in is the producer's variable, set on one invocation.** Contract 049
  selects v2 with `EFFIGY_ADMISSION_PROTOCOL=2` "next to the hook"; any other
  value fails closed at the producer before the hook starts. Effigy builds the
  hook's environment from its own (`process::environment` inherits the
  invocation's variables), so the same value reaches Nucleus's hook and Nucleus
  never guesses it. The shell prefix `EFFIGY_ADMISSION_PROTOCOL=2 effigy …` on a
  heavy foreground invocation is the whole supported opt-in.
- **Nucleus injects nothing.** `queueOwnedAdmissionEnvironment` keeps exactly
  `EFFIGY_ADMISSION_HOOK`, `QUEUE_ADMISSION_SOCKET` and
  `EFFIGY_ADMISSION_HOOK_TIMEOUT_MS`. The inherited launch path is
  `RuntimeOwner.start` → `PaseoAdapter.setAdmissionLaunchEnv` →
  `createAgent`/`createRun` → `mergeAdmissionLaunchEnv`, and it is global for
  every agent launch Nucleus creates — not just the heavy foreground invocation an
  opt-in is meant for. Contract 049 refuses v2 for **any** durable run
  (`--run-id`, or a run inside a durable parent tree) *before the hook starts*,
  so an unconditional injection there would refuse the durable route Nucleus's
  own observation evidence depends on ("Producer closure"), inside every shell
  Nucleus launches. No injection, no retroactive environment patching, no
  credential copying.
- **A caller that sets the variable and an older producer never counts as v2.**
  Nucleus's hook sees the variable too, and in v2 mode it requires the v2 request
  schema: a v1 request is denied with the mismatch named, before the workload,
  and it is never admitted as "v1, close enough". There is no fallback path that
  runs a workload unreported when v2 was expected.
- **Expected protocol is recorded per reservation.** `reserve` submits the
  protocol as Nucleus-internal identity beside the pinned request — the same
  pattern as `effigyRunId`, a sibling of `input` in the `request` and
  `submission` journal facts, never inside the pinned `host.run.submit` input,
  never in the row. A v2 request records `effigyAdmissionProtocol: 2`; a v1
  request records nothing, exactly as today. Every later protocol decision
  reads that fact, so a resubmitted, retried or reattached reservation keeps
  the protocol it was admitted under.
- **The workload's own Effigy still binds the run.** Nothing here weakens
  "Runtime identity": the bound executable is the workload's own Effigy, found by
  live attested ancestry, and the observer runs that same recorded path. The v2
  request schema is the producer's own capability statement, and Nucleus consumes
  it only for a reservation whose workload was bound.

### Wire: request, reports and acknowledgements

`reserve` keeps its params `{ request, ancestry }` and its response
`{ reservationId, observation }`; only the request schema inside changes.

- v2 request: `{ "schema": "effigy.admission-request.v2", "run_id", "task",
  "class": "heavy", "cwd", "root", "protocol": 2 }` — every v1 field plus
  `protocol: 2`. `run_id` keeps the 1–128 `A–Z a–z 0–9 . _ : -` form and stays
  the admission reservation key (`sha256("effigy-admission\0" + run_id)`).
- Reports arrive as newline-delimited `effigy.admission-event.v1` objects on
  the hook's **stdin** (the producer opens that pipe only under v2). Each one
  carries `schema`, `event`, `seq` and `run_id`:
  - `custodians`, always `seq: 1`, after `admit` and before any workload
    spawns: `owner` and `guard` are kernel `ProcessIdentity` values.
  - `workload`, one per spawned group, between the recorded receipt and that
    group's `go`: `pgid` plus the group `leader` `ProcessIdentity`.
  - `terminal`, once at settle before the hook is stopped: `outcome`,
    `exit_code`, `signal`, `cleanup` (`complete` / `incomplete` / `unknown`) and
    `workload_groups` (the acknowledged count, a cross-check only).
- A kernel `ProcessIdentity` serializes as
  `{ "boot": "<boot uuid>", "pid": <u32>, "start": {"LinuxTicks": <u64>} }` or
  `{ …, "start": {"MacOs": {"seconds": <u64>, "microseconds": <u64>}} }`. That
  is **not** contract 010's `<pid>@<boot>:<starttime>` text form, so Nucleus
  converts before any comparison: LinuxTicks plus the boot uuid is exactly
  `linuxStartIdentity`'s string, and macOS seconds become
  `pid@YYYY-MM-DDTHH:MM:SS.000Z`, which `startIdentityMatches` compares to the
  host's own whole-second read (the producer's microseconds are recorded as
  evidence and never compared, because `ps -o lstart=` does not carry them).
- Acknowledgements: the hook answers each report with exactly one `ack <seq>`
  line on its **stdout**. The producer waits 10 s per report; a write failure,
  EOF, a malformed or out-of-order ack or a timeout stops the workload before
  `go` (a running group is never left unreported), ends the sequence for that
  run, and settles it with the existing `effigy.admission.v1` `failed` error.
  A missing ack for `terminal` does not change the run's result: the durable
  record is the source of truth. Stderr stays progress only, and the hook never
  writes anything else to stdout.
- **Ack means recorded.** The hook writes `ack <seq>` only after the service
  durably stored that event. Its own bound is 8 s of retrying that one `event`
  call (100 ms apart), inside the producer's 10 s window and unrelated to the
  one-hour admission timeout; when that bound lapses the hook stops retrying and
  writes no ack, and it keeps holding for the producer's TERM rather than
  exiting under a live run. An incomplete trailing line is never acked.

### Recording: the `event` RPC, receipts and idempotence

The Nucleus-owned admission socket (`run/admission.sock`, owner-only, not
contract 010 and not a catalogue RPC) gains one method, `event`:
`{ reservationId, event }` → `{ seq, duplicate }`.

- **Bind before accepting.** The reservation must exist, be
  `submissionSource: "admission"`, be unsettled, carry `effigyAdmissionProtocol:
  2` and this Effigy run id, carry a bound launcher (`bind-hook`), and have a
  current epoch. The event's `run_id` must be the reservation's own Effigy run
  id; its `seq` must be exactly the next one; its schema, event name and field
  set are validated strictly (unknown fields fail closed). Anything else is
  refused, so the hook does not ack and the producer fails the run closed. An
  event carries no checkout of its own: the reservation's recorded checkout is
  the one the hook ran in (Effigy runs it in the invocation cwd), and it is also
  where the later producer read must happen.
- **Durable before the reply.** The accepted event is one `host_run` journal
  fact (`effigy_admission_event`) carrying `{ runId, epoch, protocol: 2, seq,
  digest, event, receivedAt }`, written in one transaction with the sequence
  check. The reply is sent only after it commits. Nothing is stored in the
  pinned contract 010 row, and no new table or migration is needed: an
  unsettled reservation's journal is never pruned, and a reservation's history
  is exactly the evidence this needs.
- **Lost replies are receipts, not replays.** A repeat of an accepted seq with
  the same digest returns `{ seq, duplicate: true }` from the stored fact and
  writes nothing; the same seq with a different body is refused as
  contradictory. Concurrent calls serialise on the same transaction, so only
  one writer wins a seq.
- **Restarts.** The journal is the sequence, so a restarted service needs no
  extra state: the endpoint's existing reattach finds the reservation, reads its
  coverage from the journal, and a hook retry after a roll sends the same next
  seq and gets its receipt. A roll that outlives the hook's 8 s retry window
  costs that report: the hook does not ack, and the producer refuses the spawn
  (or leaves the settled result and record intact, for `terminal`). That is the
  deliberate trade — a visible refusal rather than an unreported workload. The
  admission socket is not make-before-break today (the standby binds it only
  after the old pid exits, `service/executor/executor-worker.ts`), so a long roll
  can cost a report; a make-before-break admission socket is a later,
  separately reviewed improvement and not part of this contract.
- **The hook can die mid-sequence.** The recorded prefix is exactly the
  acknowledged prefix (ack implies record), and the producer's own rule says a
  report it did not get acknowledged belongs to a group that never received
  `go`. So an unrecorded pending report is never evidence of an empty set — it
  is simply absent, and the coverage rule below treats absence as unknown.
- **A v2 reservation whose hook dies is observed by the existing watch.** No
  new control, timer or task surface: `reconcileOnce` already proves hook death
  by pid plus start identity and reads `run status` with the bound bytes in the
  reservation's own checkout.
- **Nested admission refuses under v2, and says so.** A nested heavy run (a
  Nucleus- or client-submitted host run already live at that cwd) is admitted
  without a second reservation under v1, so a v2 one would have no reservation
  to record reports against and no coverage Nucleus could ever read. Acking its reports would
  fabricate evidence and taking a reservation would charge a second slot behind
  its own parent, so the hook denies a `nested` observation in v2 mode with the
  reason named, before the workload. An owner who needs that nested heavy run
  clears `EFFIGY_ADMISSION_PROTOCOL` for it, exactly as the producer documents
  for a durable key. This is a real cost of opting in and it is why the opt-in
  is per invocation rather than a launch-wide default.

### Coverage witness

Coverage is derived, never stored twice: `store.hostRunJournal(runId)` filtered
to `effigy_admission_event` facts for this reservation's epoch, read in `seq`
order.

- **Complete** means seq 1 is a valid `custodians` event and the recorded seqs
  are a gap-free prefix `1..n` with no contradiction (no duplicate, no
  out-of-order, no second `custodians`, no wrong run id, no `workload` before
  `custodians`, no recorded `terminal` whose `workload_groups` differs from the
  recorded workload count).
- **Zero is a legitimate count**: `custodians` plus zero `workload` events means
  no workload group ever started. **Missing is never zero**: no recorded
  `custodians`, an unreadable journal, an event refused at record time, or any
  gap is `coverage-incomplete` and qualifies for nothing.
- The recorded `workload` events are the *only* set of groups and identities the
  no-terminal branch may consider. No count is inferred from the terminal
  record (its `workload_groups` is not even exposed by `run status`), from a
  terminal report's cross-check, from a process listing, or from a hook's pid.
- The **terminal count is a cross-check, not a witness**: when the `terminal`
  report was recorded, its `workload_groups` must equal the recorded workload
  count, and a mismatch is `coverage-contradictory`. When it was not recorded,
  the cross-check is `terminal-report-not-recorded` and that absence alone never
  decides anything.

### The foreground terminal record

Under v2 the producer writes one row to the owning checkout journal at settle,
in the additive `foreground_terminals` table, and `run status <run_id> --json`
returns it as `effigy.run.v1` with `evidence_source:
"foreground-terminal-record.v1"`, `checkout_id`, `boot`, `state` (the producer's
own outcome word), `exit_code`, `signal`, `cleanup`, `task` (the selector) and
`finished_at_epoch_ms`. `started_at_epoch_ms`, `duration_ms` and `pid` are
absent by construction; `run logs` reports no retained log and `run stop`
refuses. One warning for the next reader: the row is written **after** the
terminal report and after settle, so a `run status` reads `not-recorded` for a
settled run whose record write failed, and the producer's own answer cannot tell
that from an expired key.

`classifyEffigyStatusPayload` gains this second positive evidence source beside
`checkout-journal`, with these gates, all of which must hold:

- the read was made by the reservation's bound runtime bytes, in the
  reservation's own checkout, and those bytes still verify before and after the
  call (existing "Runtime identity" rule);
- the record's `run_id` is this reservation's Effigy run id and its `task` is
  this reservation's selector (the existing mismatch holds keep their meaning);
- `cleanup` is present and `complete` (`absent`, `incomplete` and anything else
  hold with their own causes); a terminal result is producer closure only, and
  `complete` is R5/I-R7's resolved state, which may still leave a Retained
  container running;
- `state` is a workload verdict — `succeeded`, `failed`, `cancelled`,
  `timed-out` — or `interrupted`, and `not-started` and `unknown` hold with
  `verdict-unknown`. An `interrupted` run whose cleanup is complete is closed
  (Tom, 2026-10-27, 'Retire on `interrupted`', after an interrupted
  `qa:stage:rust` run held Project-e 207's finished workspace for eight hours): the
  verdict reads `failed`, never `passed`, and the producer's own exit code or
  signal stays on the evidence when it reported one — a bare `interrupted` with
  neither is closed with both null, nothing invented, while a value it did
  report that Nucleus cannot carry as its own verdict holds as malformed evidence
  ("A value reported is not a value withheld"). An interrupted run with residue
  (cleanup incomplete) still holds with `cleanup-incomplete`;
- the producer's numeric `exit_code` and numeric `signal` are kept exactly as
  reported: `succeeded` with exit 0 reads `passed`, every other verdict reads
  `failed`, and `hostSignalName` still maps a numeric signal to this host's own
  name. The verdict never depends on the cleanup, and the cleanup never depends
  on the verdict;
- `boot` is compared with the recorded `custodians` event's `owner.boot` and
  `guard.boot`. A record can only exist if that report was acknowledged, and ack
  means recorded, so a differing `boot` is `boot-mismatch` and holds; a
  reservation whose recorded coverage has lost seq 1 (only reachable through an
  unreadable or restored journal) holds with `coverage-incomplete` rather than
  skipping the gate. `checkout_id` must be present and stable across reads of
  the same run; Nucleus records it and does not resolve the producer's CheckoutId
  itself, and it says so rather than implying a checkout proof it did not make;
- an `evidence_source` of `checkout-journal` for a reservation that recorded
  protocol 2 is contradictory — a durable run refuses v2 before the hook — so it
  holds with `terminal-evidence-contradiction`.

On those gates the reservation's accounting is retired by a new automatic entry
point, `retireAccountingOnForegroundTerminal`, which reuses `#417`'s sidecar,
its one-transaction write, its row and epoch validation, its idempotency and its
"a stored retirement this build cannot read is never replaced" rule. It does
**not** extend `#417`'s record: `hostRunAccountingAutomaticRetirementSchema`
keeps `evidenceSource: "checkout-journal"` and its exact `producer` block
byte for byte, so every stored `#417` retirement still parses and no readable
history changes shape. The terminal basis gets its own private representation,
`queue.host-run.accounting-terminal-retirement` with
`basis: "producer_foreground_terminal"`, and its own producer block: the run id
and selector the record named, `evidenceSource: "foreground-terminal-record.v1"`,
`checkout_id`, `boot`, the verdict state, Nucleus's passed/failed reading, the
producer's numeric exit code and signal, `cleanup: "complete"`, the cross-check
state (`recorded`, `terminal-report-not-recorded`, or the mismatch that refused
it), the bound runtime path and SHA-256, and when Nucleus observed it. Its policy
is the same 2026-10-25 automatic-cleanup ruling `#417` names (reusing
`hostRunAccountingPolicySchema` unchanged), its `acceptance` is null, and its
gates are `#417`'s own row, epoch, run-id, selector and runtime-bytes gates plus
the ones above — so it is that ruling read through the foreground record, not a
new disposition of it.

Nothing else moves: the pinned contract 010 record, `host.run.list` and
`host.run.capacity.release` are untouched, no `host.run.result` or
`host.run.settlement` is written, and the outcome and runtime custody stay
UNKNOWN. `host.run.accounting.status` reports this format beside the other two
automatic ones, told apart by `format`.

Both v2 bases are added to the same `hostRunAccountingRetirementSchema` union
that `hostRunAccountingRetirementOf` and `Store.hostRunAccountingRetirement`
already read, so the "Workspace release on retired accounting" rule above
covers them with no separate rule, control or verb: a reservation retired on
either basis stops holding its workspace exactly as an operator or
producer-cleanup retirement does, and an unreadable stored retirement keeps
both the charge and the hold.

### The no-terminal branch (decision `d3bad004` v2)

When a v2 reservation's hook is proven dead, the producer reports no terminal
record at all, and the recorded coverage is complete, Nucleus may retire the
reservation's **accounting** automatically on the operator's accepted risk. All
of these must hold in one evaluation; each failure is a visible hold, once per
distinct reason, via the existing `effigy_observation_retained` /
`effigy_observation_refused` notes:

1. **Hook dead**, proven by pid plus contract 010 start identity (existing
   `hookDeath === "dead"`). Hook liveness unknown keeps the slot.
2. **Coverage complete** as above, for this reservation's epoch and its own
   Effigy run id, with no contradiction. Missing, partial or unacknowledged
   coverage never qualifies, and no count is invented.
3. **No terminal result.** `run status` for this run id and selector, read by the
   bound bytes in the own checkout, answers the producer's structured absence
   (`state: "not-found"` with `recording: "not-recorded"`, `unknown` in the
   existing classifier) or its text equivalent, **and** no `terminal` report was
   recorded. A recorded `terminal` report without a readable record holds with
   `terminal-record-absent` (and `cleanup-incomplete` when that is what it
   reported): the four-condition branch exists for the case where the producer's
   settle evidence never reached Nucleus, not for contradicting it. A structured or
   textual expiry, a live holder, a held task lock and an unreadable journal are
   not absence evidence and qualify for nothing here; with the hook gone they
   reach their own settlements ("A reservation settles when its recorded process
   is gone").
4. **The absence is real, not retention.** Foreground terminal records are kept
   seven days and a foreground run has no journal key to expire, so the
   structured `not-recorded` answer for a run launched inside that window is
   positive absence. A reservation whose `launchedAt` plus seven days is older
   than the check holds with `retention-window-exhausted`, because then a missing
   record can be retention.
5. **Every reported identity is no longer live.** For `custodians.owner`,
   `custodians.guard` and each recorded `workload.leader`, converted to Nucleus's
   canonical form as above, `processStartIdentityLiveness(pid, identity)` must
   be `dead` (pid gone, or a different live identity). `alive` holds with
   `identity-still-live`; `unknown` holds with `identity-liveness-unknown`. On
   Linux that comparison is boot-scoped, so a reboot proves every earlier
   identity dead without reading a single pid twice.
6. **Every reported group is positively empty.** For each recorded `workload`
   `pgid`, `processGroupEmpty(pgid)` must prove `kill(-pgid, 0)` → `ESRCH`. A
   succeeding probe holds with `group-not-empty`; `EPERM` or any unreadable
   answer holds with `group-liveness-unknown`. A group number reused by another
   group therefore holds, never releases.
7. **No foreign claim.** No other unsettled v2 reservation in the same checkout
   records the same `pgid` or the same leader identity; a duplicate holds with
   `group-claimed-elsewhere`, so two reservations can never both dispose of one
   group. An effect this reservation never reported — another reservation's
   group, or a process carrying no recorded identity — can neither be released
   by it nor counted for it; the worst case that leaves is exactly the
   escaped-process risk named on the record.

What it writes: the same private sidecar the `#412` and `#417` records use,
`hostRunAccountingDisposition:<runId>` bound to the row's epoch, plus one
`host_run` journal fact (`accounting_retirement`) in one transaction. It is a
distinct representation of its own — `queue.host-run.accounting-coverage-retirement`,
`basis: "no_terminal_coverage"` — so `#412`'s operator record, `#417`'s
producer-cleanup record and the foreground-terminal one above keep parsing byte
for byte and no reader can confuse them. It carries the policy
(`spec-035/no-terminal-coverage-release`, `d3bad004`, 2026-10-24, the chosen
option's own words), `producer: null`, the
exact coverage (admitted run id, seq 1 custodians, acknowledged-through, every
`{seq, pgid, leader}`), the producer's own `not-recorded` answer with
`terminalRecord: "absent"`, the checks (`checkedAt`, each identity with its
recorded and observed form and its `dead` proof, each group's `esrch` proof, the
retention window), `residualRisk: { escapedProcessPossible: true }`, and
`acceptance: null`. Its idempotency key derives from the run, its epoch and the
coverage's digests — never from the tick — so a repeated tick, a restart, a
reentrant pass and a lost reply cannot double-retire, and a stored retirement
this build cannot read keeps the charge and refuses instead of being replaced.
`host.run.accounting.status` answers `accounting: "retired"` with it, the
scheduler subtracts it from totals and nothing else, and the workspace release
above reads it through the same union.

What it never writes: no `host.run.result`, no `host.run.settlement`, no
`escapedDescendants` or `containers` inventory, no
`escapedDescendantsProvenDeadAt`, no `capacity_release`, no
`cleanup: "complete"`, no terminal outcome, no workspace or consumer permission,
no physical-headroom claim. The admission
hook's own pid is never offered as a workload `pgid`, and the recorded groups
are the producer's report, not a Nucleus custody claim. The only process call in
the whole branch is the null-signal `killpg(…, 0)` probe: Nucleus sends no signal,
reclaims nothing and gains no reaper authority, and the accepted risk is named
as exactly what it is — an escaped process may still be running.

### What never changes

- **Pinned contract 010.** `hostRunRecordSchema`, the stored row, `host.run.list`,
  `host.run.capacity.release` and both method digests stay the strict pinned
  shapes. Protocol, events, coverage, `checkout_id`/`boot` evidence and every
  automatic basis live in Nucleus-internal journal facts and the private sidecar.
  `host.run.accounting.status` is a Nucleus-owned RPC: it grows the retirement
  union and nothing in the pinned record.
- **`#417`'s stored record.** Its `queue.host-run.accounting-retirement` format,
  `evidenceSource: "checkout-journal"` and `producer` block keep their exact
  schema. The foreground terminal basis is a separate format, so no stored
  producer-cleanup retirement becomes unreadable and no reader has to
  reinterpret a field.
- **The v1 route.** A v1 reservation keeps its `checkout-journal` closure path,
  its holds and its exact observation behaviour. No v1 reservation is observed as
  v2, offers coverage, or qualifies for the no-terminal branch, and no historical
  row, attempt, disposition or outcome is rewritten.
- **The durable `--run-id` route.** It remains the supported durable consumer
  route, settled by the producer's own cleanup closure; v2 never claims it, and
  a v2 launcher that uses `--run-id` is refused by the producer before the hook
  with the variable named.
- **Exact-run disposal.** `#412`'s operator accounting disposition and `#411`'s
  reserve-before-bind are unchanged and remain the relief for anything the v2
  branches hold, including a v2 run whose coverage is incomplete.
- **Every gate outside admission.** Review, merge, closeout, callback identity
  and provider independence are untouched; normal source integration is not
  protocol activation and does not mean the foreground gap is fully fixed.

### Rollout, downgrade and compatibility

Order, each step separately authorised where it is an operator act:

1. A v2-capable Nucleus hook and endpoint ship (the implementation scope below).
   Nothing changes for v1 reservations, and Nucleus injects no opt-in.
2. The Effigy owner supplies the authentic qualified `325` packet — full commit,
   absolute immutable artifact path, SHA-256, installation qualification receipt
   and owner-selected targeted qualification naming v2 opt-in, the durable
   refusal, report acknowledgement/timeout, and the terminal record read.
3. Nucleus's exact-byte interop against those bytes: a real Effigy process, the
   real hook, the real default endpoint.
4. Independent exact-head review, expected-head merge and healthy delivery.
5. No runtime declaration is needed: the workload's own Effigy binds (Spec 035
   "Runtime identity", 2026-10-26). No install, no
   implicit global opt-in, no credential copying, no retroactive environment
   modification of already-dispatched launches.
6. Explicit consumer activation: the per-invocation opt-in, or the injection
   decision recorded in the open question in
   [questions.md](../questions.md).

Downgrade is unsetting the opt-in (and, if a launch kind ever carried it, that
injection): new invocations are v1 again. Recorded `effigy_admission_event`
facts, both automatic retirement formats and the terminal-record evidence stay
readable and are never rewritten; an older Nucleus ignores the new facts and the
sidecar key, so it charges a retired reservation again exactly as `#417`
described, and rolling back loses only the retirement — never a terminal result,
custody or settlement. v1 and v2 reservations coexist in the store, in the
journal and on the capacity totals, each decided on its own recorded protocol.
There is no semantic downgrade: an ambiguous launch is never retried, resubmitted
or reinterpreted as the other protocol.

### The qualification packet this still needs

Nucleus cannot write meaningful v2 interop until the owner's callback supplies, for
one exact artifact:

- the full commit and the absolute immutable artifact path with its SHA-256;
- the existing installation qualification receipt (gate clear, roots load, zero
  task-resolution and hosts diffs);
- owner-selected targeted qualification naming its own selectors for: v2 opt-in
  and the unsupported-value refusal; a durable `--run-id` heavy run refused
  before the hook with the variable named; report delivery and the 10 s ack
  timeout, including the "no `go` without an ack" barrier and the sequence
  ending after an undelivered report; and `run status` returning
  `foreground-terminal-record.v1` with `checkout_id` and `boot` (plus `run stop`
  refusing and `run logs` reporting no retained log for it).

Effigy's owner chooses those selectors; Nucleus does not infer or invent them, and
it does not poll, query or build the producer while waiting. The owning callback
is Effigy planner/owner `a683cd79-0ab5-4576-9e15-2952a754a795` (messages
`32546d99` and `b1366450`).

### Implementation scope (one PR) and test seams

The smallest change that delivers all of the above, with no new setting, no new
table, no migration and no pinned-shape change:

- `core/qa/effigy-admission.ts` — the v2 request schema and
  `parseEffigyAdmissionRequest` returning `protocol`, the `effigy.admission-event.v1`
  strict validator, `ack` formatting, the protocol env name and the hook's 8 s
  report bound.
- `core/qa/effigy-admission-hook.ts` — v2 mode: acknowledge only after a stored
  event, bounded retry inside the producer's window, stdin line framing with an
  oversize bound, refusal on schema mismatch, partial line never acked, keep
  holding for TERM.
- `service/callbacks/effigy-admission-endpoint.ts` — the `event` method and its strict
  binding rules, protocol recorded at reserve, coverage derivation, the
  terminal-record gates, the no-terminal evaluation and its hold causes; the
  watch stops for either automatic retirement format.
- `core/host-runs/host-run-accounting.ts` — the foreground-terminal and coverage
  retirement records with their producer and policy blocks, the widened
  retirement union, the coverage-evidence read. `#412`'s and `#417`'s records
  are not edited.
- `core/host-runs/host-run-scheduler.ts` — `retireAccountingOnForegroundTerminal` and
  `retireAccountingOnNoTerminalCoverage`, the protocol sibling in the
  reservation's internal identity, and the coverage read the endpoint uses.
- `core/qa/effigy-run-control.ts` — `foreground-terminal-record.v1`
  classification, `checkout_id`/`boot` on `EffigyProducerClosure`, and the
  verdict-independent cleanup reading.
- `shared/contracts.ts` — the private event, terminal-retirement and
  coverage-retirement schemas and the widened `hostRunAccountingRetirementSchema`
  union that the workspace release already reads. `hostRunRecordSchema` and
  `#417`'s record schema are not touched.
- `core/machine/process-group.ts` / `core/machine/start-identity.ts` — reuse only, plus one
  exported converter from a producer `ProcessIdentity` to Nucleus's canonical
  start identity.

Required tests, all isolated (in-memory or disposable stores, private `HOME`,
never the live database, settings, sockets or a real candidate build):

- a real hook process driven by a fake producer on stdin: v1 byte-identical
  (no ack, exactly `admit`), v2 acks only after the fact exists, a failed
  durable write leaves the report unacked, a lost reply is re-sent and
  acknowledged from the stored receipt, out-of-order/duplicate/unknown/oversize
  reports, a second `custodians`, `workload` before `custodians`, a partial last
  line, a wrong `run_id`, a terminal count mismatch, the 8 s bound, TERM during
  a report, and a nested admission denied in v2 mode;
- the endpoint's `event` route: protocol recorded at reserve and v1 unchanged,
  unknown reservation, pre-bind, settled, stale epoch, wrong run id, duplicate
  seq with the same and a different body, concurrent calls, a service restart
  with a reattached watch;
- the no-terminal branch: coverage with zero and with two groups, a live third
  identity, a non-empty group, an unreadable identity, an unreadable group, a
  group claimed by another reservation, an artificial record present, a recorded
  terminal report without a record, an exhausted retention window, hook liveness
  unknown, a failed retirement write (charge kept, cause recorded), a repeated
  tick, a restart and a lost reply (one retirement);
- the terminal-record closure: `passed`/`failed`/`cancelled`/`timed-out`,
  `cleanup` absent/incomplete/unknown, `verdict-unknown` states, run-id and
  selector mismatch, `boot` mismatch, `checkout_id` instability, a
  `checkout-journal` answer for a v2 reservation, and runtime drift between the
  before and after digest;
- the preservation proofs: the frozen strict contract 010 decoder and both
  method digests, the strict `checkout-journal` classifier, no
  `host.run.result`/`host.run.settlement`/container/escaped-descendant/
  `capacity_release` write, `host.run.accounting.status` telling the four
  retirement formats apart, and a stored `#417` retirement still parsing
  unchanged;
- the parent falsifications: today's hook refuses a v2 request outright, and
  today's "missing coverage is empty" reading would release a slot;
- exact-byte interop with the qualified candidate — **blocked on the packet
  above**, not faked with a substitute.

Files: `test/effigy-admission-v2.test.ts`,
`test/effigy-admission-v2-endpoint.test.ts`,
`test/effigy-v2-custody-release.test.ts`, with the extension cases in the
existing `test/effigy-accounting-retirement.test.ts`,
`test/effigy-run-control.test.ts` and `test/effigy-admission-reserve.test.ts`
harnesses (a real hook process and a `RuntimeOwner` serving its own admission
socket).

### Supported route

Superseded on 2026-10-26 (see "Runtime identity"): no artifact is declared.
Any Effigy a worker invokes binds, found from the attested process chain and
held only to the optional `minVersion`. A workload whose chain holds no
executable that answers as Effigy is refused admission before any capacity is
reserved, with the binding reason naming what each ancestor ran.

### Compatibility

- `hostRunRecordSchema` — the record, its stored row, `host.run.list` and
  `host.run.capacity.release` — keeps Nucleus's pinned strict contract 010
  shape, and both affected method digests equal the pinned definitions again.
  Nothing is removed or reinterpreted from that record.
- Nucleus's own admission identity (the `admission` submission source, the Effigy
  run id, the verified runtime and its refusal) is not part of it. It is
  durable in the store's internal meta under `hostRunIdentity:<runId>` with the
  row's epoch, written in the same transaction as the row and pruned with the
  settled run's journal. An admission reservation is written without
  `submissionSource` rather than claiming to be Nucleus's own submission; the
  pinned field is optional, and the old record has no other honest value. A
  missing, stale (another epoch), unreadable or failed identity write leaves no
  identity: that reservation is never observed, keeps its capacity and invents
  no settlement, and a failed identity write rolls the row back with it.
- The pinned `host.run.submit` journal input is exactly the caller's request: the
  internal source and Effigy run id travel beside it in the journal, never
  inside it, so the recorded request shape is unchanged. A reservation's
  `effigy_runtime_bind`/`effigy_runtime_unbound` facts stay Nucleus's own journal
  evidence, outside the pinned record and stream shapes.
- Rows written by the builds that carried the identity in the record still
  parse and are read with their identity, so an upgrade keeps a live reservation
  observable; their next ordinary write projects them onto the pinned row. An
  older Nucleus reading one of those rows before that write cannot parse it, and
  no historical rewrite, migration or raw database edit is attempted. Rolling
  back to such a build also loses the internal identity for rows this build
  wrote (the row is readable, unmarked) and leaves the meta keys an older Nucleus
  never prunes; that loses only the observation binding, never a capacity,
  settlement or source fact.
- The Nucleus-owned admission socket's `reserve` params are unchanged: the
  optional `ancestry` beside the producer's request (v1 by default, v2 only
  under the reviewed protocol above) stays as 406 added it, and the response
  shape is the same. The socket gains one private method, `event`, for that
  protocol's reports; it is not contract 010, not a catalogue RPC and absent
  from every pinned digest. The compatibility impact is in the
  verdict, not the shape: the legacy bare-params path (the producer's request
  sent as the params object, no `ancestry`) can never be observed, so it now
  refuses with `admission refused: the admission hook attested no ancestor
  process` and writes no reservation. An old hook, and any caller that sends the
  bare shape, is denied before its workload instead of holding an unobservable
  slot. A current hook sends `ancestry` and is unaffected.
- A reserve now digests the admitted workload's image and the declared artifact,
  so the hook bounds that one call by `ADMISSION_RESERVE_TIMEOUT_MS` (30 s)
  instead of the 2 s connect window. A timeout is still a first-contact deny, a
  decision never starts the workload, and a bindable admission reserves exactly
  as before once the bytes verify. `queue.sqlite` needs no migration.
- The hook and the service roll together with the plugin; a hook from an older
  build cannot bind, which now refuses the admission rather than reserving an
  unobservable slot.

### What the corrected qualification shows, and what it does not

The owner packet's artifact and receipt hashes were verified again before use,
and the isolated qualification ran the real candidate through the real default
endpoint (a `RuntimeOwner` with `hostRunEndpoint: true`) in a private HOME with
disposable fixtures, with a lying `effigy` ahead of it in `PATH` that answers
any `run status` with an unearned success. The declared-substitute scenario was
refused a reservation and ran nothing; the declared-candidate scenario bound
`efc1478`'s exact bytes, observed the run with them and settled the run's real
failure. The same isolation covers admit, deny, held capacity, nesting, cancel
and crash settlement, and lost follow. This corrects the earlier live-default
coverage limit and does not erase #381's producer/installation evidence; it is
still not a live install, native, consumer or operator-cutover proof, and no
claim about the installed machine follows from fixture isolation.

## Problem

Admission lives in Effigy and the processes live in Nucleus, so neither can prove
or clean up the other's state. On 2026-09-30 this failed twice:

- **Run 32538ba3 (consumer-b).** Nucleus SIGKILLed the timed-out run's direct
  child. Effigy's lease stayed `stale_owner_unknown` with 9 CPU and 64 GiB
  reserved until an operator-approved recovery (Effigy decision `2b915292`).
- **Run a645572d (Effigy).** The 30-minute run timeout counted 27.5 minutes of
  capacity wait, so it fired 2.5 minutes after admission. It SIGKILLed the
  owner, and the `nextest` group (pgid 62279) kept running under init. Inside
  that group, Effigy's own tests ran `effigy qa` with the parent's
  `EFFIGY_CALLER` and queued behind their own parent's lease.

There is also no way to cancel a milestone run: stopping consumer-b's d8b9b168
the same day took signals by hand, and Nucleus recorded the cancel as `failed`.

## Nucleus's side (step a)

- **Scheduler.** The Nucleus service is the contract 010 scheduler.
  - **Authority.** It holds the host authority record at epoch 1 and refuses
    calls that name a stale epoch.
  - **Journal.** Its journal lives in the Nucleus store: submissions, decisions,
    launches and settlements, each a durable record written before its side
    effect. A settled run's journal rows are deleted 4 days after it settled
    (Tom, 2026-10-16: 14 days; 2026-10-20: 4 days, to cut store size and backup writes); its record, its fact rows (`nested`, `override`,
    `container_report`, which reconciliation dedupes by fact id) and every
    unsettled run's journal stay.
  - **Admission.** It admits against a measured host budget with interactive
    headroom, in the order milestone > validation > interactive, with aging
    and per-repository fairness.
  - **Budgets.** A run's budget is the p95 of its (repository, selector)
    history from Spec 031 telemetry, CPU and wall. The submitted budget
    applies only until a measurement exists. No single run reserves more than
    half of host memory capacity (task 191): a legacy peakRss sample at or
    above host capacity — such as the 64 GiB sample that pinned all heavy
    capacity in milestone QA 73c12ae3, almost certainly a sampler summing
    shared or virtual memory — is discarded as an artifact; the surviving
    observed peak budgets with a 1.2 margin; and the no-history fallback,
    which defaults to the whole host capacity, clamps to the same share. New
    runs omit peakRss entirely (the CPU sampler never measured RSS), so
    CPU-only history also lands on the share cap instead of the whole
    machine. One settled run with an escapee can never reserve the whole
    machine again.
    Runs submitted through the endpoint are measured too (Tom, 2026-10-21,
    "Approve both"): the detached supervisor samples its command tree's CPU
    with the same process-tree sampler as milestone QA and records `cpuMs` in
    the run result, so their budgets come from history. Before, every
    endpoint run recorded no CPU, kept the no-history fallback of the whole
    heavy CPU capacity, and heavy runs serialized one at a time (Project-c's
    bounded proofs missed their windows behind a 9-of-9-CPU validation run).
    A run with no history reserves at most half the heavy CPU capacity
    (never below one CPU), whether its fallback is Nucleus's default or the
    `budgetFallback` a client declares; Effigy declares the whole box. A
    smaller declared envelope is used as given. A
    measured history above the heavy CPU capacity is budgeted at that
    capacity, so a run that averages more cores than the cap can still be
    admitted.
    Sampled CPU is a lower bound or explicitly unknown, never a false 0. Tom
    was asked what Nucleus should do after milestone QA 9d7a5cd6 recorded
    `cpuMs = 0` for a 0.7 s busy-loop host run, and answered "Honest +
    cheaper (Recommended)" (2026-10-23): "Report 'unknown', never a false 0,
    when a run wasn't seen working, and make each sample much cheaper (only
    check the run's own processes), so short runs get measured under load.
    The test's promise becomes 'measured CPU, or explicitly unknown'. One
    reviewed PR, then a milestone QA." What caused that 0 is a hypothesis
    from the source; the sample timeline was not observed (papercut
    1bd74de8).
    - **Accounting.** Each process, by PID and start identity, counts once,
      at the highest valid cumulative CPU any read showed; `cpuMs` is the
      sum. A failed read, a malformed line or a decreasing value adds
      nothing and never lowers the sum.
    - **Reason (Nucleus-internal).** Nucleus records why a CPU value is what
      it is as `cpuCoverage`: `sampled` with a positive `cpuMs`;
      `unobserved` (a read saw the tree but no CPU) or `unavailable` (no
      read saw it, or the platform cannot sample) with `cpuMs: null`.
      Each supervisor writes it, with the run id, epoch, QA step and
      `cpuMs`, to a private sidecar (`cpu-coverage.json`) beside its run's
      records, mode 0600 and atomic, before its result. The sidecar goes
      with those records: the host-run run directory, the
      project-validation run directory, or milestone QA's supervision
      files. Settlement binds it only when run, epoch, step and `cpuMs`
      all match, then stores it in the store's internal meta under
      `hostRunCpuCoverage:<runId>`, after the settlement commits. The meta
      key is pruned with the settled run's journal, and is read only
      through the scheduler's internal `cpuCoverage(runId)`, which
      re-checks the row's epoch and `cpuMs`. A missing, stale, unreadable
      or inconsistent reason, or a failed sidecar or meta write, leaves it
      absent: legacy or unknown provenance, never a measurement, never 0,
      never a delayed or failed settlement. Nothing is synthesized, not
      even `sampled` from a legacy positive.
    - **Rollback-safe.** Every wire shape (`host.run.result`, the
      settlement envelope, `host.run.list`, `host.run.capacity.release`,
      `status`, `attach`, project QA's `hostSettlement`), every private record
      (the host-run supervisor
      state, the project-validation result envelope, milestone QA's
      supervision state) and every table row (`host_run_records`,
      `host_run_journal`) keeps main's strict shape. An older Nucleus never
      opens the sidecar, and no meta scan in it matches the key, so
      rolling back loses only the reason. A null `cpuMs` on the wire is
      honest without it. Coverage says nothing about identity, exit,
      capacity or containment. Budgets already ignore a non-positive CPU,
      so an unknown run's selector budgets CPU from the fallback while its
      wall time still counts.
    - **macOS cost.** Once the run's group and its leader's start identity
      are known at spawn, each sample is one group-scoped listing
      (`ps -ww -g <pgid>`, with `COMMAND_MODE=unix2003` set on that `ps`
      only, because legacy mode ignores `-g`). A host-wide
      environment-marker scan runs at start and then about once a second by
      elapsed time, and the escapees it finds are re-read by PID. Before,
      every sample was a host-wide environment listing plus a PID CPU query.
      Milestone QA follows each step's group in turn.
    - **Ownership.** A group line counts only when its pgid matches and the
      recorded leader (pid = pgid, matching start identity) is in the same
      read, or a marker scan has confirmed that exact identity. A line
      started before the leader never counts, so a reused group number adds
      nothing. The sampler never feeds escaped-descendant custody. Without a
      provable leader identity, and on Linux (`/proc`), sampling keeps the
      full listing under the same accounting.
    - **Cadence (2026-10-25 performance audit, item A5).** The expensive read
      repeats at most every five seconds: the whole host listing on Linux, and
      on Darwin one host-wide `ps` listing *without* environments plus the
      marker environment read for the run's own candidates only — its group
      members, the identities already proven, and their descendants, which is
      how a `setsid` descendant is still found while its parent lives. The
      run's own group is re-read at most once a second on ticks, and a caller
      asking for the current value (`read`, `stop`) re-reads that group
      immediately while the host-wide read keeps its window. Cumulative maxima
      make the fewer reads cost nothing in truth: a missed sighting only lowers
      the bound, it never invents or raises CPU, and nothing about the
      sampler's timeouts, termination grace, signal or teardown path changes.
- **Submitters in step (a).** Milestone QA (`project.qa.run`, class
  `milestone`) and project validation (Spec 022, class `validation`). Workers'
  and planners' own `effigy` calls stay on Effigy admission until step (b).
  The QA admission fence (Spec 022) refuses new milestone QA before it reaches
  this scheduler; it never holds or reorders queued host runs and does not
  cover validation or client submissions.
- **Two deadlines.**
  - **Capacity deadline.** It bounds the wait for admission. When it lapses,
    the run settles `capacity_timeout`, a hold, never a failure.
  - **Run timeout.** It starts at launch, not at submission. The repository
    `qa` setting's `timeoutMs` is the run timeout. Nucleus's default grows to
    the selector's measured p95 × 1.5 when that is longer than the setting.
- **Supervisor.** `project-qa-pipeline.ts` with `project-qa-teardown.ts` and
  `project-qa-detached-io.ts` is the conforming contract 010 supervisor for
  milestone QA. Project validation uses a detached wrapper over
  the same process-group executor, with an additional durable project verdict
  that Nucleus can reconcile after a service roll.
  - **Launch.** It runs each step's command in a new process group and records
    the pgid and start identity. The `launched` fact names the command even when
    the run settles before step progress is mirrored. #115's termination path
    lives here.
  - **Stop.** Timeout and cancel send SIGTERM to the group, wait a grace period
    (default 30 s), then SIGKILL. Escaped descendants it can see are recorded
    as facts. The host-run supervisor inventories those descendants while the
    command still runs (a `setsid` child is visible through ppid only until the
    leader exits); an unreadable identity listing is not proof of absence, and
    the supervisor does not write a result while identity stays unreadable.
    After the QA step and teardown, milestone QA additionally reaps
    its own escapees rooted in its Nucleus-owned QA worktree (task 191): an
    escaped descendant whose cwd or argv is inside the checkout or run root is
    terminated by exact pid plus recorded start identity — SIGTERM, grace,
    re-proven identity, then SIGKILL — and the reap is recorded on the run.
    The scheduler then proves each reaped pid dead and releases capacity.
    Escapees outside the QA worktree, unreadable ones and SIGKILL survivors
    keep today's hold. The cwd reads in one OS pass (a single lsof on
    macOS); a relative script argv naming a file inside the checkout still
    proves rooting when the cwd is unreadable, while a known-outside cwd
    disproves it outright.
  - **Result record.** The host supervisor writes `host.run.result` v1 beside
    the run with mode 0600, a same-directory temporary file, fsync and rename.
    Project validation also writes a private mode 0600 result envelope before
    Nucleus reconciles the task verdict. Reads use `O_NOFOLLOW`; CPU that was not
    sampled stays null.
  - **Containers.** An empty process group proves only that host processes
    are gone. Container removal is recorded per container in the
    `host.run.settlement` envelope, and a run's capacity stays reserved until
    each container is reported removed or an operator releases it.
  - **Pipes.** A step settles when its group is proven dead, not when the
    child's stdout closes. An orphan holding the pipe cannot keep it open.
  - **Settlement.** Each run carries a `host.run.settlement` v1 envelope with
    its outcome, launch status, result and container facts. A durable result
    settles the QA outcome even when a known escaped descendant is still live,
    but its host capacity stays reserved until each recorded PID and start
    identity is proven dead. Unknown liveness keeps the reservation. An operator
    may release it with a recorded reason.
- **Workspace custody.** A host run holds the checkout it was submitted from
  until it settles and its capacity is released, except a row whose stored
  accounting retirement is readable and names that run and epoch (see
  "Workspace release on retired accounting" above). Nucleus's run-bound
  build-output cleanup and terminal workspace archive both wait on it, naming
  the run, so a detached run whose client left never loses its build output or
  worktree (Project-e 096, 2026-10-20).
- **Restart.** After a service roll, each unsettled run is re-attached by pgid
  and start identity. A run whose group is gone settles from its result record.
  A milestone whose host launch is durable but whose detached supervisor has
  not published its initial state resumes from the same plan and run ID. The
  supervisor writes that state before checkout preparation or any QA command,
  so missing state, absent identity-bearing processes and no recorded QA-step
  progress prove no QA side effect began. Once initial state exists, a
  proven-dead supervisor without a result settles lost and is never replayed.
  The exit proof and the result read are two observations of the same producer,
  and a publication can land between them: the supervisor writes its result
  before it exits, so Nucleus re-reads the result once after proving the exit —
  supervisor identity dead, recorded command group empty, no identity-bearing
  process left — and classifies the run from that durable result under the same
  run, epoch and token checks. Only a second proven absence settles lost, so a
  result published across the interval keeps its real pass or failure instead of
  becoming a lost run, and the re-read never outruns custody: a live or unknown
  supervisor, a live command group or a live identity-bearing process still
  holds. An unreadable or malformed result stays indistinguishable from an
  absent one, so it settles lost and needs explicit resubmission; it is never a
  pass and never a settlement invented from bytes Nucleus could not read.
  A lost validation is held for explicit resubmission; it cannot replay because
  of a build or settings change. `lost` and `timed_out` are never retried
  automatically; a resubmit is a new run ID.
  - **Heartbeat recovery.** Project QA and project-validation
    supervisors write a heartbeat every two seconds. A valid state whose
    heartbeat is more than 180 seconds old, while its supervisor identity is
    still live, is only treated as hung after the same heartbeat remains
    unchanged across two checks at least five seconds apart. Nucleus records the
    observed stale age and this confirmation signal, then sends SIGTERM and
    SIGKILL to the recorded active command group and supervisor group, after
    checking the run token or recorded process start identity. It then uses the
    ordinary lost-run path, which still proves the supervisor and child tree
    dead before settling. A fresh or advancing heartbeat keeps a long run
    attached; an unreadable identity remains unknown. A stale validation settles
    lost even when its result envelope exists, and requires explicit
    resubmission.
- **Run token.** Every launched run gets `HOST_RUN_ID` and `HOST_RUN_TOKEN` as 010
  defines them. This includes client-submitted runs and Nucleus's milestone QA and
  project-validation launches. Nucleus-internal launches use the endpoint's same
  `signRunToken` implementation and current `token.key`; claims bind the host
  run ID, authority epoch, run class, realpath of the owned checkout, and the
  launch time plus the run timeout and token grace. The credential is kept only
  in the run's ephemeral launch env file (see **Env retention**) until the supervisor
  has started the command. Captured
  output redacts any echo before tails or full logs are persisted; scheduler and
  event records carry issuance context only (run ID and epoch).
  Nucleus-launched runs are admitted by Nucleus's scheduler and carry the contract
  token. Once Effigy honours the token, a nested `effigy` uses that same run
  instead of submitting a second host run.
- **Env retention.** Nucleus never retains submitted env values; clients may still
  list any env, and no key is refused. Values exist only in one mode-0600
  `launch-env/<run>.json` file per unlaunched run, outside `runs/<id>`, written
  through the verified-traversal rule. The launch rewrites it with the full
  launch environment (listed env, `PATH`, `HOME`, `HOST_RUN_ID`,
  `HOST_RUN_TOKEN`); the supervisor reads it, starts the command, then deletes it.
  Settlement, cancel, expiry and capacity-deadline failure also delete it.
  A queued run survives a service roll through this file. A run whose file is
  missing at launch settles `cancelled`, unlaunched, with a `launch_failure`
  reason in the journal (an unlaunched run cannot settle `failed`); Nucleus never
  launches with a guessed env. Every durable record stores env key names only
  (`envKeys`): `submission.json`, `supervisor.plan.json`, the `host_run_journal`
  `request` and `submission` rows, `host_run_records`, facts and backups. Idempotent resubmission compares key names only
  (no digest): a retry that changes only a value is the same submission, and a
  retry of an unlaunched run whose file is gone re-supplies the values. Every
  persisted write of request or submission data also redacts values of
  secret-shaped keys (TOKEN, PASSWORD, PASSWD, SECRET, KEY, CREDENTIAL, AUTH,
  COOKIE, SESSION, PRIVATE, case-insensitive) to `[redacted]`, so a forgotten
  path cannot leak. The completed legacy row and run-file rewrites are retired
  (Tom, 2026-11-09); startup reattaches current records without scanning old env values.
  Backups are not touched; replacing them is an operational purge. Contract 010 says the run gets
  "only the listed env"; this changes no protocol policy, and any wording change
  goes to Nucleus.
- **Cancel.**
  - **Milestone QA.** A new `project.qa.cancel { id, reason }` RPC, CLI and UI
    button requests idempotent cancellation through the stop path, runs teardown
    and settles the run `cancelled`. A cancelled run is distinct from `failed`.
  - **Project validation.** It cancels with its task: the task's cancel and
    hold controls stop a live validation the same way.
  - **Client left before launch** (papercut 19676b0f; Tom, 2026-10-21,
    "Approve"). A run submitted through the endpoint without
    `cancelOnDisconnect` that has not launched (queued, or admitted with no
    launch or pid) and loses its last attachment keeps its place for 60 s. If no
    client reattaches, it settles `cancelled`, unlaunched, with the cancel reason
    `client_left_before_launch`, and its capacity is released. The deadline is
    durable (`disconnect.json`, `mode: "unlaunched"`), persisted across a roll
    and re-armed on startup; a reattach clears it, and a run that launches
    meanwhile is never stopped by it. A launched run whose client leaves keeps
    going detached, and Nucleus's own milestone QA and project validation runs,
    which are not endpoint submissions, are untouched. This is an interim
    default for Effigy v0.14.1, whose client can leave a queued wait without
    withdrawing; v0.15's attach by run id and settled outcome read are the
    structural fix. It changes contract 010's default for never-launched runs,
    and Nucleus was told.
- **Endpoint (for step b).** Nucleus serves 010's "Client protocol v1" exactly:
  authority file and socket, `submit`, `attach`, `cancel`, `status` and
  `report`, idempotency, error codes, disconnect window and run token. This
  spec restates none of it. `host-run-endpoint.ts` is the server: it owns
  the configured host-run state root (authority file, `token.key`, the socket
  and each run's output, submission and result), the HMAC run token, the
  allowlisted launch environment and the durable `report` fact log, and it lets
  the front worker own the public listener as described under "Endpoint across a
  roll" below. For the
  live Nucleus data directory (`~/.nucleus`, compared by realpath),
  that root defaults to `~/.local/state/host-run/`; other data directories use
  `<dataDir>/host-run/`. An explicit `hostRunStateDir` option keeps precedence.
  Contract 010 defines no environment override for this path. A non-live data
  directory refuses the live state root unless a test-only opt-in names that
  exact path.
  A submitted run is executed by the detached `queue-host-run-supervisor`
  process, which writes the durable `host.run.result` record and survives a
  Nucleus service roll; on startup the endpoint reattaches every unsettled run to
  that record and settles a result-less run `lost` only once its process group
  is proven dead. The
  standalone service enables the endpoint; service fixtures use an isolated
  state root and never touch the live authority files. Effigy's client is step
  (b) and stays out of this repository.
  Node has no `openat`, so the endpoint uses contract 010's verified-traversal
  rule for the owned subtree: `realpath` the root, `lstat` the full chain with
  the strict checks recording each `(dev, ino)`, open only the target with
  `O_NOFOLLOW` and require its recorded identity, then re-`lstat` the root and
  every ancestor and refuse on any difference. The socket and the result,
  output, plan, state, cancel and disconnect writes use the same rule. Startup
  creates and verifies the owned directories through that rule before any
  `chmod`, `unlink` or `bind`, so a symlinked or swapped component refuses
  instead of redirecting a mode change or losing another directory's socket.
  Startup refuses when the socket path already answers connections, and an
  endpoint unlinks only the socket inode it bound. The maintenance pass rebinds
  a socket whose path has gone, unless another live holder answers there
  (2026-10-02: a service test with the real `HOME` unlinked the live socket).
  **The process serving `queue-service.sock` always serves the endpoint, or
  reports itself unhealthy.** A roll handoff that resumes or keeps a process
  (rollback, an aborted roll, a reload during a roll) can leave that process
  serving Nucleus sockets without the host-run socket, and an endpoint that never
  bound cannot help itself: its maintenance binds the contract-010 socket when
  it has none — and republishes `authority.json` — once `authority.json` names a
  dead holder (the pid is gone, or a live pid's start identity no longer
  matches) and nothing answers the path. A live holder is never taken over and a
  path something answers is never stolen; the endpoint records why and the
  runtime's health reports `hostRunEndpoint` instead, and the bind is retried
  until it succeeds. A failure or a foreign holder therefore heals without a
  restart (2026-10-04: a roll that lost the endpoint left every heavy run failing
  closed machine-wide until an operator SIGTERM'd the serving pid).
  Output past the one-hour retention is removed through the same rule, after a
  durable marker records its byte counts so `attach` still reports
  `output_expired` with the correct `availableFrom`. `report` dedups `factId`
  across every fact kind, containers included, so a reused id with a different
  body or kind is `conflict`, even across a crash gap between the journal write
  and the fact log.
  Host-run start identities use contract 010's canonical encoding (its "Start
  identity" subsection): `<pid>@YYYY-MM-DDTHH:MM:SSZ` on macOS from
  `ps -o lstart= -p <pid>` run with `LC_ALL=C` and `TZ=UTC`, and
  `<pid>@<boot_id>:<starttime>` on Linux from `/proc`, with no `ps` fallback.
  The authority file, supervisor state and result records and the scheduler all
  produce and compare that form; `<pid>@unknown` never proves identity, even
  against itself, and a recorded whole-second `...SS.000Z` equals `...SSZ`
  while any other fraction refuses. The macOS read spawns `ps` with a
  five-second liveness timeout and answers `unavailable`, never absence, so a
  host that delays fork/exec past that bound answers `unavailable` —
  production's correct timeout answer, not a defect (2026-10-20, milestone
  5f82e054 at ccea47c2: the positive-identity test failed exactly that way
  after 5007 ms). The canonical parse is therefore proven through the reader's
  read seam with production defaults unchanged, while the real spawned-`ps`
  boundary keeps dedicated proofs: every unobservable shape, the timeout kill
  on a real child, and the live process's own sync read.
  For Effigy's client acceptance,
  `bin/host-run-private-server.mjs --state-dir <abs>` runs an isolated endpoint
  over a throwaway store in `<state-dir>/queue.db`, prints its authority record
  as one JSON line and stops on SIGTERM or SIGINT; it refuses the live host-run
  state directory or anything under the live Nucleus data directory.
  **Restart entrypoint.** `bin/host-run-private-server.mjs --supervise
  --state-dir <abs>` runs the server as a child of a thin supervisor and
  replaces it the way a service roll does. `kill -USR2 <supervisor pid>` starts a
  warm standby child (modules loaded, staged host-run socket bound and swapped,
  store prewarmed read-only), waits for that swap's ready marker, then drains the
  old child. The standby opens the same state directory and `queue.db` writable
  only after the old pid has exited, adopts the already-live socket and prints
  the new authority line. The supervisor relays every authority line, the first
  and one per restart, on its stdout; epoch and token keys do not change.
  SIGTERM or SIGINT stops the child and exits. Effigy uses it to accept its
  follower reattach against a real restart (`test/host-run-private-restart.test.ts`).
  Private fixtures settle the exact admitted run (run, epoch, pid and start
  identity) while the endpoint answers before they stop the supervisor and
  remove state; an unknown or timed-out settlement fails the fixture instead
  of deleting state as success (`test/support/host-run-private-fixture.ts`,
  proven by `test/host-run-private-disposal.test.ts`).
- **Endpoint across a roll.** Make-before-break: the incoming process binds
  `run/scheduler.sock.staged`, proves it answers, and `rename`s that inode over
  the live contract path *before* the outgoing process stops accepting. Every
  bind (startup and handoff) uses that staged name then rename, so libuv's
  close-unlink targets the staged path and cannot delete the live inode after
  a swap. A pre-change outgoing process that bound the live path directly still
  unlinks that name on close; the incoming process reasserts a replacement
  staged inode onto the live path as soon as the old pid has exited, before
  the writable store opens, and again when it adopts the server. The socket
  path and `authority.json` stay as contract 010 specifies.
  Existing attach followers remain on the outgoing inode until that process
  drains, then reconnect to the live path without `ECONNREFUSED`/`ENOENT`. Clients
  accepted by the incoming listener are paused until that runtime's private socket
  answers, then piped to it. The client-visible gap is the probe window around
  that swap; the roll test asserts it stays under 500 ms.
  **Accepts off the runtime loop.** The public listener is owned by a front worker
  thread (`service/executor/host-run-front-worker.ts`, handle `service/executor/host-run-front.ts`),
  never by the thread that runs the store, the engine and contract-010 request
  validation. The front binds `run/scheduler.sock.staged`, renames it onto the live
  path, and pipes each accepted client's bytes to this runtime's private socket,
  `run/inner-<pid>-<token>.sock` (0600 inside the 0700 run directory, never
  published in `authority.json`). A client is paused from the accept, so nothing it
  wrote is lost; the private connection is retried while the runtime is still
  starting or stalled, and ordinary socket backpressure then carries its bytes.
  A synchronous stall on the runtime thread — a large
  `validateWSOutboundMessage`, a database transaction — therefore costs latency,
  not acceptance: with the listener on the runtime thread the kernel accept queue
  filled and clients were refused for the length of the stall, during rolls and
  outside them (2026-10-20 milestone QA: in-window `ECONNREFUSED` spells of
  146 ms and 109 ms; the Supervisor's reproduction measured 495-884 ms inside one
  validation call). The security model does not change with the split: the front
  is the same uid, the public socket stays owner-only, the private socket is
  owner-only in the same owned subtree, and the runtime still authenticates every
  request (epoch, run token, framing, the 1 MiB request bound); the front copies
  bytes and adds no protocol meaning. The front needs no store and journals
  nothing: it reports its bind episode, first-accepted evidence and faults to the
  endpoint, which journals `endpoint_bound`/`endpoint_answered`/`endpoint_handoff`
  and publishes authority, health and `serving`. An accepting front alone is never
  health: `serving` also requires this runtime's private listener, so a front that
  accepts while the runtime is down reports the fault instead of answering for it.
  Bounds and ownership: a client whose private connection never succeeds is closed
  after 120 s and counted as abandoned (logged, never answered for), an unexpected
  front fault or exit is reported instead of hidden and retried by maintenance, and
  both the public listener and the private socket are settled on stop so no worker,
  socket or client is leaked. A private socket whose leaf names a dead pid is
  cleared at the next bind; a live owner's is left alone, and a reassert or swap
  only ever replaces an absent or owned socket at the live path, so old and
  incoming owners never remove or assume each other's sockets. Accepted, the
  kernel queue is the only buffer: no backlog, probe cadence or acceptance window
  is widened to make a roll look healthy.
  Mechanism: the bridge spawns the replacement as a warm standby *before* it
  drains the old service (`QUEUE_STANDBY_FOR_PID`, `service/install/standby.ts`).
  The standby loads its modules, starts the front and lets it bind and swap the
  staged socket, then writes an owner-only `queue-standby-<pid>.ready` marker and
  waits until the old pid has exited. That wait is cooperative, and it no longer
  carries the acceptance risk it once did: the swapped listener lives on the front
  worker's own event loop, so a synchronous wait or a busy runtime cannot stop
  accepting or fill the kernel queue (2026-10-06 milestone QA: a 1.6 s
  `ECONNREFUSED` gap on a roll that had reported warm).
  During that wait it reads store files as bytes to warm the OS cache. It does
  not open SQLite, which could create a shared-memory sidecar before schema
  admission; it takes no `processOwner` lease and issues no writes. Each prewarm tick reads a
  bounded 256 KiB chunk, because one multi-megabyte synchronous read on the
  runtime thread delays the private socket's replies (2026-10-20). The marker is
  removed when the
  standby stops waiting, on abandon, or when the process exits. The bridge waits
  for the marker before it sends `service.drain`, then polls the old pid every
  25 ms. The wait is bounded by the standby's progress, not a fixed time
  (`awaitStandbyProgress`; 2026-10-22). While the exact spawned child is alive
  and its CPU time advances, the bridge keeps waiting. It drains past the
  standby when the child exits, when the service it replaces has already exited
  (another bridge drained it; the bridge then skips its own drain), after 5 s
  with no CPU progress, or at a 120 s hard cap that never re-arms, because CPU
  activity is not proof the standby will ever report. The bridge keeps its
  spawn claim fresh on every CPU sample, since the wait may outlast the claim's
  45 s freshness. A first CPU reading is only a baseline, and an unreadable
  one is never progress. When CPU time is never measurable, the previous 20 s
  wall-clock bound applies unchanged. Bridge options `standbyReadyStallMs`,
  `standbyReadyCapMs` and `standbyReadyBudgetMs` (the unmeasurable-CPU bound)
  set the three bounds. When the wait ends without the marker the bridge
  drains anyway and records that the standby was not warm and why
  (`bridge.standbyReadiness()` with `cause` and the last CPU reading, the typed
  bridge detail and the automatic roll's detail); that fallback can still show a
  gap, and the incoming process then starts its front after the old pid exits.
  The private host-run supervisor's restart uses the same wait.
  **Only the claim owner drains.** When a second bridge finds the same
  incompatible service while another live bridge holds the spawn claim, it
  never drains the old service: draining there stopped it while the owner's
  standby was still loading, and a 2026-10-22 two-bridge fixture showed a 16 s
  endpoint gap (papercut a6c9a2ac). The waiter closes its own connection and
  waits for the owner's replacement under one hard cap fixed at entry (the
  standby cap, the upgrade window and the readiness budget). It never attaches
  to the service being replaced and never touches the owner's claim, which it
  reads without removing. A claim that goes stale or disappears with no
  compatible replacement ends the wait at once, and the bridge's next attempt
  claims and rolls itself.
  **Why.** In milestone QA b3a1c6d1 (load 27 on 18 cores) the old fixed 20 s
  bound expired with the standby still running and unreported, and the drain
  left a 3,288 ms endpoint gap. That the standby was still loading on CPU is an
  inference: the run did not measure its CPU. A solo run at load ~20 reported
  ready in 5.8 s. The standby loads the whole service through tsx, which is
  CPU-bound, so host load stretches it.
  The new runtime adopts the front the standby started (or starts one when there
  was no handoff) and binds its own private socket, ahead of the callback surface
  and ahead of the first board snapshot.
  The spawned service must then become ready inside the bridge's readiness
  budget (20 s), or the bridge reports it unhealthy and a later check spawns
  again. A start that migrates its store (pre-migration snapshot, then schema
  steps) writes an owner-only `queue-service-<pid>.migrating` marker with its
  start and, once the store is open, its finish. Neither the bridge's readiness
  wait nor the executor's 60 s boot wait counts that time, up to 10 minutes; the
  waiting bridge keeps its spawn claim fresh so no other bridge spawns beside it,
  and clears the marker when it stops waiting. The marker carries the spawn token
  the bridge passed in `QUEUE_SPAWN_TOKEN` and counts only for that spawn, so one
  a crashed process left behind never extends a later process reusing its pid. A
  start without the marker keeps the ordinary bounds. The schema 43
  roll (2026-10-21) needed about 20 s for snapshot and migration; it was called
  unhealthy, three children each took a snapshot, and it landed only on retry.
  A roll does not advance the epoch or rotate the token keys. If the drain
  request is refused, the bridge stops the standby. A bridge that meets a fresh
  `replacing` handoff it did not start waits for that handoff to settle instead
  of spawning a second owner over it. Each process journals `endpoint_bound`,
  `endpoint_answered` and `endpoint_unbound` on the authority run (names and
  instants only). A make-before-break swap also journals `endpoint_handoff`
  with `boundAt`, `answeredAt` and `swappedAt`. The #212 guards are unchanged.
  The same thread owns the run watch, so its identity proofs never block the
  replies it serves: the per-poll `ps` start-identity proof runs as a spawned child, and
  each (pid, recorded identity) pair is proven against the OS once per cache
  bound and re-proved fresh before any identity-dependent loss or settlement
  decision, because ten synchronous proofs a second on the runtime thread
  turned ordinary host contention into refusal clusters (2026-10-20 milestone
  QA). A cached proof expires even when no poll observed a death, so a reused
  pid number never inherits its predecessor's proof; an unavailable read is
  `unknown` — never matched, never read as death — and keeps the run watched
  or the escapee's capacity reserved; this process's own published start
  identity is memoized only once a positive read exists. Gone requires positive
  per-PID absence evidence: a missing PID entry, or kernel ESRCH behind an
  unreadable read. Command failure, permission denial, and partial, empty, or
  malformed data never prove absence, and a successfully read different
  identity is what disproves a recorded one. Startup and reattach adoption use
  the same rule synchronously: a durable result never settles, releases, or
  relaunches over an unreadable escapee identity — the run stays watched and
  the async watch proves the absence before settling.
  **Roll coalescing.** Backend digest changes inside a 60 s quiet window become
  one roll onto the latest digest. While any heavy run has an attached follower,
  the bridge defers that due roll until the follower's run settles or 15 minutes
  elapse, unless the operator forces it (`force` in the roll-request file, or
  `checkSource(true)`). Deferrals are recorded on the roll record (`status:
  deferred`, `deferrals[]` with `settle_window` or `heavy_follower`) and shown
  as a quiet header notice. Direct Nucleus CLI calls compare the protocol version
  and the called RPC's input/output contract digest, rather than the whole-build
  identity. Compatible calls continue on the running service during a roll. An
  incompatible call waits through `deferred`, `typechecking`, `replacing` and
  retrying progress, up to ten minutes; failed rolls and timeouts are explicit.
  A mutation whose response is lost during a socket swap reports an unknown
  outcome and names its confirming read; it is never replayed automatically.
  See the [service boundary](../contracts/service-boundary.md).
  **Measured.** Live rolls on 2026-10-05 still unbound the live path before the
  incoming process bound it: 3–7 s gaps, and consumer-b v0.1.21 (run 59760cd9)
  lost its follower with `scheduler_unreachable`. The make-before-break swap is
  the rule that closes that gap. `test/host-run-roll.test.ts` (real service
  processes on isolated dirs and HOME, a probe connecting every 4 ms) asserts
  the gap stays under 500 ms with no `ECONNREFUSED`/`ENOENT`, that a slow
  standby load is still swapped before drain, that a slow load that keeps using
  CPU is waited for past a scaled wall-clock budget and stall window with no
  gap, and that a stall window shorter than a no-CPU sleep drains past it and
  records the standby as not warm. `test/standby-progress.test.ts` covers every
  end of the wait on a fake clock: progress, stall, baseline, unreadable
  readings, the unmeasurable budget, the cap and exit. The same
  test holds one interactive run across five rolls and asserts run ID, epoch,
  process and token validity, an `attach` follower resuming from its offsets
  with no gap or duplicate, and a single settlement with the original result.
  These roll oracles run as serial `timingTest`s in `npm run test:timing` and
  skip the parallel suite. The 2026-10-15 milestone QA ran them six fixture-
  heavy files wide: real rolls stretched until deadlines cancelled or
  mis-measured them — two endpoint failures reported at the test registrations
  and one whole-test cancellation at the 120 s default — and the cancelled
  test's detached fixture service escaped the QA root. Serial execution is the
  existing lane for wall-clock acceptance, not a waiver: the 500 ms handoff
  bound and the 5 s reconnect window are unchanged, the standby readiness wait is
  progress-bounded as above, and
  the probe must prove it covered a measured window — a sample within 100 ms
  of each edge and no longer silence inside — or the window fails instead of
  passing on missing samples. The probe itself runs on an independently
  scheduled test-only worker, so fixture orchestration on the test executor
  cannot pause it and fail coverage on code-owned silence (2026-10-21); its
  samples are real socket observations mapped onto the test's monotonic clock
  through a published wall-to-monotonic offset. A refusal interval is measured
  from the last proven accept to the first recovery, both searched across the
  window edges: the covered chain includes the bounded pre-window sample, an
  interval that started earlier walks back through the probe's own dense
  failing samples, the recovery is searched through the window end across the
  observer's continuing lifetime, and a hole longer than the coverage bound
  leaves that interval edge unmeasured, which fails; a refusal that never
  recovered anywhere in the observed lifetime fails. Refusal observations are
  preserved across the whole probe lifetime — the margins between measured
  windows included — and a lifetime refusal names each interval's phase,
  duration, codes and neighbour accepts as bounded evidence, so a real outage
  is distinguishable from an observation defect. `test/service-roll.test.ts` classifies the same
  way: its service-spawning acceptance tests run serially and its in-process
  tests stay in the parallel suite. Every fixture bridge is tracked, so the
  file-level guard settles each spawned service group — including one a
  cancelled test left booting — and asserts none survived.
  `test/standby.test.ts` pins that a read-only prewarm takes no lease while the
  writable owner is alive, that `hostRunReady` settles once the socket accepts,
  and that a QueueService with the endpoint enabled binds it before executor
  boot finishes.
- **Classification.** Heavy or light comes from the repository's Effigy
  manifest when it declares it. Otherwise Nucleus's default list applies: `qa`,
  `ci`, `ci:fresh` and `test` without a filter. Nucleus records the resolved
  class on the run. A staged milestone setting classifies every stage and takes
  the heaviest class whatever the stage order, so a light first stage never
  admits a later heavy stage as light; `classSource` names where the class the
  run took came from, so a manifest that declared only a lighter stage is
  `default` evidence, not manifest evidence for the heavier run. A missing
  manifest, a selector it does not declare and an unknown `admission` value all
  fall back to the default list; an `include` that resolves outside the checkout
  is not followed.
  The all-stage aggregation is Task #121's (71b99ad2), which predates the
  2026-10-21 staged run whose retained evidence is `invalid_parent_token`;
  nothing retained proves a first-stage-only parent, so no light-first cause is
  recorded (papercut 65c2883a).
- **Unreachable.** When the endpoint is down, heavy selectors fail closed.
  Light ones run. An operator override (`scheduler.override { reason }`,
  bounded to 1 h) is recorded as a fact. The fail-closed behaviour is
  Effigy's to enforce once it submits; Nucleus's part is to keep the endpoint
  up, re-attach runs across rolls, and record the override.
- **Journal events.** Every submission request carries its recorded caller and
  stable `clientRequestId`. Nucleus stores that ID on the run for restart
  re-emission. `host_run_journal` records the scheduler authority at startup and each
  holder or epoch change. Every scheduler decision and fact carries its recorded
  `runId` and `epoch`, including admission, rejection, queue position,
  `adopt_running`, launch, escape, classification, container reports and
  settlement.
- **Operator view.**
  - **QA runs tab.** A "QA runs (N)" tab beside Decisions presents one
    project-scoped list: Now shows running, admitted, queued and capacity-held
    host runs oldest first; Results shows settled runs newest first, starting
    with the past 24 hours. Rows identify project, kind, task when named by the
    caller, selector, commit when present in joined QA or validation data, and
    outcome. A failed row includes its failing step and a short failure summary.
    Failed-only filtering, a project picker for Run QA, and row details preserve
    step output, settlement, caller and epoch identity, cancel, teardown retry,
    and capacity release. The bounded `project.qa.list` read supplies only the
    latest QA run per repository, so an older milestone host run can lack QA
    metadata such as its commit; arbitrary client runs also have no commit in
    the host-run record. It's its own tab, not a panel above the Pipeline, which
    pushed the task columns out of view (Tom, 2026-10-01).
  - **Task detail.** A task's validation shows "Waiting for QA capacity
    (position N)" from Nucleus's own scheduler, not from Effigy's status.

## Effigy generic admission (v0.15 adapter)

Tom separately approved this Nucleus integration on 2026-10-20, verbatim
"Ok. Approved", via Supervisor `b885f087` relay `63b7ce94-3dc2-4f5e-8eb5-3e0e6f6c35c3`,
recorded decision `79f09fe0-cda2-4bd4-a5cd-2cd4ce9b1e5f` v2. Q-006 still covers
Effigy only; it is not Nucleus authorization. Tom authorized early implementation
on 2026-10-21 with "yes", relayed by Effigy planner `a683cd79` in message
`d57f8ca7-365f-4680-a479-5094c1c3ad07`. Early start is not a live cutover and
does not release the merge hold.

The adapter gates Effigy v0.15 heavy runs through Effigy's generic admission
hook. The implementation lives at `core/qa/effigy-admission.ts`; that path name
coincides with the retired `effigy-legacy-admission-joins` file, and this
module is the v0.15 generic hook adapter. Effigy owns workload execution, the
hook process group, and run custody.
Nucleus retains host-wide capacity policy, honest unknown outcomes, and supported
run observation. Nucleus contract 010's client protocol stays the supported
path for installed v0.14.1 consumers until an explicit operator cutover.

### Version selection

Capability is probed from `effigy run --help` (`--run-id` and `run logs`),
never from `--version` or PATH alone. Both the development pin and the
qualified candidate still print a `v0.14.1…` version string because the
Effigy workspace version has not bumped; select by explicit path plus
verified hash and full commit. Installed v0.14.1 keeps the host-run client
protocol. Nucleus does not retire host.run because Effigy retired its client.

Qualified interop candidate (final packet, not a live install):

- path `~/.local/share/northstar/release-audits/effigy/dev-builds/candidate-efc1478/effigy`
- SHA-256 `dc6a6e9e3829b553d61358db0875ee2fc5d107cd15194a257a6c4560edde8eae`
- Effigy source commit `efc1478990a97be03f243b0d4c89246b6be55997`

Pinned development artifact for early implementation only (not this
candidate):

- path `~/.local/share/northstar/release-audits/effigy/dev-builds/3d5c3410f241/effigy`
- SHA-256 `e4e2d223542ac81c310bab9ac66da757e59ec946a19a4f9294c8aa0ed50f03c4`
- Effigy source commit `3d5c3410f2415884e2719e83123e81ef5d49fb6d`

Use either binary only with a private HOME and disposable fixtures. No
Nucleus-side Cargo build, install, symlink, or live settings change. Exact-byte
interop against the qualified candidate is recorded above; merge, live
delivery and installation stay held for independent exact-head review and the
operator cutover.

### Launch environment

Nucleus sets `EFFIGY_ADMISSION_HOOK`, `QUEUE_ADMISSION_SOCKET`, and
`EFFIGY_ADMISSION_HOOK_TIMEOUT_MS=3600000` on worker and reviewer launches it
owns (`createAgent` and `createRun`), and nothing else: the reviewed v2
protocol's `EFFIGY_ADMISSION_PROTOCOL=2` is never injected here, because these
environments also carry the durable `--run-id` route a v2 launch would refuse
("Reviewed Effigy v2 custody protocol"). The one-hour timeout is Effigy's default
ceiling for genuine confirmed capacity waits; Nucleus owns the variable in
environments it launches and keeps that value. Effigy runs the hook as
`/bin/sh -c` in the invocation cwd, so the command is an
`ELECTRON_RUN_AS_NODE=1` assignment in front of the current executable, then
`--import` of the absolute tsx loader in this Nucleus checkout and
`bin/queue-effigy-admission-hook.mjs` (task 413). Nucleus's service can itself run
inside Paseo's Electron helper, where the current executable is that helper
binary; without Node mode the helper starts its desktop argument parser and
reports `--import` as an unknown option, so it printed a desktop banner instead
of an admit or deny. The assignment is a `sh` prefix on this one command, so
only the hook child gets Node mode: the agent shell, the worker/reviewer
environment Nucleus merges and the Effigy workload never do, and Nucleus adds no
variable of its own to them. Plain Node ignores the variable, no executable is
resolved through `PATH` and no runtime is installed or configured, so the
command, its quoting and its absolute loader and hook paths are the same bytes
whichever runtime Nucleus runs under. Launches dispatched before this change keep
the command recorded in their own environment: no consumer is restarted or
environment-patched, and no earlier task is claimed to have run this way.

Already-reserved launches do not get the hook: milestone QA, project
validation, and repository hooks use `minimalHookEnvironment` plus the
contract-010 launch allowlist, so nested work inside a reserved host-run
cannot take a second slot. Nucleus never fabricates `EFFIGY_ADMITTED`. Nested
heavy work that Effigy still offers to the hook when a Nucleus- or
client-submitted host run is already live at that cwd receives a nested admit
without a new reservation — that is the v1 answer and stays it; under the
reviewed v2 protocol a reservationless nested run has nowhere to record the
reports its coverage needs, so the hook denies that same observation before the
workload instead ("Nested admission refuses under v2" in "Reviewed Effigy v2
custody protocol"). Two concurrent worker heavies at the same cwd with
different Effigy run ids take two reservations.

v0.15 no-hook direct execution cannot occur on a Nucleus-governed worker or
reviewer path: if the admission socket is down, the hook still runs and
denies unreachable before the workload.

### Admission protocol

The hook reads `EFFIGY_ADMISSION_REQUEST` schema `effigy.admission-request.v1`
(`run_id`, `task`, `class`, `cwd`, `root`), and `effigy.admission-request.v2`
(plus `protocol: 2`) only when the invocation opted in as described in "Reviewed
Effigy v2 custody protocol". Caller-supplied metadata is not
execution authority; the trusted boundary is the owner-only Unix socket
`run/admission.sock` beside `run/scheduler.sock`. That socket is Nucleus-owned,
not contract 010 and not a catalogue RPC.

The durable reservation id is `sha256("effigy-admission\\0" + run_id)`. The
scheduler hold path admits against existing CPU and memory policy with
interactive priority and the 30-minute capacity deadline. The hook prints
exactly `admit` once granted, or `deny <reason>`; progress belongs on stderr.
It holds until TERM and never spawns the Effigy workload.

`reserve` binds before it reserves (task #411). It finds the workload's own
Effigy in the ancestry the hook attested — real path, live contract-010 start
identity, an answer to `--version` — and submits with the binding inside the
reservation's own durable write. When it cannot bind, it writes no reservation
and answers with the existing `settled` observation whose reason is
`admission refused: <binding reason>`; the hook already denies on that kind, so
first contact prints `deny admission refused: ...` and the workload never runs.
No new observation kind or field crosses this socket. A reserve for a run that
already owns a live reservation returns that reservation, and nested work (a
Nucleus- or client-submitted run already live at the cwd) is admitted without a
reservation and therefore without a binding. That nested admit is v1's:
`reserve` still answers it, and the hook refuses it before the workload when
the invocation opted in to v2, because a reservationless run cannot record the
reports that protocol's coverage is built from.

Admission wait (Supervisor relay `eadc95f2-9b63-4efa-b697-6810a3861434`;
confirmation credit corrected by task 447):

- An unreachable service, Nucleus error, or unrecognized reservation on first
  contact prints `deny` with a concrete reason promptly and never waits on
  that error.
- While queued, the hook requires a still-queued confirmation every 5 s. A
  received reply for the hook's own issued reservation **is** that confirmation:
  it refreshes the last confirmed instant before any staleness decision, so the
  age of an earlier reply can never deny a wait the service is still answering.
  Only the reply credits — its arrival and its reservation identity. A confirm
  the hook did not receive (its own 2 s bound, a broken or unbound socket), the
  moment a request was sent, a local retry, and the service's own
  `admission_confirm` journal entry are each **not** credit; a journal entry is
  evidence that the service processed a confirmation, never that the hook
  received the reply.
- Missing confirmations beyond 60 s deny before workload, and the window is
  always measured from the last received valid confirmation. A run of
  unreachable confirms after one still-queued reply therefore denies from that
  reply's instant, so a service that stays unreachable still fails inside the
  existing bound and a late, lost or timed-out request never extends it. 5 s is
  longer than the contract-010 reconnect window so a roll's brief gap is a
  missed beat, not an immediate deny; 60 s (12 beats) matches the
  never-launched client-left grace and is far under the one-hour hook timeout,
  so a stalled or wedged service cannot consume that hour.
- Mid-wait unreachable counts as a missed confirmation: a killed service
  denies inside the 60 s window; a live queued reservation with fresh
  confirmations keeps waiting past that window until capacity, the 30-minute
  deadline, or Effigy's hook timeout.
- A confirm reply is credited only when it is the first line of the reply on
  the one fresh owner-only socket this hook opened for its own outstanding
  request, and it names exactly the reservation that request carried. A
  malformed, error, unknown, settled, uncorrelated or foreign reply is refused
  and credits nothing; a reply naming another reservation is a refusal in its
  own right (`admission confirm reply did not name the reservation this hook
  holds`). Admitted, running and nested observations are unchanged, and a
  cancelled or settled reservation stays a refusal — denial is never permission
  to forget a possibly granted reservation or to replay work.
- Hook denial is not permission to forget a possibly granted reservation or
  replay work. Unknown process identity, unreadable `ps`, or a disconnected
  stream keeps capacity until a supported positive settlement. Authoritative
  death or start-identity mismatch is tested separately from unknown. Nucleus
  does not treat hook death after admit as Effigy workload success; it
  observes the Effigy run through v0.15 run control (`run status` / `run logs
  --follow` with per-stream byte offsets) and releases occupancy only when
  that run is terminal. Exit 75 is a held task lock only; 77 has no scheduler
  meaning. A key aged out of the newest-20 settled runs per task is retention
  expiry, not proven non-execution, and is never resubmitted as a fresh run.

### Admission RPC metrics

A still-queued wait that ends in denial after minutes leaves one question: was
the service slow, did it answer replies the hook never received, or were the
hook's confirms arriving late? `service.health.admissionRpc` answers it from
bounded memory, with no history scan and no new work per beat (task 447).

- `methods` carries `reserve`, `status`, `confirm` and `bind-hook`, each with
  the request lines this service read, the reply lines it handed to the socket,
  the replies it could not hand over at all (the caller was already gone), the
  dispatches that threw, and a `processing` latency window (`samples`, `p50Ms`,
  `p95Ms`, `maxMs`) of the last 64 dispatches. `processing` is the service's own
  dispatch duration on the service thread, from the parsed request line to the
  reply handed to the socket: server processing only.
- `confirmCadence` is the interval between two confirms this service processed
  for the same reservation on its own clock, with the gap window, the largest
  gap, and counts over the 5 s cadence and over the 60 s liveness window. It is
  how a late confirm is visible without reading one row of history: a gap over
  the liveness window says the service was not confirming for that reservation,
  and a run of ordinary gaps says it was. It is a service-side inference of the
  hook's cadence, not a client roundtrip measurement.
- `serving` is the admission socket's own truth, so a process that is not
  serving the socket at all cannot read as a service that received no requests.
- `notes` states the measurement place in the payload itself, including what is
  **not** measured here: client roundtrip latency and client timeouts. The
  hook's own 2 s bound stays the only authority on those, and
  `delivery.undelivered` only covers replies the service could not write at all
  — a reply written into a socket the caller had already abandoned is
  indistinguishable on this side and is never reported as received.
- The metric set is Nucleus-private and additive. It is memory-only, resets with
  the service, keeps at most 64 samples per window and at most 512 remembered
  reservations (oldest dropped first, and a settled reservation's clock is
  dropped when its watch stops), publishes no run id, reservation id, selector,
  path, credential, output or environment value, and writes no row, journal
  entry, file or timer. It is a diagnosis of Nucleus's own admission socket, not
  a substitute for the account of what the workload did.

### Cutover and rollback

Live environments, installed v0.14.1 consumers, daemons, capacity profiles,
and historical journals stay unchanged until an operator cutover that names
the qualified candidate. Rollback is leaving `EFFIGY_ADMISSION_HOOK` unset on
new launches and keeping the contract-010 host-run path. This task does not
perform that cutover.

End state (Tom, 2026-10-31, confirming the Nucleus owner thread's reading): the
generic hook is the one route. Nucleus keeps the capacity decision; Effigy runs
the workload and holds its process group. Admission never moves back into
Effigy. The cutover retires contract 010's Nucleus-side execution (launch,
output retention, run token, supervisor), not Nucleus's admission.

## Later steps

- **(b)** Effigy's client submits heavy runs to Nucleus's endpoint behind an
  Effigy setting and honours `HOST_RUN_TOKEN`. Complete on Effigy 48183cf
  (2026-10-02); Nucleus's endpoint and token are implemented here.
- **(c)** Complete on Nucleus 2026-10-02. Worker liveness and project-validation
  telemetry read Nucleus's host-run records and settlements. Nucleus has no
  dependency on Effigy's legacy lease store. A client-submitted host run for
  the worktree is liveness; so is a live `effigy qa` or repository QA process
  whose cwd is the task worktree (workers still invoke those locally). Either
  one extends the missing-callback reminder instead of escalating. An incomplete
  process listing is `unverified`, never absence, and holds that same clock. [Spec 031 is
  retired](retired/031-heavy-validation-budget.md).
- **(d)** Nucleus takes the authority at epoch 2. Nucleus drains or hands over
  its live runs by pgid and start identity, then refuses to admit.

## Acceptance

| # | Scenario | Required result |
| --- | --- | --- |
| 1 | Two heavy submissions exceed the host budget | The second queues with a position and launches when the first settles; nested Effigy uses the parent run token and does not submit a second host run |
| 2 | A queued run's capacity deadline lapses | Settles `capacity_timeout` as a hold; no process launched |
| 3 | A run waits 25 min, then runs 10 min under a 30 min run timeout | It passes; the timeout counts from launch |
| 4 | A run exceeds its run timeout; one of its test processes ignores SIGTERM | The group gets SIGTERM, then SIGKILL after the grace period; settles `timed_out`; no orphan in the group; the step doesn't hang on an inherited pipe |
| 5 | A descendant calls `setsid` and survives the stop | Recorded as an escaped descendant fact; visible on the run; the result settles but capacity stays reserved until the recorded identity is dead or an operator releases it with a reason |
| 6 | The Nucleus service rolls mid-run | The run is re-attached and settles with the real exit code from the result record |
| 7 | The supervisor is killed and the group dies without a result record | Settles `lost`; no automatic retry |
| 8 | `project.qa.cancel` on a running run | SIGTERM, grace, SIGKILL; teardown runs; settles `cancelled`, not `failed` |
| 9 | Nested `effigy` inside a launched run (after step b) | It carries the token, takes no second admission, and never queues behind its parent |
| 10 | Budgets | A selector with history is admitted at its measured p95; one without uses the submitted fallback |
| 11 | Host-run journal | Every event kind above appears with its inputs and a stable client request ID; a restart replays nothing twice |
| 12 | Endpoint unreachable (step b) | A heavy `effigy` fails closed with a typed error; a light one runs; an override is recorded |
| 13 | A QA run strands a service inside its own worktree | The pipeline reaps it by pid plus start identity, records the reap, and capacity releases once proven dead; an escapee outside the worktree keeps its hold |
| 14 | History records a whole-host memory peak, or no RSS at all | Poisoned samples are discarded and the run's memory budget lands at most at half of host capacity, so a second heavy run still fits |
| 15 | A launched admission reservation has no trusted runtime binding and can never report a terminal result, so it stays running with unknown outcome and charged | The release surface still refuses it; `host.run.accounting.dispose` with the operator's authority plus a separate exact-run/current-epoch acceptance retires only its accounting. The row keeps its state, settlement, containers and history and stops holding its workspace (Tom, 2026-10-25, "Both release"); totals stop charging at that point and never resume, a queued admission may use the room, and late authentic evidence reconciles on the same run without inventing a result or a second disposition |
| 16 | A launched admission's producer reports its own run's `checkout-journal` cleanup complete while a Retained environment container is still running | The reservation's accounting is retired once, with the producer record and the 2026-10-25 policy ruling recorded and no operator acceptance invented; the pinned contract 010 row is unchanged, and no result, settlement, escaped-descendant or container inventory, process-group claim or settlement-based release is written. A cleanup that is incomplete, absent, unknown, foreground-only, another run's or another runtime's holds the slot and records its cause; a failed durable write or an unreadable stored retirement keeps the charge with its reason |
| 17 | A v2 hook-admitted heavy foreground run settles and the producer's bound bytes report its own `foreground-terminal-record.v1` with `cleanup: complete`, a workload verdict, `checkout_id` and a `boot` matching the acknowledged custodians | The reservation's accounting is retired once as producer closure in the foreground-terminal basis's own private format, with the record, the cross-check state and the policy ruling in the sidecar and no operator acceptance invented, while `#417`'s stored record schema stays unchanged; `succeeded`/0 reads passed and every other verdict reads failed on the producer's own numeric exit code or signal. `cleanup` absent, incomplete or unknown, a non-verdict state, another run id or selector, another runtime or a differing `boot` holds the slot with its own recorded cause, and no result, settlement, inventory, process-group claim or capacity release is written |
| 18 | A v2 hook-admitted run's hook is dead, its recorded coverage is the acknowledged prefix with all custodians and every workload group, no terminal record exists inside the record's retention window, every reported identity is proven dead and every reported group proves `ESRCH` | The reservation's accounting is retired once as `no_terminal_coverage`, recording the producer's own `not-recorded` answer, every identity and group proof, `residualRisk: { escapedProcessPossible: true }` and no terminal outcome, cleanup, custody, container, escaped-descendant, headroom or capacity-release claim; a missing or unacknowledged report, a live or unknown identity, a non-empty or unreadable group, a group another reservation claims, a recorded terminal report, an exhausted retention window or a hook of unknown liveness holds the slot with its recorded cause and releases nothing |
| 19 | A live task test run, and a live milestone QA run with no workspace open on the registered checkout | One terminal tab per workspace and selector follows the run's live output and the workspace carries "Testing" or "QA running", with the missing QA workspace opened on that checkout as an entry only; settling clears the label and leaves the tab on the final status line; a restart restores live runs and clears settled ones; a failed daemon call changes nothing about the run |


### Retained output completeness (Nucleus #158, 2026-10-08)

Nucleus owns the authoritative attach read path. An unavailable or unsafe stream,
or a failed/short read after delivered chunks, never becomes an empty stream or
a fabricated expiry offset. Attach ends without a settled frame; existing
contract-010 clients reconnect within their bounded window and hold when complete
output cannot be established. No new error code or reinterpretation of `invalid`
is introduced. Status retains the original result/settlement and identity; no
submission or cancellation follows from missing bytes. Real empty retained files
remain valid, and known retention gaps keep their accurate `output_expired`
offsets. Missing files cannot create a guessed zero-length retention marker.

Task 443 adds no attach frame and no wire shape: the sweep's own classification
of absent, present, refused and never-written output is private to Nucleus, and the
attach path still answers either the marker's true offsets or nothing at all. A
run whose streams are absent is recorded as unknown and retried on its own
bounded cadence instead of being pinned in front of every later run; a run with
no launch record is recorded as never written, which is a classification and not
a zero-length expiry.

The public host-run socket always belongs to its dedicated front worker. Supervisor plans carry run identity and launch settings; paths are derived from the verified state directory and run ID.
