# Nucleus engine build plan

[Spec 070](../docs/knowledge/specs/070-small-engine.md) owns the model. Milestone 1
runs one synthetic task from work through closeout on T3. The Rust engine is off
by default and uses its own settings and database. Fixture mode scopes dispatch
to the authorized fixture repository. The planner checks the run by hand. The
board switch starts in milestone 2.

A missing review checkout is recovered at the verified PR head before
reserving a run. If recovery fails, the task waits for another check.
An unsent create only has a provisional thread in its run slot. A possible
send or a positively observed completed turn binds the retained thread.

## Crates and review slices

| Slice | Crates | Boundary |
| --- | --- | --- |
| 1 | `nucleus-core` | Typed task, commands, transitions, pure `decide`, and a test for every decision arm and both gates. |
| 2 | `nucleus-store`, `nucleus-work` | SQLite task and history transactions, settings paths, and worktree allocation and retirement. |
| 3 | `nucleus-forge` | GitHub PR identity, exact-head checks, merge and merged-head readback. |
| 4 | `nucleus-hosts` | A small host interface and the authenticated T3 adapter, tested against RPC fixtures. |
| 5a | Core, store and T3 interfaces | Add versioned task writes, planner notice delivery and native wake hints. |
| 5b | `nucleus-service` | Run the task pass with due times, command preflight and authenticated reports. |
| 5c | JSON API and `nucleus-cli` | Serve the task view, invalidations and commands. Configure and run the isolated service. |
| 6 | `nucleus-acp`, T3 parenting | Present one task as one host-neutral ACP session. Parent T3 role threads under that session. |

Keep PRs near 1,500 changed lines plus tests. Open each against `main` once its
dependencies land. The planner arranges independent review and merges. Run
formatting, check, strict Clippy and nextest for changed crates through Effigy,
with a shared Cargo target under `NUCLEUS_SCRATCH_ROOT`. Oxide uses its registered
removable pool and refuses a pool path inside the task's Stash scratch directory.
Cargo deny and the whole workspace run at milestone QA. The fixture exercises
success, a stopped run, and readback after uncertain delivery before the
planner's live check.

Use `publish = false` for workspace packages. The Longhorn crates are pinned to
tag `v0.6.0` and require Rust 1.97.1.
`longhorn-config` owns the versioned engine and Storage settings domains, atomic
updates and config backups. `longhorn-storage-layout` resolves their roots and
the separate engine data root. `longhorn-git-workspace` compares exact worktree
and repository identity and supplies the bounded Git executor. `nucleus-work` owns allocation
and uses explicit `git worktree add/remove` without force. `longhorn-redact` and
`longhorn-support-log` cover adapter diagnostics. `longhorn-operation` leaves
persistence, deduplication and restart recovery to the caller, so it adds no
needed behavior here. Use `longhorn-update-install` when verified distribution
and roll enter scope.

Worktrees default to `<workRoot>/<repo-hash>/ns-<task-id>`. Barge's `barge` library
provides optional lease, lookup, hold and return. The fixture uses `workRoot`.
The Barge checkout has the worktree API and no release tag. Enable the pool
setting after a compatible dependency pin and a hold that covers the T3 turn
and its tools are available. Barge main at `47e52ea9b40e1cb4bc16c8f0e201732d2465eb56`
has `WorktreeHold` support for an inheriting child. The T3 process spawner needs
to use that hold for a pool; `existing_worktree` passes only a path. For both
backends, inspect cleanliness just before
retirement and keep dirty or unpublished local work in place. Index flags that
can hide edits also keep the checkout in place.

Git receives a pathname after the no-follow directory check. A root or bucket
replaced during that interval can redirect allocation. The work root belongs
to the operator on the single-user host. A follow-up will anchor the destination
to a verified directory handle through the Git write.

Run `nucleus-engine configure --enable` to enable the engine. The transition
home is `~/.nucleus/engine`. It contains the database, settings, backups, logs,
keys and launchers. Use `--home` to keep using an explicit portable profile.

Worktrees, scratch and builds use platform defaults in the default profile.
Select Barge in Storage or run `configure --enable --placement barge` to use
Barge's `worktrees`, `scratch` and `builds` classes. The engine asks
`barge --json path <class> --project nucleus` on its own `PATH`. It requires the
class directory to exist on its registered volume and can create the `nucleus`
child. Startup refuses a missing class or volume, including a Barge response
that reports an absent-volume fallback. Explicit worktree, scratch, build and
log overrides take precedence. Placement and root changes apply on restart.
Settings and `t3 status` show the active roots. Use the reported builds root
when selecting install output, such as the `engine:board-build` destination.

The registered project checkout still anchors Git and retains its Git objects.
The engine creates task checkouts under its work root and sets `TMPDIR`, `TMP` and
`TEMP` for local commands. The task launch tells the role to keep command
temporary files under scratch and Cargo output under builds.

### Move an existing engine home

Keep the current `--home` until the move is ready. The engine still reads and
enforces an existing `workVolume` pin. An offline copy to the new home must
clear that pin explicitly, after stopping the service and quiescing ACP sessions.
Keep a restorable source and copy the durable state together, including SQLite
sidecars if present, all configuration domains, backups, and private key files.
Preserve the original permissions. If the old profile used separate platform
directories, collect each domain into the corresponding directory in the new
home. Avoid moving roots that still hold active checkouts, sessions or report
tickets. Keep their overrides through the move until those users settle.

On the copied profile, run `nucleus-engine configure --enable
--clear-legacy-volume`, with `--placement barge` if desired. Use `--reset-roots`
to remove old overrides and pass any overrides to keep in the same command.
Refresh the owner-only serve and ACP launchers for the new absolute paths and
scratch root. Verify the database and settings under the new home, then verify
the exact provider launcher and the pinned Inbox before reopening dispatch.
Keep the original profile and launcher available for rollback.

The native T3 Inbox verifies its existing project against the absolute
`<databaseRoot>/acp-inbox` path. Moving the database requires a separately
authorized rebind of that T3 project, with its fixed project and thread IDs
intact. The ACP session ID also changes with the path. `t3 install --adopt`
can update the provider launcher and still refuses an Inbox whose project
points to the old root. Verify the Inbox session on the new binding as part of
the cutover.

## State and decisions

The [SQLite schema](crates/nucleus-store/src/schema.sql) stores tasks and display
history in its own `engine.sqlite`. It uses WAL and transactional schema
versioning. The brief's text, version and digest are stored together. Store
a human acceptance, when needed, as an exact-head
alternative in the verdict slot, including the accepting actor and authority.
Resolve the responsible planner from the task's origin and live host inventory.
Append audit history in the state transaction. The pass loop schedules active
rows. API history
and live notifications may read the event log.

Admission and edits commit locally and wake the scheduler. The scheduler
checks role profiles once in a batch that contains due queued tasks. One
cycle runs at a time, with at most one GitHub request and one exact T3 RPC
in flight. A separate T3 shell subscription supplies shared wake hints.
Repeated transcript updates and reconnects leave existing deadlines in place.
Running turns have a 45-second exact-read backstop. A lifecycle change,
callback or command can wake the task sooner.

The scheduler chooses the next task when the current one releases its slot.
Native writes and their readbacks come first, then command and callback
wakes, due decisions, and routine refreshes. Within each tier, the oldest
due task goes first. Wakes for the same task coalesce into one queue entry.

An exact read that still shows a live turn needs no forge read unless a
command is waiting on forge evidence. Launches, settlement and native writes
still use fresh evidence. T3 transport failures defer requests for 15 seconds.
GitHub transport and server failures pause requests across all tasks for 30
seconds, doubling up to four minutes until a read succeeds. Rate limits retain
their supplied deadline. A settled run that held a launch slot wakes the oldest
capacity waiter. Capacity also has a 60-second backstop. Slot limits take effect
when a Dispatch or Projects edit commits. The API serves task views from the
store and memory and pushes invalidations.

Normalize the relevant observations to one signal per phase. The bound run
takes precedence over downstream work until its turn is quiescent. A required
unknown read yields a wait before any action that depends on it. Optional and
irrelevant reads do not delay a task. In this sketch `Remaining` is derived from
the current phase and head's failure count, and `Last` means the observed
failure is the third.

```rust
match (phase, run_state, observation) {
    (_, Revoked, Quiescent) => Advance(phase), // clear the revoked run
    (_, Revoked, _) => Wait(reason, retry_at),   // reconcile the stop
    (Done | Cancelled, _, _) => Nothing,
    (_, _, Held | QuestionOpen) => Wait(reason, None),
    (_, _, Unknown) => Wait(reason, retry_at),
    (_, Bound(_), Permission | Input) => Wait(reason, retry_at),
    (_, Bound(_), Starting | Running | IdleWithoutTerminalRun) => Wait(reason, retry_at),
    (Reviewing, Bound(Reviewer), PreparedInvalidAfterPossibleSend) => Revoke,
    (Working | Reviewing, Bound(role), Failed(Remaining)) => Relaunch(role),
    (Working | Reviewing, Bound(_), Failed(Last)) => Ask(retry_question),
    (Queued, Unbound, Ready) => Advance(Working),
    (Working, Unbound, WorktreeReady) => launch(Worker, retained_thread),
    (Working, Bound(Worker), ReadyForReview) => Advance(Reviewing),
    (Working, Bound(Worker), WorkQuestion) => Ask(question),
    (Working, Bound(Worker), HandoffNeedsRepair) => Ask(repair_question),
    (Reviewing, Unbound, OpenPrAtHead) => launch(Reviewer, retained_thread),
    (Reviewing, Bound(Reviewer), ApproveAtHead) => Advance(Merging),
    (Reviewing, Bound(Reviewer), ChangesAtHead) => Advance(Working),
    (Reviewing, Bound(Reviewer), WorkQuestion) => Ask(question),
    (Reviewing, Unbound | Bound(Reviewer), HeadChanged) => Advance(Reviewing),
    (Reviewing | Merging, Unbound, PrNeedsRepair) => Ask(repair_question),
    (Merging, Unbound, OpenHeadNeedsReview) => Advance(Reviewing),
    (Merging, Unbound, ApprovedButPending) => Wait(reason, retry_at),
    (Merging, Unbound, ApprovedButBlocked) => Ask(repair_question),
    (Merging, Unbound, ApprovedAndReady) => Merge,
    (Working | Reviewing | Merging, Unbound, MergedWithAuthority) => Advance(Closing),
    (Working | Reviewing | Merging | Closing, Unbound, MergedNeedsAcceptance) => Ask(accept_question),
    (Closing, Unbound, ClosureReady) => Close,
    (Closing, Unbound, NoConfirmedMerge) => Ask(repair_question),
}
```

In Rust, the phase, run and adapter observations produce a typed signal for
the exhaustive decision match. A successful callback
waits for a terminal turn before advancing. A changed head also waits for the
old turn to end or be stopped before resetting the review. Confirmed non-delivery,
authoritative disappearance of a previously launched run, and a terminal run
without a report are failures. Transport and snapshot uncertainty advance no
counter. On launch or relaunch, continue the retained role's exact thread after
an idle read. Create only on first launch or after confirmed disappearance.
Wait for busy or unreadable threads. A changed head or phase resets attempts.
An explicit `move` also resets them when the phase and head stay the same. A worker
revision must produce a new PR head before another review. An external merge during a turn is processed
after the run settles. `Close` finishes only after fresh merged-head evidence and
workspace inspection. Dirty or unpublished work is retained and shown at closeout.

The commands mutate the same row. `hold` and `release` toggle the hold,
`amend` versions the brief, and `answer` resolves the current question. `move`
and `cancel` revoke the run credential immediately. The pass loop reconciles
the stop before releasing the workspace or starting another run. Direct moves
never give a head merge authority. The merge and clean-worktree gates also
apply to manual commands.

## T3, reports and GitHub

T3 is the engine's only supported host. The host interface describes the reads
and effects the task engine needs.

Every T3 mutation goes through the destination gate after the exact native
read. The gate checks the frozen destination against the fixture's Git origin
and current T3 project root. This includes interrupt, queue cancellation,
archive, unarchive and unsettle. Role writes need their owned checkout.
Planner writes need an exact thread in the fixture project. Review sends
also check the open PR and clean checkout after native authorization.

- Get a ticket with `POST /api/auth/websocket-ticket/rpc`, then open `/ws`
  with `orchestrationProtocol=2`. Use `server.getConfig` to check the configured
  provider and model. Pre-register the single fixture project for milestone 1.
- `orchestration.subscribeShell` can send repository enrichment snapshots before
  `synchronized`. These update repository metadata. Project binding and planner
  routing use the authoritative Shell snapshot.
  [T3 Shell stream](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/ws.ts#L1301-L1345)
- `orchestration.launchThread` takes explicit command, thread and initial-message
  IDs and `existing_worktree`. Bind the run and immutable launch inputs before
  sending. The task assigns a monotonic launch instance and derives a fresh
  bearer from it. Derive native IDs from the persisted instance and freeze the
  exact payload. Before any send, read that exact native thread and message.
  Adopt a matching delivery that already exists. Once an exact read authorizes
  a send, persist the possible send time before writing. A replay also requires
  ten minutes since the last possible send. Keep the payload and native receipt
  ID on every attempt. T3 checks the receipt
  under its dispatch lock. Launch uses the same receipt path for the thread
  claim and first message.
  [Dispatch receipts](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/orchestration-v2/Orchestrator.ts#L16305)
  [Launch receipts](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/orchestration-v2/ThreadLaunchService.ts#L1389)
- `orchestration.subscribeThread` requests a synchronized, full snapshot of the
  exact thread. Settlement requires coverage of all provider sessions and turn
  items. Pending tasks and active command, tool and subagent items keep the
  thread busy. An omitted or windowed roster leaves settlement unknown.
  [T3's background-work derivation](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/packages/shared/src/orchestrationV2PendingBackgroundWork.ts#L225)
- Planner authority uses only the exact thread record from a compact bounded
  snapshot, on scheduler demand. Only notice routing after confirmed absence
  needs the complete candidate inventory. Request for T3: a single-thread shell
  RPC on the WebSocket contract so authority checks can skip the transcript.
- Request for T3: project or thread filters for the shell subscription, so a
  service can receive only events for the projects it runs.
- Request for T3: server-attested answer provenance that distinguishes a
  direct human UI submission from MCP or a relay. Bind it to the host, thread,
  request, decision version and selected choice. When T3 supplies that
  evidence, Nucleus will require a direct UI submission for operator-only
  decisions.
- A pass shares one bounded cwd census across checkout checks. The Mac adapter
  cross-checks cwd-only `lsof` against the local T3 user's PIDs, then checks open
  files recursively under the checkout and engine scratch. It holds both
  directory descriptors during that scan and requires each in the reply.
  Darwin `lsof` can exit 1 for closed descendants. For that status, a quiet
  result requires explicit `-V` search misses and both descriptors.
  An open file or working directory in either scope is busy. An unaccounted
  live PID, undecodable path, incomplete listing or warning leaves settlement
  unknown. Decode `lsof` escapes before comparing path bytes. Run the
  engine and T3 under the same local user with private task checkout roots.
  Use a fresh pass after a launch can have started new processes. Barge pools
  require the host-side inherited hold.
- Set `NUCLEUS_ENGINE_T3_RUNTIME_DESCRIPTOR` to the connected T3 server's
  `userdata/server-runtime.json` to recognise standing provider processes.
  Each pass verifies the descriptor origin and server PID, then follows only
  direct app-server and helper ancestry. Shells and work spawned by a helper
  keep custody. Unreadable process facts and conflicting bindings also hold.
  A standing helper bound to another recorded role of the same task can be
  excluded when its cwd is inside this checkout and a fresh exact native read
  confirms that role is idle with no pending work.
- `orchestration.dispatchCommand` with `message.dispatch` starts a new turn in
  a retained, idle thread. Reopen an archived thread before reusing it. On
  revocation, clear an unsent request directly and stop a confirmed delivery
  with `run.interrupt` or `queued-run.cancel` at its exact native run ID. If
  delivery is still uncertain after the late-reply window, replay with the
  credential already revoked. When the review head is unchanged, replay
  requires a fresh open PR and clean checkout at that head. When it has moved,
  reconcile the old wire once, stop any settled delivery's live turn, and
  archive the thread before clearing the run. Read back the settled state
  before releasing the checkout. The milestone 1 fixture can use standalone
  threads. The host adapter prepares that launch wire, so the service uses the
  same task and run model when the adapter parents a thread under an ACP session.
- The role runs call a local authenticated report endpoint via an owner-only
  ticket outside the checkout. The prompt names the ticket path. The service
  verifies the task, role, current run, credential and requested review head.
  A worker sends its PR and head or a question. A reviewer sends its verdict,
  exact head and summary or a question. The same callback is harmless when
  retried while its run is current. Stale credentials cannot change task state.
- Read the GitHub PR against the task's repository, base and branch. Read
  mergeability, draft status, exact-head checks and review requirements. A
  separate reviewer turn examines the requested commit. Milestone 1 uses its
  authenticated verdict as Nucleus approval. Branch protection remains in
  force. Formal GitHub review publication needs a separate reviewer identity
  on repos that require it. Merge with `PUT /repos/{owner}/{repo}/pulls/{n}/merge`
  and the reviewed `sha`. On a lost response or head mismatch, read the PR
  again. Use `merged` and its merge commit for readback, including squash merges.
  An externally merged head with no verdict requires recorded human acceptance.
  [GitHub's exact-head merge endpoint](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)

## Service pass

At startup, enqueue every active task, including a cancelled task with a pending
run. Keep the earliest due time for each task in memory. Receipts and commands
wake that task after their transaction commits. A T3 stream wakes the task when
its known thread changes. A fresh running hint can defer a routine refresh.
A disconnect discards hints, and a periodic active scan catches any missed wake.
The next due time drives the timer even when the scan is idle.
The backstop pages through the active index with a fixed read budget.

A pass takes tasks that are due and shares one bounded process inventory.
For each task, read its row, then fetch the exact T3 turn, PR and checkout facts
needed for its decision. Process coverage and the full provider projection gate
continuation and release. A live process keeps the checkout in use regardless
of elapsed time. The service rechecks Git cleanliness just before removal.
Waits schedule another check. Unknown host reads back off from 15 seconds to
4 minutes, with thread events resetting the delay. A provider retry deadline
takes precedence over a shorter check interval. The decision table owns questions
about the work.

Read adapters outside the store lock. Every pass write compares the task row's
version and run instance with what it read. A stale result drops out and wakes
the current task. Effects and commands acquire a per-task fence only after
preflight. Store state and audit together, including the send intent before a
native write. The board reads committed rows without waiting on GitHub or T3.
Keep due times and displayed waits in memory. An available slot permits a new
launch. Waiting for a slot spends no attempt. A fresh pass checks process
custody after launch.

A definite GitHub head mismatch retires approval and keeps the bound PR in
Merging until a read shows a new head. A refusal followed by incomplete
readback waits for fresh evidence and honours any forge retry deadline.
A failed forge read keeps its retry and reports the safe failure category to
the service log.
A confirmed rejection of a superseded review stays in the revoked run slot
until T3 confirms archival or absence. Later passes only reconcile that
disposition. They never replay the rejected launch.

`next` and commands run the same preflight using the pass's forge observation
for the committed task version. Answers bound to a PR head, amendments to
tasks with a bound PR, and moves through the merge gates check that head.
On missing evidence, the command returns
HTTP 202 with `status: pending` and the version, and wakes a check. The client
can retry the command when `next` shows it ready. Merge and worktree removal
still check fresh evidence at the effect.

An open question owns its message intent. Resolve the project's most active
responsible planner at send time. Keep the thread ID only as part of the native delivery
binding. Reconcile that binding before rebinding when the planner changes.
A planner answer must match the current binding.
Unsettle a settled thread using its ID and the high-water sequence from the
same exact snapshot, then read it back. A settle emits a thread event, and the
snapshot reads the largest event sequence for that thread in the projection
transaction. A later settle advances the sequence even when it reuses a
timestamp. Queue behind an active turn and let an idle planner start immediately.
[T3 settle event](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/orchestration-v2/Orchestrator.ts#L5564-L5626)
[T3 thread snapshot](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/orchestration-v2/ProjectionStore.ts#L7075-L7093)

Record the send marker after the preflight, just before dispatching the frozen
message. The notice is delivered when it initiated a turn that started. If a
person promotes the notice to a steer in T3, look for the completed user-message
item with the exact message and target turn IDs. Replay uncertain delivery
under the same ID after the host's wait window. A durable rejection or a
terminal turn that never started permits a fresh binding. Clearing the question
also clears its binding.

## ACP task sessions

`nucleus-acp` is a host-neutral, model-free ACP agent over stdio. Each task has
one service-minted session with task-scoped credentials outside its Git checkout.
The agent reads the same committed task view and current wait as the board.
It follows task invalidations and sends the same typed commands as the CLI,
including answers. A committed command wakes the task. The agent keeps its
presentation cache in memory and has no access to the engine store.

Use `nucleus-engine bind-acp <task>` with a controller credential. This returns
the binding path and stable session ID. Start `nucleus-acp` with
`NUCLEUS_ACP_SESSION` set to that file, or set `NUCLEUS_ACP_BINDINGS` to the
binding directory so the agent finds the task by checkout. The service writes
the binding outside the checkout with owner-only permissions. Worker and
reviewer processes receive their own report credentials.
The binding also names a private scratch directory on the pinned volume,
outside both the checkout and the run scratch scanned for custody.
The agent moves there at startup and keeps the launch directory only to
resolve the session. A held presentation turn never needs files in the checkout.

Use `bind-acp --read-only <task>` for a session that can only read the task,
its history and its event stream. A writable binding has a separate command
credential. The service checks current authority locally before committing
an ACP command or a planner's answer through the API. A planner's writable
binding or command with unknown authority wakes the scheduler to read the exact
bound planner or task origin, and the service asks the caller to retry. The
service keeps that authority in memory until the host reports an identity change,
the connection fails or the task reaches Done. Rebinding keeps the session ID
and rotates the credentials. Reaching Done revokes command access and keeps the final view
readable. The live turn follows task invalidations, including changes within a
row version. Attach and load read the committed view and history locally.
A stream interruption reconnects
with backoff. After the opening prompt, enter commands such as
`hold <reason>`, `move reviewing`, `answer work <guidance>` or `release`.
`NUCLEUS_ACP_HOLD_PATTERN` and `NUCLEUS_ACP_IGNORE_PATTERN` configure silent
re-entry and wake prompts.

Preserve the stdio protocol from [Spec 065](../docs/knowledge/specs/065-acp-task-session.md).
`initialize` advertises `loadSession: true`. An unbound `session/new` is inert;
it refuses prompts locally. An unbound `session/load` refuses the attachment.
A bound attach rebuilds the full current `plan`, `tool_call` list, status and open
question. One plan covers Queued, Working, Review (with its round), Merge and
Close. A persistent wait updates the current step's status. Each worker or
reviewer run gets one tool call keyed by its launch instance. The service view
provides its purpose from the brief's title or the review round, with the
current tool, command, file or test and its observed start time when available.
These are display facts from the exact native turn. Use a redacted tool summary
and compute elapsed time at display. The agent updates the call in place.
Messages cover the PR link, verdict findings, merge, question and finish.
Coalesce repeated state and keep retries and transient reads out of the thread.
Clients without structured updates still receive the human-facing milestones.
The opening prompt establishes the session. The adapter can supply silent hold
and ignore patterns. ACP cancellation releases the presentation turn. Task
cancellation goes through the same command preflight as other clients.

An ACP launcher can bring up the local service using
`python3 ensure-local-service.py <port> <controller-key-file> <lock-file> <serve-launcher>`.
Keep the serve launcher's log under its configured log root. The helper reuses
a healthy loopback service.
When the port is absent, it serializes startup and passes the lock to the
detached engine for its lifetime. A later ACP start can recover the service
after it exits. An unverified listener never triggers a second start.

### Set up T3

`nucleus-engine t3 install` registers the Rust provider `nucleus-rust` in
the local T3 environment. First enable the engine with `configure --enable`.
Use the default engine home or pass the same `--home` to configure, serve and
T3 setup. Set the T3 origin with `--t3` or the profile's Hosts setting. The
provider's launcher is `bin/nucleus-rust-acp` under the engine home. The startup
lock lives beside `bin`.

Prepare an owner-only executable serve launcher that sets
`NUCLEUS_RUST_NATIVE_INBOX=1` and starts this profile's `nucleus-engine serve`
with `acpProvider` set to `nucleus-rust` in the project file. Use the same
loopback endpoint and the same controller key for serve and install. Supply
the key in a separate owner-only file containing 64 lowercase hex digits.
The serve launcher can load service credentials from private files and redirect
logs under the Storage log root. Install requires Python 3 on the launcher
PATH for the interim local startup helper.

Use `t3 auth session issue` to mint a short-lived session with
`--scope providers:manage --scope orchestration:read` and supply its bearer as
`NUCLEUS_ENGINE_T3_INSTALL_BEARER` for install or uninstall. T3 requires
`providers:manage` for a provider mutation with an empty settings patch.
Use a separate Rust runtime bearer with `orchestration:read` and
`orchestration:operate` in `NUCLEUS_ENGINE_T3_BEARER` (explicit `--t3`) or
the credential environment variable named by Hosts. Use Rust-specific
sessions. The generated launcher does not store the management bearer.
[T3 RPC scopes](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/auth/RpcAuthorization.ts#L268-L283)

```sh
nucleus-engine t3 install --t3 http://127.0.0.1:3773 \
  --control-key-file /absolute/path/controller.key \
  --serve-launcher /absolute/path/serve-engine \
  --acp-command /absolute/path/nucleus-acp
nucleus-engine t3 status --t3 http://127.0.0.1:3773 \
  --control-key-file /absolute/path/controller.key
nucleus-engine t3 uninstall --t3 http://127.0.0.1:3773
```

Use `install --adopt` to take over an existing local `nucleus-rust`
registration. It verifies the owner-only launcher, then updates that
instance's command path if it differs. A matching registration stays in
place. Other provider IDs and running sessions are left alone.

The launcher ensures the engine on `127.0.0.1` and execs Rust ACP over
stdio with the profile's binding directory and `loadSession: true`. Install
waits for the exact T3 registration, the `nucleus` model probe and the
engine's observation of the pinned Rust Inbox. During the TS transition, a
still-pinned TS Inbox defers Rust Inbox setup. Rerun install once that Inbox
is retired. The Rust provider can already be ready at that point.

Status uses the runtime bearer for T3 readback and the control key for
authenticated engine health. It reports configured Storage roots, the CLI
version, the exact Rust provider and launcher, and native Inbox presence, pin
and session health. Missing credentials or unavailable reads leave the
corresponding status unknown.

Uninstall verifies the Rust registration and its local launcher, unpins and
archives only the verified Rust Inbox, and removes `nucleus-rust`. It keeps
the launcher, engine data and decisions. T3's remove operation takes only an
instance ID, so keep the provider unchanged in T3 Settings during uninstall.
The command checks the exact registration immediately before removal and
reads it back afterward.
[T3 provider mutation contract](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/packages/contracts/src/providerInstance.ts#L85-L101)
For offline setup flag details, run
`nucleus-engine t3 --help`.

Keep host execution and parenting separate. The engine uses its host interface
to prepare a launch, observe a run and stop it. A host's parenting adapter
ensures the session is open and creates or continues the role's child there.
T3 runs `nucleus-acp` in the session thread. It holds or re-enters that thread,
reads its live run and root node, and sends `delegated_task.request` with the
bound launch identity. The adapter reuses each role's retained child and settles
its completion delivery with `delegated_task.completion-delivery.dispose`.
The command ID names the native child and its first message. Continue sends a
new message to the retained child. [T3 delegated task command](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/orchestration-v2/Orchestrator.ts#L9952-L10170)
The exact child projection binds the run to the task through its native
`lineage`. It must identify the task thread as both the parent and the root
of a subagent, and the child still needs the matching project, branch and
checkout. Closeout can also prove a child from the exact parent's app-owned
roster when the child has no lineage. Conflicting lineage refuses either proof.
Verify reattach after closeout and checkout removal in the parenting fixtures. ACP and T3
parenting follow the milestone 1 proof and precede the first real project.
Reaching Done schedules archival through the same native write gate after any
revoked run settles. Confirm the children are archived or gone, then take a
fresh, complete parent read that proves its turn and background work have ended.
Busy or unknown reads schedule a recheck. Confirm that the parent is archived
or gone before appending the archive receipt. The restart scan skips the task
when the receipt follows its latest transition into Done. Reopening and
finishing the task schedules a new archive pass. Archival never settles a task
thread.

Pass the registered T3 ACP provider for the Rust `nucleus-acp` binary to
`serve --acp-provider`. A legacy serve file supplies it as `acpProvider`.
Configure the provider's
`NUCLEUS_ACP_BINDINGS` to the service's binding directory. The scheduler supplies
a read-only binding when no session has been minted. Keep an existing writable
binding so the planner can use the task's commands. Standalone roles remain
available for the milestone 1 fixture without this setting.

The scheduler uses the host's `deliver_notice` operation for planner messages.
T3 can first prepare a settled destination, then queue the frozen notice after
a fresh read and the same write gate. An accepted queue write still needs
readback to prove delivery. This interface also serves project messages under
Spec 070 ruling 14 when planning moves into the engine.

## Board

The JSON model comes from the engine. A task list returns identity, phase and
current wait or question. Detail adds the brief, current run, PR, verdict,
hold and paged event history. A `next` read returns the current phase, wait,
question and available commands. A typed command endpoint handles `move`,
`answer`, `cancel`, `amend` and `hold`/`release` for the CLI and board.
`/v1/settings` reads the isolated engine's configuration domains. `/v1/health`
reports cached T3 status, scheduled queue depth and the oldest current waits.
Neither read contacts an adapter.
`/v1/events` emits the task ID and version on a change. A reconnect or missed
interval invalidates the list and visible task views. Task commands use the configured control
credential. Each run has its own callback credential, including its task and
role checks. The API exposes the run's progress without its ticket or wire.
Task detail includes a run's current activity label and optional start time
in Unix milliseconds. T3 derives it from running items belonging to the
launch's exact native run. Command labels omit arguments and shell input.
Activity is in memory, scoped to the row revision and run instance. A change
can invalidate a task at the same version, so clients refetch on each notice.
History pages include display records for run starts and ends, PR links,
verdicts, questions, confirmed merges and finish. Replays of the same launch
reuse its instance. The audit sequence and record order are enough to rebuild
the feed on attach. Decisions never read these display records.
Review rounds count applied reviewer verdicts in history. Replays and
unsuccessful launches stay in the same round.

The existing web board enables the Rust task views when its server environment
sets `NUCLEUS_BOARD_ENGINE_URL` to the engine's loopback HTTP origin and
`NUCLEUS_BOARD_ENGINE_KEY` to a controller key. Use the assigned planner's
controller for a planner board. Both preflight and writes use that same
controller. Paired browsers receive only the capability flag and talk to
same-origin task routes. Those routes forward the task reads, commands and
event stream; planning and other legacy features keep their existing routes.

The TypeScript service reads an owner-only `rust-engine-pilot.json` beside its
own settings at startup. Set `"drain": true` to send all new work to Rust.
The single-repository pilot accepts its existing `repository` setting until
the global switch. Set `endpoint` to the Rust loopback HTTP origin,
`boardKeyFile` and `inboxKeyFile` to the absolute paths to their separate
owner-only keys, and `inboxEngine` to the engine's Inbox namespace. The Rust
service needs the same Inbox key file and namespace.

After the global switch, fresh TypeScript admissions direct the planner to
`nucleus-engine task.add`.
Already accepted TypeScript operations and existing tasks keep their original
engine. The same board shows both engines' task rows. If the Rust service is
unavailable, its board section can retry while the TypeScript board stays usable.
An invalid pilot file is logged, and the TypeScript service starts with the pilot off.

Delete the pilot manifest reader, single-repository compatibility path and
global drain gate when the TypeScript engine is retired.

### Seed task numbers at cutover

Wait until the TypeScript allocator is fenced for the repository and any
accepted admissions for it have settled. Make a standalone SQLite backup
inside `NUCLEUS_SCRATCH_ROOT`. Set `NUCLEUS_ENGINE_LEGACY_NUMBERS_COPY` to the
backup's path on the next authorized Rust service roll.

Before serving requests, Rust reads the copy and uses the greater of the
stored next number or one above the largest assigned legacy number. Existing
Rust tasks get consecutive numbers in admission order. A single-pilot
`serve --project` seeds only the validated repository. Registry startup from
a globally fenced copy seeds every canonical repository in one transaction. Run the same startup again to resume a cutover. Assigned numbers stay
stable. The loopback task view shows the public reference separately from the
identity used by runs and callbacks.


The fixture uses the `nucleus-engine` binary. Run `configure --home <profile>
--enable` with an existing fixture directory. Start `serve` with
that profile, a project file for the authorized fixture, and the local T3
endpoint. Set the control key, T3 bearer and GitHub token in the environment.
The CLI's `admit`, `task`, `next`, `history` and task commands use the loopback
API. Every route requires the configured loopback Host and a same-origin Origin
when supplied. `report` reads the role's owner-only ticket and the report from stdin.
For the live proof, bind a separate key to the idle fixture origin thread with
`--fixture-origin-thread` and `NUCLEUS_ENGINE_FIXTURE_ORIGIN_KEY`. Use that key
to submit and answer as the bound fixture planner.

| Keep | Reshape | Remove from Rust tasks |
| --- | --- | --- |
| `client/web` shell and T3 theme, sidebar shades, board layout and common controls | `client/queue.tsx` and `client/board` read the new list. Queued, Working, Reviewing, Merging and Closing map to phase groups. Done and Cancelled appear in history. | Incident, wait and recovery record cards. A task shows its current wait and hold. |
| Task panel shell and activity layout | `client/task` shows brief, current role/thread, PR/head, verdict, hold and history. `next-section` shows the reason and the five commands. | Explicit-command and proof buttons, effect retry, specialised routing and closeout controls. Use `move`, `cancel`, `amend` and `hold`/`release`. |
| Inbox layout and shared question controls | The Inbox shows the task's one question and lets the assigned planner submit `answer`. | Ladder rungs, escalations and recovery ownership. One question goes to the assigned planner. |
| Settings shell and Storage form controls | Settings and Storage read the Rust domains. `client/web` transport and live channel adapt at the data boundary. | Legacy per-task tuning and recovery settings. Planning records and legacy features keep their current route while the old engine drains. |

### Delete at TS retirement

Milestone 4 removes the remaining TypeScript transition paths:

- The per-repository pilot manifest compatibility and the TypeScript admission
  selector. The global no-new-work switch covers the drain.
- The Python startup helper once `nucleus ensure` owns startup.
- The TypeScript Inbox bridge and board proxy.
- The TypeScript Settings screens and their RPC wiring. The Rust-backed
  Settings screens become the only Settings surface.

## Settings migration

Keep the Settings tabs, shared controls and save feedback. Use one noun per
control, put explanations in `?` popovers, autosave, prefer dropdowns and put
Remove inside the editor.

| Group | Longhorn file in the portable profile | Settings |
| --- | --- | --- |
| Profiles | `config/profiles.json` | Name, optional subscription group, canonical selection with stable ID, capability, weight, provider, model and effort, and the operator's `pausedGroups` list. |
| Dispatch | `config/dispatch.json` | Usage level and optional end, global slots, one host call slot, one optional allowance in minutes and `providerLimitCooldownSeconds` (default 300). |
| Projects | `state/projects.json` | Name, slots, archival, discovered repository routes, required check names and hung-tool limit. The limit defaults to 30 minutes. Planners appear from verified live bindings. |
| Hosts | `state/hosts.json` | T3 loopback endpoint and an environment key referring to its credential. The active endpoint and cached status are displayed separately. |
| Storage | `state/engine.json` | Optional volume pin, work, scratch and log roots, verified Longhorn config archives and retention. |

Use `GET /v1/settings/{domain}` to read one domain. `PUT` takes its current
`revision` and replacement `value`. The operator can save only one domain
per request. An edit whose revision changed returns HTTP 409. A Projects edit
preserves the discovered repository routes and planner bindings. Project saves
publish the local settings change and wake the scheduler.
Capacity changes wake local waiters. GitHub confirms that each configured check
is required and passing at the exact head. GitHub's branch rules and the
exact-head approval still govern the merge.

On startup both the old explicit `--t3` fixture endpoint and the saved reference
are supported. Apply saved connection and storage changes on the next start.
Storage reports the running process's active paths and the verified archive
inventory separately from saved intent. The legacy Settings shell stays on its
existing transport until the dedicated Rust Settings UI lands. The Settings
domain stores the budget allowance and hung-tool threshold. Applying them to
run accounting, planner budget questions and native tool termination requires
scheduler and host follow-up. An exhausted allowance extends automatically once,
then the planner can choose Extend directly. Backup capture and retention
execution also belong to that follow-up.

Port the worker start matrix and the reviewer bracket matrix cell for cell from
[Spec 052](../docs/knowledge/specs/052-usage-level.md). Preserve the critical
cases, smoothed Maximum and its one Frontier climb for high-complexity tasks,
and the step-up after an applied changes-required review. Derive that trigger
from the existing phase, verdict and attempt facts. Read the retained worker's
actual profile for the reviewer bracket. Use the existing five-stop demand
weight slider and [Spec 053](../docs/knowledge/specs/053-demand-based-selection.md)
to pick within a bracket. Keep the selectors pure and reproduce every worker
and reviewer case from `test/demand.test.ts` as a table-driven Rust test. The
retired coordinator has no row.

Profile rotation uses the engine's `SQLite` database. Freezing a profiled launch
records one assignment for its role, profile and subscription group in the same
transaction. The store keeps the last 50 assignments per role and lifetime
counts. The group tie-break uses the most recent 50 assignments across roles.
An empty or unreadable history leaves selection to the configured weights. A
failed usage write rolls back the charge while leaving the launch available.
Configured profiles use one T3 catalog read per pass for due launch decisions.
A profile's optional `group` names its subscription. Unset groups use the
resolved T3 provider instance ID. The scheduler freezes the group, profile
and native request together, using the retained worker's model to require an
independent reviewer. An unavailable profile leaves the task waiting.
Provider usage pauses follow [Spec 070](../docs/knowledge/specs/070-small-engine.md#rulings).
The T3 adapter reads the exact run's structured
[`error.failure` item](https://github.com/pingdotgg/t3code/blob/1368854828e259fe6e9539239b36dbf71b50301c/packages/contracts/src/orchestrationV2.ts).
Fixture serve files without a Profiles domain keep their static worker and
reviewer settings.

## Milestone 1 proof

Create the authorized private synthetic repository and its own T3 project when
the engine is ready to run. The service checks the fixture repository's fetch
and push remotes and the native project's registered checkout before dispatch.
One process holds the engine profile's write lock. Use
a real guarded merge and verify task state, exact heads, T3 turn settlement,
merge commit and worktree disposition by hand with the planner.

## Routing repositories to T3

Start one Rust service with `serve --acp-provider <provider-id>`. Give the
service and installed CLI the same machine-local
`NUCLEUS_ENGINE_T3_CALLER_KEY`, a 32-byte hex key distinct from the operator
key. The CLI takes the caller from T3's environment. The planner runs
`nucleus-engine task.add` or `nucleus-engine item.promote <id>` from its T3 thread.

On first contact the request queues a scheduler check and returns a retry
message. The scheduler reads the exact active top-level thread, uses the registered
project root from the synchronized T3 shell, then checks both GitHub remotes
and the local default branch via
`refs/remotes/origin/HEAD`. It saves the Projects route and planner binding
together. The retry derives its repository and base from that binding.
Further admissions, task commands and settings reads use local state. Each
verified planner has its own project binding. A closed thread loses its cached
authority. Task notices address the original planner and fall back to a live
verified planner in the same project when the origin is gone.

New project IDs are `repo-` followed by the lowercase hex SHA-256 of the
canonical lowercase GitHub slug. Use the same ID for offline planning imports,
even if a repository has yet to enroll. Enrollment keeps an existing Projects
ID for an exact matching route.

Projects settings edits cover the project name, slot limit, archive state and
repository checks. The Dispatch domain sets the service-wide slot limit. The
logical project's limit covers all its routed repositories. A non-fixture
launch uses the Profiles domain and the head of the verified local base.

For single-repository pilot and fixture compatibility, `serve --project` pins
one GitHub repository, canonical local checkout,
base branch and T3 project ID. Existing files default to fixture mode. Set
`"mode": "project"` explicitly for a real project and name its Rust ACP provider
in `acpProvider`. Real dispatch waits for configured profiles.

The native write gate compares the prepared destination with the current
repository binding, verifies both origin remotes and confirms that the exact
T3 project is active at the registered checkout. Projects settings edits and
native writes are ordered so an edited binding cannot authorize an earlier
destination. Role threads use the task's ACP parent.

## Pinned Inbox during transition

The scheduler creates or reads operator acceptance questions in the existing
TypeScript Inbox. The decision names the engine, task and row version. Rust
applies an authenticated acceptance to the exact merged head. A decline sends
one planner notice and leaves the task waiting for a move or cancellation.
Bridge outages leave the question pending and use shared backoff.

Set `NUCLEUS_RUST_INBOX_ENGINE` and `NUCLEUS_RUST_INBOX_KEY_FILE` in both services.
Use a stable engine name and an absolute path to a separate owner-only file
containing a 32-byte key encoded as lowercase hex. Set `NUCLEUS_RUST_INBOX_URL`
in Rust to the TypeScript board's `http://127.0.0.1:<port>` origin. The key works
only on the bridge route.

Set `NUCLEUS_RUST_NATIVE_INBOX=1` to use the Rust Inbox, and install its pin with
`nucleus-engine t3 install`. Both Inbox threads may be pinned during cutover.
Rust routes new operator questions to the Rust Inbox and leaves the TypeScript
Inbox in place for TypeScript decisions. The planner retires the TypeScript
Inbox manually after its open decisions have drained.

Keep the bridge connected until its active Rust task versions have been handed
off. Rust reads any answer already recorded there and fences each unanswered
version before offering it locally. Once an Inbox form is answered, the shared
decision record holds the answer and the scheduler verifies the task and merge
head before applying it. A fresh answer is required when the question's task
version changes.

The Rust Inbox records native form answers as
`operator via T3 Inbox (unattested)`. T3 currently returns the same response
for a desktop submission and an MCP submission.

### Agent notes

Agents must never answer Inbox requests or operator decisions, including by
relay. Tom answers them directly.
