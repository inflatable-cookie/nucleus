# BB host adapter

Status: approved. Phase 0 (the transport spike) is implemented and proved; phases 1–6 are not
implemented. This document is the design and the phased plan, and [phase 0
evidence](#phase-0-evidence-2026-11-16) answers its eight assumptions.
Owner: Nucleus runtime maintainers

BB ([getbb.app](https://getbb.app)) is a third Nucleus host beside Paseo and T3Code (Tom,
2026-11-16: "push this forward", "dispatch any work on the repo via Nucleus"). One BB workspace per
task, each task's workspace nested under its planner thread in BB's sidebar. Paseo stays the primary
host; BB is opt-in per repository, like T3Code.

## Boundary

BB supplies native thread operations: spawn, send, stop, archive, observe, interactions and
terminals. Nucleus keeps task and run identity, worktrees, durable effect intent, callback
authentication, review and merge policy, closeout custody and recovery. The service composes those
policies through `core/host`; the adapter imports no engine, store or other host.

The design adds no member to the host contract. It needs no change to Paseo's or T3Code's behaviour,
and no change to their specs. The two additive allowances it does use are the host-kind union
(`bb` beside `paseo` and `t3code`) and a connection role on the existing owner-only service socket.

There is no BB code to reuse: an earlier BB plugin for a previous Nucleus codebase has been removed,
so this design starts from the current host contract and the current BB surface.

Every Nucleus-created BB thread is parented to the task's planner thread. Nucleus never sets
`lifecycleOwnerThreadId` on any thread, never archives or deletes a thread it did not create, and
never deletes a BB project.

## Verified facts

Each fact is marked with the evidence that establishes it:

- **spike** — the BB thread's scratch-repository spike, read in BB on 2026-11-16.
- **sdk** — the typed plugin SDK BB 0.49.0 pins, `@get-bb/plugin-sdk` 0.6.132 (`@bb/domain`
  `plugin-sdk-version.ts` in the installed bundle), read from its bundled declarations.
- **guide** — `bb guide` chapters on the installed 0.49.0.
- **probe** — a read-only check made while writing this spec.

| # | Fact | Evidence |
| --- | --- | --- |
| 1 | `bb thread spawn --environment <path>` attaches a thread to an existing worktree as an unmanaged environment; a later attach by the same path or by environment ID resolves to the same environment; BB runs no setup or teardown hook for an unmanaged path and never retires it | spike |
| 2 | `--parent-thread <planner> --parent-notifications off` with role threads in one worktree draws planner → worktree group → role threads in BB's built-in thread list with no plugin code; `bb thread update --clear-parent-thread` / `--parent-thread` re-parents a live group | spike |
| 3 | The parent link is display and notification only. `lifecycleOwnerThreadId` is separate and immutable, and archiving or deleting an owner cascades to its dependents. `threads.delete` requires `childThreadsConfirmed`, and `threads.experimental_listCascade` names the threads an `archive` or `delete` would also affect | spike, sdk |
| 4 | Terminals are core, in the right panel (⌘J). A terminal created for a thread target appears only in that thread's terminal list; an environment-scoped terminal appears in neither a thread's nor a host's list; a `host_path` terminal appears only in its host's list. Archiving a thread does **not** close its terminal: the terminal stayed `running` with no close reason, and only an explicit close recorded `user` (corrected by phase 0; see [below](#corrections-to-the-verified-facts)) | spike, sdk |
| 5 | Every BB thread carries `BB_THREAD_ID`, `BB_ENVIRONMENT_ID` and `BB_PROJECT_ID`, the counterpart of `PASEO_AGENT_ID` for calling-thread identity | guide |
| 6 | `bb.sdk` is "the full BB SDK, bound to this server over loopback", typed and supported; plugins are full-trust code; `bb plugin types` re-pins a plugin's SDK surface to the running bb | guide, sdk |
| 7 | Thread operations: `spawn` (with `environment`, `parentThreadId`, `parentNotifications`, `visibility`, `pluginMetadata`, `startedOnBehalfOf`, provider/model/reasoning/session options, permission mode, title), `send` with steer/queue, `stop`, `archive`, `unarchive`, `delete`, `update` (title, parent, notifications, visibility, section, model, options), `get`, `list` (by `threadIds`, at most 200 per call), `count`, `timeline`, `context`, `interactions` (list/get/respond/resolve/cancel), `retry`, `tabs`, `queuedMessages`, `markRead`/`markUnread`, `getPluginMetadata`/`updatePluginMetadata` | sdk |
| 8 | Lifecycle events a plugin can observe: `thread.created`, `thread.active`, `thread.idle`, `thread.failed`, `thread.archived`, `thread.unarchived`, `thread.deleted`, `interaction.pending`, `turn.failed`, `message.queued`/`dispatched`/`cancelled` | sdk |
| 9 | UI contributions: `navPanel`, `settingsSection`, `pendingInteraction`, `composer.customize` (actions, banners, plus/send menus, popups), `sidebarFooter`, app commands, content scripts with `experimental_setThreadRowStatus`, `experimental_threadList`, `experimental_sidebarNavigation` | sdk |
| 10 | Agent configuration is the data-dir `AGENTS.md`, workspace `.bb/AGENTS.md`, skills (plugin, user, project), plugin tools and per-thread instructions; `bb.agents.configure` selects a plugin's tools and skills per thread and can contribute instructions, with the thread's own plugin metadata visible. There is no per-thread MCP server injection | guide, sdk |
| 11 | Usage: `threads.context` reports token usage, context window and an optional cost, estimated per provider; the timeline carries `thread/tokenUsage/updated`; `system.usageLimits` reports provider usage windows; failed turns carry provider rate-limit state | sdk, guide |
| 12 | A `threads.list` row already carries `status`, `runtime.displayStatus`, `archivedAt`, `hasPendingInteraction`, `queuedWork`, `activity`, `environmentId`, `environmentPath`, `environmentIsWorktree`, `parentThreadId`, `lifecycleOwnerThreadId`, pinned and read state | sdk, probe |
| 13 | BB's HTTP API answers on loopback without a credential from the same user (`GET /api/v1/threads` → 200 on bb 0.49.0, observed 2026-11-16), but no `bb guide` chapter documents the HTTP routes as a contract; `bb guide json` documents CLI JSON only | probe, guide |
| 14 | A BB server's data directory is the one holding `config.json`, `bb.db` and `plugins/<id>/`; a plugin reads it through `bb.server.experimental_dataDir` | sdk, probe |
| 15 | There is no standalone environment create: the environments area offers list, get, paths, commit, update, delete, archive and cleanup, and an environment comes into being when a thread attaches to a path | sdk, spike |
| 16 | A thread's origin and plugin origin are fixed at creation — `threads.update` can change only title, parent, notifications, visibility, section, model, reasoning and session options — while its parent, section and visibility can change at any time, and archived rows need their own list filter | sdk |

## Assumptions phase 0 must prove

These are the facts this design rests on that no evidence above establishes. Phase 0 is not complete,
and no later phase starts, until each is answered in writing. All eight are answered, with their
verdicts and evidence, in [phase 0 evidence](#phase-0-evidence-2026-11-16).

1. A BB plugin server entry can hold a long-lived outbound Unix-socket connection to the Nucleus
   service, and re-establish it after `bb plugin reload` and after a BB server restart. The Paseo
   plugin proves the shape on a different host; it does not prove it here.
2. The service can carry a reverse host-operation connection role on its existing owner-only socket
   without disturbing the bridge presence claim, roll recovery or the existing request path.
3. An unmanaged environment ID is stable across a BB server restart and a plugin reload, not only
   within one run.
4. A `threads.spawn` is discoverable after a lost reply: the thread's own plugin metadata names this
   exact task and run, and the search for it can be made complete across projects, hidden rows and
   archived rows, so an uncertain spawn can be adopted by observation instead of resent.
5. Archiving a role thread leaves its planner, its siblings and the worktree group untouched when
   nothing depends on it (the cascade read names only itself or rows already archived).
6. `threads.spawn` returns when the row is committed, not when the first turn starts, so "spawned"
   is never read as "running".
7. An isolated BB server (its own data directory and port) can be driven on this machine for proof,
   without touching the operator's live BB.
8. A `host_path` terminal appears where an operator would look for it, so the task-directory
   convenience is worth shipping; if it does not, phase 5 drops it and the planner tab stays native.

## Decisions

### 1. Transport: a reverse host-operation channel over the existing service socket

**Recommendation.** The BB plugin backend is the host-operation executor. It connects out to the
Nucleus service on the existing owner-only socket as the Paseo plugin does, announces itself as a
host executor for one BB server, and then answers the service's host operations from `bb.sdk`. The
service keeps the host registry, admission, breaker, durable intents and observation; it implements
`hosts/bb` as an adapter over that channel, exactly where `hosts/paseo` and `hosts/t3code` live. The
plugin holds no task, run or review state.

The channel is additive to Contract 007's framed protocol: after the credential handshake the
connection declares the role `host-executor`, and on that connection the service writes bounded
`host_op` requests and the plugin writes their results. A fault settles the one request it names and
never the connection; a dropped connection settles every in-flight operation as unknown delivery.
Nothing is resent: adoption is by observation (assumption 4 below).

**Evidence.** The SDK is BB's supported, typed extension surface (fact 6), and it is the only one:
BB's HTTP routes are undocumented as a contract (fact 13) even though they answer on loopback today.
The socket already exists, already authenticates the same user, and already carries the bridge
presence that keeps the daemon's idle clock honest. Everything the adapter needs is in the SDK —
spawn with an unmanaged environment and a parent, list by ID, interactions, archive, terminals,
usage (facts 1–12).

Plugin reload and BB restart are the two fault shapes that matter, and both are the ordinary
host-outage shape Nucleus already has: the plugin reconnects, the service re-proves the host
identity on a fresh read, and until it does the host is offline — observation defers, a task is
never read as idle, and a durable operation stays uncertain until observation settles it. T3's
lesson applies unchanged (Spec: T3Code host adapter, "Protocol and connection" and "Observation and
restart"): one request's fault never takes the connection, and an unknown write is never replayed.

**Rejected alternative: the service calls BB's local HTTP API directly.** It works today (fact 13),
and it would need no plugin for host operations. It is rejected because it would put Nucleus's
lifecycle on an interface BB does not publish as a contract: we would hand-decode every response
without the compatibility promise the typed SDK gives, we would owe the whole bounded-read,
strict-decode and fault-classification cost T3 cost us, and a BB release could change a route with
no deprecation. It also loses plugin origin attribution on created threads, and it bypasses the
presence claim that makes the service's idle shutdown correct.

**Rejected for the same decision: a plugin HTTP route plus `bb plugin token`.** A supported plugin
surface, but it would add a second transport and a second credential beside the authenticated socket
already in place, and the token would need out-of-band discovery and rotation.

### 2. Workspaces: a Nucleus-minted handle over a Nucleus-created worktree, attached as an unmanaged path

**Recommendation.** Workspace creation and run creation stay separate, in the order core already
uses: first dispatch records the workspace through `createWorkspace` and only then calls `launchAgent`,
which reaches `createRun` with the run and its ticket (`core/dispatch/first-dispatch.ts`,
`core/host/contract/run-creation.ts`). BB has no standalone environment create — an environment comes
into being when a thread attaches to a path (facts 1 and 15) — so `createWorkspace` does what T3Code's
does: it resolves the repository root, registers the BB project for it when there is none, and mints a
Nucleus-owned handle (`bb-worktree-<hash>`) bound to the canonical directory and the project ID,
persisted through the durable intent boundary. It spawns nothing, so no worker exists before its run
does and no thread is created that no run owns.

The first role run attaches the worktree. `createRun(task, run, ticket)` spawns its thread with
`environment: { type: "host", workspace: { type: "unmanaged", path } }`, the task's planner as parent,
`parentNotifications: "off"` and the run's plugin metadata, then records the returned `environmentId`
on the handle before the run counts as created. Later attaches by the same path or by the recorded
environment ID resolve to the same environment, so every role of one task shares one environment.

`workspaceAvailable` and `inspectWorkspaceCreation` read the handle and the project, never a spawn:
before the first attach the handle is available because the recorded directory and project are, and
after it the recorded environment must also be listed and not destroyed. `archiveTaskWorkspace` marks
the handle archived and `taskWorkspaceArchived` reads that marker; BB never retires an unmanaged
environment, so the handle is the only archive fact. `workspaceIdAccepted` accepts exactly the minted
`bb-worktree-<40 hex>` shape, so a handle from another host never resolves here.

**Binding sequence for one run**, each step recorded as durable intent before its write: handle
recorded → project registered → spawn with the run's exact metadata → environment ID recorded on the
handle → run creation complete. A spawn whose reply is lost is never resent on a guess: adoption needs
the exact recorded task and run identity (decision 6), and an empty search never authorizes a resend —
the run stays uncreated and unknown until an owner action takes it on.

**Evidence.** An unmanaged path is exactly the spike's verified case (fact 1): no setup or teardown
hooks run, BB never retires the folder, and re-attaching is idempotent. That leaves worktree creation,
inspection, recovery and archive custody where they already are — Nucleus — with the source-publication
proofs Spec 017 requires before a folder is removed (fact 1, `createThreadRequest.environment` in fact
7). The split matches T3Code's own: it mints `nucleus-worktree-<hash>` in `createWorkspace` without a
thread and attaches `existing_worktree` at launch.

**Rejected alternative: a Nucleus environment provider (`bb.experimental_environments.register`).**
A provider owns `create` and `remove` (SDK `PluginEnvironmentProviderDefinition`), so BB would decide
when the environment is torn down. Nucleus's closeout must prove the task's source is clean and
published before it removes a worktree, and must keep the workspace handle readable after the task
ends; handing removal to BB either blocks closeout or loses the custody rule. The provider's
`requires` facts (`projectCheckout`, `gitCheckout`, `gitRemote`) also describe a provider that owns
the checkout, which is the opposite of Nucleus owning it.

### 3. Reporting: the packaged helper with a run ticket

**Recommendation.** BB threads report exactly as T3Code threads do: the packaged Nucleus helper with
the run ticket named in the prompt, `lifecycleDispatch: true`, `reportingViaMcp: false`. The plugin
strengthens the binding without changing the route: it writes the thread's own plugin metadata
(`{ task, run, role, host }`) at spawn, and contributes thread instructions that name the helper path
and the ticket path for that thread.

**Evidence.** BB has no per-thread MCP server injection (fact 10): agent configuration is the data
directory `AGENTS.md`, the workspace `.bb/AGENTS.md`, skills and plugin tools. The helper route is
already built and proven for T3Code, works for every provider that can run a shell command, and
binds identity per run ticket rather than per host session. `bb.agents.configure` runs at thread
start and turn submit with the thread's metadata visible (fact 10), so the ticket a thread reports
with is its own even after a BB restart.

**Rejected alternative: MCP through BB agent configuration.** There is no per-thread injection point
to configure. The data-dir `AGENTS.md` is global to every project, so a per-task ticket cannot live
there, and a workspace `.bb/AGENTS.md` would be a committed file inside the task's worktree —
changing the tree under review.

**Rejected alternative: a plugin reporting tool (`bb.agents.registerTool`).** It would work and it is
typed, but reporting would then depend on the plugin being loaded and on the agent choosing the tool,
where the helper path is a durable receipt with a run ticket. It stays a possible later addition if
helper reporting proves unreliable for some provider; it would still carry the same ticket.

### 4. Thread presentation: a planner-owned group, no settle state

**Recommendation.** For one task, Nucleus creates one thread per role — worker, reviewer, recovery,
coordinator and executor — in the task's worktree, each with `parentThreadId` set to the task's
planner thread and `parentNotifications: "off"`. All are visible. The worker thread's title is the
shared `taskWorkspaceTitle` projection plus ` · ` and the step its role threads report, as T3Code's
row does; a support thread's title is `#<task-number> <role>: <title>`. Nucleus never sets
`lifecycleOwnerThreadId`.

BB has no settled state, so Nucleus implements neither `settleWorkerThread`, `settleReportedThread`
nor their reconcilers here. A released support thread simply stays in the planner's group; a task
that needs attention is shown by its worker row's step title, by BB's own pending-interaction
indicator and unread state, and by the board. Replaced attempts follow the existing lifecycle: a
superseded worker thread is archived as soon as its run is released and no live BB turn remains, and
other displaced threads stay visible until closeout. Reparenting a live task to another planner
thread writes `parentThreadId` on each of the task's threads under one durable intent per thread,
observation-first, never on the planner itself. At closeout Nucleus archives the task's role threads
and leaves them archived; it does not delete threads, so the planner's history stays readable.

**Evidence.** The parent link already draws the group, and `parentNotifications: "off"` keeps BB's
own wake-ups out of a planner that Nucleus already notifies through its own durable notices (facts 2,
3). `off` is the only value that does not duplicate the owner-owns-blockers rule: `auto` reports
every finished, failed or interrupted turn, and `stuck` still reports failures, interruptions and
blockers. Titles and reparenting are ordinary `threads.update` writes (fact 7). Archive is BB's
non-destructive retirement, but it is not a leaf-local operation: `threads.archive` cascades, and
`threads.experimental_listCascade` is the only read that names what it would also affect. So every
archive is preceded by that read and fails closed. If the read is unavailable or unreadable, or if it
names any thread outside the set this task's own records hold, the archive is refused, the thread is
left unarchived, and closeout records the cleanup as incomplete instead of guessing. A role thread's
dependents can include a thread its own agent spawned, which Nucleus did not create; that is exactly
the case the read catches, and the promise that Nucleus archives only what it created survives it.
Threads are archived children first, so a recorded child is already archived when its parent's read
runs, and the read then names only already-archived rows or nothing. Nucleus never deletes a thread:
`threads.delete` is destructive, cascades, and needs `childThreadsConfirmed` (fact 3).

No other read substitutes for that proof, so there is no exception to fail closed. The parent link
is display and notification only (fact 3): a thread's lifecycle dependents are a separate relation
that can sit in another project, another environment or another host, so a parent-child count
(`threads.count` with `parentThreadId`) counts sidebar children and says nothing about them. A zero
child count with a foreign lifecycle dependent is exactly the case that would slip through, and an
absence from any thread list is weaker still, because hidden and archived rows need their own filters
(fact 16). A thread with no cascade proof stays unarchived, and that is recorded.

**Rejected alternative: emulate settle by hiding or archiving released threads.** Archiving removes a
thread from the planner's group and from the task's one place to look, so a released reviewer would
disappear until its next round; hiding it with `visibility: "hidden"` would remove it from the group
and from every list unless `includeHidden` is passed. Both make a live task's participants invisible
to get a state BB does not have.

**Rejected alternative: tag and hide support threads as T3Code does.** T3's `nucleus-support` tag
exists to collapse a flat list into one row (Spec: T3Code host adapter, "One row per task"). BB's
list already nests the roles under their planner and their worktree, which is stronger; adding a
hiding tag would remove exactly the rows the operator asked to see.

### 5. Board UI: a `navPanel` board, a settings section, composer pills and the pending-interaction slot

**Recommendation.** The shared board in `client/shell/` renders inside a BB `navPanel` (id
`nucleus-board`), calling the service through the plugin's `bb.rpc` handlers, which forward the
existing RPC catalogue over the socket exactly as the Paseo bridge does. Nucleus's Settings render in
a `settingsSection` (and from the board). BB's lifecycle events (`thread.*`, `interaction.pending`)
forward as the existing bounded lifecycle hints, so a task's board state follows a thread that
starts, stalls or needs input without a poll. Decision and native-question pills are composer
customizations: an `actions` pill per asking agent while it has an open decision, and a pill that
opens the task's native question. A Nucleus-raised question that must block a thread is a plugin
interaction rendered by the `pendingInteraction` slot.

The built-in sidebar is enough. BB's own list already draws planner → worktree group → roles, which
is the structure the operator asked for, so `experimental_threadList` is not used. A later phase may
replace the list only if the trial shows the built-in one cannot carry the task's state, and any
replacement must reproduce the planner grouping first.

**Evidence.** `navPanel` is a titled, routable screen with its own sidebar, `settingsSection` hosts a
settings component, `composer.customize` takes `actions`, `banners`, plus/send menus and popups, and
`pendingInteraction` renders a plugin interaction with `submit`/`cancel` (fact 9). The board and its
Settings are already host-neutral behind `client/shell/` (`BoardShell`, `BoardHost`), and the Paseo
plugin forwards the RPC catalogue over the same socket (Spec 013).

**Rejected alternative: a board-only surface with no in-thread pills.** It would drop parity with the
Paseo plugin, which is an operator requirement, and it would put a blocked question where the agent
is not.

### 6. Usage and observation: chunked inventory, exact-identity adoption

**Recommendation.** Per-run usage comes from `threads.context`'s `usage` (tokens, context window,
optional cost) read on the run's finish path, with `thread/tokenUsage/updated` as the timeline
fallback; provider subscription windows come from `system.usageLimits` for the Usage page.

`observationInventory(agentIds)` takes an arbitrary list, so it chunks the ids into runs of at most
200 — the SDK's cap per `threads.list({ threadIds })` call — and reads the chunks one after another.
Each row already carries the status, runtime status, archive state, pending-interaction flag, queued
work, activity and environment path. A row with `hasPendingInteraction` costs one `interactions.list`
read. The answer is a complete map or `null`: a failed, refused or short chunk, or a row the list
omits, makes the inventory incomplete, and the caller falls back to per-agent `observe` rather than
reading absence. Timelines stay per-thread.

**Adoption after an unknown spawn.** A lost `threads.spawn` reply is settled by reading, never by
resending on a guess, and never by a title. The search is the widest identity read BB offers and it is
complete, not filtered: every thread with this plugin's origin on this host, over every project, walked
twice so archived rows are covered too (`threads.list({ originPluginId, includeHidden: true })` and
`threads.list({ originPluginId, includeHidden: true, archived: true })`, each paged to its positive
end). Origin and plugin origin are fixed at creation and no `threads.update` field can change them, so
a reparented or hidden thread keeps them; the search therefore never filters on the current planner or
project, which is what a reparented or hidden thread would defeat. Each candidate's plugin metadata is
read in chunked `experimental_listPluginMetadata` calls, and a thread is adopted only when its
metadata names this exact task and this exact run. Two or more matches are refused and recorded,
because a repeated pair is not an identity; an unreadable or partial walk leaves the delivery unknown
with nothing bound.

Zero matches never authorizes a resend. A read taken immediately after a lost reply can precede a
spawn that is still landing, so an empty complete search proves only that the thread is not visible
yet. The search repeats on each host sweep for a bounded window, and a spawn that lands late is
adopted then. If the window expires with nothing found, the creation stays unknown delivery: the run
is left uncreated rather than duplicated, the task goes to attention with the recorded intent and
what was tried, and any later attempt is an explicit owner action under a new intent — never an
automatic retry of the uncertain one. A refusal the plugin proved before the write is known
non-delivery and is retryable as it is on every host; unknown delivery is not.

**Evidence.** Fact 12 (row fields), fact 7 (`threadIds`, at most 200 per call, archived rows included
when named explicitly, deleted IDs omitted), fact 16 (origin is immutable, parent and visibility are
not) and fact 11 (usage) are the whole surface these reads need. `threads.count` answers capacity
questions without paging rows; it is never an archive or delivery proof.

**Rejected alternative: per-thread `threads.get` for every participant on every sweep.** It is the
same data one request per thread, against a limit of 200 ids per list call.

**Rejected alternative: identify an adopted thread by its title.** Titles repeat across tasks, are
operator-editable and change with the task's state, so a title can bind a different attempt to a run.
Metadata is durable and per-plugin; it is the only adoption key.

### 7. Planner terminal: a thread-scoped tab, and a separate task-directory convenience

**Recommendation.** Requirement 3 needs no adapter work and no new surface: BB's terminals are core
and ⌘J opens one in the planner's own pane, so a planner already keeps a terminal as a tab in its
workspace. Nucleus adds one convenience command, `bb nucleus terminal`, which creates a
*thread-scoped* terminal in the calling planner's thread (`target: { kind: "thread", threadId }`,
`start: { mode: "shell" }`, and a title naming the task when one is given). That is the whole of the
requirement.

A terminal in a task's *worktree* is a separate thing, not the same one. The SDK's terminal target is
exactly one of `thread`, `environment` or `host_path`, and a thread target carries no cwd, so a
terminal cannot both belong to a planner and start in a task's directory. The task-directory
convenience is therefore a `host_path` terminal (`{ kind: "host_path", hostId, cwd: <task
worktree> }`), which appears in the right panel but belongs to no thread. It is an assumption to
prove in phase 0 before phase 5 includes it; if it does not appear where an operator expects, it is
dropped, and requirement 3 is still met by ⌘J and the thread-scoped command.

Nucleus never lists, reads, resizes, writes to or closes a terminal it did not create, and never
reads terminal output as a lifecycle fact.

**Evidence.** A thread-scoped terminal appears in that thread's panel and an environment-scoped one
does not (fact 4); `terminals.create` takes a `thread`, `environment` or `host_path` target with an
optional `start` command and title, and no target carries both a thread and a cwd (fact 7); a terminal
closes with `thread-archived` when its thread is archived, so a planner terminal is retired with the
planner, not with a task.

**Rejected alternative: Nucleus creates a terminal in each planner's thread at task dispatch.** It
would mutate a thread Nucleus does not own, multiply terminals with every task, and leave the planner
cleaning up after Nucleus.

## Identity, connection and faults

**Identity.** The plugin announces the BB server's data directory, version and SDK version. The
service derives `hostId = bb:<hash of the real data directory>` and registers that identity only
after a read-only probe through the channel succeeds (`status.get`, `system.version`, and one
`threads.list`). Reconnecting must prove the same recorded data directory; a different one refuses
by its exact field and takes the host offline. Version strings are diagnostics, never an allowlist: a
newer BB whose SDK still satisfies the operations connects, and a changed required field refuses by
name. The host kind is `bb`, selected per repository
(`repository.set hostKind: "bb"`), and `hostKindOf` learns the `bb:` prefix so health, settings and
the routing snapshot answer for it.

**Presence.** The BB plugin requests the same bridge presence claim the Paseo bridge holds, so a
running BB keeps the daemon's idle clock honest. There is one claim service-wide: whichever host
claims it first holds it, and the other retries on its retained connection under the existing rule,
so idle shutdown stays correct with both hosts up. A lost plugin while its host is connected remains
a visible fault, and its recovery hint must name the plugin's own reload command
(`bb plugin reload nucleus`) instead of Paseo's.

**Faults.** One operation's fault settles that operation as unknown delivery, never the connection: a
malformed result, a refused schema, an operation past its deadline, or an error the SDK reports after
the call was written. An unknown write is never resent automatically. A create is not resent even when
a read finds nothing: observation can adopt the thread it names, and an empty read only means nothing
is visible yet (decision 6). A non-create write is retried only when a fresh read proves its
postcondition absent *and* the host's own answer establishes the write could not have landed; a
recorded plugin metadata identity, a title, an archive's `archivedAt` and a stop's status are the
reads that settle it. Loss of the connection is a host outage: observation defers for that host, and
no task is ever read as idle because its host is unreachable.

**Operation table.** Each is one `host_op` request with a deadline and a bounded reply.

| Host operation | BB call | Result the adapter needs |
| --- | --- | --- |
| Register project | `projects.create` with the repository root, `projects.list` first | One project per repository root; never deleted |
| Create workspace | Register the project, mint the task's handle, persist it; no `threads.spawn` | A handle bound to the canonical directory and the project; no thread exists yet |
| Create a run | `threads.spawn` with the unmanaged path, parent, `parentNotifications: "off"`, plugin metadata, provider/model/options and the run prompt | Thread ID whose metadata names the run, and the environment ID recorded on the handle |
| Adopt an unknown spawn | Two complete `threads.list` walks by `originPluginId` across every project, hidden included, live then archived, then chunked `experimental_listPluginMetadata` | One thread whose metadata names this exact task and run; zero matches leave delivery unknown and never authorize a resend |
| Follow-up | `threads.send` with the message identity recorded | Accepted row; unknown delivery reconciled by reading the thread |
| Steer or notify | `threads.send` steer when a turn is live, otherwise a queued send | Same rule as T3Code's `steerOrNotify` |
| Observe | `threads.get`, or a chunked row read from `threads.list({ threadIds })` | Status, active turn, pending interaction, archive state |
| Answer a question or permission | `threads.interactions.respond` (or `resolve`) | The exact interaction and thread; unknown delivery never resent |
| Dismiss a question | `threads.interactions.cancel` | Same request scope |
| Stop | `threads.stop`, then status read | Status settles the intent; a stop stays stopping until it reads |
| Set a title | `threads.update` | Title read back before any retry |
| Reparent | `threads.update` with `parentThreadId` | Read back before any retry |
| Archive a thread | `experimental_listCascade` for `archive`, then `threads.archive` | A cascade that names only this task's recorded threads; `archivedAt` on the thread; refusal when it names anything else |
| Archive a workspace | Mark the task's worktree handle archived in adapter state | The handle's own marker; BB keeps the unmanaged environment |

## Composition and unsupported capabilities

Service composition reads optional BB configuration, registers the channel independently of Paseo and
T3Code, and selects the recorded host per task. The BB Host keeps `lifecycleDispatch` false and the
Adapter enables it once the helper path is wired, as T3Code does, so BB threads report through the
helper and ticket named in the prompt. It reports `reportingViaMcp` false,
`supportsCoordinatorRecovery` true, `perThreadEnvironment` false (one worktree per task, shared by
its roles) and `repositorySharedWorkspaces` false (the shared BB project is never archived by a
task).

Explicit refusals, never empty successes: a Nucleus-raised decision through MCP, MCP reporting,
per-thread environment, thread deletion, and a settle or unsettle call. Core routes ordinary tasks
around them: reports ride the helper, decisions ride the board and native interactions, and
presentation is the group plus the title.

## Experimental API inventory

Every surface below still carries an `experimental_` prefix. Each row names what breaks if it
changes.

| Experimental API | Why the design needs it | What breaks if it changes |
| --- | --- | --- |
| `bb.server.experimental_dataDir` | Host identity (`bb:<hash>`) and the data-directory probe | Identity refuses by name and the host stays offline; the fallback is to derive identity from the machine host record and version, which is weaker, so the phase-1 probe must fail closed instead |
| `threads.experimental_listPluginMetadata` | Adopting a thread after an uncertain spawn, in one chunked read | Adoption falls back to per-thread `threads.getPluginMetadata`, which is the same exact identity one call per candidate; if that is also missing, the uncertain spawn stays unknown with nothing bound and no retry |
| `threads.experimental_listAncestors` | Proving a role thread's planner before reparenting or archiving | Reparenting reads the parent link per thread instead; a deeper planner chain is then unproven |
| `threads.experimental_listCascade` | Proving an archive would touch only this task's own threads | Archive fails closed with no substitute: without the read there is no authoritative cascade proof, so the thread is left unarchived and closeout records the cleanup as incomplete. A sidebar child count or a list absence never stands in for it |
| `composer.customize` `experimental_popups` | A pill's popover content | Pills fall back to host-rendered menus and the board opens the same action |
| `slots.experimental_threadList` | Deferred; not used by this design | Nothing, because the built-in sidebar is the plan |
| `experimental_setThreadRowStatus` | Deferred row decoration; not used by this plan | Nothing; the worker title carries the step |
| `slots.experimental_sidebarNavigation`, `slots.experimental_threadContextSegment`, `slots.experimental_threadInfoRow` | Deferred; not used by this design | Nothing |

The adapter's own tests pin the SDK version as a diagnostic and decode the fields it consumes
strictly, so an additive SDK change connects and a changed required field refuses by name.

## Phased plan

Each phase is one pull request with its own outcome, acceptance checks and dependencies. No phase
starts before its dependencies are merged. The spike is the only phase allowed to change its own
question; if it refutes decision 1 or 2, it reports the evidence and the later phases are re-planned
before any of them starts.

### Phase 0 — spike: the channel and the five-step lifecycle

**Outcome.** A scratch BB plugin and a scratch adapter prove, end to end and against an isolated BB
server (its own data directory and port), that the reverse host-operation channel works through
`bb.sdk`: mint a workspace handle and register the project without spawning → attach the worktree by
spawning a synthetic worker thread under a synthetic planner → observe → archive. The spawned thread
is the spike's own fixture, not a Nucleus run: the spike proves BB's behaviour and the attach order,
not run identity binding. The PR lands the transport skeleton (the socket role, the plugin skeleton,
the operation envelope) and an Effigy proof selector; it registers no host, adds no host kind and
cannot dispatch a task. It answers every assumption above in writing, including plugin reload and BB
restart.

**Acceptance.**

- `effigy proof:bb` prints, from one run: the connection established and re-established after a
  plugin reload; the host identity derived and re-proved; the project registered and a handle minted
  with **zero** `threads.spawn` calls in that step; a Nucleus-created worktree attached as an
  unmanaged environment by a synthetic thread spawned with the planner as parent and notifications
  off; that same environment ID read back after the restart; the thread observed (status, environment,
  parent, metadata) and archived after its cascade read. Synthetic repository, synthetic project,
  everything the run created removed or archived at the end.
- The same run answers the terminal-scope question: whether a `host_path` terminal at a task worktree
  appears where an operator would find it, and whether a thread-scoped terminal really belongs to its
  thread's panel.
- The proof refuses to run against the operator's live BB data directory, and reports what it tried
  if it cannot find an isolated server.
- `effigy check` and `effigy test:affected --run` at the pushed head.

**Dependencies.** None.

### Phase 1 — host registration, identity and health

**Outcome.** BB registers as a host: the connection role in the service socket, the plugin's
executor announcement, the identity derivation and probe, the registry entry, per-host admission and
breaker state, presence and the reload fault naming `bb plugin reload nucleus`, `service.health`
reporting the host's state, and the `bb` host kind with its per-repository setting. No task workflow
is reachable.

**Acceptance.**

- Fake-transport unit tests: a probe that matches registers; a changed data directory, a missing
  field or a refused schema takes the host offline by name; a reconnect proves identity again; a
  dropped connection leaves every in-flight operation unknown and never resent; health reports the
  host, its version diagnostics and its offline reason.
- `repository.set hostKind: "bb"` is accepted and shown; a live task never changes host; Paseo
  stays the default and T3Code's tests are unchanged.
- `effigy check` and `effigy test:affected --run`.

**Dependencies.** Phase 0.

### Phase 2 — workspace custody, without a thread

**Outcome.** The adapter records the task's Git worktree as a Nucleus-owned handle: it registers one BB
project per repository root (never deleted), mints and persists the handle bound to the canonical
directory and project, inspects a creation, recovers a lost workspace, and proves archive from its own
handle marker. It spawns no thread, so a workspace-only PR has an outcome it can actually meet and can
be tested without a run.

**Acceptance.**

- Tests: create → inspect → archive with the recorded marker; a create issues **no** `threads.spawn`
  and records no agent identity; the handle survives a restart; a second create for the same task
directory reuses the handle; a missing directory or unregistered project reads honestly; an unreadable
  read stays unknown; the shared project is never deleted; a task's archive does not retire another
  task's workspace or its project.
- `effigy check` and `effigy test:affected --run`.

**Dependencies.** Phases 0–1.

### Phase 3 — worker runs, observation and presentation

**Outcome.** A task can dispatch on BB: `hostKind: "bb"` selects the host; `createRun` spawns the
worker in the recorded worktree under the planner with notifications off, plugin metadata binding its
run ticket and the returned environment ID recorded on the handle; the helper reports; and the sweep
observes status, active turn, pending interaction and archive state from a chunked inventory. Worker
titles carry the step, attention shows on the worker row, stop and archive work, and a replaced worker
is archived. One end-to-end lifecycle test runs the ordinary path — dispatch, worker report,
independent reviewer, revision, verdict, merge, closeout and archive — on a fake transport with the BB
wire shapes pinned.

**Acceptance.**

- The lifecycle test above, plus tests for: the environment ID recorded on the handle at run creation
  and reused by the next role; an inventory of more than 200 threads chunked into bounded calls with a
  complete map; one failed or short chunk, or an omitted row, answering `null` and falling back to
  `observe`; a row with a pending interaction costing one interaction read; a lost `threads.spawn`
  reply adopted only from metadata naming the exact task and run; a reparented thread and a hidden
  thread still found by the complete origin search; a spawn that lands after an empty search adopted
  on the later sweep; a lost spawn with an unreadable or partial walk staying unknown and unbound; a
  lost spawn with two metadata matches refused; an empty complete search never resending, leaving the
  run uncreated and the task in attention with what was tried; a title write read back before retry;
  and an archive preceded by its cascade read.
- `effigy check` and `effigy test:affected --run`.

**Dependencies.** Phases 0–2.

### Phase 4 — delivery, questions and the support roles

**Outcome.** Parity for the rest of the cast: continue worker and runs, notify and steer,
reviewer, recovery, coordinator and executor threads, native question and permission answer and
dismissal, the planner ask, the decider, reparenting a live task, and closeout archiving every role
thread. Reviewer replacement releases the displaced run and archives the thread through the existing
durable archive effect.

**Acceptance.**

- Tests: a follow-up while a turn is live steers and falls back to one queued send only when a steer
  is proven not sent; an unknown delivery is never resent; an interaction answer binds the thread and
  request before reading status; a reparent writes every thread's parent once and reads it back; a
  reviewer replacement archives only the displaced thread; closeout archives recorded children before
  their parents and records completion once; an archive whose cascade read is unavailable, or names a
  thread this task does not own, is refused with the thread left unarchived and the cleanup recorded
  as incomplete, including the case where the thread has no sidebar children but a foreign lifecycle
  dependent, where a zero child count is not accepted as a cascade proof.
- `effigy check` and `effigy test:affected --run`.

**Dependencies.** Phases 0–3.

### Phase 5 — board, settings, pills, usage and the planner terminal

**Outcome.** Operator parity in BB: the shared board in a `navPanel`, Settings in a
`settingsSection`, decision and native-question composer pills, the pending-interaction slot for a
Nucleus-raised blocking question, usage on the board and its nav badge from `system.usageLimits`, and
lifecycle hints forwarded from BB's events into the existing signal path. `bb nucleus terminal` ships
with the plugin CLI as the thread-scoped planner tab; the task-directory `host_path` terminal ships
only if phase 0 proved it appears where an operator would look.

**Acceptance.**

- UI tests through the existing board harness with the BB shell bound: the board renders, its calls
  reach the service, Settings opens, a decision pill appears and resolves, a native question pill
  shows and answers, the pending-interaction slot submits and cancels, and usage renders from a
  synthetic snapshot.
- The terminal command creates one thread-scoped terminal in the calling thread and nothing else; a
  test proves the task-directory variant is absent when phase 0 did not prove it.
- A test proves no settings write, no lifecycle-owner write and no terminal read ever leaves the
  adapter.
- `effigy check`, `effigy qa:docs` and `effigy test:affected --run`.

**Dependencies.** Phases 0–4.

### Phase 6 — trial and parity call

**Outcome.** One repository opts into BB and runs real tasks through it beside Paseo, through
milestone QA's own runs; the open questions this spec leaves are answered from that evidence and
written back into this document.

**Acceptance.**

- A written parity table against the Paseo plugin for board, settings, decision pills, native
  question pills, usage and lifecycle hints, each marked met, met by a different mechanism, or
  missing with the reason.
- Evidence for plugin reload mid-task, BB restart mid-task, and a host outage during observation:
  each leaves the task uncertain and recovered by observation, never resent and never read as idle.
- The operator's call on whether BB becomes a supported host (Tom; this phase records it, it does
  not assume it).

**Dependencies.** Phases 0–5.


## Phase 0 evidence (2026-11-16)

Phase 0 is implemented and proved against an isolated BB 0.49.0 server. `effigy proof:bb` runs the
whole spike in one process, in its own scratch root: it starts a BB server with its own data directory
and port, enrolls a host daemon into that server, starts an isolated Nucleus service (the real socket
with a fake persistence fixture), installs this repository's plugin skeleton into that server only, and
then drives the five-step lifecycle through the reverse channel.

What landed:

- `shared/host-operation.ts` — the operation vocabulary, the executor declaration, the identity
  derivation `hostId = bb:<sha256(real data directory)>` and the `bb-worktree-<40 hex>` handle shape.
- `shared/service/host-channel.ts` — the strict schemas both ends are validated against.
- `service/host-executor.ts` and the `service.host-executor` role in `service/transport/server.ts` — one
  declared executor connection per host identity, bounded reverse `host.op` requests, and the fault
  rules below.
- `hosts/bb/plugin/` — the plugin skeleton: a self-contained BB plugin package whose backend connects
  out to the service, declares the role and executes the bounded operations through `bb.sdk`.
- `effigy proof:bb` (`scripts/acceptance/bb-private.ts`) — the private spike, and
  `test/bb-host-channel.test.ts`, `test/bb-host-executor.test.ts`, `test/bb-plugin-operations.test.ts`,
  `test/bb-plugin-protocol.test.ts`, `test/bb-proof-isolation.test.ts` for the parts a fake can prove.

What did not land, on purpose: no host registration, no `bb` host kind, no routing, no board, no
skill, and no code path from a task to a BB operation. The service's `sendHostOperation` has no
catalogue caller.

On the wire, the role is a method (`service.host-executor`) and a direction: after the owner credential
handshake a connection declares `{ role: "host-executor", host: { dataDir, bbVersion, sdkVersion } }`,
and on that connection the service writes ordinary Contract 007 request frames whose method is
`host.op` with `{ op, input }`, which the plugin answers with ordinary response frames. The framing,
the presence claim, roll recovery and the catalogue path are unchanged.

### The eight assumptions

1. **A plugin backend holds a long-lived outbound Unix-socket connection, and re-establishes it after
   `bb plugin reload` and after a BB server restart. — Proven.** The proof records the connection the
   service accepted, then runs `bb plugin reload nucleus` and a full server restart of the same data
   directory. Each produces a *new* connection — a later `connectedAt` for the same host identity — and
   operations run on the new one. The plugin's reconnect loop re-reads `queue-service.json` on every
   attempt, so a service roll underneath it is also a reconnect.
2. **The service carries the reverse role on the existing owner-only socket without disturbing the
   bridge presence claim, roll recovery or the request path. — Proven.** `test/bb-host-channel.test.ts`
   runs the real `QueueService` socket: a bridge claims presence before the executor declares and holds
   it afterwards, a second claim still answers `{ active: false }`, `service.health` and
   `service.request-outcome` still answer while the executor connection is held, and the idle sweep
   never closes a connection that holds the role. One operation's fault settles that operation: the
   same connection answers the next one.
3. **An unmanaged environment id is stable across a plugin reload and a BB restart. — Proven.** The
   worker attached a fresh worktree as an unmanaged environment; the same id is read back after the
   reload and after the restart, and the environment is still listed, still unmanaged, at the same
   path. A second role thread spawned onto the same path resolved to the same environment, which is
   decision 2's "every role of one task shares one environment".
4. **A lost spawn is discoverable by its own plugin metadata across projects, hidden rows and archived
   rows. — Partly proven.** The metadata does bind exactly: a thread spawned with
   `{ nucleus: { task: "spike", run: "phase-0" } }` reads that metadata back through
   `threads.experimental_listPluginMetadata`. The proof also ran both halves of decision 6's identity
   search: `threads.list({ originPluginId: "nucleus", includeHidden: true })` — no project or planner
   filter, hidden rows included — named the worker, and the same walk with `archived: true` named it
   after its archive. What phase 0 did not do: page a walk past 200 rows (the executor issues one
   `threads.list` call per walk today), prove the walk complete when a chunk fails or a row is omitted,
   and run the adoption algorithm itself. Those are phase 3's acceptance and stay unproven here.
5. **Archiving a role thread leaves its planner, its siblings and the worktree group untouched when
   nothing depends on it. — Proven.** The archive was preceded by its own cascade read, which named
   nothing; the planner's row kept its status and timestamps, and a sibling role thread in the same
   worktree stayed unarchived.
6. **`threads.spawn` returns when the row is committed, not when the first turn starts. — Proven.**
   The attach answered in tens of milliseconds with status `starting`, the environment id already
   recorded; the provider turn had not started. A spawn created with a future `sendAt` answers
   `pending` with one queued message and no environment work at all, which is the sharper form of the
   same fact.
7. **An isolated BB server can be driven on this machine for proof, without touching the live BB. —
   Proven.** The proof starts `bb-server.js` with `--data-dir <this run's root> --server-port <free>`,
   enrolls its own host daemon with `bb-host-daemon join`, and uses only that data directory. It refuses
   a data directory that is, contains, is contained by, or symlinks into the operator's live directory
   (`~/.bb` or `BB_DATA_DIR`), and refuses one outside its own scratch root; `--data-dir ~/.bb` prints
   the refusal and exits 2 before starting anything. `test/bb-proof-isolation.test.ts` pins that matrix.
8. **A `host_path` terminal at a task worktree appears where an operator would look. — Refuted for the
   task-directory convenience.** It appears in the host's own terminal list and in no thread's terminal
   list, so a planner looking at their thread does not see it. Phase 5 drops the task-directory
   `host_path` terminal and keeps the planner's native ⌘J tab plus the thread-scoped command, which
   phase 0 did prove: a thread-scoped terminal appeared in its own thread's list, with the thread's
   environment path as its initial working directory, and in no host list.

### Terminal scope

The same run answers the second acceptance bullet. A thread-scoped terminal belongs to its thread's
panel: it is created against the thread, requires that thread's environment, and is listed only under
that thread. A `host_path` terminal at a task worktree belongs to the host, not to any thread: it is
listed only under the host. An environment-scoped list showed neither. So the planner tab is the
planner's own thread-scoped terminal (⌘J needs no adapter work), and the task-directory convenience is
dropped from phase 5 unless a later BB release puts host-path terminals in a thread's panel.

### Corrections to the verified facts

Fact 4 said a thread-scoped terminal records `thread-archived` as its close reason. In the isolated
BB 0.49.0 server, archiving a thread left its terminal `running` with `closeReason: null`, and only an
explicit close recorded `user`. Phase 0 therefore closes the terminals it creates itself and reads no
terminal state as a lifecycle fact; decision 7's "a planner terminal is retired with the planner" claim
is not relied on, and phase 5 must re-check it before it does.

### Fault rules as implemented

One operation's fault settles that operation: a malformed answer, a projection missing a required
field, an answer naming a different operation, and a passed deadline are all *unknown delivery*
(`HostOperationUnknownDeliveryError`), because the write may have landed. A dropped connection settles
every in-flight operation as unknown and never replays one. A second declaration for the same host
identity replaces the first — that is what a plugin reload looks like — and the replaced connection's
in-flight work settles unknown. Nothing is ever resent on a guess.

Only two answer codes are a definite refusal a caller may act on: `invalid_input`, refused before
anything is written, and `refused`, a policy answer the plugin proves before its own write (a cascade
that names a thread the task does not own). `unavailable` and `internal` are *not* refusals: the plugin
raises them after a call that may already have committed, so they settle as unknown delivery and the
work is adopted by observation instead of resent. The case that fix exists for is the attach — BB
commits the thread and provisions the environment afterwards, so an attach whose environment id never
arrives answers `unavailable` naming the committed thread, which is unknown delivery, never a spawn to
try again. `shared/host-operation.ts` owns the two-code list, `service/host-executor.ts` classifies with
it, the plugin's own list is pinned to it, and `test/bb-host-executor.test.ts`,
`test/bb-host-channel.test.ts`, `test/bb-plugin-operations.test.ts` and `test/bb-plugin-protocol.test.ts`
pin both ends.

## Verification

Fake-transport tests serve only BB wire shapes captured from the target BB release, the way the
T3Code contract fixtures do: the fake completes every served thread, interaction and list row to the
recorded field set and refuses an invented partial record, so an adapter that reads a field BB does
not send fails in tests rather than in the operator's sidebar.

The private proof drives an isolated BB server with its own data directory and port, a synthetic Git
repository and a synthetic project, and a scripted local provider. It never discovers or reuses the
operator's BB data directory, project or threads. Evidence is retained in scratch: the connection and
its reconnect, the identity probe, the unmanaged environment, a spawn with its parent and metadata,
an observation, an archive and its cascade read, a reload mid-run and a restart mid-run. Public PR
text carries no local paths, no credentials and no private project names.

Proof selectors: `effigy proof:bb` for the private run, the affected unit files for each phase, and
`effigy check` plus `effigy qa:docs` for every phase. No phase runs the full suite; milestone QA
does that on `main`.
