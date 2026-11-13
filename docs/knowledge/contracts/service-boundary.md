# Standalone Nucleus service boundary

Status: approved
Owner: Nucleus runtime and protocol maintainers
Created: 2026-09-15
Depends on: `003-orchestration.md`

## Boundary

Nucleus runs as one persistent standalone local service. It owns the
existing SQLite database, durable operations, scheduling, Git and forge access,
repository hooks, callbacks, notifications, telemetry and its direct
Paseo SDK connection.

The Paseo backend contribution owns no Nucleus state and performs no repository,
database or lifecycle work. It validates and forwards shared RPCs to the local
service. The client contribution keeps the native Nucleus surface.

Paseo 0.8 already isolates plugin backend code in a subprocess. This service
adds independent lifetime, deployment, direct health and a smaller bridge; it
does not claim to repair Paseo-owned event-loop stalls. Nucleus remains responsible
for making its service and Paseo request rate bounded.

## Runtime module map

`service/runtime-owner.ts` owns construction, startup, bootstrap, drain, health and
presence. Its extracted methods remain one-line delegates for dispatch and callers.
`core/runtime/board.ts` owns snapshots, board counters, task pages, detail,
owner-next reads and outcomes. It receives store and engine read dependencies,
projection caches and live lifecycle observations through `BoardContext`; it never
imports or receives `QueueRuntime`. Usage and backup revision keys stay with the
board instance. These service modules are outside the plugin bridge import graph.

`core/runtime/planning.ts` owns lead reads and mutations, source promotion,
plans, lanes, draft checks and handoff submission. `PlanningContext` supplies the
store, a restricted engine view, lead operations, the existing lead-board cache
and live startup and origin-agent access. It never imports or receives
`QueueRuntime`; construction and operation-handler registration stay in the owner.
`core/runtime/questions.ts` owns native questions, delegated answers and
decision operations through `QuestionsContext`. `core/runtime/settings.ts`
owns profiles, the host catalog, queue controls and capacity settings through
`SettingsContext`. `core/runtime/repositories.ts` owns repository and project
operations, QA requests and host-run reads and accounting through
`RepositoriesContext`. Each context restricts engine dependencies to the methods
it uses; startup and active host access stay lazy. The retained QA runner and
lifecycle recovery stay in the owner, exposed through a context accessor.
These modules never import or receive `QueueRuntime`.

## Forge module map

`core/forge/index.ts` preserves the public exports. Under `core/forge/`,
`github-client.ts` owns GitHub commands and shared transport helpers;
`pr-identity.ts` owns PR lookup, binding and cancellation;
`reviews.ts` owns comment evidence, verification and durable publication;
`checks.ts` owns hosted-check evidence, history, checks policy and branch-rule reads;
and `merge.ts` owns the merge gate, merge execution and integration closeout.
The modules import downward, never through the entry point.
`shared/review-text.ts` builds review markers, verdict tables and publication bodies.
`core/review/review-body.ts`
keeps existing callers and the plugin bridge on the pure review-text module,
without loading the store or Git runtime. Merge gates, error messages and
unknown-delivery handling are unchanged by this split.

## Store module map

`core/store/store.ts` keeps the public `Store` API and delegates persistence primitives
and persistence seams downward. `store-core.ts` owns the database handle, cached
statements, transactions, events, meta and revisions. Explicit callbacks keep
post-commit cleanup in `Store` and connect it to projection rollback restoration.
`store-host-runs.ts` owns host-run rows, identities, accounting reads, output
failures, journals and the QA fence and custody inventory. `store-project-qa.ts`
owns QA history, latest-run reads and schedule-merge coverage. The seams depend
on the core, never on `Store`; projection access is supplied through callbacks.
`store-planning.ts` owns papercuts, plans, leads, decisions and their history caches, with explicit
callbacks for project and lane access and lane-activity invalidation.
`store-lanes.ts` owns lane records, views, documents and drain evaluation.
`store-maintenance.ts` owns database admission, integrity and migration backups,
retention, pruning, content fingerprints and bounded page reclamation. Store
callbacks preserve transaction cleanup and projection cache ownership.
`store-operations.ts` owns operations, notices, messages and hook events, with
a narrow task-access interface for reads, numbering and change notifications.
`store-projects.ts` owns projects, repository settings, rekey receipts and project
management, with callbacks for task, planning and projection access.
`store-auth.ts` owns credentials, callback authentication, completion receipts
and availability. Projects are parsed once per project-table write clock;
reads return detached copies and rollback clears the cache. Database triggers
cover writes from rekey and lane drains as well as project methods.
Shared hashing and freezing helpers live in the core; operation identity helpers
remain available through `Store` re-exports.

`store-tasks.ts` owns the task and run projections, incremental indexes, rollback
restore journal, task selectors and snapshot/run reads. Explicit callbacks supply
stored-row hydration, numbering, notices, projects and lane event times; write
funnels and transaction cleanup in `Store` keep the projection current. The write
clock still rebuilds projections after writes outside those funnels.

`store-task-writes.ts` owns detached task-row hydration and serialization, observation
rows and run observation comparison. `store-submissions.ts` owns submission identity,
replay matching, dependency validation and queue promotion. `store-outcomes.ts` owns
permanent outcomes, their search and lane indexes, telemetry fact reads and control
outcomes. `store-config.ts` owns profiles, assignment counts and
routing usage configuration. Their callbacks preserve shared projection state in `Store`.

`Store` retains task insertion, task updates and run writes: their ordering of row
writes, projection updates and rollback journal entries is one write funnel. It also
retains transaction cleanup, listener notifications and dependency-control transitions.

## Transport and identity

- Use an owner-only Unix socket under `~/.nucleus`; an equivalent
  owner-scoped named pipe may preserve the protocol on Windows.
- Authenticate bridge and local clients with an owner-only credential. Every
  message carries protocol version, request ID, method and bounded input.
- Validate input and output with the existing shared schemas at both ends.
  Unknown methods, versions and fields fail closed. An oversized response gets
  one small typed `oversize` error with the method, refused size and frame
  ceiling before the service closes the connection.
- Mutations retain their durable submission or operation keys, and a direct
  mutating call may carry a client-minted request key whose received and
  settled outcome is journaled before the reply frame is written ([rolls](#rolls-calls-wait-out-the-replacement-tom-2026-11-09-papercut-15754c8d)).
  A transport retry never authorizes repeating an external effect: a resend
  happens only after the replacement proves the request was never received,
  and a settled key replays its recorded outcome instead of running again.
- An ingress operation records its selected host before validation or a host
  effect. An explicit registered host can be selected; otherwise the sole
  online host supplies the legacy local selection, even if another known host
  is offline. Ambiguous or unknown
  selection is refused. An offline recorded host waits and a retry keeps its
  original selection; a control that is already invalid on stored facts refuses
  before that wait, so the wait holds only a control that would otherwise be
  accepted. The operation and task record whether selection was
  explicit, sole-online or migrated; each run inherits that evidence with its
  task host. Legacy runs inherit
  it only where it is present, and historical events and intent IDs stay intact.
- Origin threads have a separate host identity. The sole known online host or
  a unique complete host observation records it; incomplete or ambiguous
  observations remain unknown.
  Origin notices wait for that host rather than following the worker host. The
  owner-only transport does not authenticate a caller's host.
- Native agent IDs are opaque and local to a host. A task or run's recorded
  host supplies context for its agent ID; an absent or conflicting host cannot
  authenticate a callback. Encoded identities are read only from explicitly
  marked fields, never inferred from a legacy string's prefix. Lifecycle lookup
  refuses an unqualified match spanning hosts. Message participants retain their
  native IDs alongside proven host fields. Hostless legacy participants remain
  unknown; startup does not synthesize host attribution.
  New thread-archive intents use host-qualified keys and atomically leave an
  observation-only fence for older readers. A legacy archive intent stays at its
  original key; when its host cannot be proved, reconciliation waits.
- Native-question deduplication includes the task host. An already recorded
  legacy question retains its original event and delivery IDs; an offline task
  or planner host waits without rerouting or replaying an uncertain send. New
  delegated deliveries mark their encoded recipient reference explicitly and
  send the native ID only through the selected host. An answer from an
  unqualified caller waits unless a complete host lookup identifies the caller
  on the recorded recipient host; ambiguous or offline inventories grant no
  answer authority. A task-origin or current owner recipient uses the recorded origin host;
  other planner recipients need a unique host lookup. A newly selected reviewer
  consult records the task host before delivery and retains a created reviewer
  through a disconnect, without repeating its creation.
- A task message records its destination host and a delivery intent before the
  native send. An interrupted or unknown send remains uncertain; only a proven
  pre-send refusal can return it to the queue. Legacy queued sends that may have
  crossed the boundary migrate to uncertain without changing their message IDs.
  Manual native-question answers likewise record their task, request and host
  before sending; a recorded answer intent is not replayed blindly. The native
  question API accepts a marked qualified reference or a legacy native ID in
  the proven task-host context. Both forms retain old answer-intent fences.
  A late answer to an agent ask returns to the authenticated run's host; an
  offline or unproven host waits. Its notification intent is recorded before
  delivery, so an uncertain notification is not sent again after restart.
  The web question observer keys task threads by marked host-qualified
  references, while Paseo's native pill continues to use host-local IDs; the
  board shows the thread's role rather than the encoded key.
- Health reports build, protocol, database schema, host identity, readiness,
  pause state and last successful store access without secrets or private paths.

### Caller identity and host-wide settings

The transport authenticates the owner account, not a caller. `QueueService`
(`service/transport/server.ts`) mints one credential, publishes it in the
owner-only `queue-service.json` beside the socket, and treats every
authenticated connection as that owner. No frame names a caller, role or
capability; `callCatalogueMethod` (`service/transport/dispatch.ts`) validates
input, calls the owner handler and validates output. Caller claims that methods
record (`host.run.accounting.dispose`'s `authority`, `qa-fence`,
`lead.approve`, `decision.answer`, `project.set-planner`) are stored as
provenance and authenticate nothing; the CLI refuses some of them when they
claim the operator's own identity.

The CLI and helpers resolve the calling thread from a Nucleus-issued run or
participant ticket first, then a host-supplied identity; caller records are
host-qualified and existing bare Paseo IDs retain their legacy interpretation.
Planner assignment issues an owner-only participant ticket that reaches the thread
in the response to its own next authenticated call, or in the response to the
assignment when the thread named itself. A ticket message is the last route: it goes
only to a thread observed live on a host that supplies no calling-thread identity of
its own, and never into an archived, gone or unreadable thread. A planner without a
ticket is recorded ticket pending and the board's project entry says so. Startup
reconciles that state and sends nothing. Reassignment or clearing revokes the ticket.
For `nucleus ask` and `nucleus tell`, a host-supplied caller can proceed only when
`caller.resolve` returns that thread's participant ticket; an unregistered host caller
is refused before a verb is sent. A bare legacy project-planner ID binds to a matching
native ID on Paseo regardless of the historical setter, and never to another host.
The same ticket covers a task's own planner (task 1109): keyed per proven host and
thread rather than per task, handed over by the same two routes, and valid only
while a live task still names that thread as its planner. Reparenting moves the
scope, which revokes the outgoing planner's ticket without a separate write.
A named project agent takes its ticket by the same rules; renaming, reassigning or
unregistering the name revokes it ([Spec 060](../specs/060-named-project-agents.md)).
Tickets prevent same-user accidents; they do not add adversarial authentication or
grant planning authority (Tom, 2026-11-11).

Origin-thread resolution distinguishes three host answers: the thread is mine, the
host authoritatively has no such thread, and the read proved nothing (transport
failure, incomplete inventory, no such capability). A host that cannot prove absence
never reports it. Exactly one claimant resolves the origin, and every host that could
be asked must rule itself out. A registered host that is offline cannot rule itself
out, so it leaves the origin unknown — unless the identity's own source already
proved which host it belongs to (the caller resolution above, or a qualified
identity); that evidence belongs to that one thread, contradicts a claim from
anywhere else, and decides nothing about another identity. The thread is compared
as a thread, not a string: a bare recorded author is Paseo's, so it matches the
host-qualified caller of the same native thread on a Paseo host. Two claimants always
refuse. A host lookup is a read, never a grant of execution authority, and an origin
refusal settles a promotion as refused before commit rather than as an uncertain
effect.

`queue.capacity` takes nine bounded numbers (`capacitySchema`,
`shared/contracts.ts`) and no caller claim. `RuntimeOwner.configureCapacity`
writes the global, project, papercut-project, Paseo-call, stall-threshold, hold
and lane-drain meta keys in one transaction. The scheduler, admission
controller, stall detector and timers read them live, so one write changes
admission for every project without a restart. Owner verbs
([Spec 050](../specs/050-owner-task-controls.md)) are gated by task, version,
run and callback identity; a host-wide setting has no such gate.

The Settings screen (through the plugin bridge or the local web board with a
token, [below](#local-web-board)), the CLI (`bin/queue-cli.mjs`, which reads the
credential itself) and any task session's shell all reach the service as the
same owner. Task launches expose only `nucleus_report`, `ask` and `tell` over MCP
(with the `nucleus_ask` and `nucleus_message` aliases), but that is a discovery reduction, not a gate. The
effective boundary for a host-wide write is therefore the OS same-user boundary:
skill and guide text that reserves these settings for the operator is policy. Nucleus's protection is
accident prevention on the transport plus a durable record of every applied
change, not an identity check.

### Settings-only capacity writes (Tom, 2026-10-25)

Dispatch limits change only from the Settings screen, on the plugin or on the
[local web board](#local-web-board) with a live token and the Settings marker. The CLI and agent routes
refuse with a clear message, every applied change is recorded, and nothing needs
a privileged install.

- **Settings writes.** Settings → Dispatch limits saves all nine limits (global,
  per project, papercuts per project, Paseo calls, stall threshold, hold reminder
  and escalation, lane drain and escalation) as they change. No document,
  root-owned writer or host prerequisite exists.
- **Provenance comes from the transport.** The bridge sets
  `ServiceRequest.via: "paseo"` on the frame it forwards
  (`shared/service/protocol.ts`); the web board's HTTP server sets `via: "web"`
  only after a valid token. `callCatalogueMethod` allows `queue.capacity` only
  with one of those two values. Every other caller (CLI, direct socket client,
  task shell, tokenless web request) is refused before any handler with one typed `refused`:
  "only the operator changes Nucleus's dispatch limits, in Settings. Nothing
  changed; do not retry." Repeats refuse the same way. A body naming
  `authority`, `caller`, `relayed`, `approver`, `via` or `surface` fails input
  validation; an unknown frame `via` fails closed as protocol input.
  `bin/queue-cli.mjs capacity` refuses locally, on both transports, before
  building any client, so `--via-paseo` is not a write route.
- **Every applied change is recorded atomically.** `CapacityChangeJournal`
  (`server/capacity-changes.ts`) merges the named fields over the state in force
  (omitted fields keep their value) and commits all nine meta keys plus one
  record (monotonic `version`, `at`, transport-derived `surface`, full `before`
  and `after`) in one transaction; a fault rolls both back. The last 20 entries
  live in Nucleus-internal meta (`capacityChanges`), never in an export or a
  contract 010 shape.
- **A no-op is a no-op.** Saving the values in force writes nothing, spends no
  version and advances no revision, and still answers `{ok: true}`. A refused or
  invalid call records nothing.
- **The read.** `queue.capacity-state` takes no input and returns the values in
  force and the recorded changes, newest last. Reading never writes. The log is
  kept and read here, by the CLI and agents; Settings has no view of it (Tom,
  2026-11-08: "Drop the UI, keep the log"). Settings reads the values in force
  from the same call.
- **Settings layout (Tom, 2026-10-27; steppers Tom, 2026-11-08).** The three task
  slots show first; the six secondary limits sit under a collapsed Advanced
  revealer, and an open draft, pending save or refusal survives collapsing. Each
  limit is one shared number control (− value +), Role demand's look (Tom,
  2026-11-08): the bold number is editable in place, digits only, clamped to the
  field's min and max when typing ends, and arrow keys step it. An out-of-range
  value is never sent. Web and mobile share this one control; it is not a native
  `<input type="number">`. Advanced limits stack each label above a left-aligned
  control; Task slots keep the label beside it. A label wraps only between words
  (Tom, 2026-11-08). A limit's value in force shows under its field only
  when the entered value differs from it. Units sit after the stepper for the
  timer and call limits; the range sits behind the section's `?`. Saving… and
  unsaved changes show nothing. A save shows a brief Saved, or the reason it was
  not saved. A project override is one row: the name, the bare slots control
  and a trash icon that removes it after its confirmation. A project's in-flight
  cap is always twice its slots, so it has no control and `queue.project-dispatch-limit`
  takes only `limit` (Tom, 2026-11-08). Rows show the server's effective slot
  limit (`projectCapacities`); project overrides keep no change record of their
  own. A failed first read or a failed refresh says whether
  the values shown may be stale, and Try again re-reads; nothing is written.
  Sections run usage level, task slots, project overrides, role demand, then
  frontier grants (Nucleus UI lane, step 5).
- **Restart and upgrade.** The meta keys are the limits, so a restart or roll
  reads the same values and record. Nothing resets them or re-asserts over a
  later change.
- **Honest attribution.** The recorded surface `paseo` names the bridge and
  `web` names the board with a token. Neither can tell the operator's press from
  a same-uid process that sends the same bridge frame (for example
  `invokePluginRpc("nucleus", "queue.capacity", …)` on the daemon) or
  holds a board link, and neither claims to; Tom accepted that this is accident
  prevention, not authentication.
- **Retired capacity tool.** Tom retired the root-owned capacity authority tool
  and installer on 2026-11-09. Settings remains the only dispatch-limit writer.

Proofs by seam: `test/capacity-changes.test.ts` (the record against a real
store: merge, no-op, fault rollback, bounded retention, damaged entries, body
refusals); `test/service.cases.ts` (real socket and bridge: Settings applies and
survives restart, direct and forged calls refuse with no record, the bridge-frame
imitation records as `paseo`); `test/repository-settings.test.ts` (unrelated
settings are byte-identical after a write); `test/settings-pool.test.ts`
(installed dark bundle). The live Settings interaction is checked by Tom.

### Local web board

The standalone service serves the board to a browser on this machine
(`service/web/web-board.ts`, started by `QueueService`). It is part of the
service process, not a separate daemon, and it is not the Paseo plugin. The web
UI shares the plugin components through a browser shell and react-native-web.
The runtime build packages both bundles together.

- **Bind.** `127.0.0.1` on a random free port, never another interface. The port
  is recorded as `httpPort` in `queue-service.json`, beside the socket. A board
  that cannot bind is logged and the socket keeps serving; `nucleus ui` then
  refuses with `unavailable`.
- **Host and Origin.** A `Host` other than `127.0.0.1:<port>` or
  `localhost:<port>` is refused with 403 before anything else, so a page on
  another domain that resolves to loopback (DNS rebinding) gets nothing. A present
  `Origin` must be one of those two origins. The server sends no CORS headers.
- **Links and tokens.** `nucleus ui` asks the owner socket for one link,
  `service.ui-link` (not a catalogue method), prints it and opens the browser;
  `--no-open` only prints it. The link is
  `http://127.0.0.1:<port>/#token=<token>`. A token is 32 random bytes. The service
  holds only its SHA-256 digest, in memory. It expires after 8 hours by default
  (5 minutes to 24 hours through `ttlMinutes`), and at most 16 are outstanding.
  `nucleus ui --revoke` (`service.ui-link` with `action: "revoke"`) refuses every
  outstanding token and closes the live streams they opened. A restart drops them
  all. The plugin can call `service.ui-link` later; its bridge does not forward it yet.
- **Carrying a token.** The page reads the fragment once on first load, keeps the
  token in memory, and sends `Authorization: Bearer <token>` on every API request.
  The fragment never reaches the server. No cookie or query string carries it. A
  missing, malformed, unknown, expired or revoked token each get the same 401.
- **Routes.**
  - `GET /`, `/ui` and other GET paths serve the built bundle from `web/dist`
    in the installed runtime (or checkout when one exists). Otherwise they serve a minimal page that says
    the web board isn't built yet. These carry no board data and need no token.
  - `POST /api/rpc` with `{method, input}` runs one catalogue call with
    `via: "web"`. It takes the socket's path: shared input validation, the cached
    board for `queue.ui-snapshot`, the executor, then output validation. Errors are
    typed: 400 `invalid_input`, 403 `refused`, 404 `method_unknown`, 401
    `unauthenticated`, 503 `busy`, `timeout` or `unavailable`.
  - `GET /api/events` is a server-sent event stream. A `board` event carries the
    full projection when its revision moves, with the revision as its `id`. A
    `counters` event carries the unchanged-board acknowledgement when only the
    counters move, as the plugin's poll reads it. An `unavailable` event carries
    the reason while the executor cannot publish. A keepalive comment goes out
    every 15 seconds, and at most eight streams stay open. The web client suspends
    snapshot polling while this channel is connected and resumes it after a
    disconnect; an unavailable event still triggers a read to expose the failure.
- **Surface.** Web calls carry `via: "web"`. The Settings writes (`queue.capacity`,
  `queue.pool`, `queue.profile`, `queue.availability`, `queue.demand-offsets`,
  `queue.usage`, `queue.project-dispatch-limit`,
  `queue.routing-grant`, `repository.set`, `backup.now`,
  `profile.create`, `profile.update`, `profile.remove`;
  `SETTINGS_WRITE_METHODS` in `shared/web-surface.ts`) are served over the web only
  when the request also carries `x-nucleus-surface: settings`, which the web
  Settings screen sends. A Settings write with a token but without the marker is
  refused with a typed `refused` and changes nothing. A recorded capacity change
  names its surface `web`. Every route without a token, and the socket, still
  refuses `queue.capacity`. The socket accepts only `via: "paseo"` on a frame, so
  a socket client cannot claim `web`. `task.register` is refused over the web with
  a typed `refused`: a worker registers from its own thread's shell.
- **Native questions.** The board reads pending questions for each task-owned worker or retained reviewer. Before an answer reaches the host, the service rechecks task and thread identity and the pending request.
- **The limit.** The token stops other sites and DNS-rebinding pages, and it makes
  every board write deliberate. It does not stop a process running as the same
  user from reading a link the owner issued or calling `service.ui-link` on the
  socket. That is the same accident-prevention boundary as the plugin's Settings
  screen, and the change record keeps every applied Settings change readable
  through `queue.capacity-state`.

Proofs: `test/web-board.test.ts` (loopback bind and recorded port; Host and
Origin refusals; no, wrong, malformed, expired and revoked tokens; a read and a
board verb with a token; Settings over the web and the socket's refusal of the
same write; the `task.register` refusal; the live channel's revision delivery and
its close on revoke; the minimal page). The web shell's own proof lands with its task.

## Process and data ownership

- **Work placement (Tom, 2026-11-10).** `workRoot` in `settings.json`,
  overridden by `NUCLEUS_WORK_ROOT`, owns `queue/workspaces/`,
  `queue/project-qa/`, `queue/backups/` and `scratch/<namespace>/`.
  It defaults to `~/.nucleus/work`. Optional `workVolumeId`, overridden by
  `NUCLEUS_WORK_VOLUME_ID`, pins the exact volume mounted at that root; no pin
  means no volume check. An unpinned path may create ordinary local directories,
  including a missing mount-point directory; configure a pin when that must refuse.
  A missing pinned volume refuses writes with no fallback.
  When neither setting is present, existing workspace, QA, backup or scratch
  records supply their common root, and adoption reads its mounted volume ID.
  Startup persists both once before opening the store for writes. Unprovable or
  conflicting history refuses adoption without changing placement. Recorded
  paths and durable data remain in place. Settings → Backups → Storage shows the
  resolved work root as read-only text.

- A new project QA run records its checkout path before scheduling. Plan, logs
  and state stay in the internal data directory; the checkout and its declared
  sibling links use the external root. Runs without a recorded path keep their
  internal checkout, and a roll never derives a new location for them. Storage
  identity is rechecked at launch, checkout creation, hook and cleanup, and an
  uncertain creation is retained rather than removed or recreated.
- Project members without a local checkout are recorded on the QA run with
  their origin, configured path and a `No local checkout` reason, then skipped.
  Setup-declared siblings and dependency-ledger sources remain required and
  refuse launch when they cannot be resolved.
- Settled project QA history, step logs and failures logs stay in `project-qa/`;
  the hourly retention pass removes the run's exact Queue-owned checkout after
  settlement, including legacy checkouts copied into the current data home.
  Only the latest run per repository keeps a checkout when teardown failed and
  an explicit retry can still consume it; pending checkout cleanup also keeps
  its checkout. The board reads every run's stored result and logs, so it needs
  no other checkout retention.
- The live data-home backup resolver writes verified snapshots to the external
  configured work volume. An hourly retention pass prunes only regular snapshot files in
  the live data home's old `backups/` and `.external-backups/` copies, and only
  when the external set has a newer verified snapshot. It keeps copies newer
  than that snapshot, leaves unknown entries alone, never writes to the external
  volume and never prunes a fixture or non-live data home.
- Hook isolation checkouts are removed after their owning hook/task is terminal
  and no queued, admitted or running host run names the workspace. A checkout
  named by a settled host run is also removed at settlement. When no live owner
  can be proven from retained records, a direct Queue isolation checkout gets
  a 14-day grace period; after that it can be removed only from a real Queue
  isolation path and when no unsettled host run uses it.
- The existing data directory and `queue.sqlite` remain canonical. One resolver
  (`shared/data-home.mjs`) names the data home: `~/.nucleus`, or
  `NUCLEUS_DATA_HOME` when set. Tom, 2026-11-09: retire the move machinery (the
  move completed 08:05 UTC that day). The resolver reads no journal, knows no
  legacy leaf, and ignores `PASEO_HOME`. A leftover
  `~/.nucleus-stage-journal.json` and a sealed `~/.paseo/northstar-queue` are
  ignored. Resolution for `process.env` is computed once per process. An
  existing non-empty `~/.nucleus` without Nucleus store markers is refused
  (another product's state); a missing or empty folder is the creation default;
  any other filesystem error is a refusal. `NUCLEUS_DATA_HOME` is the deliberate
  selection of the whole data home. Failure to name one folder fails closed in
  every consumer instead of opening the wrong store. The planner archives the
  leftover journal and the old view afterwards.
- Exactly one process owns the process lease and writable connection. The
  bridge never opens SQLite, including for health or fallback. A replacement
  standby may open the store read-only without the lease while the owner lives
  ([Spec 035](../specs/035-host-run-scheduler.md)).
- The one-shot store conversion is the only step that rewrites the file, and it
  excludes every other writer for its whole span ([Spec 028](../specs/028-store-backups.md)
  revision "every writer stays out"). It leaves WAL for a rollback journal
  (refusing if any connection holds the store), holds SQLite's exclusive lock
  through `VACUUM` and verification, and records a second connection's refused
  write before and after. An unprovable window is refused before anything is
  touched. The window (120 s conversion bound plus the snapshot) is start work:
  it uses the store-migration pid-and-spawn-token marker, and the bridge's
  readiness wait and the executor's boot bound count it, so a roll never spawns
  a second replacement beside it.
- Startup proves the prior owner is gone before taking the lease; live or
  ambiguous ownership fails closed.
- Plugin reload and client disconnect do not stop a compatible service.
- Plugin registration starts bounded background discovery: attach a compatible
  live service or spawn when ownership is absent, without waiting for a board
  read or callback. `queue.service-state` refreshes health through that path and
  never presents an untouched cache as proof of absence. Dead identity files
  stay recoverable after their socket disappears.
- Routing reads Nucleus-owned profiles and computes availability from the host catalog.
  Until its first successful profile-catalog refresh, a started service treats
  profile availability as unknown, not unavailable. Launches and dispatch wait
  visibly ("Waiting for the daemon profile catalog to load after service start")
  and named-profile controls refuse as retryable; nothing parks, escalates or
  remaps. A failed first refresh keeps the wait; any loaded catalog, even empty,
  makes availability real (2026-10-20).
- `host.catalog` answers from the catalog Nucleus stored for that host and
  directory, with the time it was read (`readAt`); it is a stored record, not a
  live claim, so it answers while the daemon is disconnected (Tom, 2026-11-09:
  "keep a cache of it in the DB and add a refresh button"). Only the first read
  with nothing stored, and `refresh: true` (Settings → Profiles' Refresh), read
  the host live and replace the stored copy; a live read refuses on a
  disconnected daemon, and a failed refresh keeps the stored copy. A provider's
  host availability and problem are stored with the catalog and change only on
  a refresh. Only Settings reads it: routing, selection and dispatch read the
  host's catalog live through the engine's own refresh, never the stored copy.
- Bootstrap marks submission processing ready before resuming accepted operations.
  A service restart reconciles interrupted operations; a host reconnect preserves
  handlers still running in this process.
- The first post-bootstrap reconciliation walks the whole active fleet. Queued
  tasks that never started are left to dispatch and dependency wakes, so queue
  depth adds no cost (2026-11-06). Its 60 s bound
  measures a stall: each window in which a lane quantum finished re-arms it, up
  to 10 minutes. A stall reports "made no progress for 60000 ms"; a late finish
  clears its diagnostic (2026-10-21).
- A detached service continuously verifies that its owner-only identity names
  its PID, build and socket; on loss or replacement it drains rather than
  surviving as an orphan. Removal never deletes another PID's identity. A roll
  drain keeps that identity while the draining pid is still alive, so any spawn
  that sees a live owner pid starts as a standby for it. Idle drain and stop
  still drop identity once the socket is released.
- Any spawn while an owner pid or lease is alive starts as a standby for that
  pid, including a retry whose socket is already gone. A dead pid is the only
  case that starts a writer. A spawn opens the store the bridge already
  selected (`--data-dir`), the same argument MainChannel uses, so the child
  serves the store the bridge resolved.
- Build replacement drains to a durable safe point, releases the socket, then
  starts and verifies the new process, never killing uncertain effects. The
  host-run scheduler socket is make-before-break: the new process binds a staged
  socket, proves it answers and renames it over `run/scheduler.sock`
  ([Spec 035](../specs/035-host-run-scheduler.md)). Backend digest changes
  coalesce to one roll 60 s after the last. A due roll waits up to 15 minutes
  while a heavy run has an attached follower unless the operator forces it;
  deferrals are recorded on the roll. Activation of `current` and the installer
  entrypoints is a step of that roll: a failure stays `retrying` with the error
  in detail and is retried on each check; `rolled` waits until the service
  answers the target build and that activation has succeeded.
- The identity file records the spawning login session (`SECURITYSESSIONID` on
  macOS, `XDG_SESSION_ID` on Linux, or `getsid` / `/proc/self/sessionid`); a pid
  is not a session. A bridge in another session drains and replaces the service
  like a build change. A `gh` failure containing `OSStatus -26276` is that
  environment fault: the service drains rather than charging a task.
- **Effigy runtime identity** ([Spec 035](../specs/035-host-run-scheduler.md),
  "Runtime identity"). The admission hook attests the workload's process chain
  by pid; the service resolves those images, asks each for `--version` by
  absolute path, binds the first that answers as Effigy (path, version, bytes)
  and uses that path for every run-control read. No build is declared or pinned
  (Tom, 2026-10-26): an in-place rebuild is recorded as `effigy_runtime_drift`,
  and only an executable that no longer runs refuses. `settings.json`
  `effigyRuntime` carries only an optional `minVersion`; the retired
  `{ path, sha256 }` pin parses and is ignored. A `PATH` name, an absolute
  workload CLI or a caller-supplied path is not the identity. The digest is
  cached while the file identity (path, device, inode, size, mtime, ctime)
  matches, and retired rows are observed on a slow cadence. A hook already proved
  live at the same pid, epoch and identity has its start identity re-read at most
  every 20 seconds, while the kernel liveness test runs every tick; no dead or
  unknown answer is cached.
- Without a verified binding the reservation keeps its capacity with a recorded
  cause until it reads to a real terminal result; the service never spawns a
  substitute, invents success or refunds on unknown identity. Bindings and
  refusals live in internal meta (`hostRunIdentity:<runId>`, epoch-bound), never
  in the pinned contract 010 record that `host.run.list` and
  `host.run.capacity.release` carry. Old reservation rows stay readable and are
  never observed.
- **Accounting disposition** ([Spec 035](../specs/035-host-run-scheduler.md),
  "Operator accounting disposition"). The operator may retire one launched
  reservation's capacity accounting while outcome and custody stay unknown; only
  the charge stops, never settlement, release, cancel or a quiescence claim. It
  needs the operator's board identity (or an authenticated relay with the
  operator's note) plus a separate exact-run, current-epoch risk acceptance, and
  validates the authority epoch, the row's launched and unsettled state, the
  record digest the caller read and the retained request evidence. The
  disposition lives beside the row (`hostRunAccountingDisposition:<runId>`) with
  its journal fact, never in the contract 010 record, whose shape, digests and
  settled-only release are unchanged. `host.run.accounting.status` is the read
  (and the confirmation after a lost reply); `host.run.accounting.list` is the
  board's bulk read. Same operation id and input observes the same disposition;
  a mutated retry, second operation, changed row or unreadable key releases
  nothing. Later evidence reconciles without resurrecting settlement or the
  charge.
- **Automatic accounting retirements (Tom, 2026-10-25, "Auto-free them").** The first two paths below are installed; the v2 terminal and coverage paths are approved, not built. Each
  retires only the charge, never claims cleanup, custody, a terminal outcome or
  headroom, and keeps the charge with its recorded cause on any failed, partial
  or contradictory proof. Each writes its own private sidecar format. A
  retirement is accounting only, so the reservation itself reaches its terminal
  state through the ordinary settlement: a launched admission whose recorded
  hook is gone settles `lost` on the next watch tick or sweep, and the producer's
  own answer, when there is one, travels in that settlement's journal fact as
  evidence (never as a contract 010 result):
  - producer reports that run's `checkout-journal` cleanup complete (Spec 035,
    "Automatic accounting on producer cleanup");
  - hook dead by recorded identity and the bound runtime answers that Effigy run
    id with `not-found` and `not-recorded` together
    (`queue.host-run.accounting-absence-retirement`, basis `foreground_absent`,
    policy `spec-035/automatic-accounting-on-foreground-absence`);
  - a v2 admission's own `foreground-terminal-record.v1` with
    `cleanup: complete` and a workload verdict
    (`queue.host-run.accounting-terminal-retirement`, carrying `checkout_id`,
    `boot` and the cross-check state; earlier stored retirements still parse);
  - a v2 admission with a dead hook, acknowledged-prefix coverage, no terminal
    record within retention, and every reported owner, guard and leader dead with
    every group proving `ESRCH`
    (`queue.host-run.accounting-coverage-retirement`, policy
    `spec-035/no-terminal-coverage-release`, decision `d3bad004` v2, naming the
    accepted escaped-process risk).
- Build identity hashes the declared generation, protocol version, RPC method
  names and file contents under `server/**`, `shared/**` and the service entry
  point, derived once from the installed source path; an unreadable backend set
  refuses comparison. Git state, docs and client files do not change it. The
  declared generation remains a manual replacement override.
- The bridge rolls only the configured main channel. A verified local main
  build replaces the service after the 60 s settle window and any follower
  deferral; a failed build keeps the running service and reports through
  `queue.service-state` ([release](release.md)). Linked-checkout rolling is
  retired (Tom, 2026-11-09).
- Crash recovery starts from durable facts and preserves current restart,
  reconciliation and pause behavior.

## Compatibility

Existing plugin RPC names and schemas remain valid across cutover. Callback
tickets, report helpers, MCP tools and operator commands keep their paths and
credentials. The submission, administrative and generic Nucleus CLIs connect
directly to the authenticated socket by default. Health publishes the protocol
version and a per-method input/output contract digest; the CLI computes its own
from its checkout and may use a running service when protocol and that method's
digest match, even if whole-build identities differ. A mismatch or missing
method fences that call. While the bridge reports a deferred, typechecking,
replacing or retrying roll, the CLI waits up to ten minutes for a compatible
service and reports progress; a failed roll or expired wait is reported clearly.

The checkout CLI follows static imports, re-exports and literal dynamic imports
from its schema and local-client entries, including sibling declaration files. It
fingerprints exactly that transitive local closure before and after loading. On a load failure or mismatch it waits for three
matching fingerprints and retries from a private snapshot matching that proof,
which the contracts and local client then share. This finishes before any
request is sent; a persistent failure fails visibly.

`--via-paseo` explicitly selects the compatibility bridge. Clients never fall
back, replay a write without proof it was never received, or open SQLite.

### Rolls: calls wait out the replacement (Tom, 2026-11-09, papercut 15754c8d)

A roll happens on every merge, so a call that arrives while the service is
being replaced is the everyday case, and it keeps its answer:

- **Preparation keeps serving calls.** Builds, typechecks, settle deferrals and
  startup proof run while calls continue against the running service. Only the
  actual handover is recorded as `replacing`; an aborted handover reconnects to
  the running service. Roll failures stay on the roll record and board fault.
- **Reads wait for the replacement.** A read-only call whose transport fails
  during the actual handover waits, bounded, for a service to answer, then
  answers from it. The bound is the roll's own readiness budget (the CLI's
  compatibility window; the bridge's roll-call wait), and a roll that outlives
  it reports why.
- **Undispatched calls retry safely.** A call that fails before dispatch may
  retry against the running service after a handover aborts. A lost mutation
  response still requires a recorded outcome; a failed recovery reports unknown
  with the request key rather than substituting the roll error.
- **Mutations return their real outcome.** A mutating call carries a
  client-minted request key on its frame. The service journals the request as
  `received` before its handler runs and records the definite outcome — the
  result, or the typed refusal it settled with — durably in store meta (the
  request ledger, `core/runtime/request-ledger.ts`, one bounded journal like
  `capacityChanges`) before the reply frame is written. When a response is
  lost mid-roll, the client waits for the replacement and asks it
  `service.request-outcome` for that key: `applied` returns the recorded
  result exactly as the lost response would have carried it; `refused` replays
  the exact typed answer; `not received` proves the request never reached a
  service, and only then may the client resend the same request with the same
  key. A settled key never runs its handler again — the same key with a
  different method or input refuses. "Unknown" survives only where no service
  recorded anything, and it names the key, the confirming read and the
  `service.request-outcome` ask. Durable operations keep their own keys and
  receipts; this ledger is the transport's, not a second operation kind.
- **Host-dependent calls wait for the plugin bridge.** A delegated answer (and
  any call that must verify a host) arriving just after a replacement waits,
  bounded, for the service's own daemon connection to answer again instead of
  refusing as unavailable or ambiguous; only a bridge still unavailable after
  the bound refuses, bounded as before.
- **Ticket caller resolution reports the handover.** CLI identity resolution
  uses a callback socket pinned to the old service, so during the replacing or
  retrying handover it reports the stage and elapsed time immediately. Build
  preparation still serves calls. No CLI control is sent until caller identity
  has been resolved.
- **Both direct surfaces share it.** The CLI client (`localQueueClient`) and
  the Paseo plugin bridge (`ServiceBridge.forward`) recover through one module
  (`shared/service/roll-recovery.ts`), so the operator's shell and the board
  answer the same way. The web board and other callers without a key keep
  today's behavior.

Proofs: `test/roll-call-recovery.test.ts` (the real socket with a proxy that
loses one response: the applied outcome returns from the replacement exactly
once, a proven non-receipt is resent once, a read answers from the
replacement, the refusal replays, a malformed key fails closed and the
no-roll case keeps the unknown-outcome answer); `test/service-roll.test.ts`'s
serial oracle (a full bridge-driven two-build roll with the CLI on both
sides); `test/request-ledger.test.ts` (the journal's store proofs);
`test/question-delegation.test.ts` (the delegated answer's bounded bridge
wait).

Handoff submission captures the approved committed instruction locally and
returns a durable operation receipt without waiting for remote validation.
Acceptance is not validation or dispatch. Pushed-planning, dependency, hook and
recipient checks run inside the operation; unavailable Git or Paseo leaves it
pending for paced retry and invalid planning fails visibly. Quiet handoffs
resolve no recipients. Dry-run awaits validation and stores nothing. Read the
operation status for the task ID before using it as a prerequisite.
Backpressure means no operation was accepted.

`queue.operation-status` is observation unless the caller supplies
`reconcilePreSendInputHash`, which may settle a matching attention-held
task-control receipt without executing it; missing or conflicting execution
evidence refuses ([Spec 012](../specs/012-durable-asynchronous-operations.md)).

`queue.review-entry-preview` and the durable `review_entry` operation accept an
existing isolated workspace ([Spec 017](../specs/017-external-pr-review-entry.md)).
A Nucleus-held brief's exact approval and the external PR identities are verified
before source and task bind atomically. `shared_canonical` gets the typed
`exclusive_writer_unavailable` refusal before inspection. Nucleus never switches
the source checkout branch. Preview reports `pendingHandover` beside `eligible`:
a positively read active or uncertain writer is accepted as a handover, and
admission waits for a fresh idle proof before any reviewer runs; unreadable
activity refuses. Only the operator-only `queue.review-entry-reconcile` rearms an
attention-held review-entry operation, after a complete absence proof and a
fresh preview.

The durable `task_control` operation carries the Spec 050 `proof` action
([Spec 055](../specs/055-source-immutable-proof-executor.md)) as an external
effect: acceptance is durable before dispatch, the proof-only `executor` run uses
the ordinary creation and admission path, and an unknown creation or delivery is
reconciled from stored identity, never replayed. It writes no source, publishes
no review and reaches no merge path; `proofExecutions` and the `proof_executed`
callback status ride the existing surfaces.

If the service is absent, incompatible or unhealthy, the bridge returns a typed
state; it never starts an in-plugin Nucleus, inspects SQLite or infers failure
from an unknown response.

`queue.snapshot` is a live-fleet compatibility read: non-terminal tasks only,
without `handoffText`, briefs or events, paged by optional `repository`,
`project`, `limit` (default 100, max 250) and `cursor`. It never enumerates
terminal history, even terminal tasks still on the board. `queue.detail({
taskId })` returns one completed task in full, `queue.telemetry` aggregates by
window and `queue.outcome-search` pages terminal rows. Telemetry returns at most
100 group rows, reviewer rows per group and values per filter dimension, with
omission counts; `repoPath` gives an exact repository aggregate. Any response
over the frame ceiling gets a typed error naming method, size and ceiling, and
the latest refusal is kept in owner-only `oversize-response.json`.

## Agent interfaces

New worker, reviewer, coordinator and proof-executor MCP configurations expose
only `nucleus_report`, `ask` and `tell` (with the `nucleus_ask` and `nucleus_message` aliases); older configurations
without an explicit scope keep their administrative catalog. This is discovery,
not authorization: callback authentication and server gates stay mandatory, and
retained sessions need no recreation.

`nucleus_report` takes its run from the session's own binding. It fills in the
bound `runId` when omitted and refuses a report that names any other run, naming
the bound one, without forwarding or recording anything (queue #535, papercut
5ac8ffb0: a reviewer mistyped one character of its runId, read its own report as
accepted, and Nucleus had no receipt). When that ticket lives under the current
data home the refusal names a resend with the bound runId, or omit runId. When
the ticket is outside the current data home the refusal tells the agent not to
retry that callback: the next restart or dispatch relaunches the role on a
fresh thread. The report
path names the exact active run only when the agent has exactly one.

MCP and the standalone report helper share callback HTTP transport, error
handling and bounded waits, with no automatic replay, and keep their routes and
event-ID construction. Operator CLIs share the authenticated direct client. Run
tokens never become operator credentials, and nothing writes SQLite directly.

## Responsiveness

The bridge performs bounded serialization and local transport only and awaits
no lifecycle effect. The service accepts mutations through durable operations,
runs keyed work lanes and serves compact revisioned projections.

Routine dispatch, audit, origin routing, lifecycle and notification reads select
live tasks or explicit pending obligations before parsing payloads. Terminal
recovery, disposition, checkpoint, notification and cleanup obligations remain
eligible. Capacity and side-effect boundaries read current durable facts;
archive-sharing proofs keep the broader ownership check.

Health caches the retained task count between identity changes;
transaction-local reads are uncached. Board facts use their own durable
revision: task, run, notice, operation, outcome and board-configuration writes
invalidate them; history-only events and hook records invalidate only
telemetry. An observation-only write (`lastObservedAt` with no status, activity
or other substantive change) spends neither a board nor a telemetry revision (Tom, 2026-10-25). The
45-second unsettled counters read `lastObservedAt` from the rows, so a fresh
observation registers at once and an elapsed boundary needs no write. Workspace
lifecycle signals invalidate matching cached availability, and an in-flight
read cannot repopulate across an invalidation.

The executor serves every catalogue read on its one thread, so nothing running
there may hold that thread unbounded. A board, `queue.snapshot`, `task.next` or
`queue.detail` read takes the store and cached host views only: it awaits no
live host call and no mutating operation, and a host call that outlives its
admission deadline is abandoned rather than waited on. The removals that delete a
whole populated checkout go through `removeTree`
(`core/workspaces/tree-removal.ts`), which runs node's walk on libuv's pool:
sibling worktrees, orphan checkouts and an archived owned worktree. An archived
orphan is first moved to a quarantine sibling by a synchronous rename, so the
tree the asynchronous walk removes is exactly the tree the synchronous proof
validated. Two bounded synchronous removals remain and say so where they are:
one run's recorded TMPDIR leaf in the store's retention and release paths, one
recorded evidence head under the report's 32 MiB proof budget, and the private
directory holding one migration snapshot. `service.health.requestTimings.held`
names a request that still does hold the thread, with its age.

The 2026-11-13 09:55Z sample is consistent with that shape rather than proof of
it: its only busy thread was a worker in the service process, inside node's
synchronous `lstat`/`unlink`/`rmdir` recursion (the V8 frames are unresolved),
while the request loop sat idle in `kevent` and every read timed out at the
client. The sample names no call site. Reads are served on the persistence
executor thread, so a blocking removal there explains the timeouts, and that is
the candidate the read path implicates; the other recursive-removal holders in
the repository run in a separate process (the backup CLI) or a different worker
(the host-run front) and cannot block a read (nucleus#1179).

An observation pass reads Paseo through one bounded inventory: one
`agents.list` over the Nucleus label set, live threads only, walked to the
daemon's positive end. Archived history never enters the walk. A listed identity
is answered only when its entry carries every field `observe` reads (status,
active turn, pending permissions, workspace, labels, runtime info, activity
stamps), with the same result as a direct read (an idle status with a live turn
still reads active). Anything else (absent, missing a field, or a partial,
repeated or unended list) takes the narrow per-agent read, so a list never turns
missing evidence into inactivity. Retired workers are re-read every two minutes,
or at once on a lifecycle signal for that identity or workspace; a pass with
nothing due makes no call and writes nothing. Their unsettled counter allows
that cadence plus 45 s. Charged admission watches keep their one-second tick and
runtime verification; only the hook start-identity read uses the slower Spec 035
cadence. A worktree-validation scan answers for one lifecycle pass
([orchestration](orchestration.md)).

Lane views (`laneViews`, the board's `lanes`) derive only from lanes, permanent
outcomes, live lane membership and phase, and newest event time per task. One
outcome-by-lane index is built once and extended as outcomes are written, and
built views are cached against a clock that SQLite triggers advance on every
write to those six tables, including writes that bypass the store's funnels.
Notice, project, operation, run, configuration and history-only hook writes
leave them alone. A transaction never populates a cached view.

Task rows stay slim ([orchestration](orchestration.md) "Task rows stay slim").
Instruction text shared with a brief version is resolved from that version by its
exact digest. A distinct handoff or brief keeps its own bytes in the task row;
reads verify referenced bytes. Review findings shared with a run completion are
resolved from that run and checked against their digest. Distinct findings stay
with the review. Lane-document pins resolve by key, version and digest from
`lane_documents`, refusing an unknown version or mismatch and never substituting
the current document; a legacy pin no stored version proves keeps its text
inline. Observation-only fields (`lastObservedAt`, `agentActive`,
`lastAgentStatus`, `idleSince`) live in `task_observations`; such a write spends
no task version or board revision, and readers still see the same values. Side
table writes advance the projection's `writes` clock like a task or run write.
Every task and run funnel acknowledges its write once its in-memory maps hold it
and before any synchronous callback (shadow wait capture, event callback,
`taskChanged`), so those reuse the warm projection; only bypassing or
rolled-back writes invalidate it. Status or activity changes still spend a
version. Schema 45 migrates every row and refuses the upgrade if a public record
would change; the snapshot precedes the schema steps. The side tables are
operational: never portable, purged with their task, empty on import. Older
backups migrate the same way; an older build refuses the file by schema version.

A rollback invalidates exactly what it touched. Projections keyed on a
`projection_clock` row revalidate on next read and rollback rewinds those rows,
so unrelated projections stay warm. Task and run funnels journal touched entries
and restore them after rollback; bypassed writes or a changed clock still rebuild
from committed rows. The two clockless caches (task number, lane activity map) are
reset and rebuilt from committed rows. The 45 s counter and the projected task
row agree across a rollback.

Lead reads never parse retained history to answer a narrower question. Detail
carries the current version in full and earlier versions as metadata, with
SQLite dropping superseded bodies. Check, approval and promotion read only the
exact version or digests they name. Open-lead reads use the `leads_state` index.
Lane activity joins a maintained lead-to-lane index written in the lead's
transaction (and rebuilt when bypassed), never `json_each` over every lead.
Stored versions, bodies, digests and approvals are unchanged.

Planning history is stored as reverse deltas
([Spec 026](../specs/026-planning-records.md#revision-lead-and-lane-document-version-storage-2026-10-25)):
latest version and every 32nd in full, others as reverse line deltas. A rebuild
applies at most 31 deltas from the nearest snapshot; a longer chain refuses as a
missing snapshot. Every rebuilt body is checked against its stored digest (and
recorded contract digest, if any) on every read, including cache hits (at most
64 entries, 8 MiB), and any corruption, missing base, unsupported format or
truncation refuses with its own message. A check or approval writes metadata
without reconstruction; a new version writes in full and demotes its
predecessor in the same transaction. Approval and promotion compare original
reconstructed bytes. A backup carries the full versions with the same digests.

Plan reads (`plans`, `plan.get`) share the lane revision plus a plan write
clock. `plans` reads projects and lane rows once per call and returns each
current lane projection with the saved entries used to distinguish planned
steps from newly joined lanes; Planning therefore does not fan out one
`plan.get` per project. Each project's Done band is cached against the `plans`
clock, which triggers advance on every `project_plans` write (save, merge,
import or bypassing repair). A requested version returns exactly as saved, the
latest row is parsed in full every call, and both caches drop on rollback.
`plan.get` uses the same derivation as `plans` and remains the exact saved-version
read for callers that request one.

Selected-task detail keeps a service-local LRU of at most four entries and
8 MiB. Task, event, run, notice, hook and operation writes invalidate the entry;
rollback clears it and transactions never populate it. Dependencies are read
fresh, a 15-second maximum age bounds staleness, and `telemetry.generatedAt`
gives the derivation time. No effect gate uses this cache. `task.next` reuses
that entry's evidence only when it was read at the task's current version; the
task row, version, pause, holds, retry records, usage policy and every authority
or side-effect observation stay fresh, so no verb is offered from another
version's facts.

The executor publishes full boards only on board revisions (including operation
and PR-display changes); between them it sends compact counter/error
acknowledgements that merge into the retained board.

The native surface fetches only the projection for the visible view:

- initial board load returns compact unfinished-task cards and global counters;
- task detail loads one task and its bounded recent evidence after selection;
- telemetry, profiles, subscriptions and limits load only when opened;
- unchanged refreshes return a revision acknowledgement or bounded delta;
- no UI route calls the live-fleet compatibility snapshot.

Planning lists read the revisioned `lead.board` projection, which serves
Triage, Planning, Lanes and the project selector with list metadata, a bounded
body preview and the card facts. Its cards are the open leads plus promoted
leads that still have a draft or task target and a repository without one;
other promoted leads appear only as link facts for an open decision. It runs in
SQLite JSON functions and is reused until a lead, papercut or decision write
advances the planning-list revision. Opening a record reads `lead.get`;
`lead.list` stays the full-body read, and no agent or skill interface depends on
`lead.board`.

A full board projection carries `planning: {leads, decisions, plans}`, one read
key per planning list. `leads` is the planning-list revision; `decisions`
advances on any `decisions` row write; `plans` advances on any `project_plans`,
`lanes` or `projects` row write. SQLite triggers move the last two, so a
bypassing write and a rollback stay exact. Each such write also advances the
board revision, so the bounded acknowledgement carries no planning keys. A run,
event, observation or telemetry write moves none of them.

Every projection has a response-size bound and pagination or a narrower cursor
before history can exceed it. The service never serializes full task, handoff,
event or run history to derive a card or count. SQLite and full-history
validation run behind one service-local asynchronous executor with short,
serialized transactions; callers never scan the database on the request loop.

## Outbound Paseo load

Nucleus treats Paseo SDK work as a bounded external effect. A task callback or
task-scoped control schedules only that task's lane, never a full-fleet pass. A
submission, promotion or released slot schedules only that repository's queued
lanes. The safety sweep runs every 20 seconds as one bounded cursor page;
profile refresh is a separate slower pass.

An explicit reconciliation (`wake()`: bootstrap, refresh, operator
configuration) ends at a bounded drain cut: a full drain pass that started after
the request has covered the fleet, then the already-scheduled lane work and
lifecycle follow-ups outside the audit lane have settled, then the title
projection has drained. Cleanup is kicked, never awaited: a workspace archive
legitimately runs for minutes, its own durable retry record carries its
progress, and the post-bootstrap diagnostic is a reconciliation question, so a
slow archive never holds it. It does not wait for audit-lane safety-sweep
windows, which can keep that lane busy indefinitely. A drain requested during a
drain gets another pass. A failed or stopped pass credits nothing; its callers
are rejected and the fault stays in `engineError` and the post-bootstrap
diagnostic. Stable agent and workspace facts stay cached until a relevant event,
observation, bounded expiry or restart reconciliation makes them stale.

The bridge forwards only bounded `agent.created`, `agent.turn_started`,
`agent.turn_ended`, permission, archive and workspace lifecycle signals, each
with only the event name and agent/workspace identity. The service maps a signal
only to known identities; an unknown one schedules nothing, and no signal
authorizes a fleet scan or delivery.

The service coalesces equivalent observations and title updates by identity and
limits concurrent and per-window SDK requests through admission classes (total
concurrent calls is the Paseo-call limit, default 6, 1–32, applied without
restart); workspace creation and archive have explicit admission. Cleanup admits
at most four concurrent effects within that global limit, covering both thread
and workspace archives. Required callbacks, operator controls and turn delivery
outrank workspace creation;
workspace creation outranks background observation, inventory, titles,
origin-health refresh and cleanup. Agent creation uses the control class and
already outranks observation. A phase transition may enqueue one idempotent
title update; ordinary wakes do not walk retained workspaces, and confirmed
titles make no request. Backpressure delays work durably and visibly.

After the dispatch itself has populated its owned worktree, workspace
registration may skip the live `git worktree add` process scan: the completed
populate call is the current proof that add has finished. Recovery and all
other workspace inspection retain the full process scan before classifying the
worktree.

An ordinary lease check proves only identities that still own work: the current
worker, an assigned coordinator or reviewer with a live run, unreleased runs and
identities named by a persisted uncertainty. Released historical agents are not
polled.

**Degraded-state breaker.** New workspace creation and nonessential workspace
mutation are deferred after three completed observation, workspace, title,
cleanup or inventory calls each take at least 10 seconds within a rolling 60
seconds. One slow or long-pending call is only a health warning. Timing sits on
the daemon client's single-request methods (`fetchWorkspaces`, `fetchAgents`,
`fetchAgent`, `fetchAgentTimeline`, `archiveWorkspace`): each page of a walk is
one sample and subscriptions are never timed. A workspace archive (Nucleus-owned or
catalog-only external) is admitted as one cleanup call but each daemon request
inside it is its own sample, and its Git and filesystem work is not Paseo
latency (Tom, 2026-10-23); a request still outstanding when the archive settles
stays pending, and none started after is sampled. Its samples are
breaker-exempt: they keep their cleanup slot, their latency record and their
visible pending state, but the breaker neither trips nor recovers on them,
because an archive legitimately runs for minutes (median 238 s, max 1,432 s on
2026-11-05) and its duration says nothing about whether Paseo answers (Tom,
2026-11-05). It keeps its four-slot cleanup bound, so a stuck archive holds
only its own slot and stays a health warning that names the exemption. Thread
archives, which answer in under a second, still count. Slow pages, slow
observation, workspace, inventory and title calls and transport
failures still trip admission; a disconnected transport trips at once. The trip
reason records classes and latencies. Title and archive work recheck admission
just before starting; deferred effects keep their intent, and a held task names
the breaker and its re-check time.

A breaker deferral is not a failed attempt: a terminal archive records no
attempt while the breaker holds, a mid-attempt deferral neither counts nor
doubles the retry delay, and a deferral-only retry record is due on the first
admitted pass, so merged tasks archive as soon as it clears. New
preserved-external deferrals are held catalog records with the bare breaker
prefix. A pre-fix row stored as uncertain with no intent and the request-wrapper
prefix is the same deferral and is replayed, because `allowed()` is the only
intent writer and runs just before the native call. An uncertain throw that only
resembles a deferral, or already wrote intent, stays observed and is never
auto-replayed. Recovery needs a 30-second quiet period after the latest slow or
disconnected call, no overdue call running, and bounded successful
observations; failed probes do not count, and a timeout never implies success.
A workspace admission budget equal to the global task-slot limit delays only new
creation and says so; retained workspaces and stored limits are untouched.

**Held slots have a deadline and an owner.** Every admitted host call is a
named holder for its class and identity, and every one of them has a deadline:
the ordinary 60 seconds, or the long bound for the effects that legitimately
hold a slot while bulk local or native work runs — a workspace archive, creation,
recovery or closeout, which are bounded by 30 minutes, above the ten-minute bulk
Git budget and the 1,432-second archive maximum. The observation inventory pass
gets the long bound as a whole because a legitimate walk accumulates pages, while
each page keeps the ordinary bound, so one stuck page is abandoned in a minute
and the pass itself may finish (nucleus#1179 review 5890172363). The exemption is
per effect, never per class, so `archiveAgent` and `reconcileSettledThreads`
(cleanup) and `recoverTaskWorkspace` and `createCloseoutWorkspace` (workspace)
are abandoned at the ordinary bound like every other effect (nucleus#1179 review
5889669364). A call past its deadline is abandoned as unknown: the caller
receives an unknown-delivery answer naming the holder and how long it held, the
class and total slots are released, and the call is never resent. A late answer
from the host belongs to nothing and is discarded, and an abandoned effect that
starts another request has it refused rather than sent outside the admission it
no longer holds.
`service.health.admission` names every held slot past five seconds (`heldSlots`:
class, holder, age, deadline) and the last abandoned call, and logs a wait for a
slot with the oldest holder and its age. `heldSlots` names the admitted effect
that holds the slot, including an inner-timed one whose individual requests are
the pending calls. The freed bound keeps bounding instead of shrinking to nothing
because one host call never returned. An abandoned call is reconciled from
recorded state, exactly like any other unknown delivery (nucleus#1179).

Nucleus has no global lane cap (Tom, 2026-09-27). One active quantum per key
still holds, so no task or repository races itself, and per-repository
integration effects stay FIFO. Spawned processes (Git, hooks) share a fixed
internal bound at the spawn site. Long project validation runs as a durable
background execution off the lanes; its completion enqueues the task's next
quantum, which consumes the outcome for the same base, head and command. An
outcome decided before a run (merge conflict, unbuildable candidate) reaches
the task the same way instead of relaunching.

Title retries use bounded exponential backoff with their idempotency key;
repeated wakes never resend a failed rename. Title and archive projections drain
on their own serial lanes, so they never hold a callback, control or turn lane.
Completion is separate from cleanup: once terminal evidence is durable, archive
work drains serially and restart-safely without repeating delivery.

A slow interruptible sweep is the restart and missed-event safety net: durable
cursor, bounded pages, yields between quanta, never blocking health, compact
reads or task controls; an explicit reconciliation drains pages until the cursor
covers the fleet once. Nucleus records SDK latency per admission class and
publishes class depth, coalescing, admission wait and breaker state in health
and telemetry; hook occurrences keep their own duration, and database and Git
timing stay in their reconciliation records.

## Deployment

Cutover requires a consistent SQLite backup, clean canonical repository, full
QA, exhaustive RPC parity and rehearsal against a copied production-size store.
Reload only the plugin; never restart Paseo.

Rollback may restore the prior backend only after the service drains, closes
SQLite and releases its lease. Both directions reject concurrent ownership.

### Executor request timings

`service.health.requestTimings` reports the executor's in-flight count and the
last 32 settled requests: method, timestamp, outcome, `queueMs`, `handlerMs`
(including async waits), `publicationMs`, `returnMs` and `totalMs` (the executor
round trip, excluding final output validation, socket delivery and client
parsing). It also reports `held`: the requests outstanding past a five-second
threshold with their method, age and start time, the in-flight total, and how
many arrived after the oldest one started. `held` is read on the request loop,
so it answers while the executor thread is blocked: a read that had to queue
behind an unyielding request is named with its holder and age in
`service.health`, and the same holder is logged once per 30 seconds while it
keeps the thread (nucleus#1179). Parent-served cached health and board responses
make no sample.
Timeouts and unavailable-worker failures carry total time with null stages.
Samples hold no inputs, task IDs, paths, credentials or error messages, are
memory-only and reset with the service. Successful replies clear their timeout
at once.

### Executor liveness

`service.health` and `queue.ui-snapshot` answer only while the persistence
executor is live and its last publication succeeded; otherwise both return
`unavailable` with the cause (worker error or exit with kind, time, exit code,
bounded message and stack, or an unpublished projection since failure). A stale
board never answers as current, and requests fail closed once the worker is
gone. A deliberate drain is not a fault. The latest death is kept, with its
service pid, in owner-only `queue-service-executor-fault.json` beside the socket.
A worker death also drains and exits the standalone service, so the bridge starts
a replacement that reconciles from the store. A projection fault doesn't, because
that worker is alive and recovers on its next publication (2026-11-06: one
`database is locked` left the service refusing everything until it was stopped by hand).

### Event-loop delay

`service.health.eventLoop` reports the runtime executor thread's event-loop delay
(`monitorEventLoopDelay`, 10 ms resolution): `p50Ms`, `p99Ms` and `maxMs` over a
window of up to 60 s (`windowSeconds`), plus `maxSinceStartMs`, memory-only. That
thread serves every store read and the host-run endpoint's private socket. A
dedicated front worker owns the public `run/scheduler.sock` and pipes clients to
the runtime, so a blocked executor delays replies instead of filling the accept
queue (Spec 035, "Accepts off the runtime loop").

The host-run module map keeps isolated processes independent of the store:
`host-run-files.ts` owns verified file IO, paths, discovery reads and socket
handoff; `host-run-token.ts` owns token keys, claims and signing;
`host-run-wire.ts` owns request and supervisor schemas and launch environment.
The supervisor and front worker import these primitives directly, without the
endpoint or store. `host-run-endpoint.ts` re-exports the existing public names
and delegates serving and rebinding to `host-run-serving.ts`, retained output
and sweeps to `host-run-retention.ts`, supervisor observation and settlement to
`host-run-watch.ts`, and followers and disconnect deadlines to
`host-run-attach.ts`. Each receives a narrow context and never imports the
endpoint. `host-run-endpoint-types.ts` holds their shared constants and shapes;
the endpoint keeps submission, request dispatch, facts and lifecycle coordination.

Exact-head Git identity (HEAD, branch, common dir, origin) is read from the
checkout's files, including inside a transaction or a `stillAllowed` send guard.
Working-tree cleanliness (`status`, `diff`, `ls-files`) is async git: it is the
last await before send or a transaction, and it delays that task, not the
executor's other work. A retained reviewer continuation proves cleanliness,
then placement (workspace refresh plus filesystem identity) is the last await.
The transaction then re-reads identity from the filesystem. Git objects are
immutable, so an unchanged HEAD is still the same tree; a dirty tree at the
same HEAD is refused by the proof taken milliseconds earlier. A reftable-format
checkout fails closed.

`service.health.hostRunEndpoint` is `{ serving, error, heavyFollowers,
retentionError, retentionFailures }` when the standalone service enables the
endpoint, else null. A process without a bound socket retries the bind and
reports why; a live holder (pid plus start identity) is never taken over.
`serving` needs both the front's live inode and the runtime's private listener.
`heavyFollowers` counts unsettled heavy runs with a live attach client; the
bridge reads it from live health on each roll decision, so a settled follower
cannot hold the 15-minute cap. `retentionError` is the bounded summary of the
output-retention sweep's failures (exact count, up to 5 named runs, and how many
more are recorded), and `retentionFailures` is `{ count, firstSeen, lastSeen,
examples, examplesOmitted }` or null (Spec 035, "One stuck run does not pin the
sweep" and "Every failure identity is durable; only the summary is bounded").
Failures are rows in `host_run_output_failures` (one per run id: epoch, reason,
first and last sighting, attempts, next retry). A run that could not expire
keeps its bytes and stays listed until its own success (or verified Project-QA
ownership clears a false positive, with durable evidence), never blocks another
row, survives restart and cursor wrap, and is retried from its own due page.

The host-run state root follows the data directory: only the live data directory
uses `~/.local/state/host-run`; a non-live service defaults to
`<dataDir>/host-run` and refuses the live root even when configured, unless a
test-only opt-in names it. `HOME` alone cannot share the live scheduler socket.

**Admission socket.** Nucleus's Effigy v0.15 admission hook talks to a second
owner-only socket, `run/admission.sock`, beside the scheduler socket. It is not a
catalogue RPC and does not change Nucleus contract 010. The approved, not yet implemented v2 protocol would carry
custody reports on the same socket under one `event` method; the hook is acknowledged only after
the report is stored as an internal journal fact, so a lost reply is a receipt,
a failed write is no acknowledgement, and the producer refuses an unreported
spawn. The proposed v2 opt-in is the producer's own `EFFIGY_ADMISSION_PROTOCOL=2`; Nucleus
injects nothing, because contract 049 refuses a durable `--run-id` run before the
hook when it is set. Nucleus-owned worker and reviewer launches get
`EFFIGY_ADMISSION_HOOK` plus the socket path; already-reserved QA, validation and
repository-hook launches do not, so they cannot take a second slot. The hook
command carries `ELECTRON_RUN_AS_NODE=1` as a prefix on its one `/bin/sh -c`
command, so it runs as Node inside Paseo's Electron helper while the agent
shell, merged environment and workload gain no such variable. Tom approved this
integration (2026-10-20); wait, custody, candidate identity, qualification and
cutover rules live in [Spec 035](../specs/035-host-run-scheduler.md).

Admission confirmation is credited only by a received reply. A received
still-queued reply refreshes the confirmation before any staleness decision; a
sent request, local retry, the 2 s bound and the service's `admission_confirm`
journal entry credit nothing. The 60 s liveness window runs from the last valid
received confirmation. `service.health.admissionRpc` (null when this process
does not serve that socket) publishes memory-only diagnostics: per method
(`reserve`, `status`, `confirm`, `bind-hook`) requests read, replies written,
undeliverable replies, dispatch errors and the server-side latency window, plus
per-reservation intervals between processed confirms, counted over the 5 s
cadence and 60 s window; `serving` is the socket's own truth, and `notes` states
what is and is not measured. Client roundtrip and timeouts stay unmeasured, a
reply into an abandoned socket is never reported received, and no run or
reservation id, selector, path, credential, output or environment value is
published. At most 64 samples per window and 512 reservations; no watch, poll,
timer, row, journal entry or file write is added.

`service.profile` (`{seconds}`, 1–60, default 10) writes a V8 CPU profile of
that thread to `<data dir>/profiles/runtime-<time>.cpuprofile` (mode 600) and
returns the path, for stalls a store-backup replay does not reproduce
(`node bin/queue-cli.mjs service.profile payload.json`).

The slot, live, maintenance and lifecycle task lists scan task blobs with
`json_extract`; Store memoises their rows per task/run write version (advanced
by every task or run write, board revision and rollback). Schema and rows are
unchanged.

Task-specific events, runs and notices use additive `taskId` indexes installed
idempotently at Store open, without a schema version change or record rewrite.
Lifecycle identity hints use transactionally maintained SQLite expression
indexes, also additive at open, for task/run scalar identities. Retired-worker
matching scans only nonremoved tasks with retired workers, including retained
terminal tasks and released runs. There is no separate identity cache or
identity authority.

**Availability cleanup.** `queue.availability` with `action: "remove"` removes a group’s availability record. It refuses while the group remains in the profile pool, is referenced by an unfinished nonremoved task, or has an unreleased run. Removing an absent record succeeds.

### Host identity registry

The runtime records a host only after its outbound connection observes the native
server ID. The configured endpoint cannot silently change identity. The legacy
single-host ID is retained for older task ingress and is registered only when it
matches the observation; a mismatch waits. A disconnected or unknown host is
not a reason to redirect its work or replay an uncertain effect. Live sessions
and admission pressure are separate for each registered identity; reconnecting
keeps that host's admission state. The local service credential remains a
same-user accident-prevention boundary, not adversarial per-host authentication.

The runtime retains one admission and breaker state for each observed host ID.
Paseo remains the default connection. Optional owner-only `settings.json`
configuration `t3code: {endpoint, bearer, probeThreadId?}` registers a second
native host with separate admission state. The bearer is issued locally with
`t3 auth session issue`, never returned by health or public settings. Initial
Paseo identity is recorded first; subsequent T3 reconnects are independent.

The [T3Code adapter contract](../specs/t3code-host-adapter.md) defines the second
host's connection and operation boundary. Before registration or
mutation, authenticate the environment, check the protocol and strictly decode
a full shell snapshot and one thread subscription; a missing method or field
refuses by name. Nightly version strings are recorded diagnostics, not an
allowlist (Tom, 2026-11-11).

T3 has no schema discovery or dry run. Pin nightly command shapes in contract
fixtures. Its decoder runs before handlers, but its untagged remote defects
cannot prove their phase; even schema-formatted failures remain unknown and
are never resent (planner ruling, 2026-11-11). Sanitized reported command and field
names are diagnostics only. Only a proven local pre-write refusal is known non-delivery.
Reported names persist on the unknown native intent. The registered permission
route also carries them into the exact owning task's durable attention; a reload
or blocked repeat does not erase them or authorize another write.
Never send a compatibility canary mutation to the operator's T3.

`host.permission-answer` requires an explicit registered host, native agent,
workspace, runtime request, typed decision and stable intent. It uses only that
host's permission-response capability and refuses unknown, offline or unsupported
hosts without falling back. Native T3 rechecks request kind and workspace;
this method grants no task lifecycle dispatch capability.
The native response binds its request to the original intent before any status
check. A lost reply stays unknown under the same or a new intent; a settled
identical answer replays locally without a second write.
Unsupported reporting, native decisions and UI capabilities remain
explicit; transport registration alone grants no lifecycle dispatch capability.
The T3 Host keeps `lifecycleDispatch` false. The Adapter enables it when the
Nucleus helper path is wired, so T3 threads report through the helper and
ticket named in the prompt, and Nucleus-raised questions land on the board.
Native capabilities are exposed through the host facade; an unsupported
capability never becomes an empty successful reply.

**Idle shutdown** (Tom, 2026-11-08, `vision.md` "Split details"). The daemon
closes ten minutes after the last host closes. "Last host closes" means no live
observed host connection in the registry and no bridge presence. The bridge
requests `service.nucleus-bridge-presence` on its retained connection — since
nucleus#971 it is the one presence form; the legacy `service.host-presence` RPC
is refused as an unknown method. The claim is granted only when no other live
presence connection exists. A bridge whose request is refused keeps the
health-matching service for RPC and retries the claim on that retained
connection until the previous claim's connection closes and this one is
granted. A granted claim counts as presence for the idle clock. The daemon reads presence and the registry together; a live
presence returns before the runtime is even asked, so presence alone keeps it
open.

- **One durable clock.** The last close is recorded (`hostDisconnectedAt`) and a
  connect clears it; the runtime's `HOST_IDLE_GRACE_MS` is the only place the ten
  minutes are stated. A presence that appears while the decision is being taken
  cancels it, and the runtime's latch is cleared, before anything drains.
- **Active host runs keep it alive.** A local host run may be admitted while the
  host is offline during the grace; while one is live the daemon stays, and the
  shutdown follows once the last one settles. Unknown run state is never read as
  idle.
- **A restart resumes the clock** rather than granting a fresh grace: a daemon
  restarted mid-grace closes when the remainder runs out. The registry, its
  admission state and durable intents come back from the store, and a lost
  connection is never proof that an effect completed. A known host with no
  recorded close (an older store) starts one grace rather than closing at once
  on a guess; a store with no observed host at all has no clock until one
  connects and leaves, because an unknown host is a wait.
- **The decision latches before the drain**, and the host-run launch fence
  refuses a later launch. The drain is the ordinary durable safe point: it
  releases the socket, the service identity and the store lease, and a later
  host starts a fresh daemon through the bridge.
- **A lost plugin while Paseo is still connected is a visible fault.** Closing
  the last granted `service.nucleus-bridge-presence` claim while a host remains
  in the registry arms a 45 s grace. If presence does not return, the board
  error names that the Nucleus plugin is not present while Paseo is still
  connected and that the recovery thread cannot act while the plugin is down,
  and the Nucleus planner is messaged once with `paseo plugin reload nucleus`.
  Granting the claim again (the same single-claim path) clears the fault; a
  presence that returns inside the grace is silent. The web board is the
  operator-visible surface (the plugin board is gone with the plugin). A
  CLI-started service never granted presence, so this path does not fire.
- **Only the bridge starts the daemon.** An ordinary CLI call reads it over the
  authenticated socket and refuses with `unavailable` when nothing is running;
  it never spawns, upgrades, reads SQLite or falls back on its own.

Proofs: `test/host-idle-lifecycle.test.ts` (the grace, reconnect cancellation,
a live run holding it and the shutdown following its settlement, restart
catch-up, the older-store cases, the CLI writing and starting nothing, and the
real service draining itself after the last host and presence leave);
`test/host-registry.test.ts` and `test/host-registry-migration.test.ts` (the
clock and identity across restart); `test/host-idle-runtime.test.ts`
(`hostShutdownDue` reads the connection, the run and the bootstrap, not a stale
fact, and a lost plugin while a host is connected raises the board fault once);
`test/bridge-presence.test.ts` (the first claim holds until its connection
closes, and a refused claim is retried until granted);
`test/host-service-lifecycle.test.ts` and
`test/host-presence-race.test.ts` (presence cancelling a decision);
`test/host-idle-fence.test.ts` (the launch fence).

Store open checks schema compatibility before writable admission and runs SQLite's
integrity check once under the admission lock. Hot metadata and projection-clock
reads reuse prepared statements. Pending submission cards probe the indexed task
and tombstone identities only for unfinished submit or review-entry operations;
paused-resume counters read an episode-range index over resume events.

Schema 57 stores independent board and telemetry counters in one publication-clock
row. Each mutation advances that row once, and a publication compares against the
last successfully posted revision, including on forced mutation acknowledgements.
Lane drains resolve project membership from one project read per pass. QA runners
are retained per runtime, legacy QA budget samples use repository indexes, and
hook cleanup measures bytes only for checkouts it selects for reaping.
The board cursor advances when either its durable revision or its display facts
change, so a clock-driven card change cannot hide the next durable mutation.

Service watches reuse only positively matched supervisor start identities and
unique command tokens for up to five seconds. Result and settlement checks
re-read both proofs, since macOS start times can collide; unknown
liveness never proves death. Parsed supervision files are reused only while their
file identity, size, timestamps and ownership remain unchanged. Output attachment
polls back off while idle, bounded at 500 ms, and return to 40 ms when bytes arrive.

The opt-in effigy bench:service-hot-paths snapshot comparison and its limits
are recorded in the performance receipt (`evidence/1010-service-hot-paths.md` in Git history).
Active Git and supervision probe measurements and their limits are in the
fact-cache receipt (`evidence/1024-git-file-facts.md` in Git history).

### Completed host attribution migrations

Startup no longer infers a host for historical hostless operations or task
origins. The one-time host attribution migrations are complete; new records
must carry their own host identity, and unknown attribution stays unknown.

### QA artifact housekeeping

The hourly QA retention sweep removes recognized per-run logs, results and
sidecars after the four-day history window. Active runs, pending checkout
cleanup and the latest retryable teardown evidence stay retained; orphan files
expire by modification time. QA execution paths share step records, escapee
merging and failure classification; streamed output shares one token redactor.
