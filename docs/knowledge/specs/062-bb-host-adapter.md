# BB host adapter

Status: approved, not implemented. This document is the design and the phased plan; phase 0 proves
the transport before any phase depends on it. Amended 2026-11-16: decision 5 now carries the forked
sidebar, the two boards and the forked usage card with Nucleus's pace and the Grok source, and the
experimental inventory and the plan from phase 5 on follow it; phases 0–4 are unchanged.
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
- **upstream** — BB's own source at the pinned commit `7b26cae7`, tag `desktop-v0.49.0`, SDK
  0.6.132, read in a sparse clone on 2026-11-16. These are the facts the amendment re-verified
  itself rather than carrying from the thread.

| # | Fact | Evidence |
| --- | --- | --- |
| 1 | `bb thread spawn --environment <path>` attaches a thread to an existing worktree as an unmanaged environment; a later attach by the same path or by environment ID resolves to the same environment; BB runs no setup or teardown hook for an unmanaged path and never retires it | spike |
| 2 | `--parent-thread <planner> --parent-notifications off` with role threads in one worktree draws planner → worktree group → role threads in BB's built-in thread list with no plugin code; `bb thread update --clear-parent-thread` / `--parent-thread` re-parents a live group | spike |
| 3 | The parent link is display and notification only. `lifecycleOwnerThreadId` is separate and immutable, and archiving or deleting an owner cascades to its dependents. `threads.delete` requires `childThreadsConfirmed`, and `threads.experimental_listCascade` names the threads an `archive` or `delete` would also affect | spike, sdk |
| 4 | Terminals are core, in the right panel (⌘J). A terminal created for a thread target appears in that thread's panel; an environment-scoped terminal does not appear in a thread-scoped list. A thread-scoped terminal records `thread-archived` as its close reason | spike, sdk |
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
| 17 | `plugins/thread-list` is 15,766 lines of TypeScript and React in 72 source files plus 37 test files, and imports only `@get-bb/plugin-sdk/app`, React, `jotai`, `@dnd-kit/*`, `sonner`, `zod`, `@radix-ui/*`, and 33 modules through the component registry's `@/components/ui/*` and `@/lib/*` aliases (3,925 lines; `@/components/ui/icon` resolves to the registry's host-backed icon flavor) | upstream |
| 18 | `plugins/thread-list` is on upstream's forkable list (`scripts/forkable-plugins.json`), so `docs/forkable-plugins.md` and CI's "Plugin Fork Check" (`scripts/lib/plugin-fork.mjs`) guarantee a copy of the directory installs, typechecks, tests and `bb plugin build`s outside the monorepo with published packages only — rewriting `@/*` onto the copy's own root and writing the registry items it imports into it. Upstream BB is MIT (root `LICENSE`, copyright 2026 Michael Yong); the plugin directory carries no separate license | upstream |
| 19 | The worktree group header is `EnvironmentThreadGroupHeader` (`app/list/ProjectRow.tsx`): environment-provider icon, inline-renamable name, child toggle chevron, the roll-up status glyph only while collapsed and only when a hidden thread has an indicator, a new-thread button, and an overflow menu holding Rename and Archive | upstream |
| 20 | A sidebar thread row carries `environment.id` (with name, branch, path, `isWorktree` and provider id), `projectId`, `originPluginId`, `status`, `runtimeStatus`, `queuedWork`, `hasPendingInteraction`, `activity`, `indicator` with its accessible label, unread, pinned and archived state, and `href`, so a list can find a task's group and draw the host's own status without another read | upstream |
| 21 | Collapse is per client and per plugin: `collapsedEnvironments` is a synced preference whose default is the empty list (`app/preferences/atoms.ts`, `shared/preferences.ts`), so every group starts expanded | upstream |
| 22 | The metadata line (`experimental_ThreadRowMetadata`) renders under a *thread* row's title (`app/rows/ThreadRow.tsx`); the group header has no metadata hook, so a collapsed group has no metadata line at all | upstream |
| 23 | `app.slots.experimental_threadList` is exclusive and replaceable: the registration id is `thread-list`, automatic selection prefers a non-bundled list, `sidebar.threadListProvider` pins one, a crash falls back with a toast and a placeholder, and the plugin gets the scrolling list only — the New-thread button, navigation rail and footer stay host-rendered. A replaced list is expected to keep honouring `useSidebarThreadRowStatus` so another plugin's row status does not vanish with the list | upstream, guide |
| 24 | Plugin storage, RPC and realtime are scoped by plugin id (`realtime.publish` sends `{ pluginId, channel, payload }`), so a copy of the list neither reads nor publishes the bundled plugin's preferences | upstream |
| 25 | A `navPanel` is a navigation destination through the bundled Navigation plugin's rail (`navigation/rail`, the default) or top list; `experimental_useBadge` draws a count, short text or a dot; its route is `/plugins/<pluginId>/<path>/*` and `subPath` is the route remainder, so a deep link works | guide, upstream, probe |
| 26 | Tab contexts are exactly `{ kind: "thread" }`, receiving `{ threadId, environment: { id } }`, and `{ kind: "nav-panel", panelId }`, receiving `{ subPath }`; `useVisible` decides whether a fixed tab shows | upstream |
| 27 | `plugins/provider-usage` is 2,936 lines of TypeScript and React in 13 source files plus five test files (1,415 lines), is on upstream's forkable list, declares `engines.bbPluginSdk: ">=0.4.90"`, and registers a sidebar-footer **disclosure** card (`experimental_sidebarFooter` with `ExperimentalSidebarFooterDisclosureProps`) plus a settings page (`UsageSettings`); it draws no navigation entry and owns no rail markup | upstream |
| 28 | The card aggregates *source* plugins: its server discovers `provider-usage.v1.listResources` implementors through `bb.sdk.plugins.experimental_discoverRpc({ method })`, so a source must register its RPC with `experimental_discoverable: true`; it then lists each source's resources, fetches `provider-usage.v1.getResource` per resource three at a time, and serves one `getUsage` snapshot of `{ machines: [{ id, displayName, status, providers: [{ id: "<source>:<resource>", providerId, accountLabel, displayName, logoUrl, icon, strings, usage }] }] }`. Provider display metadata comes from `bb.sdk.providers.list({ capability: "usage" })`, ordering follows that catalog, and a provider it does not carry falls back to `{ id: providerId, displayName: providerId }` | upstream |
| 29 | The card's window value after `normalizeUsageMeasurement` is `{ label, usedPercent, resetsAt, cost }`: the source contract's `kind` (`five-hour`/`daily`/`weekly`/`custom`) is used only to name the label and is dropped before the client. The window row renders `<n>% used` and a bar filled to `Math.max(2, min(100, usedPercent))` with `usageBarColorClass` (80 warning, 95 destructive) | upstream |
| 30 | The source contract is owned by `plugins/provider-usage/usage-source-contract.ts` and copied into each source: `provider-usage.v1.listResources` (cheap inventory; `id`, `accountKey`, `providerId`, `label`, `scope: shared \| host`) and `provider-usage.v1.getResource` (one resource: `observedAt`, `usage.ok.windows[]` of `{ kind, id, label, usedPercent, resetsAt, model, cost }`, or `not_installed`/`unauthenticated`/`expired`/`error`). Its README states that other providers "must explicitly implement the contract to appear in these displays" | upstream |
| 31 | Today's sources are provider-claude-code, provider-codex and provider-acp. ACP's covers only providers whose declaration sets `usage: true` (from `providerUsage` on the agent), which is `acp-opencode` alone: `acp-grok` ("Grok Build", `known-agents.ts`) sets no `providerUsage`, so it publishes no resource and earns no `capability: "usage"` catalog entry | upstream |

## Assumptions phase 0 must prove

These are the facts this design rests on that no evidence above establishes. Phase 0 is not complete,
and no later phase starts, until each is answered in writing.

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
   convenience is worth shipping; if it does not, phase 6 drops it and the planner tab stays native.

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

### 5. Operator surfaces: the forked sidebar, the task group header, the global board and the per-project board

**Recommendation.** Nucleus owns BB's sidebar by forking BB's own list, and it carries the two boards
the operator asked for (Tom, 2026-11-16: "the sidebar is where most of the workflow exists in these
apps, so getting it right is crucial"). The built-in group row draws a provider icon, a name, a
collapse toggle, a roll-up glyph while collapsed, and new-thread plus an overflow menu with Rename
and Archive (fact 19). That row cannot say what a task is doing, which PR it is on, or where its
validation stands, and its collapse preference starts every group expanded for every task (fact 21).
So the BB plugin vendor-copies `plugins/thread-list` — the operator's option A — and keeps it as a
thin patch set, and each Nucleus task group's header renders the task's state from one batched read.
The shared board from `client/shell/` renders in a `navPanel` in BB's left rail with an attention
badge, and it renders per project in a fixed thread tab plus a `navPanel` sub-path route. The rest of
the surface is as first drafted: Settings in a `settingsSection`, decision and native-question
composer pills, and a `pendingInteraction` for a Nucleus-raised blocking question. Usage is BB's own
card, forked once to carry Nucleus's pace, with Grok published as a source (5e).

The parts below are decisions, not options: 5a and 5b are the sidebar work, 5c extends the board
phase, 5d is the per-project board the operator asked for beside the global one, 5e is the usage fork
and the Grok source, and 5f records what does not change.

#### 5a. The sidebar is a fork of BB's own list

**Recommendation.** Vendor `plugins/thread-list` from BB at a pinned upstream commit into the BB
plugin package that phase 0 lands (`hosts/bb/plugin/`), and keep it a thin patch. The pin is the
commit a BB *release* tag points at, not the branch head: the vendored list must be the one written
against the SDK the running BB ships. Today that is tag `desktop-v0.49.0`,
`7b26cae79ec978fafd0a5db0e8517e94f12eb8f4`, SDK 0.6.132, whose list declares
`engines.bbPluginSdk: ">=0.6.112"` (facts 18, 23).

Layout, chosen so the copy stays mechanical:

- `hosts/bb/plugin/sidebar/` holds the vendored plugin source: upstream's `app.tsx`, `app/`, `shared/`
  and `server.ts`, unchanged except by the patch set, plus upstream's `LICENSE` and
  `PLUGIN_OVERVIEW.md`.
- The 33 component-registry modules the list imports through `@/components/ui/*` and `@/lib/*`
  (fact 17) are written into the plugin package root at the paths upstream's own copy routine writes
  them (`components/ui/`, `lib/`), with the `@/` alias mapped onto the package root in the plugin's
  tsconfig. Copying them by hand into `sidebar/` would defeat that routine.
- The plugin's own `app.tsx` calls `definePluginApp` once and registers the forked list's `ThreadList`
  component alongside the board, Settings, pills and the pending-interaction slot. The plugin's own
  `server.ts` composes the fork's vendored server entry (`threadListPlugin(bb)`) with the adapter's
  RPC catalogue and the presence socket. Both are composition, not forks of upstream behaviour.

Whoever copies keeps upstream's documented fork path rather than a hand copy: `plugins/thread-list`
is on upstream's forkable list, so upstream CI's "Plugin Fork Check" already guarantees a copy of the
directory installs, typechecks, tests and `bb plugin build`s outside the monorepo with published
packages only, and `scripts/lib/plugin-fork.mjs` performs the copy (facts 18, 23). Nucleus runs the
same routine and records its output.

**The patch set is four seams, and nothing else.** Each is a `.patch` file under
`hosts/bb/plugin/sidebar/patches/`, listed with its reason in `sidebar/PATCHES.md`:

1. `app/list/ProjectRow.tsx` — the task group header: for a group whose threads carry this plugin's
   origin and whose environment is a Nucleus task handle, render the state line (5b); every other
   group takes upstream's path.
2. `app/preferences/atoms.ts` and `shared/preferences.ts` — one preference key, `expandedTaskGroups`
   (environment ids), which owns the collapse state of Nucleus task groups and nothing else.
3. `app/list/nucleusTaskGroups.ts` — a new file in the fork: the batched read, its join, and the
   collapsed/expanded decision derived from (1) and (2).
4. `app.tsx` — export the `ThreadList` component instead of defining the plugin, so the plugin's own
   entry can register it beside the board.

A vendored file that needs a fifth change is a signal that the seam is wrong: either the patch set
grows deliberately, with its reason recorded, or the change belongs upstream (5f's exit path).

**Rebase routine.** Bump the pin to a new release tag, run the copy, apply
`sidebar/patches/*.patch`, resolve rejects by updating the patch (never by editing a vendored file in
place), then run the vendored-manifest test, the fork's own test files, and the phase acceptance. The
routine is one documented sequence in `sidebar/PATCHES.md` so any worker can do it.

**Drift check.** `sidebar/UPSTREAM.json` records the repository, tag, commit, the plugin path, a
SHA-256 per vendored file, the registry items written in, the patched file list and the pinned SDK
floor. Two checks read it:

- an ordinary unit test (`test/bb-sidebar-vendored.test.ts`, in the affected set for any change under
  the plugin package) proves every file under `sidebar/` and every vendored registry path is either
  byte-identical to its recorded hash or named as patched, that every patched file is named, that the
  SDK floor stays at or below the SDK the pinned release ships, and that `plugins/thread-list` is
  still on upstream's forkable list at the pin;
- an opt-in selector, `effigy bb:sidebar-drift [ref]`, fetches the pinned commit, re-derives the
  hashes and reports files that changed upstream since the pin plus any loss of forkability. It needs
  the network, so it never runs inside `effigy check`; it is the first step of a planned rebase.

**MIT notice.** Upstream BB is MIT, root `LICENSE`, and `plugins/thread-list` carries no separate
license of its own (fact 18). MIT requires the copyright and permission notice in copies of
substantial portions, so `sidebar/LICENSE` keeps upstream's notice verbatim and the root
`THIRD_PARTY_NOTICES.md` gains a section naming the upstream
repository, the pinned commit, the two vendored trees (`sidebar/` and the registry modules), that the
files are unmodified except where `PATCHES.md` says otherwise, and that Nucleus's modifications to
them are under Nucleus's own terms. A rebase updates the section's commit and file list.

**Evidence.** The list is 15,766 source lines in 72 files with 37 test files (fact 17), and it is on
upstream's forkable list with a CI job that proves a copy builds (fact 18). Its collapse preference
defaults to the empty list, so groups start expanded (fact 21), and the group header is one function
in one file (fact 19). `experimental_threadList` is exclusive, replaceable, and automatically prefers
a non-bundled list, so installing the plugin replaces the sidebar and pinning
`sidebar.threadListProvider` puts the built-in one back (fact 23). Plugin storage, RPC and realtime
are plugin-scoped, so the fork neither reads nor publishes the bundled plugin's preferences
(fact 24).

**Rejected alternative: build a sidebar from scratch.** The list is a full sidebar already: pinned and
custom sections, three organization modes, sorting, drag to reorder and nest, windowed rows, inline
rename, keyboard jump shortcuts, split indicators, archive and thread action menus, provider icons,
draft presence, and 37 files of tests over that behaviour. Rebuilding it would re-earn all of it
before the first task row drew a state line, and the operator's answer was to fork (option A).

**Rejected alternative: keep the built-in list and decorate it.** `experimental_setThreadRowStatus`
sets status on a *thread* row, and the metadata line renders only under a thread's title (facts 20,
22). Neither reaches the group row that stands for the task, and a collapsed group shows no thread
rows at all, so the task's state would be invisible in exactly the state the operator wants as the
default. Collapse-by-default per task is also not something the host offers: the preference is one
global list (fact 21), and flipping its default would collapse every group, including non-Nucleus
ones.

**Rejected alternative: a second BB plugin for the sidebar.** A separate plugin package would need
its own server entry and therefore its own socket connection, presence claim and RPC surface to read
Nucleus state. One plugin, one connection, one catalogue (decision 1) is the cheaper shape, and the
exclusive slot does not care which plugin owns it.

#### 5b. A Nucleus task group's header carries the task's state

**Recommendation.** A worktree group whose threads carry this plugin's `originPluginId` and whose
`environment.id` is a Nucleus task handle renders one state block on the header row:

- **line one:** `#<task-number> <task title>`, truncated, with the number as the link target for the
  task (the board's task detail, 5d);
- **line two:** the task's state from the shared title helper — phase label, then whichever of hold,
  wait, stop or attention applies (`shared/task-state.ts` via `phaseStateLabel`/`taskStateLabel`,
  which the Paseo client already reads, so the two hosts name a state the same way);
- **line three, when the task has them:** the PR number from the card's `prUrl`/`completionPrNumber`,
  and the recorded wait that says what the task is waiting for (`Waiting for QA capacity (position
  N)`, `Merge hold`, `Needs operator input`);
- the rolled-up agent-status glyph upstream draws while the group is collapsed stays, from
  `experimental_resolveThreadStatus` over the group's hidden threads;
- upstream's controls stay: the toggle chevron, inline rename, the new-thread button and the overflow
  menu.

A Nucleus task group is **collapsed by default** and an operator's explicit expand persists in the
plugin's own preference (`expandedTaskGroups`), so a group is expanded exactly when its environment
id is in that list. Upstream's `collapsedEnvironments` keeps governing every other group, and the two
never disagree because each group class reads exactly one of them.

Non-Nucleus groups are byte-identical upstream behaviour: the same header, the same actions, the same
collapse preference, no extra line and no extra read. A group whose environment is not in the read —
unknown, archived, or a read that has not landed — renders exactly upstream. Failing to upstream's
row is the right degradation: a task's state line is an addition, never a precondition for the
sidebar drawing.

**The data comes from one batched keyed read, not one call per group.** A new method on the plugin's
existing RPC catalogue, `bb.sidebar-groups`, returns one bounded projection:

- `groups[]` — for every live task whose workspace handle records a BB environment id: the
  environment id, the task id, number, reference, title, phase, held/blocking hold, wait state, stop
  kind, `prUrl`, `completionPrNumber`, the recorded resolution/attention flags, and the label strings
  the sidebar draws;
- `threads[]` — the thread ids Nucleus knows per Nucleus project: its planner thread, its named-agent
  threads, and each task's role threads with their environment id, for 5d's tab visibility.

It is a projection of records the adapter already owns (the workspace handles) and the board
projection the service already serves, so it reads no forge, no Git and no thread timeline. The
sidebar joins it to `experimental_useSidebarThreads`' rows by `environment.id`, which every row
already carries (facts 20, 24), so no per-thread metadata read happens and an unknown group costs
nothing. Live updates ride the board signal the plugin already forwards: the sidebar refetches this
one read when it arrives, so a task that starts, needs input or merges updates its header without a
poll, and the read stays bounded by the live task count.

**Evidence.** A sidebar row already carries the environment id, project id, plugin origin, host
status, runtime status, queued work, pending interaction, activity and the resolved indicator with its
accessible label (fact 20), so the group join needs no new read and the roll-up glyph needs no new
data. The roll-up in upstream shows only while collapsed and only when a hidden thread has an
indicator (fact 19), which is exactly the collapsed-by-default case. The labels come from the shared
helper the Paseo client and the board already use, so the sidebar and the board cannot drift
(`shared/task-state.ts`).

**Where the state comes from, and where it stops.** The header draws only facts the service
publishes. Per-check CI state and per-task QA run state are not on the board card today: a task's
validation and merge stage is its phase and its recorded wait, and the QA runs the board carries are
keyed per repository and selector, not per task (`shared/schema/state.ts`, `shared/schema/qa.ts`). So
the header says `Reviewing`, `Verifying`, `Merging`, `Waiting for QA capacity (position N)` or
`Merge hold` rather than inventing a check list, and the sidebar never calls GitHub or the forge. When
the service later publishes check state on the card, the header adds one field and no new read.

**Rejected alternative: read the task's identity from the threads' plugin metadata.** It is the same
durable key adoption uses (decision 6), but it costs a metadata read per candidate group and it is
not live: a task's phase changes far more often than its metadata. The environment handle is already
the join, and the board signal already carries the state.

**Rejected alternative: draw the state line under each role thread's title.** That is where the
metadata line lives (fact 22), and it is invisible while the group is collapsed, which is the default.

#### 5c. The global board is a `navPanel` in the left rail, with an attention badge

**Recommendation.** The shared board in `client/shell/` renders inside a BB `navPanel` (id
`nucleus-board`, path `board`), calling the service through the plugin's `bb.rpc` handlers, which
forward the existing RPC catalogue over the socket exactly as the Paseo bridge does. The panel is a
navigation destination in BB's left rail, because the bundled Navigation plugin's rail is the default
layout and every registered panel is an entry in it (fact 25). Its `experimental_useBadge` returns the
count of items that need the operator — tasks in `needs_attention`, `blocked`, `error`, an escalated
hold, or a pending question — with the `warning`/`critical` tone BB expects and a `label` naming what
the count is. The route takes sub-paths (`/plugins/nucleus/board/<sub-path>`, fact 25), so a deep link
into a project's board works.

Nucleus's Settings render in a `settingsSection` (and from the board). BB's lifecycle events
(`thread.*`, `interaction.pending`) forward as the existing bounded lifecycle hints, so a task's board
state follows a thread that starts, stalls or needs input without a poll. Decision and native-question
pills are composer customizations: an `actions` pill per asking agent while it has an open decision,
and a pill that opens the task's native question. A Nucleus-raised question that must block a thread
is a plugin interaction rendered by the `pendingInteraction` slot.

**Evidence.** `navPanel` is a titled, routable screen with its own sidebar and an optional badge hook,
`settingsSection` hosts a settings component, `composer.customize` takes `actions`, `banners`,
plus/send menus and popups, and `pendingInteraction` renders a plugin interaction with
`submit`/`cancel` (fact 9, 25). The board and its Settings are already host-neutral behind
`client/shell/` (`BoardShell`, `BoardHost`), and the Paseo plugin forwards the RPC catalogue over the
same socket (Spec 013).

**Rejected alternative: a board-only surface with no in-thread pills.** It would drop parity with the
Paseo plugin, which is an operator requirement, and it would put a blocked question where the agent
is not.

**Rejected alternative: the board as a right-panel action tab only.** A rail destination is always
visible, carries the badge, and survives a thread being closed; an action tab exists only where it is
opened from.

#### 5d. The per-project board is a fixed thread tab plus a sub-path route

**Recommendation.** Two surfaces over the same filtered board:

- **a fixed thread-context tab** (`experimental_tab`, `context: { kind: "thread" }`,
  `availability: "fixed"`) on a Nucleus project's planner thread and named-agent threads, with
  `useVisible` true only for those threads, rendering the board filtered to that project;
- **a `navPanel` sub-path route** on the global board's panel, so a project's board deep-links and the
  forked sidebar's project and planner rows can reach it.

Both resolve the project through the same `bb.sidebar-groups` read 5b already needs: it names each
project's planner and named-agent thread ids, and the tab's own props carry the thread id and its
environment (fact 26). A tab is one registration and one `useVisible`; the board component is the
same one the rail renders, with a project filter.

**The route key is the Nucleus project id, not a BB project id.** A Nucleus project spans one or more
repositories (Spec 027), and the adapter registers one BB project per repository root (decision 2), so
a BB project id would show one repository of a multi-repository project and call it the project. The
sidebar's BB project rows and planner rows resolve a BB project or a planner thread to its Nucleus
project and link to `/plugins/nucleus/board/project/<nucleus-project-id>`.

**Task-role threads get a tab too.** A Nucleus task's worker and support threads get a fixed
`Task` tab showing the board's task detail (`client/task/`), visible when the thread's environment is
a live task handle. The operator spends the day inside role threads, and the group header is in the
sidebar, not in the pane; the task detail is already written and host-neutral, so the marginal cost
is one registration and the same join. This is the answer to whether role threads get a task detail
surface, and it is yes.

**Evidence.** A tab's context is exactly a thread or a nav panel (fact 26); a nav panel's route takes
sub-paths and its `subPath` is the route remainder, so `project/<id>` deep-links (fact 25). The
sidebar's live rows already carry each thread's environment and project, so both visibility hooks
resolve from one read (facts 20, 24). The board is already filterable by project in the shared shell.

**Rejected alternative: one tab on every thread in the workspace, filtered by the thread's project.**
A project board on a random task thread says nothing about the task in front of the operator, and it
would appear on threads Nucleus does not own.

**Rejected alternative: reach the per-project board only from the rail.** The operator asked for the
planner's board where the planner works; a rail-only board loses the in-thread place it is looked for,
and it makes the forked sidebar's project row the only path to it.

**Rejected alternative: a task tab on every role thread but no project tab.** The reverse of the
trade: the project board is where a planner dispatches from, and it would keep needing a navigation
away from the thread it was asked about.

#### 5e. Usage in BB is BB's own card, forked once for Spec 059's pace

**Recommendation.** Drop the Nucleus mini gauges in BB entirely (Tom, 2026-11-16: BB's card "provides
useful information and more than the mini gauges do"). BB's bundled `provider-usage` plugin already
draws a sidebar-footer card and a settings page with each provider's windows, percents, reset times and
plan labels (fact 27). The one thing it lacks is Nucleus's pace, so Nucleus forks that plugin the same
way it forks the list, adds the pace, and publishes Grok usage as a source so the card can show the one
subscription BB has no source for. Nucleus's full Usage screen stays on the board.

**The fork is its own BB plugin.** The card is a display plugin: it reads sources over
`experimental_discoverRpc` (fact 28) and needs neither the adapter's socket nor the board, and the
operator has to be able to install it and disable `bb--provider-usage` (fact 27). So it is a second
plugin package beside the adapter's — `hosts/bb/usage-plugin/` — vendored with the same routine as the
list fork: one pinned commit for both trees, one copy procedure, one `UPSTREAM.json` entry per tree,
one drift test and selector covering both, one `PATCHES.md`, one MIT section. `plugins/provider-usage`
is on upstream's forkable list, MIT, and 2,936 lines with five test files, so the copy is held to the
same promise the list's copy is (facts 27, 18).

**The patch set is five seams**, each a `.patch` under `hosts/bb/usage-plugin/patches/`:

1. `server.ts` — compute the projection once per window and once per provider from
   `shared/usage-projection.ts`, add the pace facts to the snapshot it serves, and fall back to the
   source's own label for a provider BB's catalog does not carry (the Grok case below).
2. `usage-schema.ts` — the snapshot's window and provider schemas gain those fields (window length,
   elapsed fraction, pace percent, projected use at reset, pressure state, the short label and the
   one-line verdict).
3. `app.tsx` — the window row draws the pace marker on the bar at the window's elapsed fraction and
   reads `<n>% used · pace <p>%`; the provider heading carries the one-line verdict.
4. `settings.tsx` — the settings page shows the same marker, text and verdict, reusing the card's
   pieces where it already does.
5. `usage-source-contract.ts` — accept one additive optional field on a window, `startsAt`, for a
   source that knows its window start. It is consumer-side only: sources keep publishing upstream's
   shape, and one that omits it falls back to the length rules below.

Everything else stays upstream's: the card's layout, the footer disclosure, the machine and account
grouping, the catalog ordering, 80/95 colour thresholds, plan labels, shared-account hints, the
refresh cadence, the safety refresh on focus and `thread.idle`/`thread.failed`, and the settings page's
structure.

**The projection is one, and it is removed from the board only once.** The pace comes from the same
module the board and the Paseo row use: `projectUsage` over a window as
`{ usedFraction: usedPercent/100, windowSeconds, windowStartsAt, resetsAt }`, then
`projectedUseLabel` for `on track` / `+18% over` / `-30% spare` and `usageStateWord` for the state. Two
pure label helpers currently live in `client/usage.tsx`; the phase moves them into `shared/` and
re-exports them, so the service, the board and the fork's server produce identical strings rather than
three approximations.

**Window length.** BB's source contract gives `kind` (`five-hour`, `daily`, `weekly`, `custom`),
`usedPercent` and `resetsAt`, and no start or length (fact 30). The fork derives length in this order:

1. an optional `startsAt` from a source that sends one (seam 5), so `resetsAt - startsAt` is exact;
2. the kind: `five-hour` is 5 hours, `daily` is 24 hours, `weekly` is 7 days;
3. for `custom`, a recognised label: a label naming a month ("Monthly", "Month") is one calendar month
   before `resetsAt` in UTC, and one naming a year ("Annual", "Yearly") is one calendar year before;
4. otherwise the length is unknown, the window shows its percent and reset with no pace marker, and
   the verdict says the pace cannot be projected rather than guessing.

Tom's live window is the case that rules out a fixed table: OpenCode Go's monthly window arrives as
`{ "kind": "custom", "label": "Monthly", "usedPercent": 72, "resetsAt": "2026-12-05T17:24:37Z" }`, so
rule 3 makes its start `2026-11-05T17:24:37Z` and its pace `72 / elapsed`. A window whose reset has
passed counts as unused and a window with no usage counts as unused, both of which `projectUsage`
already does (Spec 059); below 5% elapsed it holds the neutral pace and projects no runout, which is
the same rule the board shows.

**Grok usage.** BB ships a Grok provider through its ACP plugin (`acp-grok`, "Grok Build") but no
plugin publishes Grok usage: `provider-usage.v1` sources come from provider-claude-code,
provider-codex and provider-acp, and ACP's covers only providers whose declaration sets
`usage: true`, which is `acp-opencode` alone (fact 31). Nucleus already reads Grok usage (Spec 059), so
the adapter plugin publishes it as a source of its own: `bb.rpc.register` of the copied
`usage-source-contract` with `experimental_discoverable: true` (the flag a source needs to be found,
fact 28), where

- `listResources` returns one `scope: "shared"` resource per Grok subscription from `usage.state`,
  with `providerId: "acp-grok"`, the pool group's id as the resource id, the reading's account identity
  as `accountKey` when it has one, and `label` naming the pool;
- `getResource` maps that subscription's windows to `usage.ok.windows[]`: `kind` from the Nucleus
  window (five-hour, daily, weekly, else custom), `label` from its name, `usedPercent` from the used
  fraction, `resetsAt` from the reading, and `model`/`cost` null. A reading that is unknown or
  unavailable is `error` with its reason — never `ok` with zeros, so the card's own "never show missing
  usage as zero" rule holds.

The Nucleus BB plugin is thus a usage *source* as well as the adapter, which is what the contract is
for: its README states that other providers "must explicitly implement the contract to appear in these
displays" (fact 30). One caveat the patch covers: the card takes a provider's display metadata from
BB's provider catalog filtered to `capability: "usage"`, and `acp-grok` does not declare that
capability, so without seam 1's fallback the card would label the provider `acp-grok`. Seam 1 makes the
card show the source's own label, and if BB later declares usage for `acp-grok` upstream the fallback
simply stops applying.

**The two copies never double-show.** Enabling both draws two footer items and two settings pages,
because each plugin registers its own. So the install step is: enable the fork, disable
`bb--provider-usage`. Nucleus never disables another plugin and cannot detect a disabled one (the
plugin list a plugin can read names loaded plugins and their published methods, not every install);
the plugin's settings copy states the step, and an operator who leaves both enabled can hide either
item in the footer's own customize menu.

**Evidence.** The card's aggregation path, its normalization to `{ label, usedPercent, resetsAt, cost }`
(which is why the patch carries length through the server), its window row and colour thresholds, and
the source contract's own text are facts 28–30. The catalog filter and `acp-grok`'s missing capability
are fact 31. `shared/usage-projection.ts` is pure over `{ now, windows }` and already exports
`projectUsage`, `projectUsageWindow`, `usageWindowElapsed` and `USAGE_DAMPING_ELAPSED`, and
`client/usage.tsx` already calls the same fraction "the bar's on-pace marker", so the marker is a port,
not a new idea. `plugins/provider-usage` is MIT and on the forkable list, like the list plugin
(facts 18, 27).

**Rejected alternative: add the pace upstream first.** Tom is not ready to contribute it without
testing it, and the patch workflow is the way to test it in his own sidebar (his call, 2026-11-16). The
patch set is small enough to upstream later, and 5f records that exit.

**Rejected alternative: keep the Nucleus mini gauges in the rail beside the card.** Tom's ruling is
that the card carries more than the gauges did, so two surfaces would duplicate one fact and the rail
would lose space to a weaker version of the same information.

**Rejected alternative: publish Grok usage by patching provider-acp.** That plugin belongs to BB: it
declares Grok's capabilities, and a `providerUsage: true` there would be an upstream change, not ours.
A Nucleus source needs no change to BB and appears in any display that aggregates sources.

**Rejected alternative: a Nucleus-only card that mimics BB's.** The operator's comparison was with
BB's own card: same shape, same grouping, plus one metric. A second, independently drawn card would
drift from BB's provider catalog, machine grouping and refresh behaviour, and re-earn 2,900 lines of
UI to add one number.

**Rejected alternative: project the pace in the card's client.** The client's window schema drops
`kind` in normalization (fact 29), so length inference would have to re-derive what the server already
had, and the board and the card would each carry a copy of the rules. The server has the source window
and the shared module, so the projection belongs there and the client only draws it.

#### 5f. What does not change, and the deferred exit paths

Decisions 1–4, 6 and 7 are unchanged and this amendment does not reopen them. The forks add no host
operation, no workspace fact, no reporting route and no thread presentation: they read records the
adapter and the board already own, and they draw a task's state one level up from the row decision 4
already titles. Decision 4's worker title keeps carrying the step; the group header repeats it where a
collapsed group needs it, which is presentation of the same fact, not a second one. The usage fork
changes no Nucleus read either: it consumes the source contract and the shared projection.

Both forks are a means, not a goal, and both have the same exit. **Option B — an upstream extension
point** (a group-row metadata slot whose data is per environment, and a collapse hint a list can supply
per group) — would replace the list fork and delete its patch set, and the pace marker is a candidate
to upstream once Tom has tested it. Tom takes that upstream himself, later; until it exists, the forks
are how the requirements are met, and each patch set stays small enough that an upstream slot can
absorb it.

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
prove in phase 0 before phase 6 includes it; if it does not appear where an operator expects, it is
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

Every surface below carries an `experimental_` prefix unless its row says otherwise — the
`provider-usage.v1` contract and the provider catalog read are versioned by their owners, not prefixed.
Each row names what breaks if it changes.

| Experimental API | Why the design needs it | What breaks if it changes |
| --- | --- | --- |
| `bb.server.experimental_dataDir` | Host identity (`bb:<hash>`) and the data-directory probe | Identity refuses by name and the host stays offline; the fallback is to derive identity from the machine host record and version, which is weaker, so the phase-1 probe must fail closed instead |
| `threads.experimental_listPluginMetadata` | Adopting a thread after an uncertain spawn, in one chunked read | Adoption falls back to per-thread `threads.getPluginMetadata`, which is the same exact identity one call per candidate; if that is also missing, the uncertain spawn stays unknown with nothing bound and no retry |
| `threads.experimental_listAncestors` | Proving a role thread's planner before reparenting or archiving | Reparenting reads the parent link per thread instead; a deeper planner chain is then unproven |
| `threads.experimental_listCascade` | Proving an archive would touch only this task's own threads | Archive fails closed with no substitute: without the read there is no authoritative cascade proof, so the thread is left unarchived and closeout records the cleanup as incomplete. A sidebar child count or a list absence never stands in for it |
| `composer.customize` `experimental_popups` | A pill's popover content | Pills fall back to host-rendered menus and the board opens the same action |
| `slots.experimental_threadList` | **Used by the fork.** It is the only way to own the sidebar, and it is exclusive: the plugin registers one list and the host prefers it over the bundled one | The plugin cannot draw the sidebar: phase 5 is blocked, and the operator's fallback is pinning the bundled list (`sidebar.threadListProvider`) with the task state living only on the board. The exit is the upstream group-row slot in 5f |
| `slots.experimental_tab` with `context: { kind: "thread" }` and `useVisible` | The per-project board tab and the task-detail tab (5d) | Both in-thread boards are dropped and the per-project board stays reachable only from the rail; nothing else in the design depends on it |
| `navPanel.experimental_useBadge` (and `experimental_usePageTitle`) | The rail badge for items needing the operator, and the panel title naming a project | The badge is dropped and the board's own attention count is the fallback; the title falls back to the panel's static title |
| `experimental_useSidebarThreads` | The whole live row view the forked list draws: status, runtime status, queued work, pending interaction, activity, indicator and label, environment, project, plugin origin, pinned/archived/unread | No live row data. The fork falls back to the browser SDK's `threads.list` plus its own polling, which loses the host's resolved indicator, draft and queued-message state, and the environment fields the task-group join uses |
| `experimental_resolveThreadStatus`, `experimental_ThreadStatusGlyph` | The roll-up glyph and the host's own precedence rules (attention before work) | The header draws Nucleus's own state word instead and the rolled-up agent glyph the requirement keeps is missing until a patch reproduces it |
| `experimental_useSidebarThreadSplit` (`useSidebarSplitLayout`) | The split mini-map on a row, and the split indicator on the group | The split affordance on rows is dropped; split drag itself still works from the panes, so the loss is presentation |
| `experimental_ThreadActionsContextMenu`, `experimental_ThreadActionsMenu`, `experimental_useThreadActions`, `experimental_useThreadActionRegistrations`, `experimental_THREAD_ACTION_GROUPS` | Row context menus and the thread action registry | Rows lose the host and other plugins' thread actions; the fork would render a host-independent menu, and Nucleus's own verbs stay reachable from the board |
| `experimental_ThreadRowMetadata` | Other plugins' metadata line under a thread title (PR status and similar) | Thread rows lose other plugins' metadata; the task group header is the fork's own render and is unaffected |
| `experimental_useArchiveEnvironmentThreads` | The group header's archive action | The archive item leaves the group menu. Nucleus archives role threads itself (decision 4) and never archives a group it did not create, so no Nucleus behaviour depends on it |
| `experimental_useExperiment("threadRowMetadata")` | Upstream's gate on other plugins' metadata line, which the fork inherits by not patching that path | Other plugins' metadata line stops drawing until a rebase adapts it; the task group header is the fork's own render and needs no change |
| `experimental_Icon`, `experimental_ProviderIcon`, `experimental_useProviders`, `experimental_usePluginId` | Row icons, provider glyphs, the provider catalog and the plugin's own id (the task-group join's origin test) | Icons fall back to a static set and provider glyphs to a name; the plugin id is available from the manifest, so the join survives |
| `experimental_setThreadRowStatus` | Deferred; not used by this plan | Nothing here. The fork draws its own rows, so no host row-status write is needed. A replaced list is still expected to keep honouring `useSidebarThreadRowStatus` (fact 23), which the fork does by not touching that path; if option B lands, this is the slot's replacement for a group-level hint |
| `experimental_sidebarFooter` (disclosure) | The forked card's own mount: BB's footer disclosure is how `provider-usage` draws its card, and the fork inherits it unchanged | The card has no mount. Nothing else in the design uses the footer, so the loss is the card alone; the board's Usage screen stays |
| `bb.sdk.plugins.experimental_discoverRpc` and `bb.rpc.register`'s `experimental_discoverable` | The card finds its sources; the Nucleus BB plugin is itself a source for Grok | A source that cannot register discoverably is invisible to the card, so Grok's usage would have no surface (5e). The card's own rows keep working for the providers BB publishes |
| `provider-usage.v1.listResources` / `provider-usage.v1.getResource` | **Used twice:** the fork's card consumes them, and the Nucleus BB plugin publishes them for Grok (5e) | The card's other sources keep working through their own copies of the contract, but Grok's usage disappears from BB until a later BB release publishes it (fact 31). The contract is owned by the card's plugin and copied into each source, so a change is a copy-and-patch step, not a negotiation |
| `bb.sdk.providers.list({ capability: "usage" })` | The card's provider display metadata and ordering; `acp-grok` is absent from it, which is why the fork's fallback exists (5e) | A provider without a catalog entry shows its raw id; the fork's fallback covers Grok, and a missing capability elsewhere is a display-name loss, not a data loss |

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

### Phase 5 — the forked sidebar and the task group header

**Outcome.** The plugin owns BB's sidebar. `plugins/thread-list` is vendored at the pinned release
commit inside the plugin package under its recorded patch set, with the MIT notice in place; the
plugin registers the list through `experimental_threadList`; a Nucleus task group renders collapsed
by default with its header state line, an explicit expand persists, and every other group behaves
exactly as upstream. The vendored-manifest test and the drift selector exist so the next rebase is
mechanical and a stray edit to a vendored file fails a test instead of surviving review.

**Acceptance.**

- The vendored-manifest test proves every file under the plugin's vendored tree and every vendored
  registry module is byte-identical to its recorded SHA-256 or named in `PATCHES.md`, that the
  recorded SDK floor is at or below the pinned release's SDK, and that `plugins/thread-list` is still
  on upstream's forkable list at the pin.
- `effigy bb:sidebar-drift` reports no drift at the pin, and the selector is absent from
  `effigy check` (it needs the network).
- The fork's own test files for the paths the patch set does not touch pass unchanged, including the
  group disclosure, the section and thread drag-and-drop, keyboard shortcuts, inline rename and the
  row action menu (`ProjectThreadTree.disclosure.test.tsx`, `useSectionThreadDnd.test.ts`,
  `ThreadRow.test.tsx`, `SidebarInlineRename.test.tsx`, `ThreadRowActionsCustomize.test.tsx`).
- A test proves a Nucleus task group renders collapsed with the number and title, the state label from
  `shared/task-state.ts`, the PR number when the task has one, and the collapsed roll-up glyph; that an
  explicit expand is written to `expandedTaskGroups` and read back on a fresh mount; and that
  `collapsedEnvironments` is never written for a task group.
- A test proves a non-Nucleus group renders upstream's header with no state line and no call to the
  header read, and that an unknown, failed or not-yet-landed read renders upstream's header rather
  than blocking or blanking the sidebar.
- A test proves the header read is one call for many groups (no per-group request), that it is
  refetched on the board signal, and that no forge, Git or timeline read leaves the adapter.
- `bb plugin build` succeeds and the built plugin installs into the isolated BB server from phase 0;
  the list is selected automatically, pinning `sidebar.threadListProvider` restores the bundled list,
  the New-thread button, rail and footer stay host-rendered, and the row-status path another plugin
  writes still draws (fact 23).
- `effigy check`, `effigy qa:docs` and `effigy test:affected --run`.

**Dependencies.** Phases 0–4: the plugin package and its transport, the workspace handles phase 2
records, and live tasks from phase 3 give the header something real to read.

**Deferred exit path.** Option B — an upstream group-row metadata slot (per-environment data) plus a
collapse hint a list can supply per group — would replace this phase's fork and delete the patch set,
keeping the header read and the tenure of the requirement. It is not scheduled; it is the exit that
makes the fork a bounded commitment (5f).

### Phase 6 — board, per-project board, settings, pills, usage and the planner terminal

**Outcome.** Operator parity in BB: the shared board in a `navPanel` with its attention badge in the
left rail, the same board per project in a fixed thread tab and a sub-path route reachable from the
forked sidebar's project and planner rows, a task-detail tab on a task's role threads, Settings in a
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
- The rail badge counts the tasks that need the operator from a synthetic snapshot, carries its tone
  and label, and drains as they settle.
- The per-project tab is visible on a Nucleus project's planner and named-agent threads and nowhere
  else, and filters the board to that project — including a multi-repository project, which shows
  every repository, not one.
- The sub-path route deep-links to a project's board and the forked sidebar's project and planner rows
  link to it; the route key is the Nucleus project id.
- The task-detail tab appears on a task's worker and support threads and nowhere else.
- The terminal command creates one thread-scoped terminal in the calling thread and nothing else; a
  test proves the task-directory variant is absent when phase 0 did not prove it.
- A test proves no settings write, no lifecycle-owner write and no terminal read ever leaves the
  adapter.
- `effigy check`, `effigy qa:docs` and `effigy test:affected --run`.

**Dependencies.** Phases 0–5.

### Phase 7 — usage in BB: the provider-usage fork, the pace and the Grok source

**Outcome.** BB shows usage from BB's own card, forked at the pinned commit and patched with Nucleus's
pace: a marker on each window bar, `<n>% used · pace <p>%`, and a one-line verdict per account on the
card and on the settings page, from the shared `shared/usage-projection.ts` under Spec 059's rules. A
custom window gets its length from `startsAt`, its kind or a recognised label, and otherwise reports no
pace. Nucleus's BB plugin publishes Grok usage as a `provider-usage.v1` source (`providerId`
`acp-grok`) so the card shows the one subscription BB has no source for, and the board's Usage screen
stays the full view, reading the same projection. The second fork carries its own pin entry, patch set
and MIT notice under the routine phase 5 built.

**Acceptance.**

- The pace marker sits on the window bar at the window's elapsed fraction and reads `<n>% used · pace
  <p>%`; the account verdict reads `on track`, `+N% over` or `-N% spare` from `projectedUseLabel`, and
  both appear on the card and the settings page.
- A test pins the projection agreement: one synthetic source snapshot produces identical pace, state
  and label text through the fork's server and through the board's Usage view, and a window below 5%
  elapsed projects no runout.
- The custom-window rule is tested for all four paths: an exact `startsAt`; `five-hour`, `daily` and
  `weekly` from `kind`; `Monthly`/`Annual` labels as one calendar month or year before `resetsAt`; and
  an unrecognised label reporting no pace with its percent and reset still shown. Tom's OpenCode Go
  example (`{"kind":"custom","label":"Monthly","usedPercent":72,"resetsAt":"2026-12-05T17:24:37Z"}`)
  is one of the fixtures.
- A Grok resource appears in the card with the fork's pace, published by the Nucleus BB plugin with
  `providerId: "acp-grok"` and `experimental_discoverable: true`; a reading that is unknown or
  unavailable maps to `error` with its reason and never to `ok` with zeros; and the card labels it with
  the source's own label rather than `acp-grok`.
- A test proves enabling the fork and disabling `bb--provider-usage` leaves exactly one card, that the
  fork's settings copy states the install step, and that the fork never disables another plugin.
- `effigy bb:sidebar-drift` covers both vendored trees and reports no drift at the pin; the
  vendored-manifest test fails if a file in either tree is neither byte-identical nor named as patched,
  and if either tree's SDK floor exceeds the pinned release's.
- The vendored card's own test files for the paths the patch set does not touch pass unchanged,
  including the aggregation, the account grouping and the footer disclosure.
- `effigy check`, `effigy qa:docs` and `effigy test:affected --run`.

**Dependencies.** Phases 0–5: the plugin package, the fork routine and its drift test, and the
service's `usage.state`. It runs beside phase 6.

### Phase 8 — trial and parity call

**Outcome.** One repository opts into BB and runs real tasks through it beside Paseo, through
milestone QA's own runs; the open questions this spec leaves are answered from that evidence and
written back into this document.

**Acceptance.**

- A written parity table against the Paseo plugin for the sidebar and its task groups, the global
  board, the per-project board, settings, decision pills, native question pills, the usage card with
  Nucleus's pace, Grok's usage and lifecycle hints, each marked met, met by a different mechanism, or
  missing with the reason.
- Evidence for plugin reload mid-task, BB restart mid-task, and a host outage during observation:
  each leaves the task uncertain and recovered by observation, never resent and never read as idle.
- Evidence for one fork rebase against a newer BB release tag through the documented routine, with
  the drift report and the vendored-manifest test at the new pin.
- The operator's call on whether BB becomes a supported host (Tom; this phase records it, it does
  not assume it).

**Dependencies.** Phases 0–7.

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

The vendored sidebar is checked twice, and neither check reaches the network from `effigy check`: the
vendored-manifest test is an ordinary unit test over committed files, and `effigy bb:sidebar-drift` is
the opt-in fetch that compares the pin against upstream and opens a rebase.

The usage fork is tested the same way, from a recorded source snapshot rather than a live provider:
one fixture serves the card's aggregation, the projection and the pace rendering, so the pace a test
sees is the pace the card draws. The agreement test runs the same snapshot through the board's Usage
view, which is what keeps one projection rather than two.

Proof selectors: `effigy proof:bb` for the private run, `effigy bb:sidebar-drift` at a planned rebase,
the affected unit files for each phase, and `effigy check` plus `effigy qa:docs` for every phase. No
phase runs the full suite; milestone QA does that on `main`.
