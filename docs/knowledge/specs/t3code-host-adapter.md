# T3Code host adapter

Status: native adapter, CLI-helper reporting, board questions and per-project host opt-in are implemented.
Owner: Nucleus runtime maintainers

## Boundary

T3Code supplies native thread operations. Nucleus continues to own task and run
identity, worktrees, durable effect intent, callback authentication, review and
merge policy. Service composition injects those policies through `core/host`;
the adapter never imports their implementation or another host. Paseo remains
the primary host (Tom, 2026-11-11).

Worker, reviewer and recovery identities are separate top-level T3 threads.
No role uses T3's delegated-task relationship. The adapter does not patch T3,
attach Nucleus MCP servers, raise Nucleus questions inside threads or contribute
T3 UI. A T3 thread reports through the packaged nucleus helper with the run
ticket named in its prompt. Nucleus-raised questions go to the web board and
the project planner's agent channel. A repository setting selects `paseo`
(default) or `t3code` (opt-in) for new tasks; a live task never changes host.
Host selection resolves that setting by repository origin when known, with the
checkout path as a fallback when origin is unavailable. An origin-only settings
row is sufficient to select the host.
Registering a transport must not make an unsupported task workflow executable.

## Protocol and connection

The implementation lives behind `hosts/t3code/index.ts`. Its small RPC client
owns wire encoding, bounded responses, cancellation, deadlines and subscription
cleanup; adapter modules translate those responses into Nucleus host contracts.
No unpublished T3 package becomes a dependency.

The proof target is nightly `0.1.6-nightly.20261030.3917`, source
[`97e35bcf23e4dcf34c2dcffadd37c08db0e01e52`](https://github.com/pingdotgg/t3code/tree/97e35bcf23e4dcf34c2dcffadd37c08db0e01e52),
identified by the installed app's build metadata and matching release. The newer
planner research checkout is navigation evidence, not the proof target. Version
strings are diagnostic facts, never an allowlist. A newer nightly may connect
when the required protocol and decoded structures match. The owner-only state
file records the last nightly version that passed the read-only connect probe.
The target nightly uses orchestration protocol `2`.

Connection order:

1. Read an optional local T3 connection configuration with endpoint and session
   bearer issued through `t3 auth session issue`. Keep it owner-only and outside
   the repository; expose no bearer in settings responses, diagnostics or logs.
2. Exchange the bearer at `/api/auth/websocket-ticket/rpc`, then open `/ws` with
   the short-lived ticket and the supported orchestration protocol. The client needs
   `orchestration:read` and `orchestration:operate`; missing scopes fail closed.
3. Read `server.getConfig` through the authenticated socket. Validate
   `environment.environmentId`, `serverVersion` and
   `orchestrationProtocolVersion`, then strictly decode a full shell snapshot.
   If `probeThreadId` is configured, strictly decode that thread. Otherwise,
   strictly decode the first listed thread when one exists. A missing method,
   missing field or changed field type refuses connection with its exact name.
   If no thread is readable, register online with thread shape pending first
   thread; the first thread Nucleus creates or observes is strictly decoded
   before use. A mismatch refuses by its exact name and takes the host offline.
   A missing protocol version is also a refusal.
   The public environment descriptor is only a preflight hint.
4. Only after those probes, claim `t3code:<environmentId>` in the existing host
   registry. Reconnecting must prove the same environment at the same endpoint. Give this host its own
   admission and breaker state; disconnect only its session token.

The wire is Effect RPC JSON: `Request` frames carry an ID, method tag, payload
and headers; `Exit` settles unary calls; `Chunk` carries subscription values and
requires `Ack`; `Interrupt` releases a subscription. The client validates the
subset it consumes. Malformed frames, error exits, premature stream completion,
timeouts and disconnects invalidate affected reads. Ticket URLs, headers and
raw remote error bodies are never logged.
Strict decoding validates consumed fields and their types while tolerating
unrelated extra fields, so additive nightly changes do not become version pins.

T3 provides no RPC schema discovery or dry run. Never send a canary mutation to
establish compatibility. Pin the target nightly's command shapes as synthetic
contract fixtures and compare them with newer nightly source during the drift
check; the version itself does not decide compatibility.
An empty shell does not make the authenticated configuration, protocol and shell
incompatible. Keep the host online with a pending thread-shape diagnostic until a
real thread can be checked; do not create a probe thread on a live host.

Mutation shapes are checked on first use. The target nightly decodes request
schemas before invoking handlers, but serializes decoder errors and handler
defects without a decode-phase tag. Identical schema-formatted text can come
from a handler after an effect, so every remote failure remains unknown delivery
and is never resent. Only a local refusal before the socket write proves
non-delivery (planner ruling, 2026-11-11). Sanitized reported command and field
names remain diagnostic text, never proof of a decoder phase; raw error bodies,
actual values and credentials are omitted. The recorded diagnostic keeps the
bounded why behind a remote failure as value-free facts only (planner ruling,
2026-11-12, after three review rounds): the remote error tag when it is on the
fixed list of known tags, which known failure shape matched as a fixed name the
adapter defines (`unknown_request_tag`, `schema_missing_key`, `schema_expected`,
`encoder_rejected`, `remote_failure`, `project_mutation_failed`,
`project_not_empty`, `scope_missing`), the ticket exchange's HTTP status, and
method and command names from the adapter's own constants. No remote string,
and no part of one, is copied into a diagnostic, intent or attention text. No
schema-location text is retained at all: even a location naming one of our own
payload fields is remote-chosen text, so nothing from it survives. The token
shapes make that structural: reasons admit no spaces, quotes or punctuation
beyond the tag/shape separator, and delivery classification is unchanged
(nucleus#1136).
The manual-fix guidance is Nucleus-authored and names the repository path
exactly as recorded — whitespace included, untruncated — straight from
Nucleus's own record; only remote-derived fields are bounded.
Those names and the reason are stored on the durable unknown intent and returned
on blocked repeats, including after reload. A registered permission failure also
records them through the owning task's existing attention policy, selected by
its exact host, agent and workspace identity; standalone native operations
retain them in the intent ledger without inventing a task owner.

## Identity and workspaces

Native T3 thread IDs stay opaque. Existing task, run, message and question host
fields qualify them; a legacy string prefix grants no host attribution. Equal
native IDs on Paseo and T3 must resolve to different participants. A missing host
or ambiguous inventory cannot authorize a callback or answer.

A host call that names an agent goes to that agent's own host. The host facade
and the transport-boundary adapter proxy route an identity qualified for another
registered host to that host's own adapter, unwrapped only there; the call is
never unwrapped against the wrong transport. Refused only when the identity's
host is unknown or offline, and the refusal names that host (nucleus#1128). A
routed send's optional source from yet another host rides out, the way the
delegated ask route already dropped it.

T3's project and existing Git worktree form its workspace handle. Persist their
mapping through the service's durable intent boundary, including the canonical
directory, project ID, task/run ownership and native thread ID. Do not recover
ownership from titles or tags. Discovery uses complete host inventory plus this
map. An unreadable map or partial inventory is unknown, never an empty result.

When a repository root has no T3 project, `createWorkspace` registers one with
the `project.create` mutation through the `projects.mutate` RPC
(nucleus#1136). The dispatch command union carries only thread-scoped commands:
a `project.create` sent through `orchestration.dispatchCommand` is refused at
the nightly's decoder before any handler runs, which is why swallowtail#225's
creates never reached a span. Route evidence was read from the shipped bundle of
`0.1.10-nightly.20261111.4529` (app commit `d2c25950b4d9`): `WS_METHODS.projectsMutate`
is `projects.mutate` (`packages/contracts/src/rpc.ts`), the handler enqueues
`ws.projects.mutate` → `mutateProjectWithClone` → `projectMutationOperation`
(`apps/server/src/project/ProjectMutation.ts`), and `ProjectService.create`
(`apps/server/src/project/ProjectService.ts`) normalizes the root, commits
through the command receipt ledger under project and workspace locks, and
returns the full `Project`. The method needs only the operate scope the session
bearer already holds when no scripts ride the mutation. Its title is the
repository folder name and its root is the real repository path; the task
worktree is never used as the project root. The deterministic project ID,
command ID and root are recorded in the durable intent before send, and the
returned project must name the recorded project ID. Before retrying an unknown
create, read the complete project inventory again and adopt a project that now
exists for that root; a resend keeps the recorded command and project IDs, so
T3's receipt answers idempotently. An unknown intent recorded on the retired
dispatch route may resend once on the mutation route with the same IDs
(nucleus#1136); no other payload change is accepted. When the remote failure
text names no known registration method, the create stays unknown delivery —
the same text can come from a handler after an effect — and the task keeps the
path-and-manual-fix guidance inside that unknown, never a refused mark
(review ruling, 2026-11-12). Nucleus does not rename or remove projects.

Closing a task archives the task's project through the `project.update`
mutation with `archived: true` — the nightly keeps the project's threads and
files (nucleus#1139, shapes read from the same bundle:
`ProjectMutation = project.create | project.update | project.delete` in
`packages/contracts/src/project.ts`). The project is one registration per
repository, so while another live task on the same host still works there the
archive holds — a visible `workspace_cleanup_wait` wait, never a failure — and
the last closer retires the registration; earlier terminal tasks complete
their local teardown against whatever state the last closer leaves, including
the archived one. An archived project keeps its repository
root, so a later task in the same repository reopens the same registration
with `archived: false` instead of registering a second project, which the
nightly refuses for an owned root. Archive observation is a positive native
fact: the project is gone from the inventory or carries `archivedAt`, and an
archived registration is no longer a current workspace.

Nucleus prepares and verifies the Git worktree before handing it to T3. Creation
uses only `existing_worktree`; T3 must confirm it belongs to the selected project.
The adapter never asks T3 to create, rename, remove or clean a worktree. Thread
archive is a catalog operation, not evidence that a folder was removed. Native
workspace operations without an equivalent must explicitly refuse rather than
pretend to be a Paseo workspace.

## Operations and delivery

| Host operation | T3 RPC or command | Required result |
| --- | --- | --- |
| Register project | `projects.mutate` / `project.create` mutation | Deterministic IDs bind the real repository root; the receipt ledger answers replays; reconcile unknown delivery against the complete inventory before retry |
| Create | `orchestration.launchThread` with explicit thread/message IDs, provider instance/model, prompt, the profile's runtime mode and model options, and `existing_worktree` | Top-level thread with the exact project and directory |
| Follow-up | `orchestration.dispatchCommand` / `message.dispatch` | Stable command and message IDs; receipt records acceptance |
| Observe | `orchestration.subscribeShell` and `orchestration.subscribeThread` | Fresh complete state, including active run and pending request |
| Answer question or permission | `runtime-request.respond` through dispatch | Exact request, thread and workspace; typed answers or approval decision |
| Stop | `thread.stop` through dispatch | Receipt followed by observation; never a replacement thread |
| Archive | `thread.archive` through dispatch | Receipt followed by archived-state observation |
| Archive workspace | `projects.mutate` / `project.update` `archived: true` | The project is retired with threads and files kept; observation reads `archivedAt` from the inventory |
| Atomic interrupt and continue | `message.dispatch` `steer_active` with the live run's `targetRunId` | The message injects into the active turn; with no active run the refusal is proven before send |

Use `launchThread` for creation because it supplies the native workspace strategy
and initial-message preparation. Other mutations use `dispatchCommand`. Each
operation binds a stable command ID, native target and canonical payload to the
existing durable intent before send. Launch also binds its explicit thread and
initial-message IDs. Persist the mapping before remote creation so a lost reply
cannot produce an unowned thread.

### Model options

The nightly carries each model's configurable options in
`server.getConfig`: `capabilities.optionDescriptors` — a select with its
choices or a boolean toggle, `currentValue` when the provider reports one
(`packages/contracts/src/model.ts`, nightly
`0.1.10-nightly.20261111.4529`, app commit `d2c25950b4d9`). The catalog maps
them onto the shared shape: the reasoning select becomes `thinkingOptions` —
T3 marks a provider's own thought-level control `role: "reasoning"`, and every
stock driver (Codex, Grok, Muse, Kiro) names its reasoning select
`reasoningEffort` — with `defaultThinkingOptionId` from the default choice or
`currentValue`; other selects and booleans become catalog features; model
`aliases` carry through.

At launch the adapter maps the profile's `thinkingOptionId` and feature values
into `ModelSelection.options` (`[{ id, value }]`;
`packages/contracts/src/modelSelection.ts`, values `string | boolean`). A
value the model does not report is refused before send with the option and
value named — no silent dropping, no nearest-value guessing. Selection keeps
such a profile out of a host-bound task in the first place: the engine keeps a
routing-profile snapshot per registered host, built from that host's own
catalog, and dispatch, worker creation, reviewer selection and the
`route`/`set_routing` validation read the task host's snapshot, so
availability — including the configured runtime mode and every feature value —
and `supportedThinking` are that host's own answer. T3Code answers feature
values without a project context, so its answer is always authoritative; a
host that resolves features per directory (Paseo) marks a read made without
one `featuresDeferred`, and availability treats that as unknown, never
negative. The launch fence catches catalog drift between refresh and send. A secondary host's snapshot is built
when it comes online, and afterwards on the periodic profile pass, never on an
unguarded per-tick chain.

### Runtime mode

A T3 thread runs in one of four runtime modes, narrowest first:
`approval-required`, `auto-accept-edits`, `auto`, `full-access`
(`packages/contracts/src/providerPolicy.ts`; nightly
`0.1.10-nightly.20261111.4529`). `launchThread` requires one, and
`DEFAULT_RUNTIME_MODE` is `full-access`. Each provider reports the subset it
offers as `ServerProvider.supportedRuntimeModes`; a provider that reports no
list offers all four, and a request outside a reported list runs as
`approval-required` (`providerRuntimeMode`) — silently, since the launch
succeeds.

The profile's `modeId` is the thread's runtime mode, id for id
(`full-access` to `full-access`, and so on). A profile with no mode gets
`full-access`: the mode T3 launches a thread with when none is asked for, and
the unattended run a Paseo worker of that role has today. `approval-required` is
never chosen for an unattended role, because it would stop at every approval
prompt.

The catalog reports each model's modes as its provider's list — the whole four
when the provider reports none — with the nightly's own labels (`Supervised`,
`Auto-accept edits`, `Auto`, `Full access`) and descriptions. Selection
therefore judges the configured mode against the host that will run it, and a
profile naming a mode outside its provider's list is ineligible for that host
with the mode named — never silently downgraded, and never sent to be refused
at launch. The launch re-reads `server.getConfig` and refuses, before send, a
mode T3 does not have or its provider does not offer; that fence only catches
catalog drift between refresh and send. Observation reports the thread's
`runtimeMode`, so a reviewer's mode evidence is the thread's own fact.

A repository's pool profiles are the same pool every host selects from, but each
host answers availability from its own catalog. T3Code names its provider
instances itself (`codex`, `claudeAgent`, `grok`, `pi`), so a pool profile using
another spelling is ineligible on T3 with `Provider … is not available on this
host` until the Nucleus provider map records the mapping; that mapping is the
provider map's job, not a runtime-mode substitution.

A creation refusal that is proven pre-send settles the run refused and the task
in attention with the step that failed named — `Worker creation refused before
send: …`, `Reviewer creation refused before send: …`, `Coordinator creation
refused before send: …` — instead of the absent-creation exact-lookup ladder,
which would find nothing and send a replacement into the same refusal.

The adapter's owner-only state file binds those records to the authenticated
environment. Synchronous exclusive locking and atomic, synced replacement keep
intent durable across a crash. A held or abandoned lock refuses writes; the
adapter never guesses that a prior process finished. Settled commands return
their recorded outcome; unresolved commands are never resent.

Runtime responses also bind the native thread/request pair to their original
intent and caller input before reading the request's current status. The binding
is reserved atomically with the intent, so concurrent callers and new intent IDs
cannot send another answer while delivery is unknown. A settled identical answer
replays locally, even after the request resolves, expires or disappears; changed
answers do not rewrite that outcome. Question answers and dismissals share this
request scope. Earlier unbound intents are inspected rather than ignored.

T3 receipts reject a command ID belonging to another thread, but do not compare
payloads on the same thread. Nucleus must reject a changed payload under an
existing intent ID locally. A transport reconnect does not resend a mutation.
An uncertain result stays uncertain until native receipt/projection evidence
settles that exact intent. Project creation is reconciled by re-reading the
complete project inventory before retry; an existing project for the repository
root is adopted, and any retry uses its recorded command and project IDs. Never
replace an intent's IDs to escape doubt.

Guarded sends retain core's `allowed`, `stillAllowed` and `beforeSend` ordering.
The last synchronous fence precedes the socket write. A proven local refusal
uses the existing pre-send error/result. After a possible write, remote errors
cannot establish non-delivery. A command receipt proves acceptance, not provider
completion or a Nucleus report.

## Observation and restart

Start with an unfiltered shell subscription and explicitly read
`orchestration.getArchivedShellSnapshot`; the target nightly's live shell loader
does not include archived records even though its schema has an archive array.
Do not enable omission of older settled threads or idle children. Require the
initial snapshot and synchronization/completion evidence before answering an inventory
read. Each read takes a fresh synchronized snapshot; an intervening event,
reconnect, invalid update or unfinished snapshot refuses that read. There is no
cached inactivity to carry across connections. Read the thread
projection when shell summaries lack request details or timeline coverage.
Project-enrichment snapshots marked with `resolvedRepositoryIdentityRoots` can
carry empty thread arrays; they never replace the authoritative inventory.

The origin-thread read takes the complete shell and archived inventory before it
reads a projection: a thread the complete inventory does not carry is authoritative
absence (not mine), while a failed inventory or projection is an unread read
(unknown) and never absence. A native question about a thread T3 does not have
therefore never makes a two-host origin lookup ambiguous.

Observation reads are one-shot and per call: each sweep or reconcile takes a fresh
snapshot, so an interrupted `subscribeThread` or `subscribeShell` stream ends that
read only and never ends observation. T3 transport and timeout errors are an
observation outage, classified as a transport failure: the lane defers and the next
sweep re-reads, and the task is never marked idle or attention for it. A task
quantum that does not return within two minutes (`TASK_QUANTUM_BOUND_MS`) no
longer holds the sweep; the task records an `observation_outage` event and its
lane stays held until the quantum returns (#1148, planner ruling).

Report active run, idle, pending question/permission and archived state from
positive native facts. A thread is gone only after a complete authoritative read
proves absence/deletion. Partial reads reject or return the contract's unknown
result. A disconnected thread never becomes idle or gone by timeout. Timeline
pages retain gap and coverage facts; a bounded tail is not full history.
Active and archive snapshots must report the same application-event sequence;
otherwise their union is refused as incomplete. This includes an unarchive
between the two reads, which could otherwise hide a live thread. A direct
retained-thread read must settle an identity before reporting it gone. Coverage
flags and cursors are strictly typed; retyped fields or a remaining history
cursor cannot establish complete observation or timeline coverage.

The canonical thread projection is the whole turn list, so timeline pages carry
the full coverage contract: no gap, no reset, no newer history, an epoch that
is the thread identity, and start/end cursors that are positions in the full
list. Archived threads are retired participants: they report the terminal
closed state with `archived` carried on its own field, so archive proofs and
workspace teardown read a terminal state while retained reads still see the
retirement.

On T3 startup, active runs are cancelled and live approvals expire. Pending
questions may remain pending with `responseCapability: {type: "message"}`.
Read this capability from the fresh thread projection and answer through
`runtime-request.respond`, which owns the message-based continuation. Do not
invent a second follow-up. Expired or nonresumable approvals cannot be answered
again. An interrupted answer remains uncertain even if the request later expires;
expiry is not evidence that the original answer was never delivered.

## Composition and unsupported capabilities

Service composition reads optional T3 configuration and imports only its public
host index. It registers the second connection independently of Paseo. Replace
single-connection assumptions only where needed to select the recorded host,
enumerate sessions and account for shutdown. Preserve the existing Paseo identity,
configuration, SDK behavior, callbacks and migration history.

The authenticated `host.permission-answer` service method requires the exact
host, native agent, workspace, runtime request, decision and stable intent.
It selects only that registered host, with no fallback, and uses its permission
response through the host facade. The native adapter rechecks the pending
request's kind and workspace before delivery.

Expose explicit unsupported capabilities for Nucleus-raised native decisions,
Nucleus-raised in-thread questions, native workspace titles and UI
contributions. Do not substitute empty success results. Core routes those
needs for T3 through the board, CLI-helper reporting and core's own workspace
allocation, so an ordinary task never reaches those refusals (nucleus#1139):
per-thread MCP reporting is unreachable because reporting rides the helper;
per-thread launch environment is unreachable because T3 launches carry none.
Runtime modes are not in that list (nucleus#1143): the catalog reports the
provider's own modes, so a pool profile the pool selects on T3 either launches
in its configured mode or is ineligible with the reason named in its routing
policy. The Host keeps `lifecycleDispatch` false; the
Adapter turns it on once the Nucleus helper path is wired, so T3 threads report
through the helper and ticket named in the prompt. Service composition injects
`HostPolicies` through the public `core/host` constructor, so review
verification (live author/reviewer independence and exact-head checks) and
retained-thread continuation, recovery and checkpoint delivery use the same
core policy as Paseo. The Adapter supplies `askReviewer` (a T3 message that sends the core consult
prompt unchanged) and `findRunAgents` (exact `nucleus.run` plus `nucleus.task`
label lookup). Core names `question.answer` with the reissued recipient run
ticket for any host that has a recipient run on that proven host; MCP hosts
without a matching run clear an inherited `NUCLEUS_TICKET` so the host's identity
answers. Equal native IDs on different hosts do not share a consult ticket. A
shared ticket-first caller resolver fills identity for any host and skips a
ticket path that is gone, so T3 does not rewrite the command to a separate
endpoint. A proven caller that already holds its participant ticket (project
planner, named agent, task planner) receives that same ticket's path on every
`caller.resolve`; a second ticket is never minted, and a credential file that
is gone is revoked and reissued on that caller's own next call (nucleus#1128).
A T3-hosted planner has no calling-thread identity of its own, so its
participant ticket is delivered by one message, and only after the thread is
observed live; assignment from the board or the thread's own call is the trigger,
and an archived, gone or unreadable thread is left ticket pending instead. A task's
own planner follows the same rule: before a question names a T3-hosted task planner,
Nucleus issues its ticket by that one message, and only while the thread is
observed live. Uncertain reviewer or
coordinator creation can bind. T3-hosted planners are out of trial: missing
`askPlanner` becomes an answerable board decision with the planner message,
never a silently pending ask. Production planners stay Paseo threads. `host.permission-answer` still grants no
task lifecycle dispatch. An unconfigured T3 adapter changes no default route. A
configured second host never causes implicit rerouting of a live task, origin
notice or pending question.

## Trial

Paseo stays the primary host. Opt a repository into T3Code for new tasks:

1. Start T3Code.
2. Issue a session bearer with `t3 auth session issue`.
3. Write owner-only local settings (outside the repository, never logged): `t3code: { endpoint, bearer, probeThreadId? }`.
4. In Settings, set the repository Host to T3Code, or `repository.set` with `hostKind: "t3code"`.
5. Switch back to Paseo the same way. Live tasks keep the host they started on.

## Verification

Fake-server tests cover each operation, the exact wire envelopes and scopes,
authorization refusal, missing/incompatible protocol, a previously untested
nightly passing structural probes, identity conflicts, malformed
and incomplete snapshots, lost replies, immutable intent replay, subscription
cleanup and restart during both kinds of request. Identical decoder-formatted
and post-effect handler defects must both retain unknown delivery. Contract
fixtures pin the nightly command shapes rather than a server-version allowlist.
Cross-host cases deliberately reuse native IDs and keep task, run, message and
question ownership separate.

One end-to-end test drives an ordinary task's whole lifecycle on the fake
Nightly transport (nucleus#1139): promotion onto the T3 host, workspace
registration, a worker launch whose profile carries a thinking level (the
launch carries `modelSelection.options`), a planner `tell` delivered mid-run,
the worker's report through the packaged helper, an independent reviewer's
launch and verdict, a revision round addressed on the retained worker, the
accepted round-two verdict, the merge, closeout, and the archive of both
threads and the native project, observed positively. The test fails on a tree
without the model-option, archive and steering work.

The private proof starts an unmodified checkout of the target nightly revision,
or its bundled server copied into fresh run scratch, with separate home, data,
configuration and synthetic Git project/worktree. A local scripted provider drives questions, approvals and a
stoppable run without operator provider credentials. It must exercise the real
T3 server and RPC, not replace the orchestration service. Configure networking
on loopback; issue the bearer only from that private instance. Never discover
or reuse a live T3 home, session or desktop data directory.
Seed a synthetic thread during private fixture setup for the read-only connect
probe; that setup is confined to the private server.

Retain redacted observations for create, follow-up, observe, answer, stop and
archive, plus compatibility refusal and restart behavior, with source revision,
nightly version and protocol. Re-check the newest nightly at the end and report
command/schema drift separately from runtime proof on the target nightly.
Store proof artifacts only in scratch; public PR text includes
no local paths, credentials or private project names. Execute the proof through
an Effigy selector, and keep every process and temporary root owned by the run.

Implementation acceptance requires `effigy check`, each new adapter test file
alone, `test/host-composition.test.ts`, `test/host-identity-boundary.test.ts` and
`test/folder-imports.test.ts` alone, `effigy qa:docs`, and the private proof.
The private proof selector is `effigy proof:t3code -- --asar <nightly archive>`.
It copies the target app's bundled server into fresh scratch and uses a scripted
local provider. Its evidence distinguishes source drift, injected incompatible
read responses and actual lifecycle operations on the private nightly.
