# T3Code host adapter

Status: native adapter, CLI-helper reporting, board questions and per-project host opt-in are implemented.
Owner: Nucleus runtime maintainers

## Boundary

T3Code supplies native thread operations. Nucleus continues to own task and run
identity, worktrees, durable effect intent, callback authentication, review and
merge policy. Service composition injects those policies through `core/host`;
the adapter never imports their implementation or another host. Paseo remains
the primary host (Tom, 2026-11-11).

Provider subscription usage belongs to T3Code and its host-specific plugins.
Nucleus adds no subscription usage gauge; Spec 052's usage level remains a
separate dispatch policy setting.

A task is one T3 thread on the Nucleus ACP provider (Spec 065) and its worker,
reviewer, recovery, closeout and executor threads are that thread's native
subagent children (Tom, 2026-11-16; nucleus#1305 — see [Native
parenting](#native-parenting)). The parent authors nothing: it shows the task's
lifecycle and holds its turn while any child runs. **There is no top-level
fallback (Tom, 2026-11-19, on retiring it so the parent's is the only row rule:
"Agreed, let's keep things simple").** When the provider is missing or not ready,
the parent is archived or deleted, or a child can't be created, the task waits
visibly with the reason and the fix (for example "T3 provider not ready: run
`nucleus t3 install`"), or the operator moves it to another host. **Nucleus
never settles a task thread; a waiting task is snoozed (Tom, 2026-11-19: "I use
the settle list for longer running threads I want to come back to.. it would be
great if we could keep Nucleus noise to a minimum in that list, snoozing seems
ideal?").** **Nucleus wakes a thread the operator settled (Tom, 2026-11-19: "I explicitly want nucleus to unsettle threads like that.. when threads have done what they can then need to wait for nucleus to notify it of progress, I want to settle it so it's out the way, then it gets woken by nucleus").** A settle means "out of the way until Nucleus has something", not "never deliver". A message, decision, re-entry or follow-up addressed to a settled thread unsettles it and is delivered. Nucleus still never issues `thread.settle` itself. The parent row has three states, driven by the board's attention
projection: *active* while a role child runs or a person must act (Nucleus
unsnoozes it then, and leaves a settled row settled); *snoozed* while the task
waits on nothing Nucleus is running and needs no one (held until something,
prerequisite wait, queued for capacity, between roles), with the snooze renewed
before it lapses; *archived* when the task finishes. The top-level fallback and
the per-role settle rules it replaced are gone (implementation: nucleus#1366).
Archived task threads are pruned by Nucleus's own retention pass (see the
orchestration contract, "Archived thread retention").
**Decisions reach the T3 operator in T3 (Tom, 2026-11-19: "how to bring
decisions to the user in T3 - they appear on the nucleus board, but I don't
actually look at it very much at all … We could also make use of the nucleus ACP
model here, with a single Nucleus thread permanently on the board (pinned) that
can surface decisions programatically without needing AI interaction at all, and
could also manage loading the board UI in the browser in that workspace?").** A
task-scoped question is raised by the Nucleus ACP agent on that task's parent
thread as an ACP form elicitation, and the row unsnoozes. Every other decision
goes to one pinned "Nucleus" inbox thread per T3 environment, a permanent
`nucleus` ACP session the adapter creates and pins. It holds its turn only while a
decision is open for it and is idle otherwise (nucleus#1384). It is never pruned or
archived, and it opens the board in T3's browser pane. Planners don't
raise native questions themselves. An answer given anywhere settles the T3 card
exactly once (implementation: nucleus#1371). The adapter does not patch T3,
attach Nucleus MCP servers, raise Nucleus questions inside threads or contribute
T3 UI. A T3 thread reports through the packaged nucleus helper with the run
ticket named in its prompt. Nucleus-raised questions go to the web board and
the project planner's agent channel. A repository setting selects `paseo`
(default) or `t3code` (opt-in) for new tasks; a live task never changes host.
Host selection resolves that setting by repository origin when known, with the
checkout path as a fallback when origin is unavailable. An origin-only settings
row is sufficient to select the host.
Registering a transport must not make an unsupported task workflow executable.

## Calling thread identity

When no `NUCLEUS_TICKET` is present, the CLI reads `T3CODE_THREAD_ID` and
`T3CODE_DESKTOP_HOST_SCOPE` as the T3 caller source. The desktop scope is not the
registered T3 environment ID and is not used to construct a host identity. The
service asks every online T3 host to observe the exact thread ID; exactly one
matching live observation identifies the caller's host. No owner or multiple
owners refuse before any caller-bound command is sent, naming the thread and
online T3 hosts. Thread IDs, including an `mcp:` prefix, stay unchanged in both
observation and the canonical host-qualified caller identity. The desktop scope
is not used for host selection; resolution relies on observation until T3 offers
a supported mapping to an environment. This is caller attribution only and follows
the same command permissions as a Paseo caller.

Source precedence is Nucleus ticket, T3Code identity, then Paseo's
`PASEO_AGENT_ID`. An invalid or revoked ticket refuses. An absent ticket file
uses the host check above, which refuses a bare MCP session with no exact thread.
When T3
and Paseo environment values coexist, T3 wins; a partial T3 identity refuses
rather than using Paseo. An explicit planner ticket still wins when
`T3CODE_THREAD_ID` is an `mcp:` session: the ticket's thread is the recorded
asker and delivery target, never that session. Replies to `ask` and `tell` use the existing host-qualified T3
delivery path. A decision answer reaches that recorded thread or stays queued with
a visible wait (attempts > 0).

For reparenting, Nucleus verifies the candidate T3 thread through that host's
observation and records its qualified ID. A T3 project thread can have no
Nucleus-managed workspace registration; its origin location is represented by
the stable `t3-project:<projectId>` scope from the T3 thread record. Task
references such as `barge#064` are resolved at the service boundary before the
reparent owner lookup.

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
   `orchestration:read`, `orchestration:operate` and `preview:operate`; missing scopes fail closed.
3. Read `server.getConfig` through the authenticated socket. Validate
   `environment.environmentId`, `serverVersion` and
   `orchestrationProtocolVersion`, then strictly decode a full shell snapshot.
   If `probeThreadId` is configured, strictly decode that thread. Otherwise,
   strictly decode the first listed thread when one exists. A missing method,
   missing field or changed field type refuses connection with its exact name.
   If no thread is readable, register online with thread shape pending first
   thread; the first thread Nucleus creates or the first eligible live (non-archived,
   non-deleted, observed) row a shell or inventory read sees is strictly decoded
   via one single-flight bounded direct projection probe without re-entering shell
   or inventory (leaving terminal and archived rows unread and sharing the pass's
   observation snapshot). A mismatch refuses by its exact name, takes the host
   offline and leaves independent hosts unaffected.
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
A request deadline settles only that request, with unknown delivery after send;
it never closes the shared socket or replays a mutation. Late replies are dropped
by request ID, and an expired subscription sends `Interrupt` to release it.
Small requests have a 10-second deadline; `orchestration.subscribeThread` has a
60-second deadline in the adapter's method table, including bounded snapshots.
A protocol fault that names one in-flight request — a `Defect` with a request ID,
a `Chunk` for a unary call or with non-array values, a stream past its per-method
cap, an `Exit` whose shape does not match, or an unknown tag carrying a known
request ID — settles that request as a protocol failure (unknown delivery, never
resent) and, for a stream, sends `Interrupt`. The connection stays open. Default
streams accept 10,000 values; `orchestration.subscribeThread` accepts 50,000, and
thread readers interrupt once they have the snapshot they asked for.
The connection closes only for unattributable data: an unparseable frame, a
binary or oversize message, a frame batch over the cap, a frame that is not
an object with a string tag, a connection-level `Defect` without a request ID, or
a frame with no request ID that is not `Ping` or `Pong`.

Liveness uses the nightly's Effect RPC `Ping`/`Pong` control frames, independently
of request traffic. After 10 seconds idle between heartbeat exchanges, a ping
gets 10 seconds for a pong; one miss sends a second ping immediately, and a
second consecutive miss closes the connection. A pong resets the failure count.
Socket close, socket error and unattributable protocol frames also close it; the
service's ordinary host reconnect path then proves identity again. `service.health`
retains `t3code.lastDisconnectReason` across reconnects as a fixed reason code
(`heartbeat_failure`, `socket_close`, `socket_error`, `protocol_error` or
`connect_timeout`), and `t3code.lastProtocolError` as the branch and frame tag
that last fired (never payload values), without remote text or credentials.
`binary_message` and `oversize_message` additionally retain the message's byte
length and the distinct pending method names. The 16 MiB limit counts UTF-8
bytes, including on sends. These messages close the connection: their envelope
has not been decoded within the byte budget, and neither a JSON prefix nor a
single pending stream proves attribution in the presence of late replies.

Strict decoding validates consumed fields and their types while tolerating
unrelated extra fields, so additive nightly changes do not become version pins.

Drift check for the delegated-task shapes (read-only, installed nightly
`0.1.11-nightly.20261117.4838`, app commit `ea6d3fc30fb0`, source
`OrchestrationV2` command union in `ManagedEndpointRuntime-*.mjs` and
`orchestrationV2.dispatch.delegatedTaskRequest` in `runtimeLayer-*.mjs`):
`delegated_task.request` takes `{type, createdBy, creationSource, commandId,
parentThreadId, parentRunId, parentNodeId, task, title?, modelSelection,
runtimeMode, interactionMode, workspaceStrategy?, completionWake?}`;
`delegated_task.completion-delivery.dispose` takes `{type, commandId,
parentThreadId, taskId}`; the derived ids are `thread:delegated-task:<commandId>`,
`node:delegated-task:<commandId>`, `message:delegated-task:<commandId>`; a child's
completion delivery state is one of `pending`, `claimed`, `acknowledged`,
`delivered`, `disposed`; and the projection's `subagents` record carries
`completionDelivery`. The contract fixture records all of it and the fake nightly
asserts the shapes a send must have. Nucleus sends neither `delegated_task
.wake-policy`, `delegated_task.remote.*` nor a canary.

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

A stored task or run `agentId` is native, so it carries no host of its own: every
host call that names the owner's agent runs inside `Engine.onTaskHost(owner, fn)`
(fn. `Resolution.onTaskHost`), which reads the owner's recorded `hostId` — never
a caller's claim (nucleus#1154). That covers the reviewer checkpoint
auto-continue, worker and revision continuation, planner `tell` delivery, the
stall and idle checks and the closeout archive. A review, revision or closeout
pass may only be reached from a lane quantum, and a lane runs outside its
caller's async context, so the transport context is part of the quantum: a
`task:<id>` (or `runtime-retirement:<id>`) lane binds that task's host, and any
other lane keeps the host its scheduling call ran on. Without that, an
agent-naming call inside the quantum resolved the default host and the review
answered `Agent was not found` (swallowtail#226).

The same rule covers work that runs in no host context at all: the sweep's fleet
steps, operator controls on a queue lane (stop active threads, bulk disposition)
and retention. Outside a context the routed adapter is the unbound fallback,
which has no forge or agent ports, and host availability answers only for the
legacy Paseo primary, so a port or availability read made there skips every task
on T3 or BB without a word. Such a step reads both inside the task's own host
context (`withHost(task.hostId, …)` or `onTaskHost`): a bulk disposition runs
each item on its task's host, and stop active threads names any task whose host
it cannot reach as a failure, marking nothing for it. An operator control is
gated on any connected host, not the Paseo connection. Run tickets live in the
service's data directory for every host, so retention removes them without a
host connection (2026-11-23 audit). In
tests, `Engine.unboundPortRead` reports each port a registered host serves that
was read with no host context; production leaves it unset.

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

Closing a task retires its task-specific worktree handle from the adapter's
stored state and tears down its owned Git worktree. The adapter keeps an
archived marker on the handle so archived threads retain their workspace
mapping for lifecycle reconciliation. It does not mutate the
native project registration: that registration is shared by every task in the
repository, and a finished task's archive must proceed while another task is
live. Nucleus currently leaves the shared project registered; if a future
project-level retirement is added, it must wait until no task uses the
registration. A new task reuses the still-registered project directly.
Workspace archive observation is positive from the stored adapter state: a
missing or marked task worktree handle is archived, while the shared project
remains available.

Nucleus prepares and verifies the Git worktree before handing it to T3. Creation
uses only `existing_worktree`; T3 must confirm it belongs to the selected project.
The adapter never asks T3 to create, rename, remove or clean a worktree. Thread
archive is a catalog operation, not evidence that a folder was removed. Native
workspace operations without an equivalent must explicitly refuse rather than
pretend to be a Paseo workspace.

Core derives the task row's title with `taskWorkspaceTitle` and hands it
through uncapped. Each host fits titles to its own bound at its boundary with
the shared Unicode-safe fitting in `shared/title-fit.ts`: T3 row and thread
titles are capped to `T3_TITLE_LIMIT` (`hosts/t3code/titles.ts`), Paseo
workspace and agent titles to `PASEO_TITLE_LIMIT`
(`hosts/paseo/adapter/titles.ts`). Core never caps for a host. It sends the current title through
`thread.metadata.update` on the task's parent thread; the adapter appends the
step the task's role children are doing (see
[one row per task](#one-row-per-task)).
The core title projection coalesces queued changes and records failed writes on
the task for sweep retry. Each title-change request has its own durable command
identity — the identity includes the desired title, so a changed title is never
a changed payload under a spent command (nucleus#1366) — and a refusal names the
row title, never another role's work. Before retrying an uncertain T3 update,
the adapter reads the thread title and settles the write if the desired title is
already present.

## Operations and delivery

| Host operation | T3 RPC or command | Required result |
| --- | --- | --- |
| Register project | `projects.mutate` / `project.create` mutation | Deterministic IDs bind the real repository root; the receipt ledger answers replays; reconcile unknown delivery against the complete inventory before retry |
| Refuse a role that cannot be a child | No command: a proven pre-send refusal naming the reason and the fix | The task waits visibly (`T3 provider not ready: … run \`nucleus t3 install\``, an archived or deleted parent, another checkout, a parent T3 will not run); never a top-level role thread |
| Create parent | `orchestration.launchThread` on the `nucleus` provider instance with the ACP model and the task's own checkout | The task's one row; its run is held by the ACP agent, never a model's turn |
| Create role child | `delegated_task.request` anchored on the parent's live run and root node, with the profile's provider, model, runtime mode and options, and no `workspaceStrategy` | A native subagent child that inherits the parent's checkout; deterministic `thread:delegated-task:<commandId>` |
| Dispose a child's wake | `delegated_task.completion-delivery.dispose` naming `node:delegated-task:<commandId>` | `completionDelivery.state: disposed`; sent after the create and after every follow-up dispatch |
| Hold and release the parent | `message.dispatch` (one re-entry prompt) and the ACP session's `release` | The parent's run is live exactly while a child may be created; a finished task's held turn is released at once and the parent archived |
| Follow-up | `orchestration.dispatchCommand` / `message.dispatch` | Stable command and message IDs; receipt records acceptance |
| Observe | `orchestration.subscribeShell` and a bounded `orchestration.subscribeThread` | Fresh state, including active run and pending request, from a snapshot whose timeline window never makes a long thread unobservable |
| Answer question or permission | `runtime-request.respond` through dispatch | Exact request, thread and workspace; typed answers or approval decision |
| Stop | `thread.stop` through dispatch | Receipt followed by observation; never a replacement thread |
| Archive | `thread.archive` through dispatch | Receipt followed by archived-state observation |
| Remove | `thread.delete` through dispatch at closeout, never `onlyIfUnused` | Durable intent, then `deletedAt` or absence from a complete inventory proves removal; an unknown outcome is never resent |
| Snooze a waiting row | `thread.snooze` through dispatch with `snoozedUntil` in the future | One bounded horizon, read back from `snoozedUntil`; deterministic command identity per wait episode and horizon; a refusal is "stay active" for that episode, never a retry loop. Only a verified same-task parent row is snoozed, and only the exact horizon this host read back is renewed (nucleus#1445) |
| Deliver to a snoozed thread | No command: a proven pre-send refusal naming the snooze | T3 clears `snoozedUntil` on an ordinary delivery, so a message to a thread the operator snoozed waits for that snooze to wake; the durable notice stays pending and is delivered then. A task row this host snoozed is delivered over (nucleus#1445) |
| Report a row that stays hidden | No command: one durable `row_hidden` notice per continuous snooze episode (30 minutes) or hold generation (3 hours), and the planner's answer window for its own hold (30 minutes) | The task, its age, its wait, its last transition and one supported action; unknown when the row cannot be read; superseded when the episode ends; an unanswered planner hold shows the row again |
| Show a row again | `thread.unsnooze` through dispatch with `reason: "user"` | Only a row this host snoozed; a person who must act or a running role gets the row back immediately through the title/row projection drain and the host pass. The snooze record stays until a fresh T3 read proves `snoozedUntil` is cleared; a settled unsnooze that still reads snoozed is re-observed and retried as a new occurrence, while an unknown delivery is never resent blindly. Operator snoozes and manual settles are never touched |
| Continue a manually settled thread | Unsettle, then send | A message, decision, follow-up or re-entry for a thread the operator settled unsettles it first and then delivers (Tom, 2026-11-19). Refusing before send is retired |
| Archive workspace | Mark the task's T3 worktree handle archived in adapter state | Observation reads the handle's `archivedAt`; the shared project registration remains registered and available |
| Atomic interrupt and continue | `message.dispatch` `steer_active` with the live run's `targetRunId` | Exposed through `T3Adapter.interruptAndContinue`; injects into the active turn, or refuses before send with no active run |
| Queue message behind current step | `message.dispatch` `queue_after_active` | Exposed through `T3Adapter.enqueueMessage`; queues behind any active turn without interrupting it |
| Decider and consult reviewer | `delegated_task.request` child under the task parent, followed by `askPlanner` / `askReviewer` | Exposed through `T3Adapter.runDecider` and `T3Adapter.createConsultReviewer` with separate deterministic launch IDs (`ns-decider-launch-<id>`, `ns-reviewer-consult-launch-<id>`) and first-question delivery IDs (`ns-decider-<id>`, `ns-reviewer-consult-<id>`) |
| Closeout workspace recovery | Nucleus-owned Git worktree (`ns-closeout-<taskId>`) under the task workspaces root, registered via `createWorkspace` | Records `worktreeSlug` and `projectRootPath` on the T3 workspace handle so `findCloseoutWorkspaces` and `verifyCloseoutWorkspace` prove identity and cleanliness. Before binding a replacement parent on the recovered closeout checkout, the adapter verifies the prior parent's identity and archived/deleted state, binds the ACP session pointer to the verified closeout directory, and persists the replacement `launchCommandId` for restart recovery |
| Tell, relayed answer, decision notice or brief amendment (`steerOrNotify`) | `message.dispatch` `steer_active` when the thread has a live run, read immediately before send; otherwise `queue_after_active` as `notify` | A proven not-sent steer falls back to one queued send under its own command identity; a remote steer failure is unknown delivery and is never resent. Nucleus's own lifecycle reminders and notices keep `queue_after_active` |
| Host-neutral fallbacks (run usage, native decisions, live-run presence) | No silent skip | Missing run-usage streaming records one `run_usage_unavailable` event per run; native-decision fallback records one `operator_question_route_fallback` event before ladder/board routing; absent live-run terminal/label presence is reported as `liveRunPresence: { active: false, reason }` in `service.health` |

Use `launchThread` for creation because it supplies the native workspace strategy
and initial-message preparation. Other mutations use `dispatchCommand`. Each
operation binds a stable command ID, native target and canonical payload to the
existing durable intent before send. Launch also binds its explicit thread and
initial-message IDs. Persist the mapping before remote creation so a lost reply
cannot produce an unowned thread.

Nightly `0.1.11-nightly.20261118.4890`'s installed bundle defines the one row
commands as (`apps/server` bundle, `OrchestrationV2` command union):

```ts
{
  type: "thread.snooze",
  commandId: CommandId,
  threadId: ThreadId,
  snoozedUntil: IsoDateTime
}
{
  type: "thread.unsnooze",
  commandId: CommandId,
  threadId: ThreadId,
  reason: "user"
}
```

`snoozedUntil` must be in the future. The handler refuses a thread with a
pending non-user-input approval, a queued user run, and an archived thread; a
snoozed thread wakes at `snoozedUntil` or early on a guest message, a pending
runtime request or a failed run, and the client never auto-settles a snoozed
thread. `thread.settle` clears a snooze, and `thread.unsnooze` clears the snooze
and leaves `settledOverride` exactly as it was (`runtimeLayer`, `dispatchOnce`).
Both commands are ordinary dispatch commands, so the runtime bearer's
`orchestration:operate` scope covers them; they need no wider scope.

**An ordinary delivery wakes a snoozed thread.** `dispatchMessage` clears
`snoozedUntil` and `snoozedAt` for every `message.dispatch` that carries neither
`notification` nor `delegatedCompletion`; those two automatic shapes keep the
snooze. Nucleus sends ordinary messages (a planner notice, a question, a
follow-up), so a message to a thread the operator snoozed used to clear that
snooze with no record of it. Tom reported manual snoozes cleared on two planner
threads and restored them; the private proof reads the wake on the installed
nightly (`t3-native-wake-on-delivery`), and the refusal below is what prevents it.

Nucleus never owns a snooze on a thread that is not a task row, so a message to
such a thread holds its delivery: the adapter refuses before the send, naming the
snooze, and leaves the manual snooze and that thread's transcript exactly as they
were. A proven pre-send refusal is not an unknown delivery, so the durable notice
keeps waiting and is delivered once that thread wakes (Tom's ruling, 2026-11-20;
nucleus#1445). A manually settled thread keeps its distinct rule: it is
unsettled and delivered to, because a settle is not a snooze.

Nucleus never issues `thread.settle` for a task thread (Tom, 2026-11-19). The
task's parent row is driven by the one attention projection the board and
`task.next` read (`shared/task-attention.ts`):

- *attention* or *active* — a person must act, or a role child is running: the
  row is shown, and a row this host snoozed is unsnoozed. A role's failed run
  names the row (`blocked: <role>`) only while the task's own attention is
  `attention`; a role that failed under a wait or a settled incident is history
  and never holds the row (nucleus#1437). A role waiting on a current question or
  permission always names the row (`<role> needs input`). Task-level title and
  row reconciliation (`WorkspaceTitleProjection` draining `enqueueTitle`) runs
  `reconcileTaskRow` right alongside title updates when a role goes active or
  attention changes, instead of waiting for the next periodic sweep; `HostPass`
  also reconciles active and attention rows ahead of waiting and finished rows.
  One pass derives every row of a host from that projection before it writes any
  of them, and the Inbox title counts those rows, so a row fault never leaves a
  partial reading (nucleus#1443).
- *waiting* — the task waits on nothing Nucleus is running and needs no one: the
  row is snoozed, including past a role's old fault (nucleus#1437) and while an
  unconfirmed role launch (an `intent` reservation or `uncertain` creation with
  no bound agent or observed active turn, or an unbound `agentIntent`) waits in
  a passive lifecycle, capacity or host wait for Nucleus to reconcile it
  (nucleus#1453). Visible activity and the Inbox running count require a
  confirmed running role (`status: "running"` with a bound agent not observed
  idle, or observed active execution) rather than delivery ownership alone,
  while durable intent ownership, held capacity, escalation and recovery stay
  unchanged. An owner hold with a release condition, a planner's own hold and an
  unresolved completable prerequisite wait are waiting with their named cause. An
  operator-owned hold with no release condition and an operator-owned
  prerequisite correction remain attention, and a confirmed running role,
  pending question or permission, genuine attention or escalation, or the
  `#1417` hidden-row notice still surfaces the row.
- *finished* — the row's snooze is retired and the terminal lane archives it.
  The finished parent's archive is its own step in the host pass, settled from the
  durable parent binding before any of these reads: see [A finished parent is
  archived by its own step](#a-finished-parent-is-archived-by-its-own-step).

A planner's own hold parks the row the way a releasing hold does (nucleus#1419):
the planner already said the task waits, so the row must not ask anyone for
anything while that park is answered. It stops being a park when the planner's
nudge for that hold generation goes unanswered (see *A planner's own hold parks the
row until its nudge goes unanswered*, below).

The horizon is bounded (48 hours) and the ordinary sweep renews it with 24 hours
left, so the row never wakes itself while the task still waits. The command
identity is deterministic per wait episode and horizon (advancing on a new
occurrence after a spent receipt), so a returning identical wish never reuses a
spent command. Like every presentation write, the effect is recorded before the
send and the adapter reads `snoozedUntil` back afterwards — both on snooze and
on unsnooze. For a snooze, an unknown delivery retains its identity and is never
blindly resent; a later read that finds the requested horizon establishes
ownership, a different snooze is left alone, a refusal stays active for that
wait without retrying, and if the task becomes active before an unknown snooze
resolves, a later wait can snooze after the old horizon expires.

**Ownership is one verified row and the exact occurrence it wrote (nucleus#1445).**
Tom, 2026-11-20: "Nucleus must leave snooze state alone on T3 threads that aren't
assigned to Nucleus tasks, including registered planners and personal threads."
Snooze renewal, row visibility and unsnooze all ask one ownership question: this
task's recorded parent binding still names this exact thread (never the inbox, nor
a thread another task's record also claims), the record is bound to this task, and
a fresh read shows exactly the horizon that record wrote. A record written before
the task binding was stored proves itself only by that same horizon. Anything else
is somebody else's snooze, so this host writes nothing to it: a replaced horizon
is the operator's, a legacy record T3 does not match claims nothing, and a
read-back that is not the horizon the command asked for is never adopted. An
unreadable row still reads as unknown with its recorded snooze kept as evidence.

A record is written with the task it belongs to, so a record another row wrote is
dropped rather than renewed or cleared. The delivery gate asks the same question
in the other direction: it delivers over a snooze only when exactly one recorded
parent binding names the thread and the record proves that exact horizon, so no
message or command reaches a planner, the inbox or an unrelated thread.

Unsnoozing never forgets this host's snooze record on the command
acknowledgement alone: the record stays until a fresh T3 read (dropping any
cached snapshot held earlier in the pass) proves `snoozedUntil` is `null` or
`undefined`. If a `thread.unsnooze` command settles yet T3 still reports
`snoozedUntil` (a delayed apply, a stale observation or an ack that did not
take), the next pass re-observes the thread fresh: if `snoozedUntil` has since
cleared, the snooze record is retired without sending again; if it is still set,
the host retries `thread.unsnooze` as a new occurrence under the next
deterministic command identity. An unknown delivery (`timeout`, in-flight late
reply or remote failure) retains its command identity and is never resent
blindly while delivery is unknown; once a fresh read confirms `snoozedUntil`
cleared, the unknown unsnooze intent settles and the snooze record is retired.

An operator snooze (any live snooze not recorded by this host) is left exactly
as it is, and a repeated pass inside the horizon writes nothing.

**A row that stays hidden says so to the planner (nucleus#1417).** The row's snooze
is normally the design working: a task that waits on nothing Nucleus runs is
deliberately hidden. It stops being normal when the wait has gone on quietly, so
the host reconciles the row's visibility on every pass before its presentation
step (`rowSnoozeVisibility`): only the exact occurrence this host wrote is
Nucleus-owned, a row T3 reads unsnoozed or an operator replaced, snoozed or
settled is clear, and a row the host cannot read is unknown rather than clear.
Reading first is what lets the pass that decides an escalation present the row it
just woke, in that same pass.

A Nucleus-owned snooze is one continuous episode, from the first snooze until a
fresh read proves the row shown, the task closes out, or a genuinely new wait
starts. The episode start is durable state in the adapter's own record: every
horizon renewal keeps it, and a record written before the field existed proves its
start from the horizon it read back (it was written exactly one horizon before
that). After 30 minutes the planner gets one `row_hidden` notice through the
ordinary durable notice path, naming the task, the age, the current wait reason,
the last task transition and one supported inspection or owner action. It says
which of the two cases it is: a wait that is genuinely waiting, or a row that
should be shown (a role is running, or a person must act) while T3 still reads it
snoozed — the ordinary unsnooze reconciliation keeps running either way, and an
unreadable row is reported as an unread observation fault with its recorded snooze
kept as the evidence.

Exactly one notice belongs to one episode, so sweeps, rolls, horizon renewals and
owner changes never produce a second; a pending notice follows the owner it would
reach now. An episode that ends supersedes an undelivered notice, and one the
planner has already read keeps its record. An undelivered notice stays pending and
visible while the planner's turn runs and is delivered when it ends; a failed send
is unknown delivery and is never resent. When the ordinary attention delivery
already reached this planner for the task's current state, the hidden row is
recorded as one `row_hidden_visibility_failure` event instead of a second message.
Presentation after that state stays the same: nothing here settles, stops,
restarts or releases anything, and an operator's snooze or manual settle is never
interpreted as Nucleus-owned.

**An explicit hold is excluded from the 30-minute rule (nucleus#1417).** A hidden
row behind a hold fence that blocks the current phase does not accrue wait time.
After three hours of one continuous hold generation the planner gets one
informational `row_hidden` nudge naming the hold's reason and its release condition
where it has one; it changes no hold, owner, release condition or escalation. A
Spec 040 hold prompt that already reached this planner for the same generation is
reused instead of repeated. Time under the hold never accrues toward the wait
episode: the 30-minute clock starts again at the first pass after release.

**A planner's own hold parks the row until its nudge goes unanswered
(nucleus#1419).** An effective hold whose holder is the task's planner — the planner
the brief named, else the task owner — is the planner's own park, whether or not it
names a release condition, so it snoozes the task row like any other wait while the
work is quiet (Tom, 2026-11-20). A hold the operator placed, and one a worker,
reviewer, coordinator or any other participant placed, keeps its existing treatment:
only the thread that answers for the task's planning parks its row. A running role,
an independent call for a person, an origin fault or a pending question or permission
keeps the row visible whatever the hold says. The fence stores the nudge and the answer in `plannerAnswer`: the generation's
start, the due time (its start plus the three-hour hold bound), the durable notice
that carries the nudge, when that notice was confirmed delivered, and — once the
window closes — the moment it went unanswered and the delivery fault when delivery
was never confirmed. The nudge is raised only while the row is hidden, is the one
`row_hidden` notice of the existing hold rule, and reuses the Spec 040 prompt
instead of repeating it.

From the later of the due time and a confirmed delivery the planner has thirty
minutes to `release` the hold or `keep_hold` it into a fresh generation. A release
ends the hold, and the ordinary wait rule takes the row over; a keep is a new
generation, which starts a fresh hidden clock, nudge and answer window (Spec 040's
`keep_hold` also restarts the fence's own start time). Neither one is an
escalation. When the window closes with the hold still in place the task is
attention again for that generation: the row is unsnoozed through the ordinary
read-back path and stays visible until the planner releases or keeps that
generation, and the pass records `row_hidden_hold_unanswered`. When
delivery was never confirmed the pass records `row_hidden_hold_undelivered` with
the notice path's own reason and the fence keeps that `deliveryFault`, so the row
is shown and the fault with it. Ordinary reads, sweeps, unchanged state and
callback noise are not an answer. Nothing here releases, lifts, keeps or changes a
hold because a timer fired: only the planner's own `release` or `keep_hold` answers
it, and a self-lifting hold ([Spec 046](046-self-lifting-merge-holds.md)) names its
own end so it is never measured by this window.

A settled thread starts no run, and T3 does not clear a manual settle on
`message.dispatch`. So every message, decision, re-entry and follow-up goes through
one delivery gate, `wakeBeforeDelivery` (Tom, 2026-11-19). The gate reads the thread
fresh and refuses an archived or removed one before anything else. A settled thread
is unsettled with a recorded `thread.unsettle` (`reason: "user"`), whose command
identity is `identity("unsettle", [threadId, messageId])`, and is read back until T3
shows it active; only then is the message sent. The read-back allows a few short
gaps for a late apply. A thread still settled after those gaps refuses before send,
and the message stays queued for the next pass. An unsettle with an unknown outcome
is never resent blindly: the next pass reads the thread first, and resends the
unsettle only when that read shows it did not land. An unsettle that landed is
settled, not repeated. A settle is how the operator parks a thread until Nucleus has
news. Nucleus never issues `thread.settle`, and a snooze or other settle the operator
placed is left as it is.
Existing closeout and retention paths still decide when threads are archived or
removed; the [thread lifecycle](#thread-lifecycle) is where that decision lives.

### Model options

The nightly carries each model's configurable options in
`server.getConfig`: `capabilities.optionDescriptors` — a select with its
choices or a boolean toggle, `currentValue` when the provider reports one
(`packages/contracts/src/model.ts`, nightly
`0.1.10-nightly.20261111.4529`, app commit `d2c25950b4d9`). A model's
`capabilities` is `NullOr(ModelCapabilities)` and a provider's `status` is one of
`ready | warning | error | disabled`, so a model whose options are not known yet
reports `null` or no descriptors. `hosts/t3code/thinking.ts` owns the one decision
of which option carries a model's thinking level (nucleus#1375): the catalog
publishes from it and the pre-send fence resolves from it, over the same model
entry, so a profile selection keeps is never refused by the fence.

The carrier is the option this adapter's table names for the provider (`thinking`
for Pi, `effort` for Claude and FX) when the model reports it, else a select T3
itself reads a level from: a select marked `role: "reasoning"`, or one whose id is
in `vocabulary.thinkingSelects` — `reasoningEffort`, `effort`, `reasoning`,
`variant`, `reasoning_effort`, `thinking_level`, `thinking`, which is T3's own
client list (nucleus#1375 read it from the installed bundle). A stock codex model
reports `reasoningEffort` with no `role`, which is why the id list, not the role
alone, decides. An id-only match must offer at least one canonical level; otherwise
it remains a feature. The catalog maps a generic reasoning select to
`thinkingOptions` (with `defaultThinkingOptionId` from the default choice or
`currentValue`), the table's own carrier stays a feature the way it always was,
and other selects and booleans become catalog features; model `aliases` carry
through.

At launch the adapter maps the profile's thinking level and feature values into
`ModelSelection.options` (`[{ id, value }]`;
`packages/contracts/src/modelSelection.ts`, values `string | boolean`). The
canonical thinking level reaches the model's carrier whichever way the profile
stores it (nucleus#1364): a level stored as `thinkingOptionId` and a level a
translated feature carries (`translated: ["thinking"]`) are the same fact. A
canonical level the model's carrier does not offer settles to the nearest level it
does offer, by the one ordered-scale rule in `shared/profile-vocabulary.ts`
(distance decides, a tie takes the lower level, so a translated level never
silently buys more than the profile asked for); the live nightly's
`gpt-6.1-terra` offers low..ultra, `gpt-6-luna` offers low..max, Muse 1.3 offers
minimal..xhigh, and DeepSeek 4.1 Flash offers low, high and max. A level therefore
never fails at send.

A snapshot that cannot answer yet is a **host wait**, never a refusal: the
provider is not `ready`, or it reports no model option on any model (T3's initial
and re-probe snapshots do exactly that). The adapter raises
`HostSnapshotPendingError`, dispatch releases the creation and the task waits on
its host for the next pass to read a settled snapshot. Selection treats such a
model as `unsettled`: it publishes the table's levels and keeps the profile, so
dispatch is never parked on an answer the host has not given. A settled snapshot
that truly reports no carrier — Pi's `default` model reports none while other Pi
models do — is refused before send with the option named **and the model's real
option descriptors** (`serviceTier:select, cyberAccessProgram:select`, or `none`),
and selection keeps that profile out of a host-bound task. `service.health`'s
`t3code.modelShapes` line carries the same descriptors (id, type, role) for every
provider the last read reported, so a refusal is diagnosable from the host's own
facts. Any other feature value the model does not report is refused with the
option and value named — no silent dropping, no post-send guess.

A nested role's options are resolved against **the role profile's own provider
entry**, never the parent provider's: the `nucleus` ACP parent provider reports
models with no options at all, and judging a codex profile by that entry refused
every nested role launch on the pilot (nucleus#1375). The fence runs before the
parent thread is created, so a wait or a refusal leaves no held turn behind.

Selection keeps such a profile out of a host-bound
task in the first place: the engine keeps a
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
host answers availability from its own catalog. Profiles store Nucleus's
canonical vocabulary (task 1158, Tom 2026-11-12: "hard code the mapping that each
host gives to each provider and have them converge on one canonical corpus"), and
this adapter owns T3's translation table, `hosts/t3code/vocabulary.ts`: canonical
`claude` is T3's `claudeAgent` instance with its thinking level as the `effort`
option (`ultra` is `ultrathink`); Pi's thinking rides the `thinking` option and
FX's `effort`; Codex, Grok and the rest ride the reasoning option. Canonical
`supervised`, `accept-edits`, `auto` and `full-access` are T3's
`approval-required`, `auto-accept-edits`, `auto` and `full-access`; `plan` and
`auto-review` have no T3 form, so a profile naming one is unavailable on T3 with
the reason. The T3 routing snapshot carries the translated values, so the launch
sends T3's own `instanceId`, options and runtime mode. On the recorded nightly
snapshot every enabled pool shape runs on T3 (`test/profile-vocabulary.test.ts`).
Nothing is configured per profile; `profile.compatibility` shows each answer.

A creation refusal that is proven pre-send settles the run refused and the task
in attention with the step that failed named — `Worker creation refused before
send: …`, `Reviewer creation refused before send: …`, `Coordinator creation
refused before send: …` — instead of the absent-creation exact-lookup ladder,
which would find nothing and send a replacement into the same refusal. A refused
coordinator creation (`CoordinatorRoute`) releases its run, credential and
episode agent binding at once and keeps the escalation with the refusal named, so
nothing remains to look up and the owner's `restart` re-arms recovery instead of
being refused by an intent that never crossed the send boundary. Until that
restart, recovery selection leaves out every profile this host refused before
send, so the retry asks for another eligible one rather than repeating the
identical launch; when none is left the ordinary route-unavailable wait names the
`route` that fixes it (nucleus#1364).

The adapter's owner-only state file binds those records to the authenticated
environment. The service is that file's single owner: it holds the parsed record
in memory for the life of the connection and writes through on every change, so a
status line, a health read or the board snapshot never reads or re-parses the file
(nucleus#1327: on 2026-11-18 every status getter re-read a 12 MB file, 35% of the
executor's samples). The owner-only mode, ownership and symlink checks run on the
one load; a file that is corrupted or unsafe there refuses the record exactly as
before, and a second owner-path reader in the same process gets its own load.
Synchronous exclusive locking and atomic, synced replacement keep intent durable
across a crash: a write that fails or is refused leaves the file as it was and
discards the in-memory record, so the next read loads what the file holds. A held
or abandoned lock refuses writes; the adapter never guesses that a prior process
finished. Settled commands return their recorded outcome; unresolved commands are
never resent.

The history the file carries is bounded. Beyond the newest 64 terminal commands an
entry keeps its delivery receipt — status, kind, thread, the digest of the wire it
delivered, its deletion marks and, for a launch, the thread a replay reads — and
loses the message or launch body. The entry itself is never dropped: a command
identity stays taken, so an exact lookup and the snooze, unsnooze and row-title
ladders still find what they recorded, and a repeat replays the receipt
instead of sending again. An unresolved intent (`unknown` delivery) is never
compacted, a pre-send refusal keeps the wire a recorded retry replays, and the
kinds whose body a later exact lookup parses (a confirmed deletion, a runtime
response, a project mutation) keep theirs. Per-thread records — agents, parents,
workspaces, snooze records, row titles — are one small entry per thread and each is
the exact fact a later lookup reads, so they are kept (24 KB of that 12 MB file).

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
uses the existing pre-send error/result. The connection precondition (no
authenticated connection, or a changed durable host identity) is one: it refuses
before any request, so a durable operation that fails on it settles failed with a
reconciled effect. Every other compatibility failure can follow a call and stays
unproven. After a possible write, remote errors cannot establish non-delivery. A command receipt proves acceptance, not provider
completion or a Nucleus report.

## Observation and restart

### Live shell (Spec 069 batch 5)

The adapter holds one `orchestration.subscribeShell` subscription per connection
(`hosts/t3code/live-shell.ts`). T3 answers it with one authoritative snapshot, a
`synchronized` marker and then a live tail (`thread.updated`, `thread.removed`,
`project.updated`, `project.removed`), and the adapter applies that tail to the
copy it holds. Every reader — the host pass, the board's live lists, Settings,
project observations, exact lookups — answers from that copy, in a pass or not.
The live shell lists every active, non-archived thread, so a thread it does not
list is not live.

Freshness is bounded: the copy counts as live only while its subscription is
open, its tail has delivered an item within five minutes
(`LIVE_SHELL_QUIET_BOUND_MS`), and the subscription is younger than fifteen
minutes (`LIVE_SHELL_MAX_AGE_MS`). Past either bound, or after a dropped stream, a
disconnect, `snapshot-required` or an item the adapter does not know, the next
reader that needs a current answer opens a new subscription and waits for its one
fresh snapshot; rows that differ between the two copies count as changed. The
opening snapshot has the 60-second deadline thread snapshots have; one that
outlasts it is a `T3RpcError` timeout, which fails only the step that waited, and
a remote failure to open is a transient read refusal (`T3TransientReadError`).
Neither is an incompatibility or a host fault. After a failed open the next one
waits out a backoff (1 s doubling to 60 s); a decision read in between gets a
bounded `T3ShellBackoffError` refusal instead of another open. The previous copy
is kept: the board's and Settings' live-agent list (`listLiveAgents`) answers from
it at once while the new one opens in the background. Decisions never read that
dated copy.

There is no archived or paired inventory in steady state (Tom, 2026-11-22: "We
shouldn't need to be reading archived threads at all"). Where this spec says a T3
read uses the "complete" or "paired" inventory, the adapter now reads the live
shell and, for a bound thread the shell does not list, one exact
`subscribeThread` read by id. That exact read answers an archived or tombstoned
thread with its own record, and `ThreadNotFoundError` (or the projection's proved
missing-thread cause) means T3 has no such thread: removed, or never created —
unless the live shell lists it, because T3's projection store and its shell can
disagree for a moment, and a creation lookup must never answer such a thread
absent. Its
answer is kept until T3's shell names the thread again, a command goes to it, or
the connection drops, so a missing thread costs one read, not one per pass. A
thread a command just went to (`forget`, including the child a
`delegated_task.request` derives) keeps its exact read until the shell shows it,
because its absence may only be the stream's lag. `T3InventoryChurnError` is gone.
The one archived read left is the retention pass's walk, on its own interval
(see Archived thread retention in the orchestration contract).

For already-bound targets (`observe`, `originAgent`, `isObserved`, `activeRunId`,
`activeRunIds`, `runtimeRequest`, `knownThread`, `parentGone`, and
`restoreForRestart`), a transient projection read
(`OrchestrationV2GetThreadProjectionError` without a missing-thread proof for that
thread — including `ProjectionStoreReadError`, `LegacyV1ThreadImportError`,
missing/unrecognized `cause`, or a missing fork ancestor) throws
`T3TransientReadError` (a `HostReadRefusalError`) rather than inferring absence.
This keeps T3 online and model-eligible, records no `host_transport_fault`, and
never marks an un-sent intent refused or unknown (`intents.ts` releases the
provisional intent reservation before delivery on `HostReadRefusalError` or
`HostSnapshotPendingError`).

When a proved pre-send transient (`HostReadRefusalError`) hits worker launch,
ordinary reviewer admission and owned-tool custody checks (`#1448`), recovery
coordinator admission, durable owner controls/restarts, or `question.answer`:

- **Lifecycle and review/recovery admission:** any un-sent run reservation or
  creation intent (`agentIntent`, unsent `runId`, credential, or coordinator
  `recoveryAttempts`) is released without consuming launches or raising
  immediate `needs_attention`, retaining the task in a bounded, visible
  `external_unavailable` wait and retrying automatically on fresh evidence
  until settled or exhausted after sustained failures (`hostReadTransient:*`
  episode -> one actionable escalation). Positively live or genuinely unknown
  tool custody (gaps, stale cursors, missing timelines, live workspace/run
  processes) still blocks review admission.
- **Durable owner controls and #1431 parent restore:** `task_control`
  operations failing before their send boundary retain their authorized intent
  without consuming attempts and retry automatically on recovery; after a
  lost or unobservable restore boundary, `holdParentRestore` / `observeRestartRestore`
  keep the operation pending while manual archive/restore policy stays intact.
- **`question.answer` (`EscalationSettlement` / `Delegation`):** when the
  pre-send check cannot read (e.g., observing the worker for an active turn,
  checking/delivering a live reviewer direction, or checking an owner control's
  custody before send), the already-recorded `delegated_answer` receipt is
  honored without recording `delegated_command_refused` or losing the answer.
  The call returns `{ ...receipt, status: "pending" }`, places the task in a
  bounded `external_unavailable` wait, and retries applying that same recorded
  answer once host reads recover (escalating once on sustained exhaustion),
  while still refusing conflicting overrides, unknown sends, distinct identity
  failures, and manual archive/restore policy. Native question forwarding
  (`NativeQuestions`) likewise preserves recorded answers without recording
  `native_question_unknown`, and manual `host.question-answer` records
  `native_manual_answer_refused` on pre-send transient/refusal failures.
`archivedThreads` reads `getArchivedShellSnapshot` once to enumerate candidates
(with a 60-second deadline), and only the retention pass calls it.
`threadArchiveState` then answers from the live shell (an unarchived thread reads
live there at once) and from that same walk. The read after a removal is not a
fresh observation: T3's settled `thread.delete` receipt confirms the removal, so
that read answers absent even before T3's shell streams the removal. Without a walk on
this connection it is one exact read by id. Do not enable omission of older settled threads or idle children.
Project-enrichment snapshots marked with `resolvedRepositoryIdentityRoots` can
carry empty thread arrays; they never replace authoritative shell reads.

Observation reads keep each sweep bounded: T3 transport and timeout errors fail
only their own step (host health is the connection's, Spec 069 batch 2), and a
transient read refusal keeps the host online and lets independent work proceed.
A task quantum that does not return within two minutes (`TASK_QUANTUM_BOUND_MS`)
releases the sweep; the task records an `observation_outage` event and its lane
stays held until the quantum returns (#1148, planner ruling).

### Observation window

A host pass states the tasks it still works on (`beginHostPass`, closed by
`endHostPass`), and that is the whole scope of thread observation
(nucleus#1328). The adapter observes a thread only while its Nucleus task is
live: a thread whose task is done or cancelled, or that T3's own thread list
reports archived or removed, leaves observation. Its live record moves to the
stored `retiredAgents` index, which keeps the identity its own rows read —
workspace, labels, the recorded parent link a nested child's one-row rule needs, and
the task's state title — so an exact lookup and the terminal archive lane still
answer; the intent ledger, the snooze records and every recorded command
stay exactly as recorded, and a confirmed deletion marks the retired record. Nothing
leaves T3: leaving observation never deletes, archives or edits a thread, and a person
or planner re-attaching a thread returns it to observation under the ordinary verbs. A thread that has left observation answers from the thread list
alone, because that row already carries the thread record, its status, active run
and pending request; `observe`, `originAgent` and the archive lane therefore read
no snapshot for it, and a read that would need one is refused rather than answered
from memory.

Every consumer shares the live shell and one held snapshot per thread: status, row
step, the row's shown/snoozed decision and pending questions all read the same
answer. A thread's snapshot is kept with its live-shell row as the change marker —
the whole decoded row, including `updatedAt`, `status`, `activeRunId`,
`settledOverride`, `archivedAt`, `deletedAt`, T3's `itemCount` and
`visibleItemCount`, `latestRunId`, `activityRunStatus` and the pending request —
and is read again only when that row moved, in a pass or out of one, so an idle
unchanged thread is never re-read. Two kinds of thread cannot be answered by the
row and are refreshed at most once per pass: a thread with a pending runtime
request (the row summarizes one request; its questions are in the snapshot), and a
thread with a live run (its projection's `updatedAt`, which a stall check measures
quiet time from, and its window's tool output can move under an unchanged row).
Out of a pass those two are read fresh. A command dispatched to a thread drops its held
snapshot, so a post-write read is never answered from before the write. A
transcript read is never served from a bounded snapshot.

Pending questions are read only for a thread the live shell marks as awaiting a
runtime request. At most `T3_THREAD_READ_CONCURRENCY` (4) thread snapshots are in
flight to one host; further reads wait their turn in arrival order (an owner or
answer read outside a pass queues behind pass reads already waiting), and
heartbeats (control frames) never queue behind them. The catalog is one
`server.getConfig` read in flight at a time; when T3 takes longer than
`CATALOG_PROMPT_MS` (2 s), a caller that already has a catalog from this
connection gets it at once and the read finishes in the background. The first
catalog read on a connection, and the first shell snapshot, are waited for.

A follow-up child is recorded when its message is sent, before T3 creates (or
declines to create) it, so it is only a candidate until the live shell lists it
(`seenAt`). An unseen candidate costs no read while its task runs and is dropped,
not retired, when the task ends: a reminder, checkpoint, brief amendment, reviewer
report or revision-run prompt (`ns-run-<runId>` to the retained reviewer) whose
message T3 delivered into the existing thread never becomes a thread to read.

The move is reversible and loses nothing: a thread T3 no longer reports archived — a
person or a planner re-attached it — returns to observation on the next pass with the
record it had, including its recorded parent link and state title, and recording a
thread again under its own identity (an ordinary launch, or a child created again)
writes its live record and retires the retired entry. A confirmed removal keeps its entry marked, is never restored, and is never
an exact-lookup answer, so one thread is never named twice.

Leaving observation never turns an unknown delivery into a confirmed effect.
The adapter does not resend or reconcile it without an authoritative read.

A control action still works, and it never confuses "nothing is running" with "I
could not look". An explicit stop reads the live run from the thread list's own
`activeRunId` for a thread that left observation, exactly as `activeRunId` answers
`tell`'s steer-or-notify and the interrupt-and-continue path; a thread list that
cannot be read is an error there, not an empty run set, so a stop is refused and
retried instead of being recorded as sent. Absence from a complete list is a
removal, and a removal cancels its runs, so that answer is empty and final. A
guarded send refuses on the same gate before it reads a projection.

A command dispatched to a thread drops the snapshot held for it, so a read later in
the same pass cannot answer a post-write question with a pre-write answer: a snooze readback and title reconciliation see the effects just sent.

Report active run, idle, pending question/permission and archived state from
positive native facts. A removed thread has no projection; the origin read uses
`deletedAt` or absence from a complete authoritative inventory to prove removal.
It does not invent an observation with remembered workspace or ownership labels.
Partial reads reject or return the contract's unknown result. A disconnected
thread never becomes idle or gone by timeout. Timeline
pages retain gap and coverage facts; a bounded tail is not full history.
Active and archive snapshots must report the same application-event sequence;
otherwise their union is refused as incomplete. This includes an unarchive
between the two reads, which could otherwise hide a live thread. A direct
retained-thread read must settle an identity before reporting it gone. Coverage
flags and cursors are strictly typed, and a claim the nightly never makes is
refused: `hasMoreHistory` and `historyCursor` are one pair, so more history
without a cursor, or a cursor with no more history, is not usable. A *paged*
snapshot is not a malformed one. The nightly answers a bounded snapshot only to
a read that opts in (`acceptBoundedSnapshot`), and that snapshot keeps exactly the
facts observation reads: the thread record is whole, the projection carries every
queued, preparing, starting, running or waiting run, the runs its window
references, the run the shell presents, and every pending or waiting runtime
request; plans and context handoffs are filtered to the active or window-reachable
ones. Settled runs, resolved requests and the timeline before the window are
absent, and none of them changes a status, an active run, a pending request or a
settle marker. Observation asks for that bounded snapshot and reports status,
active run, pending request and archive state from any length of thread, so a
long thread is never unobservable (nucleus#1188). The timeline and question reads take the same bounded snapshot. The timeline
returns the whole newest rendered window (`visibleTurnItems`), with no gap,
reset or newer history, the thread as its stable epoch and local item ordinals
as cursors. `hasOlder` follows Nightly's coverage flag; `projection: "bounded"`
explicitly distinguishes this window from complete tool-history evidence.
Retained request and interrupt dependencies in `turnItems` are not window rows.
Native commands, edits, searches, subagents and dynamic tools become shared tool
entries; pending tasks on the retained provider threads remain positive live
evidence even without a corresponding tool row.

For a T3 participant, owned tools clear only when all three observations clear:
no active run or pending runtime request; no live tool or provider background
task in the newest window; and no owned process in the workspace or recorded
run temporary directories. Workspace archive resolves every recorded run for
each participant in that workspace, including attached support roles and the
task-row worker, and checks every scratch root on each proof pass. A missing
run inventory, identity or scratch root stays inconclusive.

A participant ticket is a run identity even without a run row. The retained
worker's ticket is the task's recorded scratch leaf; a retired worker record
names the worker ticket a replacement displaced, so its leaf is the one that
ticket's own identity names beside the recorded leaf in the shape the launcher
wrote (the 8-character leaf, the older 12-character one, or `runs/<ticket>`).
That is the root its processes were started under, so the proof scans it rather
than calling it unrecorded, and a process still living there holds. A ticket
recorded on another host, one this task never recorded, or a recorded leaf in
none of those shapes stays unrecorded and inconclusive, as does a run row with
no recorded leaf.
History pages are not read or reconstructed (planner ruling, 2026-11-15).
Provider threads are window-retained: active threads, threads referenced by the
window or retained nodes, and the latest todo owner. The residual premise is
explicit: a T3-internal background task on an idle provider thread outside the
window is not covered. That is a T3 limitation, not a Nucleus absence claim.

Pending questions use the retained runtime request and its `user_input_request`
item. A missing item is refused by that exact field. Answered questions cover
the retained answered window; an absent question item leaves its text empty.
Answered reads return an explicit success or unknown result; an unreadable
bounded snapshot never becomes an empty answer list.
A complete-transcript read still refuses a paged or locally omitted projection;
no consumer requests an unbounded snapshot. A native answer reads the window too
(see Native question answers), so no answer needs the transcript.
Complete shell
and archive inventory reads contain summaries rather than transcript history;
the Nightly exposes no complete paged shell form. Omitting settled threads or
subagents cannot establish absence and is not an inventory substitute.

`effigy proof:t3code:read-sizes` measures the live config, shell, archive and
full/bounded thread replies read-only. It records byte counts, field names and
collection counts with synthetic thread labels, never remote contents or IDs;
the full reads belong only to this explicit diagnostic, not adapter reads.

An observation read that fails names its own cause. Every owner path that turns a
caught observation into a refusal keeps the host error's kind and message: the
`restart` refusals, `move to=review`'s reader check, the quiet-project participant
proof of an external-merge source acceptance, and a finished run whose
observation fences the verb. One rule applies to every host (planner ruling,
2026-11-14): the kind is the error's class name plus its `code` or RPC `method`
whenever the error carries one — a system code such as `ECONNREFUSED`, a numeric
code, a library code or a non-dotted method name all count, first line only and
clipped — and the detail is the first line of its message clipped to 200
characters. Presence decides, not a character class. Hosts are the operator's own local services and the refusal goes
only to the task owner, so the host's words are shown as they are and nothing is
certified: a Paseo `Agent was not found` and a T3 `T3Code timeout:
orchestration.subscribeThread` both appear verbatim.

The canonical thread projection is the whole turn list, while a T3 timeline page
is the nightly's rendered window: the page carries the window's own coverage (no
gap, no reset, no newer history, the thread as its stable epoch and cursors as
positions inside the window), so a page never claims the full list, and its
entries come from the rendered rows rather than the item list that also holds
the nightly's retained dependencies. The test transport serves only records in
the Nightly's own wire shape:
`test/fixtures/t3code-contract.json` (`wireShapes`) records the field sets
captured read-only from the nightly, the fake completes every served thread,
run, runtime request, message and turn item to them (`visibleTurnItems` derived
from the items served, so a window holds no older rows), and it checks both the
records and the projection's own key set, so an invented partial record or a
missing collection cannot stand in for a real one (nucleus#1188). Archived
threads are retired participants: they report the terminal
closed state with `archived` carried on its own field, so archive proofs and
workspace teardown read a terminal state while retained reads still see the
retirement. The workspace thread inventory reads the same terminal states as the
single-thread read (nucleus#1381): a finished run (`completed`, `interrupted`,
`failed`, `cancelled`, `rolled_back`) reads `idle`, an archived thread `closed`
and a tombstoned one `gone`. A live run, a pending request or any other status
holds the archive. A delegated follow-up child leaves observation with its task,
as its parent does, so a finished task's follow-up reads as retired, not as a
live row.

On T3 startup, active runs are cancelled and live approvals expire. Pending
questions may remain pending with `responseCapability: {type: "message"}`.
Read this capability from the fresh thread projection and answer through
`runtime-request.respond`, which owns the message-based continuation. Do not
invent a second follow-up. Expired or nonresumable approvals cannot be answered
again. An interrupted answer remains uncertain even if the request later expires;
expiry is not evidence that the original answer was never delivered.

## Operator decisions on T3

Every open operator decision belongs to one host's pinned **Nucleus** inbox
(Spec 032, Tom 2026-11-22). A task thread never shows a decision card and never
holds its turn for one. A linked T3 task's host picks the Inbox, so a planner
sign-off about that task reaches the host that owns the work; a decision that
links no such T3 task belongs to the connected host's pinned **Nucleus** inbox.
No parent is created to ask a question. A version bound to a task thread before
this ruling moves to its Inbox on its next offer, and the sweep's read of the task
thread settles and cancels the card left there; answered and withdrawn decisions
are untouched. An Inbox card for a task-linked decision is titled with that
task's reference and title, as the board's task link is. Opening, withdrawing or
superseding a decision wakes the reconciliation sweep so the inbox refreshes its
title and raises or settles cards without waiting for an unrelated wake. The
inbox has a dedicated service-owned directory and a host-scoped ACP binding, not
a task identity. Its credential can read its decision projection and answer it,
but cannot send a task message, report a run or exercise task controls. Re-minting
replaces the authority record and revokes the previous credential. The inbox is
not a role thread and retention and task archiving never select it.

The service durably binds a decision version to the exact Inbox of its first offer
before returning the form. A later link change does not move an Inbox offer, and a
restart keeps the same owner. A fresh read of the offering Inbox precedes a first
offer, and a legacy pending card on that Inbox is adopted from positive T3
evidence before anything else can offer the version. An unknown card read never
proves a card absent, and a bound version is re-offered only after its own scope
is read again. Offer, count, callback authorization and card settlement use the
same owner. An Inbox sign-off uses the ordinary authenticated T3 operator answer
route and leaves independent task holds intact (nucleus#1433).

Each open decision version becomes its own `elicitation/create` form on the Inbox
thread. The field id carries the decision id and version; its title names the
linked task, and the question and labelled options are shown by T3. Multiple cards
can remain pending on one held turn. An accepted answer goes through the existing
decision answer route as the authenticated T3 operator; it is not a planner relay.
A task with an open decision needs a person, so its row stays unsnoozed and names
the decision while the Inbox holds the card; the task's own thread is never held
for it. Once the answer is recorded, ordinary attention projection decides whether
the row snoozes again.

The adapter reads each pending runtime request before settlement. An answer from
another surface is sent to the same request as `runtime-request.respond` with the
recorded scalar answer. A withdrawal or supersession sends `decision: "cancel"`
without answers. T3 resolves the request and marks the question item cancelled;
the agent receives `action: "cancel"` and records no answer. Neither agent-side
`$/cancel_request` nor permission or URL-mode elicitation is used for these forms.

**A card belongs to the turn that raised it, and a lost card is offered again
(nucleus#1395).** An open, offerable decision always has exactly one live card:
the agent keeps a raised card for its own held turn only, so one version never
has two, and the next held turn raises again whatever the service still offers.
What is offered is the service's reading of two facts, never an assumption:

- the host's own read of T3. Each sweep reads the thread's pending runtime
  requests, settles the cards whose run or capability is gone, and records the
  ones still pending with their decision id and version
  (`observedCards`). The offer names the open versions whose cards that read
  confirms absent, so a lost card comes back on the next held turn in the same
  inbox, binding and session. Offers and re-entry wait for a successful observation
  when the thread's pending cards are unknown. A task thread's own read is used
  only to settle a card an earlier owner left there.
  A card older than the thread's window is read from the full transcript so the
  sweep can settle a card that survives a T3 restart;
- the operator's own dismissals. A cancel is the operator's only when it arrives
  for a card the held turn raised, and only that one is recorded as a
  cancellation receipt: an operator's cancel leaves the decision open and permits
  one re-offer per decision version, and the receipt survives a service restart so
  that limit is not reset. A card the client settles after its turn ended (across
  a callback-socket replacement, say) is a settlement the host made from its read,
  records nothing, and so never spends the version's re-offer. A version whose
  re-offer is spent no longer names the inbox, and no longer marks its task's row
  as waiting on a decision, because the offer key applies the same rule everywhere.

An answer whose delivery is unknown is never resent. The decision stays open, the
version is offered again on the next held turn, and the operator's next answer is
a fresh delivery. A card the client settles without telling the agent (the sweep
answers an ended turn's card, which T3 then cancels locally) is forgotten when the
next turn starts: a reopened thread's attach shows the line only and records no
offer. A held poll raises the cards once the host has confirmed their absence.

A T3 restart cancels the held run but can leave an old card answerable through a
message continuation. On load the agent does not treat that text as an answer;
it reads open decisions again. The adapter clears stale cards from the service's
record. Re-entry uses a durable occurrence generation, and a later confirmed
restart uses a new command identity. The same rule governs the inbox's re-entry.
How the previous occurrence is judged depends on its send (nucleus#1407):

- An acknowledged receipt (settled) is final. The fresh observation that shows no
  live or queued run is enough for the next occurrence, however far the old one
  has moved out of T3's window. No history read is made for it.
- An unsettled occurrence (unknown, refused or timed out) is decided from its own
  user message. The newest window is read first: finding the message there is
  exact. Absence is read from the full transcript, which alone proves it. A timed-out
  send waits for its late reply. A bounded window never proves absence.
- An unsettled occurrence older than the window cannot be proven either way. The
  paged transcript raises `subscribeThread: incomplete projection`, nothing is
  resent, and re-entry waits. The sweep reports it after its nesting pass runs,
  not as a silent skip.
  `effigy proof:t3code:window` runs this case on the installed nightly: an earlier
  wake pushed outside the window, a T3 daemon restart that keeps the inbox thread,
  binding and credential, then a fresh decision (`--expect woken`, or `--expect
  blocked` on the pre-fix code). Its evidence names the source revision it ran.

**The inbox is idle between decisions (nucleus#1384).** Its ACP turn holds only
while an operator decision is offered: the same host-scoped projection that raises
the forms, with the operator-cancel re-offer cap applied (`pendingInboxDecisionKey`).
The ordinary sweep re-enters the inbox with its marked message only while that offer
is open and no inbox run is live. It releases the turn only once nothing is offered
and every Nucleus card on the inbox thread is answered or cancelled on T3 (the card
settlement runs first, and its result gates the release), so no card is left
pending behind an ended turn. A pending card older than the thread's window (the
window keeps only the newest timeline suffix) is answered from the full transcript,
so a card that survives a T3 restart is still settled. A release directive is
cancelled by an offer that
arrives before the release. An empty inbox is released by the first sweep after
startup or a T3 restart. The inbox's T3 project is named "Nucleus Inbox"; its thread
is "Nucleus". A registration made before this change is renamed with T3's native
`project.update` title, so its project id, pinned thread, binding and directory
survive. Other repository projects keep their folder names.

**The inbox thread's title is its live signal (nucleus#1384, Tom 2026-11-19: "Perfect,
let's do it"; pause prefix, nucleus#1427; complete count, nucleus#1443).** The thread
title shows one signal, in priority order: "N decisions to answer" (or "1 decision to
answer"), counting decisions offered on this inbox by the same projection as the
cards; otherwise "N tasks running" (or "1 task running"), counting each task once
whose attention is active on this host in the pass (waiting, attention and finished
tasks are not counted, and neither is a task whose decision is open, since that is
the title's decision signal). The count is derived from the pass's complete set of
task rows — the same shared attention projection the row writes read, one row per
task, so every role a task runs is one task and a task on another host is never
one — before any row write reaches T3. A row write that fails or times out partway
through the pass therefore never publishes a partial count: the titles read the
pass's rows, not how far its writes got, and no tally of landed writes is kept.
While the persisted global Nucleus pause is in
effect, the title prefixes that signal with "Paused: ". The prefix does not change
the signal priority or counts. The title is written with `thread.metadata.update`
only when the thread's current title differs, including while the inbox is idle and
on pause, resume and reconnect reconciliation passes; the write never wakes the
inbox. Each write has its own command identity by title and a title generation, so a
title that returns to an earlier value is written again rather than replayed. The
project name stays "Nucleus Inbox".

The service mints a fresh one-time board link for `preview.open` on the inbox
thread. It sends the link only in that WebSocket call, never in an ACP prompt,
thread reply or intent log. A new host connection opens the pane again after T3 or the service
restarts; an uncertain open is not blindly repeated on the same connection.
`nucleus t3 install` grants `preview:operate` to the runtime bearer, and a repeat
install rotates that bearer.

Typing exact `ui` in the pinned Nucleus inbox shows the board in that thread's
browser pane and answers with one short result (Tom, 2026-11-19; bounded and
served-from-the-message by nucleus#1415). One `ui` is served once, by its own
message id, and the attempt is recorded in the host state before the native open
(`inbox.ui`), so a crash, an unknown delivery or a reconnecting socket never
replays that open; a later `ui` is a new message and a new attempt.

The inbox ACP agent routes exact `ui` through its authenticated `inbox` binding
(`/acp-inbox-ui` -> `AcpSessions.openInboxUi` -> `T3HostConnection.openInboxUi`
-> `T3Inbox.showBoard`). `showBoard` reads the inbox thread's window, finds the
newest operator `ui` message and serves it unless that message already has an
attempt. Serving reads `preview.list` for the inbox thread, closes every board
tab of this board's origin, mints a fresh one-time pairing link and calls
`preview.open` with `runtime: "server"` and `reveal: true`. T3's web client
auto-reveals server-rendered tabs. On the installed 0.1.12 nightly, an open
without a runtime returned a tab that stayed in `Loading` and never brought
up the pane. Non-`ui` prompts and task threads never
invoke this route, and pairing URLs never cross back to the ACP session, the
host state or logs.

The command is the operator's own words, not the whole prompt (nucleus#1435).
The nightly's ACP harness prefixes the client's instructions and wraps the
person's message in a `<user_request>` block, so on 2026-11-20 the prompt for `ui`
was that envelope and the agent's exact match never saw the command: the turn
went straight to the held poll, showed nothing and opened nothing. The agent now
reads the last `<user_request>` block as the operator's text and matches `ui`
there; a prompt without the block is its own text. A message T3's own tools send
keeps its marker inside the block, so it is not the operator's command. The
transcript's own message text stays exactly `ui`, which is what the window scan
serves, so the normal and queued `ui` paths share one reading of the command.

**A retained board tab is replaced, not reused, because the nightly cannot
reveal it.** Opening is the only reveal the RPC surface offers (see "Workspace
pane layout limitation"), so a healthy retained tab, a `LoadFailed` tab and a
duplicate left by an earlier attempt are all closed first and one freshly
revealed tab is opened in their place: exactly one board tab remains and the
open is what brings the pane up. The board's own scroll and in-page state are
not preserved across `ui`; the page reload is what the reveal costs (Tom asked
for the board to appear, not for the tab to be kept warm, 2026-11-20).

**`ui` while a decision holds the inbox (nucleus#1415).** An open decision holds
the inbox's turn, and T3 queues an operator's message behind a live run of the
same thread instead of starting another. The queued `ui` therefore never
reaches the agent as a prompt: it waits for the held turn to end, which waits
for the operator to answer the card. That is the silent turn Tom saw — the board
was never asked for, the card stayed answerable, and nothing was reported. The
ordinary sweep now answers it: the inbox pass reads the thread's window (the
queued message is in the thread's `messages` before it is a turn item) and,
when the newest `ui` is a message T3 has queued and has no attempt yet, serves
it from the same record with the same open. That pass touches only the preview
RPCs and `inbox.ui`: the offer, the card, its version and the hold are read and
never written, so answering the card is unaffected and the card is not re-raised.
When the held turn finally ends, the queued `ui` runs and reports that same
recorded result (`The Nucleus board is open.`) without opening a second tab. An
in-flight serve for one message is tracked in the process, so the turn and the
pass cannot both open for it.

**One bound, a clear result, and a responsive Stop.** Inbox lookup, message
lookup, link issuance and all preview calls share one
`INBOX_UI_DEADLINE_MS` budget (20 s), under the callback's 30 s bound. Inbox
lookup checks the live shell first and reads the inbox thread by its exact id only
when the shell does not list it. Each read uses the time left in the
same budget. If the deadline expires after an open is sent,
the command records a timeout and leaves that attempt's delivery uncertain.
The three cases are
reported as one line each: `Opened the Nucleus board.`, `The Nucleus board is
open.` (this message's open is already recorded, usually served by the pass), or
`Nucleus could not open the board: <reason>` with any pairing URL or token
fragment removed. Once the open finishes the inbox returns to `end_turn` (idle)
at once unless an offerable decision holds it, as every other inbox turn does.
The transport's `openUi` takes the turn's abort signal, so Stop ends the command
at once (`cancelled`, with no invented line) without waiting for the bound or the
socket; the service's own serve continues under its bound, and the operator's
next `ui` is a new attempt.

**Workspace pane layout limitation.** Verified against installed nightly
`0.1.11-nightly.20261119.4941` (commit `ff9efe89f6e7`): the right panel's
maximized state (`byThreadKey[threadKey].maximized` via `setMaximized` in the
client `rightPanelStore` persisted in `window.localStorage`) is client-local
only, controlled by the native "Maximize panel" toggle (`PanelLayoutControls`)
or `rightPanel.toggleMaximized`. Neither `WS_METHODS` (`preview.open`,
`preview.resize`, `preview.adjust`) nor `OrchestrationV2` exposes a server RPC
or command to set or toggle workspace pane layout, and browser viewport sizing
(`preview.resize`) does not change that layout. Likewise, `WS_METHODS` exposes
no `preview.reveal` or `tabId`-reusing `preview.open` RPC (`PreviewManager.open`
always creates a new `tabId`, and `PreviewManager.requestReveal` is internal to
T3's in-process MCP `PreviewAutomationBroker`). **A retained preview tab therefore
cannot be revealed through any supported call; `ui` shows the board by replacing
the tab with a freshly revealed open** (nucleus#1415). The adapter keeps T3's
native manual maximize control with no T3 patches or client-state hacks.

#### Board appearance in the browser pane

The web board uses the browser's `prefers-color-scheme` for its light and dark
palettes. A paired T3 tab also reads `/api/theme` when it loads, independently of
the board snapshot and live channel. The adapter uses the existing
`orchestration:read` bearer for `server.getSettings` and the first
`environmentThemesUpdated` event from `subscribeServerConfig` with
`environmentThemes: true`. The event provides published theme definitions.
The settings read provides the environment's `defaultTheme` and
`defaultAppearance`.

The spike against nightly `0.1.12-nightly.20261122.5098` found that definitions
may supply colours and light/dark variants, canvas/accent seeds, or both. The
renderer resolves the seeds itself. Nucleus maps supplied roles to the board,
uses its own surface steps for seeds, and fills missing roles from the board
palette. A fixed environment appearance takes precedence over the browser's
preference. A theme with one usable appearance uses that palette. An unavailable
read or missing definition leaves a usable board palette.

The planner ruled on 2026-11-23 that the board follows the environment defaults.
T3 stores per-renderer choices and built-in palettes in its renderer. The board
can use a built-in's colours only if the server supplies its definition. Exact
parity with local T3 choices needs a supported T3 API.

### Native question answers

A native answer reads the bounded window, the same read that lists the pending
question. The retained `user_input_request` item supplies the question ids on a
paged thread, so a long child history never needs the complete transcript. A
request whose item the window does not carry is refused before any write, and the
refusal says so: `T3Code pending question item is outside the bounded timeline
window; no answer was sent`. Every other pre-send refusal names its own step
rather than a generic fence.

A proven pre-send refusal is not an unknown delivery. Nucleus records it as a
refused answer (`native_question_refused`) that names the agent and permission,
and the next maintenance pass delivers the same recorded answer again without
asking a planner. A recovered answer is delivered only while its permission is
still pending on the thread; a permission answered elsewhere settles as stale and
receives no answer. An unknown outcome is never resent. Its intent stays, and
only the thread's own answered read reconciles it.

An answer the planner ladder escalates to the operator is held, not sent. The
escalated question raises one Nucleus decision on the task, shown as the ACP
parent's card. The operator's answer applies to that same permission once, and the
card is withdrawn when the permission leaves the thread without an answer. The
task row names the host its question waits on.

## Native parenting

A task's row is a thread on the Nucleus ACP provider (Spec 065), and every role is
that thread's native subagent child (Tom, 2026-11-16: "role threads become native
subagent children of the worker on the T3 host"; nucleus#1305). The earlier ruling
that every role is a separate top-level thread (2026-11-11) and the worker-as-parent
design that stopped on question routing (nucleus#1290) are both replaced.

**Why the parent has no model.** T3 routes a pending child `user_input` to the
parent's agent (`DelegatedTaskQuestionReactor`), whatever the child's completion
delivery state, and the parent's Stop would end its children. A parent that is a
working agent would therefore be consulted about a reviewer's questions, which is
exactly what exact-head independent review forbids. The parent is instead the
Nucleus ACP agent: it holds its turn, shows the task's lifecycle text and authors
nothing. Nucleus answers each child's runtime requests itself
(`runtime-request.respond` naming the child), so the parent is never asked.

**What makes a child creatable.** `delegated_task.request` refuses a parent run
that is not active (`Parent run … is not active.`) and a parent node that is not
part of that run. The adapter therefore reads the parent's latest live run
immediately before the send and anchors the child on it and its root node. A child
takes no `workspaceStrategy`: with one, T3 dispatches its first message
`defer_start` and only its own MCP `delegate_task` handler prepares the run, so an
outside client's child would never start. A role whose run needs a different
checkout is refused with a visible reason, never silently re-homed.

**The turn is held, released and re-entered.** The ACP agent holds the parent's
turn while the service says to. The adapter releases it when no role child of the
task is live and no decision needs a person, so it no longer reads as busy forever. Before
the next child, the parent is re-entered with a message whose text carries the
adapter's plain sentence, `Nucleus keeps this task thread open for its next role.`,
which T3 shows as the user bubble. The binding's `holdPattern` matches that sentence
exactly, so the agent holds the turn and shows or forwards nothing. A legacy parent uses the same sentence: the agent recognizes it for the old binding
rule as well. A manually settled parent is woken first: the re-entry message goes through the
delivery gate, which unsettles it and reads it back before sending. A parent T3 will
not run leaves the task waiting with a reason.

**A callback-socket gap never ends the parent's turn (nucleus#1400).** A temporary
gap or replacement of the callback socket (a Nucleus roll or restart) leaves the
held parent's turn, binding, ACP session and native children as they are. The
agent keeps polling the same session on a bounded, doubling wait and resumes once
the socket answers, with no re-minting and no manual restart. A sustained outage
shows one fault line, not a line per failed call. The row's state never comes from
the transport: the parent row reads Nucleus role activity (running, needs a person,
or truly waiting), so a gap changes neither the row nor a live child's hold. An
authenticated answer or report whose delivery is unknown is still reconciled, never
resent. Only a refused credential (401) ends the turn, because no retry can succeed.
On the installed nightly `0.1.11-nightly.20261119.4941`, `effigy proof:t3code:reoffer -- --expect=held`
proves the Inbox's open decision through a roll and a 40-second sustained outage: the
same live card, a live run, the same binding, session and pin, and one fault line for
the outage. `effigy proof:t3code:parent-gap` proves the task parent: a reviewer child
running under a held parent through a 4-second roll, a 40-second sustained outage (one
fault line), and a second child created under the same held parent after the first is
interrupted, with the same binding and session. One run of that proof failed the
sustained step on the fault count (no new line), and two earlier runs did the same.
Those runs predate the proof's agent-stderr capture and its bounded fault-count window,
so their cause is not confirmed. The window now lets a late-landing line count, and a
failure prints the parent's runs, messages and the agent's stderr. Three consecutive runs
at `8afefd567` passed, and the agent log of a passing run shows one fault line per outage
with the turn held. The same proof also covers a decision linked to the task: the held
parent posts no card for it (the Inbox owns it, Spec 032), the parent's run stays live and
the decision stays open through a roll, and the binding is unchanged. The proof marks the
parent's scope observed and confirms no card is posted, since the service's adapter runs
in another process.

**Completion wakes never reach the parent.** Every child is created with
`completionWake: "settled_only"` and its delivery is disposed
(`delegated_task.completion-delivery.dispose`) right after the create. A follow-up
`message.dispatch` to a child starts a new delegated task under the dispatch's own
command id (`node:delegated-task:<commandId>`), and T3 does not dispose that one,
so the adapter disposes it too. The sweep reads the parent's `subagents` and
disposes any `pending` or `claimed` delivery it finds, which settles a wake whose
fast-path dispose was lost. The binding also ignores the nightly's wake and restart
wordings, so even a wake that arrives is never forwarded to the task as a person's
message.

**There is no top-level fallback (Tom, 2026-11-19).** A role that cannot be
created as a child refuses before the send, and the task waits visibly with the
reason and the fix: the provider instance is missing or not ready ("T3 provider not
ready: … run `nucleus t3 install`"), the parent is archived or deleted, the role's
run needs another checkout than the parent's, or a re-entry T3 will not run. The
refusal text is the task's reason, so the board and the operator see it, and the
operator can move the task to another host. Nothing is launched that the task's one
row would then have to settle, and there is no ten-minute native-path parking.

**A finished parent is never relaunched.** Launching a second parent would orphan
the task's existing children and re-mint a binding under a thread nothing runs.
Deletion is read two ways from the same inventory, because the nightly omits a
removed thread from the shell lists and also serves it as a `deletedAt` tombstone:
absent or tombstoned are the same fact. Before a role create, the adapter re-reads
this exact parent and checks its project and worktree against the retained binding.
An incomplete inventory or changed binding refuses the create. An exact live read
clears an older finished marker after a manual unarchive; old markers alone cannot
distinguish an archive from deletion. A live task keeps the binding even if a
sweep observes deletion, so a later role cannot launch a replacement parent. A
finished task's held turn is released at once — the create grace window is for live
work — and its parent is archived by the terminal step ([A finished parent is
archived by its own step](#a-finished-parent-is-archived-by-its-own-step)).

An explicit owner restart can restore the same archived parent after its existing
creation, workspace and custody admission proves settled. The parent must still
match the task's recorded workspace, project and Nucleus ACP provider. The T3
`thread.unarchive` effect has the restart operation's durable identity; the
narrow parent observation must prove the same parent live before normal admission
proceeds. A narrow read that cannot answer (`ThreadNotFoundError`, an
`OrchestrationV2GetThreadProjectionError` proving
`ProjectionStoreThreadNotFoundError` for the requested thread, or the generic
incomplete projection error the nightly gives without that proof,
nucleus#1460) falls back to the paired inventory, and an unreadable inventory keeps
the authorized restart pending without losing it. A prepared binding (below) is
not a restore: the restart precheck sends nothing and the worker's create launches
the same parent, so no live projection is needed first. After a lost reply, the operation observes only that occurrence.
An archived or unobservable result waits without another send or child; a deleted
or mismatched parent remains fenced with its cause. A routine sweep never
restores a manually archived parent, and terminal archival is unchanged.

**A deleted child does not hold the turn.** The release decision reads one complete
inventory: a child absent from it, or listed there as a `deletedAt` tombstone, is
deleted (a positive fact, never a read that failed), and a live child counts only
while its shell reports a live run or an `activeRunId`. An inventory the host cannot
read keeps the turn rather than guessing.

**Identity and durability.** The parent thread id, its command id and the ACP
session are deterministic for a task
(`identity('thread', …)` and `identity('parent-launch', …)`), recorded in the
adapter's state before the send, and a lost reply is settled by finding the thread
before anything is launched again. The binding is stored before the parent's
launch read, so a read failure in between leaves a **prepared** binding
(nucleus#1458). An older or generic `OrchestrationV2GetThreadProjectionError` without `ProjectionStoreThreadNotFoundError` grants no absence on its own, so the
parent observation and the launch's own existence check fall back to the live
shell for a prepared binding only (nucleus#1460; Spec 069 batch 5). A sent parent's generic
read keeps its transient wait, so churn never turns it into archive scans or a finished
marker (nucleus#1451); only `ThreadNotFoundError` or `OrchestrationV2GetThreadProjectionError:thread_not_found` checks the paired inventory. An unreadable inventory keeps the wait.
Prepared is one decision, shared by first dispatch, the retained launch and owner
restart: the complete inventory shows no row for the parent, and the `parent-launch`
command has no ledger intent, which proves nothing was reserved for a send. Only that
pair resumes the launch: the
same binding (session and binding path, never a second `acp.bind`), the same thread
and command id, and the normal launch intent. Any launch intent, a `deletedAt`
tombstone, an archived parent, or a checkout or project that no longer matches the
binding is not resumed: a launch that may have been sent and is not shown is never
resent, and nothing is replaced. A child's id is derived from its command id, so
a lost reply cannot produce an unowned thread; a failed child command is read back
first and adopted when the child exists, and a proven absence refuses with the
reason rather than launching anything else. The parent is kept out of
the recorded agent labels, because it is nobody's run: `findAgents` must not mistake
it for the worker the task created.

**Presentation follows the parent row.** Every role title (including the step
suffix) and the shown/snoozed state address the parent row the children are drawn
inside; no presentation write addresses a child. When the task ends, the terminal
step releases the held turn and archives the parent; the shared project
registration is untouched.

**The provider is checked, never assumed.** The nested path needs an enabled,
ready provider instance named `nucleus` whose driver is `acpRegistry`, advertising
the `nucleus` model (the agent's two display models, Spec 065). The operator
registers it once with `nucleus t3 install` ([operator install
route](#operator-install-route)); the adapter reads `server.getConfig` at connect
and at each create, records what it found in its own state, and reports it as
`service.health`'s `t3code.nativeParenting` line. A missing, disabled or
wrong-driver instance refuses each role with that reason instead of falling back. The status distinguishes
an absent instance from a registered instance that is not ready, including T3's
status message when present. The adapter and the service never write T3 settings; only
the operator's `nucleus t3 install` and `nucleus t3 uninstall` do, through T3's own
`server.updateSettings`, and only the `nucleus` provider instance (Tom,
2026-11-18; nucleus#1330).

**The task parent is the participant's runtime, not its tool.** T3 starts the
`nucleus` provider as `nucleus-acp.mjs` with the task worktree as cwd and keeps
it for the task's whole life, and it starts every role session as a native child
of that parent thread. A cwd-rooted process proof would read both as a live tool
and block review or closeout, so one host-qualified recognition owns them
(nucleus#1377; [orchestration
contract](../contracts/orchestration.md), the owned-tool process proof): the
connected T3 server is the pid its own runtime descriptor records under the
stored connection's base directory, the ACP parent is its direct child running
`nucleus-acp.mjs` whose binding names this task, and its role sessions are its
children — or the server's children whose readable `T3CODE_THREAD_ID` names a
recorded participant thread. A command a session's tools start stays a tool. The
same recognition protects these processes from run cleanup and lets the
owned-tool, review and closeout workspace proofs pass while the task is idle. The
private proof is `effigy proof:t3:runtime`.

**A shared provider app-server's helpers are runtime too.** T3 starts each
thread's provider as `<provider> app-server …` directly under the connected
server, and one app-server can serve several threads (nucleus#1397). That
app-server starts the session's own standing helpers — `cua-driver mcp`, the
provider's code-mode runtime host such as `node_repl` — as its direct children,
with the thread's workspace as their cwd, so a cwd-rooted proof read them as work
in whichever worktree they were started for and refused review. One recognition
owns them with the ACP parent set ([orchestration
contract](../contracts/orchestration.md), the owned-tool process proof): a live
`app-server`-mode child of the connected server is runtime, and so is each of its
live, non-shell, `mcp`-mode or runtime-host direct children. A basename alone,
anything below those direct children and a same-shaped app-server whose parent is
a shell or another daemon all stay tools, and a terminal host-process sweep
leaves the helpers alone in a worktree they only inherited. The private proof
covers both shapes.

## One row per task

One task reads as one row (Tom, 2026-11-15; nucleus#1366): the task's parent thread
on the Nucleus ACP provider. T3 draws every role child inside that row itself, so the
adapter tags, links and settles nothing, and a child has no row of its own. Two
things follow.

**The row carries the step.** The row's title is the task's own state title
(`taskWorkspaceTitle`, the shared helper Paseo uses) plus ` · ` and the step its role
children report: `reviewing`, `recovery`, `verifying`, `closing`, `executing`,
`<role> needs input` for a pending question or permission, or `blocked: <role>` for a
child whose latest run ended with a fault. A step the state title already opens with
is not repeated. The step is read from the role threads' own projections on the host
sweep, so it follows a role that starts, needs input or stalls without a task title
change. Only the thread each role currently uses counts: a role that gets a
replacement child displaces the old one, so a superseded thread's last failed run is
history rather than the task's attention.

**The row is snoozed, never settled.** The row's shown/snoozed state is the one
attention projection's answer (see [Operations and
delivery](#operations-and-delivery)): a person who must act — the task's own
attention flag, a role asking a question, a child that ended with a fault — or a live
role child gets the row shown, and a row this host snoozed is unsnoozed; a task that
waits on nothing Nucleus is running is snoozed; a finished task's row is the terminal
lane's. A row an operator settled by hand stays settled for presentation: Nucleus
writes no snooze or title to it. A message or re-entry for that row still goes
through the delivery gate, which unsettles it first. Being in T3's "Working" section is the client's own view of an
active run and cannot be set from outside.

## Board project badges

Task, lead and papercut cards on the Nucleus board that T3 opens show their project with
the same generated monogram and colour as the T3 project they belong to (nucleus#1450: a
T3 project whose title gives the fuchsia BA; nucleus#1490: lead and papercut cards share
the same badge rendering). The rules copy the installed T3 nightly's `ProjectMonogram`
(renderer `t3code-0.1.12-nightly.20261120.4994`); they live in
`shared/t3/project-badge.ts`, and the parity table in `test/t3-project-badge.test.ts`
is the evidence, produced by running that renderer's own functions on the same titles.

- **Identity, not names.** Task cards match only by their own T3 host and canonical
  repository path (`projectBadges`). Lead and papercut cards have repository references
  without a dispatched task host, so they match across live T3 observations by canonical
  `workspaceRoot` (`repositoryBadges`), including repositories with no displayed task
  card. A title lookup, a task on another host or the dispatch default never counts as
  identity evidence. Archived and deleted projects do not count. A repository matched by
  no active T3 project, or by more than one (including across live T3 hosts), keeps its
  folder icon. On a card spanning different projects, each project keeps its own name
  and shows a badge only where its own project association is unambiguous, never choosing
  a badge by repository order.
- **The text comes from the T3 title.** The monogram and colour derive from the exact
  T3 project title, not the Nucleus display name. An operator's own monogram icon
  (`projectIcon` of kind `monogram`, with a palette colour) is reused as stored. A
  lucide or emoji icon, or any `faviconPath`, means no generated badge; the service
  never fetches an image path, so those projects keep the normal label.
- **The observation is the last read.** The T3 host keeps the projects its last
  synchronized shell read saw, and the board reads that observation. A badge never
  costs a host call. The observation counts only while the connection is live, and a
  change in it advances the board revision, so a renamed or re-rooted project shows on
  the next publication.
- **Only the T3 surface.** The board link the T3 host asks for (`service.ui-link` with
  `surface: "t3code"`, issued when the inbox's `ui` opens the board) pairs a session that
  receives `projectBadges` and `repositoryBadges`. The token and session record the
  surface, persisted beside the session digest; a session without one, `nucleus ui`, any
  browser, and the Paseo and BB plugin boards never receive either field. `projectBadges`
  is keyed by host and then by repository path (a task card looks up only its own host);
  `repositoryBadges` is keyed by repository path for hostless lead and papercut records.
- **Rendering.** The card draws the badge in place of the folder icon, in the renderer's
  text colour for the surface's mode (600 on light, 400 on dark, judged from the
  surface colour) over the 14% tint. It is decorative: the project name is the label, and
  the accessible label is unchanged. The browser board (react-native-web, which drops
  the pinned `oklch()` text and the `color-mix()` tint in its `normalizeColor`)
  converts the assigned palette entry at the presentation boundary to sRGB (`rgb()`)
  and the same entry at 14% alpha (`rgba()`, nucleus#1487); the pinned OKLCH palette
  stays the single owner, never duplicated.

## Thread lifecycle

While a T3 task is open, its worker, reviewer, recovery, coordinator and executor
threads are never archived or deleted, with one exception: a superseded worker
is archived at once (Tom, 2026-11-13; nucleus#1181). A nested task's parent thread
is archived by the host pass's terminal step once the task reaches a terminal phase
or is removed (`thread.archive`, deterministic command id, one archive per thread);
its children keep their own run lifecycle. Releasing the parent's held turn is not
an archive and changes no thread fact; a finished task's held turn is released at
once and its parent archived (see [A finished parent is archived by its own
step](#a-finished-parent-is-archived-by-its-own-step)). Nucleus never settles a
task thread (see [one row per
task](#one-row-per-task)): a waiting row is snoozed and a row that needs a person is
shown again, while the task keeps its retained reviewer and recovery bindings so the
next round or fault continues the same child thread. A manually settled thread is unsettled by the delivery gate before a follow-up is sent. A new
thread is needed only when the old one is gone or deleted, or the role's selected
profile changes; other displaced threads stay as the terminal lane leaves them
(Tom, 2026-11-12).

Role detection reads the shared `WIRE_LABEL_KEYS` through the label helpers:
`nucleus.role` identifies support threads, while the task's worker identity or a
revision run identifies a worker without a role label. Tests copy the stored T3
worker and recovery label shapes with synthetic IDs, including catch-up cleanup.

A deliberate reviewer replacement stops the turn and observes it idle, then
releases the displaced run. The existing released-run callback fence refuses a
late report; it needs no in-flight deletion, archive or separate removal fence.
The displaced thread stays as the terminal lane leaves it. Decider threads keep
their existing lifecycle and are outside this cleanup rule.

A person who must act shows the task's row (Tom, 2026-11-13; nucleus#1181, as
replaced by nucleus#1366): while a T3-bound task is blocked, errored, needs
attention, carries an attention flag or has a role child asking a question or
faulted, the sweep shows the parent row again (`thread.unsnooze`, only when this
host snoozed it) so it leaves T3's snoozed state. When the task returns to
waiting the row is snoozed again under a fresh wait episode. A superseded worker is archived at
once: when a worker run is replaced on a different profile — an owner
`route now`, an approval reroute or failover to another profile — the old worker
thread is archived as soon as its run is released and no live T3 run remains on
it, through the same durable, idempotent observation-first archive effect the
terminal lane uses, with the lost-reply check. That archive is the one
mid-task archive the open-task rule allows.

At closeout after a merge, a completed proof task or a completed cancellation,
archive the worker threads (`thread.archive`) and delete the task's reviewer,
recovery, coordinator and executor threads (`thread.delete`). Use the existing
terminal thread archive lane, with its ownership checks, released-run fence,
observation-first handling and durable effects. Nothing durable lives only in a
deleted thread: review text, verdicts, recovery reports and decisions are already
in Nucleus's records and on the pull request before deletion.

Deletion is the installed nightly's command `{type: "thread.delete", commandId,
threadId}`. Never send `onlyIfUnused`: that option can return success while
leaving a thread with runs or messages intact. Record intent before delivery and
confirm deletion by `deletedAt` or absence from a complete inventory; an archived
thread still owes deletion. A lost reply remains observation-only, including on
the final attempt, and never authorizes resending an unknown effect. A failure
proven to precede delivery stays retryable through the same terminal lane;
cleanup failure never blocks task closeout. Connection preflight reads the
existing deletion ledger first: absent or refused intents prove an unsent attempt,
while an earlier unknown intent stays unknown even when disconnected. Receipt
replay still requires the same authenticated host identity.

The sweep directly selects already-finished T3 tasks that still owe a thread
archive or deletion, including tasks closed before this rule existed. The query
does not use the active-capacity index. A bounded rotating window schedules each
selected task on its existing task lane; the host sweep never awaits its remote
cleanup, and permanently pending candidates cannot hide later finished tasks.

Ordinary closeout and catch-up use the same terminal effects and record completion
per task in the common terminal lane after every thread effect is confirmed. A
task cleaned before the catch-up query still has its completion record, so later
sweeps do nothing; incomplete effects remain selectable.

Paseo keeps its existing archive behaviour, including its reviewer-replacement
fence and support-thread retirement after an episode. This T3 rule changes no
Paseo lifecycle.

### A finished parent is archived by its own step

A finished task's parent leaves the operator's T3 snoozed list through one
obligation, and that obligation is the host pass's own terminal step before any
presentation read (nucleus#1459). It used to run after the Inbox and decision-card
reads inside the title pass, which returned early on a fault and was skipped
entirely when an earlier step timed out the pass; eleven Done Nucleus parents sat
in T3's Snoozed list with no `archivedAt` and no recorded archive command because
of it. The step is now independent:

- **Discovered from the durable binding.** One eligible entry is an unarchived
  `parents` record whose task the same pass reports as this host's and terminal
  (removed, done, or cancelled with no active disposition). The record is on disk,
  so the obligation survives a task workspace archive and a service roll, and
  Inbox, decision-card, row and title faults cannot hide it. The step walks the
  host's own open bindings and resolves each task through the store's single-task
  read (Spec 069 §4), so it costs one read per open binding, never one per finished
  task, and a finish the batch did not reach, or one from before a service roll, is
  still owed on the next pass.
- **Bounded and rotating.** One pass visits at most `PARENT_ARCHIVE_BATCH` (four)
  entries, the one whose last attempt is oldest first, and records the attempt's
  timestamp on the binding, so a backlog drains over sweeps and no parent waits
  behind a steady stream of newer ones. One entry's fault never stops another's:
  only a host timeout ends the step, and the step records itself the way every
  other pass step does.
- **An exact identity.** Only the record's own task and thread are touched: the
  record must name the task, the thread must not be claimed by a second task
  record, and it must not be the pinned Inbox thread or any recorded role, follow-up
  or retired-agent thread. Nothing here sweeps planners, project agents or a
  person's own threads, and an operator snooze on another thread is untouched.
- **Release, then archive.** The finished parent's held turn is released first (a
  local ACP call, so a thread that left observation is still released), then
  `thread.archive` goes through the durable intent with the deterministic
  parent-archive command id. T3's settled receipt for that exact thread marks the
  binding `archivedAt`; no inventory is read to confirm it (the planner's Spec 069
  batch 5 design, following Tom's 2026-11-22 ruling "We shouldn't need to be
  reading archived threads at all"). A thread T3 later shows live is a person's own
  unarchive and is never undone.
- **Unknown delivery is read, never resent blind.** A recorded intent whose
  delivery is unknown is settled by a fresh positive read of that parent: archived
  settles it, and a live thread is the read that lets the same command replay under
  its own identity. A proven pre-send refusal may be re-sent the same way.
- **A typed, visible wait.** Every entry the step cannot settle is returned as a
  typed wait (`unknown`, `refused`, `mismatched`, `shared`,
  `read_failed`) with the host's own reason. The pass writes it on the task
  (`parent_archive_uncertain` for unknown delivery, `parent_archive_wait`
  otherwise, one event per distinct reason) and the binding keeps the same state,
  so the record survives a roll. Reading the same wait again says nothing new.

The three-day archived-thread retention pass and the workspace delete/archive
rules are unchanged: this step archives a parent thread and nothing else.

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
prompt unchanged) and `findRunAgents` ([run creation lookup](#run-creation-lookup)).
Core names `question.answer` with the reissued recipient run
ticket for any host that has a recipient run on that proven host; MCP hosts
without a matching run clear an inherited `NUCLEUS_TICKET` so the host's identity
answers. Equal native IDs on different hosts do not share a consult ticket. A
shared ticket-first caller resolver fills identity for any host and skips a
ticket path that is gone, so T3 does not rewrite the command to a separate
endpoint. A proven caller that already holds its participant ticket (project
planner, named agent, task planner) receives that same ticket's path on every
`caller.resolve`; a second ticket is never minted, and a credential file that
is gone is revoked and reissued on that caller's own next call (nucleus#1128).
A T3-hosted planner can answer from its participant ticket or its exact,
host-verified caller identity. Nucleus queues both planner questions and reviewer
consults after any active T3 turn. If a recorded planner ID has no matching thread
and the host has supplied no deletion or archive evidence, the ladder shows it as
unroutable. Uncertain reviewer or coordinator creation can bind.
`host.permission-answer` still grants no
task lifecycle dispatch. An unconfigured T3 adapter changes no default route. A
configured second host never causes implicit rerouting of a live task, origin
notice or pending question.

### Run creation lookup

`findRunAgents` uses exact `nucleus.run` and `nucleus.task` labels to select
local launch records, then reads each native thread by ID. A fresh thread
snapshot supplies placement. On `ThreadNotFoundError`, or on an
`OrchestrationV2GetThreadProjectionError` whose `cause` proves
`ProjectionStoreThreadNotFoundError` for the requested thread (the installed
nightly's `subscribeThread` wire shape for a missing thread, classified as
`OrchestrationV2GetThreadProjectionError:thread_not_found`), the candidate
contributes no match: T3 has no such thread (Spec 069 batch 5). Any other `OrchestrationV2GetThreadProjectionError` (a read failure
such as `ProjectionStoreReadError`, missing/unrecognized `cause`, or a missing
fork ancestor) and any transport or timeout error stays transient and leaves
the lookup unanswered.

The
[uncertain-creation contract](../contracts/orchestration.md#uncertain-creation-and-explicit-exits)
owns the grace and producer checks that allow a replacement.

## Operator install route

One command connects an environment, and the same route reports and removes it
(Tom, 2026-11-18: "We'd need a way to automate installation - I don't want to
require people using this to set up the nucleus acp directly.. can we build a
`nucleus t3 install` / `status` / `uninstall` suite like for bb?"). The three
commands are `nucleus t3 install`, `nucleus t3 status` and `nucleus t3 uninstall`
(`bin/t3-install.ts`, beside the BB route this one mirrors). They are the only
writers of T3 settings anywhere in Nucleus: the adapter and the service still
never write one.

**Finding the server.** The running server's own descriptor,
`<base>/userdata/server-runtime.json`, names its `origin`; `--base-dir` selects
another T3 home and `--endpoint` names a server directly. The route proves the
origin by reading T3's public `/.well-known/t3/environment` descriptor, and
refuses clearly when nothing answers. The environment id in that descriptor is
the host id the service must come online as, `t3code:<environmentId>`.

**Bearers.** Two sessions, split by scope. The service's **runtime** bearer has
`orchestration:read`, `orchestration:operate` and `preview:operate`, with a long TTL
(`--ttl`, default 365 days), label and subject `nucleus`; it is stored owner-only
in `<data home>/settings.json` as `t3code: { endpoint, bearer, sessionId, environmentId, baseDir,
expiresAt, probeThreadId? }`, and is never printed, reported or logged. The
**install** bearer is minted for one registration with `providers:manage` and
`orchestration:read`, used for the read and the single mutation, and revoked
immediately; it is never stored. The nightly derives the scope from the payload,
and a provider mutation with an empty patch requires `providers:manage`
(`requiredScopesForSettingsUpdate`), so `settings:write` alone would be refused.
A re-run rotates the runtime bearer: the new session is minted and stored first,
then every other active session with subject `nucleus` is revoked.

**Registering the provider.** One mutation through T3's own route:
`server.updateSettings { patch: {}, providerInstanceMutation: { operation:
"upsert", instanceId: "nucleus", instance: { driver: "acpRegistry",
displayName: "Nucleus", enabled: true, config: { source: "local", commandPath } }
} }`, where `commandPath` is the resolved absolute path of this install's
`nucleus-acp` launcher (`~/.local/bin/nucleus-acp`, or `--acp-command`). The
nightly's operations are `create`, `upsert` and `remove`. Ownership is the rule
BB's route uses: an existing `nucleus` instance is ours only when its driver is
`acpRegistry`, its `source` is `local`, and its `commandPath` is that launcher; a
namesake — another driver, or another command path — is refused by name for
install *and* uninstall and never overwritten or removed. A launcher must carry the ownership marker and invoke the ACP entry point; the ordinary CLI launcher is not an ACP launcher.

**Proving it.** After the mutation, install re-reads `server.getConfig` until the
instance is ours, enabled, advertising at least one model and its probe has settled (or the wait expires), and then has the
running service adopt the stored connection without a restart: the service
watches its settings file's stamp on its bootstrap tick
(`RuntimeOwner.refreshT3Settings`) and replaces the T3 connection, so
the host registers as `t3code:<environmentId>`. Install waits, bounded, for
`service.health`'s `t3code` line to report exactly that host online and prints
every step's result. A service that is not running is reported, not failed: the
connection is recorded and adopted at its next start. `service.health` and the
host list are read over the local service socket; the route never starts a
service.

**Cold start (nucleus#1394).** T3 probes the registered launcher on its own
server start, with no thread, workspace or model picker, so a cold T3 start runs
`nucleus-acp` in an unbound directory. That launcher starts the Nucleus daemon for a
stored loopback T3 connection when none is running, through a claim that makes repeated
and concurrent probes converge, and it never waits for the daemon. The gates and the
ownership rules are in the service boundary contract's idle shutdown section.
The private proof is `effigy proof:t3code:daemon -- --asar <nightly app archive>`.

Readiness is T3's own verdict. The nightly probes an unbound directory; the
agent opens an inert session advertising `nucleus` and `nucleus-quiet` without
attaching to a task (Spec 065). A genuine probe warning remains installed but
unready: install prints T3's note and says role creation waits until the probe
succeeds. Status reports readiness,
usability and the probe note separately. Install waits for the service to adopt
the newly issued session, not just an earlier connection to the same environment.

**Status** (`nucleus t3 status`, `--json`) reports, with no secret:

- the server: its endpoint, version and environment id, and the host id;
- the runtime bearer: present, whether T3 accepted it for this run's read, its
  scopes and expiry from `t3 auth session list`, and a warning while it is within
  seven days of expiry (or when it carries a settings scope the service does not
  need);
- the provider: registered, ours, enabled, ready, its `commandPath` against this
  install's `nucleus-acp`, and its models;
- the adapter's own `t3code.nativeParenting` line and the support-thread line, as
  the service reports them;
- the repositories whose stored `hostKind` is `t3code`, i.e. the projects opted
  into this host.

`ok` is true only when the server answers, the bearer is present and not refused,
and the provider is registered, ours, enabled not `error` and pointed at this
install; `ready` and the probe note say whether T3's own ACP probe passed.

**Uninstall** removes the `nucleus` provider instance with `operation: "remove"`,
only when it is ours (a namesake is refused by name), revokes every active session
with subject `nucleus`, and clears `t3code` from the settings file. While tasks
are live on `t3code:<environmentId>` it names them from `host.list`'s dependents
and refuses unless `--live-tasks` is passed; a service that cannot report its
hosts is a refusal too, unless `--live-tasks` explicitly overrides the unknown state. The selected endpoint and any recorded environment and base directory must match the stored connection; a mismatch refuses without changes. Legacy endpoint-and-bearer settings can be checked at that same endpoint and migrated. WebSocket endpoints compare using their corresponding HTTP or HTTPS origin, preserving host, port and transport security. A missing or revoked runtime session does not prevent install from rotating it or uninstall from removing the connection: the short-lived session must authenticate to the selected server before its provider can be changed. Status attributes session scopes and expiry only to the saved session in a verified matching store. Status reports provider registration as unknown when authenticated configuration cannot be read. It never
archives, deletes or edits a thread, and never touches a project registration.
The service drops the connection on its next bootstrap tick.

## Trial

Paseo stays the primary host. Opt a repository into T3Code for new tasks:

1. Start T3Code.
2. Run `nucleus t3 install`. It mints the scoped bearer, registers the `nucleus`
   ACP provider and waits for the host to come online; `nucleus t3 status` shows
   each fact and `nucleus t3 uninstall` removes them again.
3. In Settings, set the repository Host to T3Code, or `repository.set` with `hostKind: "t3code"`.
4. Switch back to Paseo the same way. Live tasks keep the host they started on.

After install, each T3Code start starts the Nucleus daemon when none is running (nucleus#1394). The daemon's own ten-minute grace after the last host closes decides when it exits.

## Verification

`test/t3-install.test.ts` drives the operator install route's three commands as a
child process against the fake Nightly transport and a fake installed `t3`
command: install mints the two split-scope sessions, sends the one provider
mutation and stores the runtime connection owner-only; a re-run rotates the
bearer; a namesake instance (another driver, or another `commandPath`) is refused
for install and for uninstall with nothing written; status reports a missing,
disabled and foreign provider and a near-expiry bearer; uninstall removes only
our instance and our sessions, clears the connection, touches no project or
thread, and refuses a namesake. `test/t3-settings.test.ts` covers the stored
connection's shape, owner-only write, key preservation and change token;
`test/t3code-composition.test.ts` proves the live reconfigure adopts a new
connection, releases the previous claim and ignores an unchanged file.

Fake-server tests cover each operation, the exact wire envelopes and scopes,
authorization refusal, missing/incompatible protocol, a previously untested
nightly passing structural probes, identity conflicts, malformed
and incomplete snapshots, lost replies, immutable intent replay, subscription
cleanup and restart during both kinds of request. Identical decoder-formatted
and post-effect handler defects must both retain unknown delivery. Contract
fixtures pin the nightly command shapes rather than a server-version allowlist.
Cross-host cases deliberately reuse native IDs and keep task, run, message and
question ownership separate. `test/t3code-observation.test.ts` counts thread
snapshots on the serving side: a pass over stored terminal-task threads serves
none, an unchanged live thread is not snapshotted again, a changed live thread is
snapshotted once for every consumer, a thread T3 reports archived leaves
observation, and a terminal task keeps its exact lookup after its agent records
leave the stored `agents` map. Its state fixture carries the stored file's own
top-level and record key sets.

`test/t3code-one-row.test.ts` is the row's own suite: the parent row naming the step
its role children report, a later round writing the same step under a fresh command
identity, a superseded child's fault dropping off the row, a waiting task's row
snoozed once with `snoozedUntil` read back and renewed before the horizon with no
write on a repeated pass, a person who must act unsnoozing a row this host snoozed,
an operator's settled row left alone, an operator horizon replacing this host's
left alone, a read-back that is not the requested horizon never adopted, a stale
legacy record and an ambiguous or foreign parent binding addressed by nothing, a
snooze refused for a pending approval staying active with no retry loop, no
`thread.settle` on any decision, and a role whose create refuses launching no
thread and naming the fix. `test/notice-refused-delivery.test.ts` proves a refusal
the host named before the send keeps a durable notice pending instead of reporting
unknown delivery, while a genuinely uncertain send is still recorded as unknown.

`test/t3code-row-hidden.test.ts` is the hidden row's own evidence on the fake
nightly: one recorded episode start that a horizon renewal keeps, a legacy record's
start proved from its own horizon, an operator snooze, manual settle and lapsed
horizon all clear, a refused snooze clear, and an unreadable row reported as
unknown with its record untouched. `test/row-hidden-notice.test.ts` is the notice's
own suite: the 30-minute bound with an injected clock, the age, wait reason,
transition and action in the text, no second notice across passes, renewals and
rolls, the confirmed wake, terminal closeout and new episode each clearing the
timer, an owner change re-pointing a pending notice, an undelivered notice waiting
for a busy planner and a refused send staying unknown, the attention-delivery
coalescing, the hold's 3-hour nudge with the existing reminder reused, and hold
time never accruing toward the wait bound after release.

One end-to-end test drives an ordinary task's whole lifecycle on the fake
Nightly transport (nucleus#1139): promotion onto the T3 host, workspace
registration, a worker launch whose profile carries a thinking level (the
launch carries `modelSelection.options`), a planner `tell` delivered mid-run,
the worker's report through the packaged helper, an independent reviewer's
launch and verdict, a revision round addressed on the retained worker, the
accepted round-two verdict, the merge, closeout, the worker thread's archive, the
removal of every support thread and the archive of only that task's T3 worktree
handle while its shared project registration remains registered (nucleus#1155).
A second lifecycle test continues the released recovery child for the next
fault instead of opening another. The test fails on a tree
without the model-option, archive and steering work.

`test/t3code-nesting.test.ts` covers native parenting on the same fake transport,
with the Nucleus ACP provider registered in its `server.getConfig`: the parent
launch on that provider and the task checkout with the binding's ignore and hold
rules minted first; the role as a child of the held run with the profile's own
provider, model and runtime mode and no workspace strategy; the dispose under the
derived node id; a released parent re-entered by a marked message and the next
child anchored on the re-entered run; a follow-up's own dispose; one release per
held turn and the parent's archive at a terminal phase; child questions and
permissions answered on the child with the parent never addressed; a reconnect
that re-enters the same parent rather than launching another; the refusals (no
provider, a non-ACP driver, a role in another checkout, a parent T3 will not run, an
archived or deleted parent) naming the reason and the fix and launching nothing; an
unknown child command never resent under the same identity; the recorded
delegated-task wire shapes decoding into the projection; a deleted child releasing
the parent turn; and a `deletedAt` tombstone in the inventory counting as deleted for
both a child and the parent. `test/acp-agent.test.ts` adds the hold rule (nothing shown, nothing
forwarded, the turn held) and keeps it distinct from the ignore rule;
`test/acp-service.test.ts` proves a mint carries both prompt rules into the binding
and that a mint without them writes neither.

`test/t3code-one-row.test.ts` covers parent row titles, snooze and renewal, the
manual settle left alone by presentation, the re-entry wake, and the absence of
top-level role launches and settle writes. `test/t3code-settled-delivery.test.ts`
covers the delivery gate on the private server: settled and visible targets, the
archived fence, a delayed unsettle, unknown unsettles that did and did not land, a
manually snoozed non-task thread refused before send with its snooze intact and
delivered once it wakes, a foreign snooze record authorizing nothing, and the wire
order and command identities.
The sweep skips presentation work for confirmed terminal archive or deletion.
Once Nucleus's own recorded delete is confirmed by its receipt or authoritative
readback, unknown presentation intents for that thread become
`moot`, linked to that delete. Their delivery is never recorded as successful,
and they are never replayed. The adapter retires them before its presentation
reconciliation reads, including after restart. An unknown delete remains unknown
when readback proves its postcondition; external disappearance without Nucleus's
own delete does not retire presentation intents. Regression tests instrument
`readStream` and exercise repeated real sweeps alongside another task's cleanup.

nucleus#1378's held-turn proof (`effigy proof:t3code:held-turn`) runs the parent
transcript on the installed nightly: the initial launch, same-state writes, several
milestones within one held turn, the production release and re-entry, the closeout
through the ordinary host pass, and the wire's paragraph breaks. On `0.1.11-nightly.20261119.4928`, a re-entry created
with `createdBy: "system"` is accepted and holds the run, but T3 renders it as a
visible user bubble. No quiet re-entry exists on `message.dispatch`, so the visible
plain sentence is the prompt. The proof releases the held turn through a fixture-only
`acp` debug target, because the adapter in that proof does not own the service's ACP
surface.

nucleus#1459's finished-parent archive proof (`effigy
proof:t3code:parent-archive`) runs on the installed nightly through the ordinary
host maintenance owner: a real store, the real `nucleus t3 install` route and a
real `T3CodeHost`, driven by `HostPass.run` and never by a presentation, nesting or
archive method directly. It proves a stored done task with a retired workspace
handle and a snoozed parent archived in one ordinary pass with exactly one
`thread.archive` under the deterministic command id and the binding settled; one
parent's own projection read failing while its sibling archives in the same pass,
with the faulted parent keeping a `read_failed` wait the next pass settles; an
archive whose reply is lost leaving an unknown intent, and the rolled host settling
it from the thread's archived fact with no second command; and two records claiming
one parent thread never archived while a nonterminal parent keeps the operator's
snooze. `test/t3code-parent-archive.test.ts` and `test/host-pass.test.ts` cover the
same cases on the private synthetic nightly — including the failing Inbox read,
which an isolated nightly cannot create while its own ACP probe reports `warning` —
and the step order that keeps the archive ahead of every presentation read.

`test/t3code-inbox.test.ts`, `test/acp-agent.test.ts`, `test/acp-service.test.ts`
and `effigy proof:t3code:inbox` (`scripts/acceptance/t3code-inbox-private.ts`)
cover the pinned inbox lifecycle and its `ui` command (nucleus#1415): one board
tab after every `ui`, a retained healthy tab replaced by the revealed one, a new
`ui` message served once and a repeated report of it not reopened, ignoring
non-exact prompts, reopening from a closed or `LoadFailed` pane with a fresh
one-time pairing link and `reveal: true`, keeping pairing URLs out of ACP
messages, the host state and logs, being served by the pass while a decision
holds the turn (the queued message, the unchanged card, the served result
reported when the queued turn runs), Stop ending a hung open at once, and
returning to idle immediately when no decisions are offerable while staying held
when an offerable decision is open.

The existing-Inbox proof (`effigy proof:t3code:inbox -- --existing-only`)
also closes its private preview, dispatches exact `ui` on the same pinned
thread and checks both the bounded ACP reply and the newly revealed preview
tab. It checks the tab against the real private board's origin and records
the tab ID, runtime and reveal state. A rendered-pane check also observes the
board in T3's client, since server readback alone cannot show what rendered.

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

When the server cannot be reached, uninstall refuses without changes and says the stored runtime bearer remains active; start T3Code and retry.

The opt-in `NUCLEUS_T3_MODEL_CAPTURE` path writes the decoded codex, Pi and
Claude model entries from the adapter's existing config read (every codex model
since nucleus#1386, so a later capture carries `gpt-6.2-astra`). It
contains no settings or environment identity, is limited to 16 models per provider
and 256 KiB, and makes no additional T3 call. Set the path inside run scratch
when collecting a capture; the file is overwritten on each config read. The
committed codex, Pi and Claude model entries were compared with an isolated
service runtime's own live T3 read on 2026-11-19 and were identical. The ACP
parent entry came from the earlier ad hoc read-only client and decoder capture.
The bounded Pi capture prioritizes the three fixture models before other entries.
