# BB host adapter

Status: approved. Phase 0 (the transport spike) is implemented and proved, phase 1 (host
registration, identity and health) and phase 2 (workspace custody) are implemented; phases 3–6 are not implemented. This document is the design and the phased plan, and [phase 0
evidence](#phase-0-evidence-2026-11-16) answers its eight assumptions. Amended 2026-11-16: decision 5
now carries the forked sidebar, the two boards and BB usage left to BB's card plus the operator's Usage
Pace plugin, and the experimental inventory and the plan from phase 5 on follow it; phases 0–4 are
unchanged.
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
- **community** — a third-party plugin read at its own commit: `chug2k/bb-plugin-usage-pace`
  `8e3e06da`, cloned 2026-11-16, plus its open issue and BB's contract beside it. A community
  plugin is not a dependency, and its facts carry a date for that reason.

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
| 31 | None of the bundled sources publishes Grok: they are provider-claude-code, provider-codex and provider-acp, and ACP's covers only providers whose declaration sets `usage: true` (from `providerUsage` on the agent), which is `acp-opencode` alone. `acp-grok` ("Grok Build", `known-agents.ts`) sets no `providerUsage`, so it publishes no resource and earns no `capability: "usage"` catalog entry | upstream |
| 32 | `chug2k/bb-plugin-usage-pace` is MIT, 0.2.4, `engines.bbPluginSdk: ">=0.5.9"`, about 7,100 lines including tests, and decorates BB's card rather than replacing it: an even-pace tick and a red difference band on each window bar, hover lines with the delta and the time without quota, no projection below `MIN_ELAPSED_FRACTION = 0.05`, a custom "Monthly" window read as one calendar month before its reset in UTC, an optional footer strip and a dialog, and a `provider-usage.v1.listResources` source for Grok Build. It is itself a fork of Usage Bar (Dmitrii Kapustin, MIT), and its Grok usage comes from MacHatter1's Grok Build Usage (MIT); its README states that a change to the card's markup stops the tick and delta and breaks nothing else | community |
| 33 | Usage Pace 0.2.4's card integration posts `{ force: false, machineIds: null, providerId: null, maxAgeMs }` to `bb--provider-usage`'s `getUsage`, while BB 0.49's contract is the strict object `{ force, machineIds, providerIds: string[], maxAgeMs }` (`provider-usage` server, `usage-source`), so BB rejects the call and the tick, red bands and hover lines do not appear on 0.49 while the Grok tab and the CLI still work; the report is `chug2k/bb-plugin-usage-pace#2`, and a locally patched copy is the operator's workaround | community, upstream |

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
composer pills, and a `pendingInteraction` for a Nucleus-raised blocking question. Nucleus adds no
usage UI to BB at all: glanceable usage is BB's own card plus the operator-installed Usage Pace plugin,
and the full usage screen stays on the board (5e).

The parts below are decisions, not options: 5a and 5b are the sidebar work, 5c extends the board
phase, 5d is the per-project board the operator asked for beside the global one, 5e is usage (BB's card,
not ours), and 5f records what does not change.

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
- **line three, when the task has them:** the PR number from the card's `prUrl`/`completionPrNumber`
  with its state — `OPEN`, `CLOSED` or `MERGED` from the board's own `prStates` record, which the
  service refreshes for every task that has a PR and no merged commit (`core/forge/pr-status.ts`) —
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
  kind, `prUrl`, `completionPrNumber`, its `prStates` entry, the recorded resolution/attention flags,
  and the label strings the sidebar draws;
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

**Where the state comes from, and where it stops.** The header draws exactly the facts the service
publishes in the snapshot it already reads: the task's phase, holds, waits and stop, and its PR number
with its PR state by task id (`prStates`, `shared/schema/state.ts`). It draws no QA row: the QA runs
the board carries are keyed per repository and selector rather than per task
(`shared/schema/qa.ts`), so the task's validation and merge stage is its phase and its recorded
wait.

**One stated departure from the brief's list: CI check conclusions.** The brief asks the header to
carry checks; the service publishes no per-task check conclusion — the merge gate reads check state
live from the forge at merge time, and the only check facts a task records are merge-time exceptions
(`resolution.forcedChecks`). The header therefore names the stage and the wait the task is in
(`Reviewing`, `Verifying`, `Merging`, `Waiting for QA capacity (position N)`, `Merge hold`) instead of
inventing a check list, and the sidebar never calls GitHub or the forge. Adding a live check read from
the sidebar would put a second, unbounded forge client in the UI and let it disagree with the merge
gate, so it is not done here. When the service publishes check state per task, the header adds one
field from the same read and nothing else changes.

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

#### 5e. Usage in BB: BB's card plus the operator's Usage Pace plugin

**Recommendation.** Nucleus contributes **no usage UI** to BB — no rail block, no forked card, no usage
source of its own (Tom, 2026-11-16: "usage pace is enough I think"). Glanceable usage in BB is BB's
bundled `provider-usage` card (fact 27) plus the community plugin **Usage Pace**
(`chug2k/bb-plugin-usage-pace`, MIT), which the operator installs beside it. Nucleus's full usage
screen (Spec 059, dial and verdict) stays on the board, and the two surfaces answer different questions:
the card answers "am I about to run out", the board answers "what is the whole picture".

**What BB's card already shows.** A sidebar-footer disclosure with each provider account's plan, and per
usage window a bar, the used percent, the reset time and a cost when the source reports one, from
whichever source plugins implement `provider-usage.v1` (facts 27–30). It has no pace.

**What the operator's plugin adds.** Usage Pace decorates that card rather than replacing it: a tick at
even pace on each window bar, the difference coloured red when usage is ahead of pace, and hover lines
naming the delta and the time without quota ("17% ahead of pace (1d 4h)", "runs out Sun 00:03 · 2d 15h
without quota"). It projects no pace in the first 5% of a window (`MIN_ELAPSED_FRACTION = 0.05`), treats
a custom "Monthly" window as one calendar month before its reset with UTC month arithmetic, publishes
Grok Build usage so the card gains that row, and adds an optional footer strip and a dialog. The thread
records that its numbers match the board's pace to within a point or two, and it is a fork of Usage Bar
by Dmitrii Kapustin with the Grok usage from MacHatter1's Grok Build Usage plugin, both MIT (fact 32).

**It is a recommendation, not a dependency.** Nucleus works on BB with or without it: the card is BB's,
Usage Pace only adds nodes to it, and nothing in Nucleus reads either. A new BB install gets the card and
no pace until the operator installs the plugin; a repository that opts into BB needs nothing from it.

**Known risk, recorded with its evidence.** Upstream 0.2.4 does not show its pace on BB 0.49: BB changed
`bb--provider-usage`'s `getUsage` input to require `providerIds: string[]` in place of `providerId`, and
the plugin still posts `providerId: null` to a strict input object, so BB rejects the call
(facts 29, 33). The failure is narrow and stated by the plugin itself and by its issue: the card keeps
working, the tick and the delta stop showing, and the Grok tab and the CLI still work. The fix is
reported as `chug2k/bb-plugin-usage-pace#2`; until it lands, the operator runs a locally patched copy.
Nucleus neither vendors nor patches that plugin: a plugin we do not own is not a fork obligation, and
its degradation is BB's card minus one metric.

**One projection, and it is the board's.** The pace Nucleus states is `shared/usage-projection.ts` behind
`usage.state`, which the board's Usage screen and the Paseo row draw (Spec 059). Usage Pace has its own
implementation of the same idea, which the thread records as agreeing within a point or two; the
difference that matters is that Nucleus's keeps Spec 059's rules (every pool profile keeps its gauge, a
reset window counts as unused, no projection early in a window) while the card's shows BB's providers.
Because Nucleus adds no BB surface, there is no second copy of the projection to keep in sync — and if
exact agreement is ever wanted, it belongs to the community plugin as an upstream proposal, not to a
Nucleus fork.

**Evidence.** The card's registration, aggregation, normalization and thresholds are facts 27–30,
re-verified at the pinned commit; BB's Grok provider publishes no usage and none of the bundled sources
covers it (fact 31); the community plugin's licence, structure, pace rules and Grok source are fact 32,
re-verified at its own commit; and the 0.49 breakage is fact 33, verified from BB's side and from the
plugin's open issue. The change itself is Tom's ruling, quoted above, not a technical claim of this
spec's: the evidence below it is what makes the ruling implementable.

**Rejected alternative: fork `plugins/provider-usage` to add the pace.** It was the previous draft and it
is withdrawn: the community plugin already draws the pace on that card, so a fork would maintain a second
copy of one metric, pin a second upstream tree with its own patch set and drift check, and own a
projection that is not Nucleus's. "Usage pace is enough" — and Usage Pace supplies it.

**Rejected alternative: publish a Nucleus `provider-usage.v1` source for Grok.** Also withdrawn. The
contract is designed for it (fact 30) and BB's bundled sources do not cover Grok (fact 31), but Usage
Pace already publishes that row from MacHatter1's plugin, and a second source for one account is exactly
the duplicate the card's account-key deduplication exists to prevent. A Nucleus source would also mean
Nucleus contributing the usage UI this decision rules out.

**Rejected alternative: keep the Nucleus mini gauges in the rail.** Dropped: the card shows more, and two
surfaces for one fact put a weaker copy where the operator reads the sidebar.

**Rejected alternative: vendor Usage Pace and ship it with Nucleus.** Adopting someone else's plugin
means owning its rebase against BB's card markup, its Grok source and its two upstream forks. The
operator installs it instead, and Nucleus keeps one fork instead of three.

#### 5f. What does not change, and the deferred exit path

Decisions 1–4 and 7 are unchanged and this amendment does not reopen them. Decision 6 keeps its
observation and adoption rules and loses only the `system.usageLimits` clause that served a BB Usage
page 5e no longer has. The fork adds no host
operation, no workspace fact, no reporting route and no thread presentation: it reads records the
adapter already owns, and it draws a task's state one level up from the row decision 4 already titles.
Decision 4's worker title keeps carrying the step; the group header repeats it where a collapsed group
needs it, which is presentation of the same fact, not a second one. The usage decision adds no surface at
all, so it changes nothing in the adapter.

The thread-list fork is the only fork, and it is a means, not a goal. **Option B — an upstream extension
point** (a group-row metadata slot whose data is per environment, and a collapse hint a list can supply
per group) — would replace the fork and delete the patch set. Tom takes that upstream himself, later;
until it exists, the fork is how the requirement is met, and the patch set is kept small enough that an
upstream slot can absorb it. Usage needs no such exit: there is nothing of ours to retire.

### 6. Usage and observation: chunked inventory, exact-identity adoption

**Recommendation.** Per-run usage comes from `threads.context`'s `usage` (tokens, context window,
optional cost) read on the run's finish path, with `thread/tokenUsage/updated` as the timeline
fallback; provider subscription windows come from `system.usageLimits`. The first draft fed a BB Usage
page with that read, and 5e removed that page along with every other Nucleus usage surface in BB, so
the adapter reads no subscription windows of its own and the board's Usage page keeps `usage.state`
(Spec 059). That clause is the one change this amendment makes to decision 6, and it is here because
the usage decision forces it.

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
after a read-only probe through the channel succeeds (`status.get`, `system.version`, one
`threads.list` and `hosts.list`, whose answer supplies the host ids the probe reports). Reconnecting must prove the same recorded data directory; a different one refuses
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

**Implemented (2026-11-16).** What landed, and where:

- the declaration now carries the identity proof: `service/transport/server.ts` asks a
  just-declared executor for `identity.probe` (`status.get`, `system.version`, one `threads.list`,
  `hosts.list`; every one a read) *before* it answers the declaration, validates the
  projection through `shared/service/host-channel.ts`, and hands the proved identity to the runtime
  (`bbHostVerified`). A probe that refuses, omits a field or answers a refused shape answers the
  declaration with `refused` and the field it names, and records that reason for health;
- `service/bb-host.ts` owns the durable identity (`bbHostIdentity`: the real data directory and its
  derived `bb:` id), the registry claim, the per-identity admission and breaker state, the release on
  a dropped connection and the health projection. A declaration naming a different data directory
  than the recorded one refuses by `dataDir` and takes the host offline: one service serves one BB
  host identity, so a moved data directory is a refusal, not a second host;
- `HostRegistry.primary()` names the Paseo entry and never falls back to whichever host registered
  first, so a BB host that registers before the daemon bootstrap never displaces the legacy
  unqualified `hostId` (health, the board and settings read it), the host states the health projection
  presents, the retired-observation scope, the admission resource or the daemon-identity guard — and
  never makes that guard refuse the Paseo connection that follows;
- a connection that closes between the identity proof and the registration is not installed: its
  link is released and the claim the runtime just recorded is retired, so nothing reads online for a
  connection that no longer exists;
- the work-host decision: a registered BB host counts as a live host for liveness, presence and
  health, and never as an available work host;
- `service.health` carries a `bb` block (the registered identity, the announced BB and plugin-SDK
  versions, the probe's host list, and while offline the field-prefixed reason) and lists the
  identity in `hosts` as online or offline with that reason;
- the registered adapter (`createBbHostAdapter`) declares BB's composition
  (`reportingViaMcp: false`, `lifecycleDispatch: false`, `supportsCoordinatorRecovery: true`,
  `perThreadEnvironment: false`, `repositorySharedWorkspaces: false`) and refuses every
  task-workflow call before send, so no dispatch reaches a task yet;
- `shared/host-kind.ts` learns the `bb` kind and the `bb:` prefix, the project editor offers it, the
  board card shows it, and `repository.set hostKind: "bb"` round-trips; a live task keeps the host it
  started on;
- the plugin requests the one `service.nucleus-bridge-presence` claim after its declaration and
  retries a refused claim on its retained connection; the plugin-lost fault names
  `bb plugin reload nucleus` when BB is the connected host;
- liveness is a heartbeat: the retained connection reads `service.health` on its own cadence (15 s), the
  service records `lastHeartbeatAt` for the identity it proved, and health reports
  `heartbeatStale` after 45 s without one. A late or missing heartbeat never closes the
  connection and never settles another operation — the T3 lessons this phase applies.

Tests: `test/bb-host-registration.test.ts` (probe, registration, health, refusal by field,
reconnect, drop), `test/bb-host-presence.test.ts` (the real plugin channel: declaration, presence
claim and retry, reload re-proving identity), the `bb` cases in `test/host-selection-provenance.test.ts`
and `test/repository-settings.test.ts`, and the updated `test/bb-host-channel.test.ts`.

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

**Implemented (2026-11-16).** The BB adapter registers or reuses the BB project for the canonical
repository root, then records a Nucleus-owned `bb-worktree-<40 hex>` handle for the canonical task
worktree in the durable Nucleus store. The handle reservation precedes project registration. If its
reply is unknown, a later create adopts only after a fresh exact-root project read; an empty or unreadable
read never authorizes a resend. Project inspection is a bounded read through the plugin SDK; workspace
creation calls no thread operation and stores no agent identity. Availability reads both the local
worktree and the exact registered project, and an unreadable project read propagates as unknown.
Archive writes only the handle's durable marker, so the unmanaged environment, shared project and
other task handles remain untouched. The socket service exposes the existing reverse operation channel
to the adapter through the authenticated owner socket; operation faults remain per request.

Tests: `test/bb-workspace-custody.test.ts` covers creation, handle identity, lookup, archive isolation,
missing directories, unregistered projects and unreadable reads; `test/bb-plugin-operations.test.ts`
covers project registration/reuse, read-only project inspection and zero `threads.spawn` calls; the
shared operation schemas and `test/bb-host-executor.test.ts` retain the bounded reply and unknown
delivery rules.

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
  group disclosure, the section and thread drag-and-drop, keyboard shortcuts, **split drag** (the pane
  drag from a row, and the group's split indicator and mini-map), inline rename and the row action menu
  (`ProjectThreadTree.disclosure.test.tsx`, `useSectionThreadDnd.test.ts`, `ThreadRow.test.tsx`,
  `SidebarInlineRename.test.tsx`, `ThreadRowActionsCustomize.test.tsx`).
- A test proves the header patch leaves the row's drag bindings and split props untouched, so a task
  group is still draggable and still opens in a split from the same gestures as an upstream group.
- A test proves a Nucleus task group renders collapsed with the number and title, the state label from
  `shared/task-state.ts`, the PR number and its `OPEN`/`CLOSED`/`MERGED` state when the task has one,
  and the collapsed roll-up glyph; that an explicit expand is written to `expandedTaskGroups` and read
  back on a fresh mount; and that `collapsedEnvironments` is never written for a task group.
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
Nucleus-raised blocking question, the board's own Usage view over `usage.state`, and lifecycle hints
forwarded from BB's events into the existing signal path. `bb nucleus terminal` ships
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

### Phase 7 — trial and parity call

**Outcome.** One repository opts into BB and runs real tasks through it beside Paseo, through
milestone QA's own runs; the open questions this spec leaves are answered from that evidence and
written back into this document.

**Acceptance.**

- A written parity table against the Paseo plugin for the sidebar and its task groups, the global
  board, the per-project board, settings, decision pills, native question pills, usage and lifecycle
  hints, each marked met, met by a different mechanism, or missing with the reason. Usage is recorded
  as met by BB's own card plus the operator's Usage Pace plugin — a host surface Nucleus does not own —
  with the board's Usage screen as Nucleus's full view.
- Evidence for plugin reload mid-task, BB restart mid-task, and a host outage during observation:
  each leaves the task uncertain and recovered by observation, never resent and never read as idle.
- Evidence for one fork rebase against a newer BB release tag through the documented routine, with
  the drift report and the vendored-manifest test at the new pin.
- The operator's call on whether BB becomes a supported host (Tom; this phase records it, it does
  not assume it).

**Dependencies.** Phases 0–6.


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
   list, so a planner looking at their thread does not see it. Phase 6 drops the task-directory
   `host_path` terminal and keeps the planner's native ⌘J tab plus the thread-scoped command, which
   phase 0 did prove: a thread-scoped terminal appeared in its own thread's list, with the thread's
   environment path as its initial working directory, and in no host list.

### Terminal scope

The same run answers the second acceptance bullet. A thread-scoped terminal belongs to its thread's
panel: it is created against the thread, requires that thread's environment, and is listed only under
that thread. A `host_path` terminal at a task worktree belongs to the host, not to any thread: it is
listed only under the host. An environment-scoped list showed neither. So the planner tab is the
planner's own thread-scoped terminal (⌘J needs no adapter work), and the task-directory convenience is
dropped from phase 6 unless a later BB release puts host-path terminals in a thread's panel.

### Corrections to the verified facts

Fact 4 said a thread-scoped terminal records `thread-archived` as its close reason. In the isolated
BB 0.49.0 server, archiving a thread left its terminal `running` with `closeReason: null`, and only an
explicit close recorded `user`. Phase 0 therefore closes the terminals it creates itself and reads no
terminal state as a lifecycle fact; decision 7's "a planner terminal is retired with the planner" claim
is not relied on, and phase 6 must re-check it before it does.

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

The vendored sidebar is checked twice, and neither check reaches the network from `effigy check`: the
vendored-manifest test is an ordinary unit test over committed files, and `effigy bb:sidebar-drift` is
the opt-in fetch that compares the pin against upstream and opens a rebase.

Proof selectors: `effigy proof:bb` for the private run, `effigy bb:sidebar-drift` at a planned rebase,
the affected unit files for each phase, and `effigy check` plus `effigy qa:docs` for every phase. No
phase runs the full suite; milestone QA does that on `main`.
