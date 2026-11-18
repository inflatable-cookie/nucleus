# BB host adapter

Status: approved. Phases 0–7 are implemented. Phase 0 (the transport spike) is proved, phase 1 (host
registration, identity and health), phase 2 (workspace custody), phase 3 (worker runs, observation
presentation), phase 4 (delivery, questions and the support roles), phase 5 (the forked sidebar and
the task group header) and phase 6 (the boards, settings, pills and the planner terminal) are in
place, and phase 7 records its parity table and evidence with the operator's parity call still
pending (see [phase 7](#phase-7--trial-and-parity-call)). This document is the design and the phased
plan, and [phase 0 evidence](#phase-0-evidence-2026-11-16) answers its eight assumptions. Amended
2026-11-16: decision 5 now carries the forked sidebar, the two boards and BB usage left to BB's card
plus the operator's Usage Pace plugin, and the experimental inventory and the plan from phase 5 on
follow it; phases 0–4 are unchanged. Amended 2026-11-17 (nucleus#1302): subscription usage leaves
Nucleus, so BB's card and the operator's plugins are the whole usage surface on either host. Amended
2026-11-17 (nucleus#1313): the parent link is conditional on the planner living on this BB host, it
follows a planner change, an explicit detach makes a task group standalone, and a project whose task
nests under another project's planner points at it instead of reading "No threads".
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

A Nucleus-created BB thread is parented to the task's planner thread **only when that planner lives on
this BB host** (decision 4, amended 2026-11-17 by nucleus#1313): a task whose planner is on T3, Paseo or
nowhere dispatches as a standalone top-level group, and questions still climb the task's real planner
ladder on its own host. Nucleus never sets `lifecycleOwnerThreadId` on any thread, so archiving a
planner never cascades into the task threads; it never archives or deletes a thread it did not create,
and never deletes a BB project.

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

Before any BB run attaches, Nucleus creates that run's recorded temporary directory with owner-only
permissions on the configured scratch volume. This includes workers, reviewers, coordinators and
recovery runs. BB cannot inject a per-thread environment, so the directory is prepared without
passing `TMPDIR` to the thread. Its namespace comes from `store.scratchNamespaceFor(task)`, the same
repository setting used by Paseo, instead of falling back to the global `nucleus` namespace.

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
coordinator and executor — in the task's worktree, each with `parentNotifications: "off"`. All are
visible. `parentThreadId` is set **only when the task's planner thread lives on this BB host** (Tom,
2026-11-17: "If a task is dispatched from a planner in BB then the task is nested under the planner
thread, otherwise it should be standalone in the sidebar"): the planner is the first rung the task's
questions climb — the planner the brief named, else its owner, else the project's planner — and a task
whose planner is on T3 or Paseo, or that has none, is created with no parent at all, a standalone
top-level group. The parent link is presentation only, so an off-host planner never changes a question
route: asks climb the task's real ladder on the planner's own host (amended 2026-11-17, nucleus#1313). Every thread title names the task's full reference — the repository it works on plus its unpadded
number, `poodle-lab#29`, never a bare or padded number (Tom, 2026-11-17). While the worker is the
task's only thread its title is the shared `taskWorkspaceTitle` projection
(`Working: poodle-lab#29 <title>`) plus ` · ` and the step its role threads report, as T3Code's
row does; once the container holds a second participant the worker is named by role like the
others (`poodle-lab#29 worker: <title>`) and the phase lives on the container's state line alone.
The container is the task's **live** threads: an archived participant is no member, so a worker left
alone again by the superseded-participant archive returns to its phase-prefixed title (a fresh read
proves the row left the earlier title, so a settled title intent never blocks that return).
A support thread's title is `<reference> <role>: <title>`. Nucleus never sets
`lifecycleOwnerThreadId`.

BB has no settled state, so Nucleus implements neither `settleWorkerThread`, `settleReportedThread`
nor their reconcilers here. A released support thread simply stays in the planner's group; a task
that needs attention is shown by its worker row's step title, by BB's own pending-interaction
indicator and unread state, and by the board. Replaced attempts follow the existing lifecycle: a
superseded worker thread is archived as soon as its run is released and no live BB turn remains, and
so is every other superseded participant (nucleus#1313, Tom 2026-11-17, live trial: the container
listed four reviewer rows and a recovery row as though each were current). A role thread whose own run
is settled, which no task binding names any more and whose turn is proved idle is archived under the
same recorded-thread and cascade proofs; a live thread, one with a pending interaction, the planner and
the task's other threads are never touched. Archive rather than dim, because a dimmed row still looks
like a participant to the archive proofs. Reparenting a live task to another planner
thread writes `parentThreadId` on each of the task's threads under one durable intent per thread,
observation-first, never on the planner itself; a planner change to a thread on another host writes
`null` instead, the same write that clears the link. The `detach` owner verb (board, task row and
`nucleus helper detach`) records `presentationDetached` on the task — "no planner thread for
presentation" — and each host renders that as standalone, so a planner thread can be archived or
replaced without taking its tasks' threads with it; a reparent that names a planner clears the record
and re-nests the group (Tom, 2026-11-17: "We will also need the ability to detach a worker thread from
a planner in case the planner needs replacing"). At closeout Nucleus archives the task's role threads
and leaves them archived; it does not delete threads, so the planner's history stays readable.

An operator drag in BB is a separate, authoritative **presentation-only** parent choice. BB's
`experimental_thread.parentChanged` event carries the moved thread's new `parentThreadId`; Nucleus
records that parent on the task and reconciles every live task thread to it. A null parent detaches
the group, and a parent naming another BB thread nests it there. Dragging any one task thread moves
the whole group. Nucleus filters its own `threads.update` echoes before recording the event, never
reverts an operator choice, and spawns later task roles under the group's recorded parent. This
does not change the task's planner, ticket, authority or question route; planner changes remain the
`helper reparent` operation.

**Evidence.** The parent link already draws the group (fact 2), `threads.update` sets or clears it on
a live thread, and `parentNotifications: "off"` keeps BB's own wake-ups out of a planner that Nucleus
already notifies through its own durable notices (facts 2, 3). `off` is the only value that does not duplicate the owner-owns-blockers rule: `auto` reports
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
subscription usage UI to BB: glanceable usage is BB's own card plus the operator-installed Usage Pace plugin (5e).

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
   group takes upstream's path. Nucleus#1313 adds the project row's cross-project pointer where that
   row would otherwise render upstream's empty state (5a, item 5 below).
2. `app/preferences/atoms.ts` and `shared/preferences.ts` — one preference key, `expandedTaskGroups`
   (environment ids), which owns the collapse state of Nucleus task groups and nothing else.
3. `app/list/nucleusTaskGroups.ts` — a new file in the fork: the batched read, its join, the
   collapsed/expanded decision derived from (1) and (2), and (nucleus#1313) the nested-elsewhere
   pointer, computed from the same live thread rows the host already gives the list.
4. `app.tsx` — export the `ThreadList` component instead of defining the plugin, so the plugin's own
   entry can register it beside the board.

A vendored file that needs a fifth change is a signal that the seam is wrong: either the patch set
grows deliberately, with its reason recorded here and in `PATCHES.md`, or the change belongs upstream
(5f's exit path). Nucleus#1313 settled that question in the opposite direction from a fifth patch: a
Nucleus task is a task group from its first thread only when grouping adapts, which Tom ruled
"representative of the state of the task" (2026-11-17), so a lone worker stays a plain row and the
container appears through upstream's own grouping when a second participant joins. The patch set
stays four.

**The cross-project pointer (nucleus#1313).** The list attributes a nested thread to its root
ancestor's project, so a task whose planner thread lives in another project (Tom's Personal project, in
his live trial) leaves its own project row reading upstream's "No threads" over a live task. That row
renders one compact pointer per planner instead — "1 task under <planner title>", counting a task's
role threads once by their shared environment — on the planner's own app route, so the host routes the
click and the pointer opens the nested group. A project whose threads are all its own keeps upstream's
empty state, and a task's own root thread draws as an ordinary row. The logic lives in the fork's own
file and the pointer replaces only the empty state in `ProjectRow.tsx`; no vendored grouping code
changes.

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
- **line two:** the repository the task works on, then the task's state from the shared title helper —
  phase label, then whichever of hold, wait, stop or attention applies (`shared/task-state.ts` via
  `phaseStateLabel`/`taskStateLabel`, which the Paseo client already reads, so the two hosts name a
  state the same way). The repository leads (`<folder> poodle-lab · Reviewing · <PR>#39`) because a
  task can nest under a planner from another BB project, one Nucleus project can span several
  repositories, and a standalone group has no planner context at all; its label is the board's own
  rule (`shared/repository-label.ts`: the short name, `owner/name` when a short name is ambiguous);
- **the PR chip, when the task has one:** the standard state icon (`GitPullRequest`, `GitMerge`,
  `GitPullRequestClosed`) plus `#<number>` in the state colour — success for open, accent for merged,
  danger for closed, warning when an open PR's task needs attention, muted otherwise — with no visible
  state word and the state in the `aria-label`. The mapping is one module
  (`shared/pull-request-badge.ts`) shared with the board's `PullRequestBadge`, so the two cannot
  drift. The number and state come from the card's `prUrl`/`resumePrNumber` and the board's own
  `prStates` record, which the service refreshes for every task that has a PR and no merged commit
  (`core/forge/pr-status.ts`); the recorded wait that says what the task waits for (`Waiting for QA
  capacity (position N)`, `Merge hold`, `Needs operator input`) stays on the same line;
- the rolled-up agent-status glyph upstream draws while the group is collapsed stays, from
  `experimental_resolveThreadStatus` over the group's hidden threads;
- the toggle chevron and inline rename stay. The task row has no action menu and reserves no menu
  slot, leaving the title and state line the available row width. Detach remains on the `detach`
  owner control for agents and planners, while BB operator drag and drop can detach or re-nest the
  group. Upstream's "New thread in environment", Edit and Archive are removed
  from a task container — a new thread would add a participant Nucleus does not know about, Edit
  renames an environment the header no longer shows, and Archive would archive live role threads
  behind Nucleus's back. Every ordinary worktree group keeps upstream's actions exactly.

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
  environment id, the task id, number, reference, the repository label, title, phase, held/blocking
  hold, wait state, stop kind, `prUrl`, `completionPrNumber`, its `prStates` entry, the recorded
  resolution/attention flags, and the label strings the sidebar draws;
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

**Recommendation.** Nucleus contributes **no subscription usage UI** to BB — no rail block, forked card, source or board view (Tom, 2026-11-17: "I want to strip out the usage functionality from Nucleus - each host app now has at least _some_ usage functionality and anything missing should be added via host-specific plugins separately from Nucleus"). Glanceable usage in BB is BB's bundled `provider-usage` card (fact 27) plus the community plugin **Usage Pace** (`chug2k/bb-plugin-usage-pace`, MIT), which the operator installs beside it. Any missing host display belongs in a BB-specific plugin.

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

**Nucleus display boundary.** BB and its plugins own subscription usage presentation. Spec 052's usage level remains a separate Nucleus dispatch policy.

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
the adapter reads no subscription windows of its own and Nucleus contributes no subscription usage view.
That clause is the one change this amendment makes to decision 6, and it is here because the usage
decision forces it.

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
| `slots.experimental_appOverlay` | One per-window mount for the board host the shared decision and native-question pill modules run against (phase 6) | The pills stop registering; decisions and native questions stay answerable on the board and in the `Task` tab |
| `slots.experimental_threadAction` | The planner and named-agent rows' "Project board" link (phase 6) | Planner rows lose the link; the project row's menu item, the rail panel and the per-project tab still reach the board |
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
- the initial phase-1 work-host decision: a registered BB host counts as live for liveness,
  presence and health, but phase 1 did not yet make it available for task work. Phase 3 below later
  enables repository-selected BB task dispatch; caller identity alone still does not select work;
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
archived-handle reuse, missing directories, unregistered projects and unreadable reads;
`test/bb-plugin-operations.test.ts` covers project registration/reuse, read-only project inspection
and zero `threads.spawn` calls; `test/bb-host-channel.test.ts` covers the adapter's production
service-to-executor route, offline and missing-service-identity pre-send cleanup, typed refusal
classification and reservation recovery; the shared
operation schemas and `test/bb-host-executor.test.ts` retain the bounded reply and unknown delivery
rules.

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

**Implemented (2026-11-16).** The service composes BB's native operations with the shared
workspace, launch, helper-ticket and forge policies. A spawn records intent before send and
binds its environment to the workspace before returning a created run. Its parent is the task's
BB planner; roles stay visible with parent notifications off and no lifecycle owner.

Observation reads complete list rows in chunks of 200, with one interaction read per flagged
row. A partial or failed chunk returns `null` for the existing per-agent fallback. BB's rows
report execution status, not a positive turn id; idle/error project a null turn identity, while
starting, provisioning and waiting for a host remain
busy without claiming a provider turn has begun. Per-agent observation reads fresh default
execution options to prove the retained reviewer’s model; batch inventory does not add that read. Merge and cleanup use a per-thread bounded timeline,
including pending tools and background activity, alongside core’s fresh inactivity and owned-process
proof; the bounded page never claims complete history. Unknown spawns walk live and archived origin
pages, including hidden rows across every project, then read metadata in chunks. Only one exact
task/run/host match binds. Empty, partial and ambiguous reads never authorize another spawn,
including after the observation window; the existing attention path retains the intent.

Worker titles carry the shared task title and the active role's step or need for input. Title,
stop and archive writes retain durable intents; uncertain writes are read before another write
and never blindly replayed. Archive requires a fresh leaf cascade proof. The minimal queued
send needed by the ordinary revision/review lifecycle is included; steering, native question
responses, reparenting and multi-role cascade ordering landed in phase 4.

Tests: `test/bb-worker-runs.test.ts` names the phase acceptance cases;
`test/bb-lifecycle.test.ts` exercises dispatch, helper reporting, independent review, retained
revision, verdict, merge, closeout and archive through the real operation executor. Its thread,
list and interaction fixtures are captured from the isolated BB 0.49 / SDK 0.6.132 proof route,
with synthetic identities and paths. `effigy proof:bb` retains the raw SDK records only in its
own scratch root; the production plugin records none.

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

**Implemented (2026-11-16).** Delivery, questions and the support roles on the same reverse channel and
the same durable intents phase 3 established:

- `thread.send` carries a `mode`: `queue` waits behind the live turn and `steer` joins it. The plugin
  takes one read immediately before a steer and refuses with `refused` (proven non-delivery, nothing
  written) when the thread has no live turn; any failure after the write is `unavailable` and therefore
  unknown delivery. `steerOrNotify` answers a proven not-sent steer with exactly one queued send under
  its own durable identity, and never resends an unknown steer, not even as that fallback.
- Interactions are read as the target BB declares them: `thread.interactions` projects each row's kind,
  status, title, a `user_question`'s questions (`id`, `header`, `question`, each option's label *and* wire
  value, and whether free text is allowed) and an approval's available decisions, and fails closed on a
  payload missing a required field. `pendingQuestions` surfaces only native `user_question` rows, with
  their option labels, because that is what an operator chooses between; a plugin interaction is never
  read as one.
- `thread.interaction.respond` and `thread.interaction.cancel` read the exact interaction first, so the
  thread and request are bound before anything is written, and `<thread>/<interaction>` refusals happen
  before the write. Answers map the host contract's decisions onto BB's three (`accept` → `allow_once`,
  `acceptForSession` → `allow_for_session`, `decline`/`cancel` → `deny`); `acceptAlways` has no BB
  counterpart and is refused, never widened, and a decision the interaction does not offer is refused
  before the write. A question answer names an option by its label *or* its wire value and always sends
  the option's value, because a real provider's label and value differ; only a question that declares
  free text takes raw text, and a value outside the offered set is refused where it does not. Dismissal
  cancels a pending question only, never a permission.
- The planner ask and the reviewer consult are one queued send to a thread Nucleus did not create; the
  answer arrives through the relayed reply, never the recipient's chat output. `runDecider` and
  `createConsultReviewer` spawn one idle support thread in the task's recorded worktree under its
  planner, with the same parent-notifications-off and role metadata as every other role thread, and
  `askPlanner` then delivers its question.
- `thread.reparent` writes `parentThreadId` and reads it back, or clears it when the destination is
  `null` (nucleus#1313). A reparented task moves each of its own recorded threads under the new planner
  on the ordinary sweep, one durable intent per thread, and never touches the planner itself. The
  destination is the task's first planner rung when that thread lives on this BB host and `null`
  otherwise — an off-host planner or an explicit `detach` — so the same sweep re-nests, stands the
  group alone, and never names a BB thread the task's questions would not ask. A BB planner thread is a
  valid reparent target: it resolves its own environment as its workspace (`bb-environment:<id>`), the
  same shape T3 uses for a project scope. There is no task-wide destination cache: the fresh per-thread read is the
  only settlement, so an older role is never skipped because a newer one already names the new planner,
  and a move back writes again when the read proves the thread left. An unknown reparent write is settled
  by a later read and never re-sent.
- `archiveAgent` gains the phase-4 cascade rule: the cascade read is the only proof, every id it names
  must be this task's own recorded thread, and a recorded child is archived before its parent so the
  parent's fresh read names only already-archived rows. A foreign id — including a foreign lifecycle
  dependent on a thread with no sidebar children — refuses the archive with nothing written; an
  unreadable read is unknown delivery. The adapter maps both proven pre-send refusals and local
  not-sent reads to `ArchiveNotDeliveredError`, so core's durable effect stays `ready` and the cleanup
  is recorded as incomplete instead of reading as an uncertain write. Reviewer replacement uses the
  existing `archiveReplacedReviewer`/`observeReviewerReplacement` lane unchanged: it archives the
  displaced thread only, then releases the displaced run and clears the binding.
- `capabilities()` now states `nativeDecisions: false`: a Nucleus-raised decision rides the board, and
  native provider questions and permissions are read and answered where the host raises them.

Executor faults name a code only when the executor raised a typed `HostOperationError`: a Node or SDK
error's own `code` (an `ENOENT` from a provider process, for example) is answered `internal`, because
forwarding it would make the service read a real post-write failure as a refusal it may retry.

Tests: `test/bb-phase4.test.ts` names every phase-4 acceptance case at the operation executor and
through core's durable lanes (steer/queue, interaction binding with label-to-value answers, permission
mapping and dismissal, reparent including a move back and an older role after a partial pass,
support-role spawns, children-first closeout, cascade refusals and incomplete cleanup, reviewer
replacement). `test/bb-host-presence.test.ts` proves an executor failure's own code never reaches the
wire as a refusal. `test/bb-worker-runs.test.ts` retains the phase-3 archive proof with the phase-4
cascade rule.

Evidence: `interactionQuestion` and `interactionApproval` in `test/fixtures/bb-0.49-wire.json` are real
provider rows recorded from the isolated BB 0.49 server by the opt-in pass
`effigy proof:bb -- --record-interactions` (synthetic identities): a claude-code probe thread raises a
native question and a plan approval, the plugin lists them, answers the label by the option's wire value,
and the recording keeps the raw SDK rows and both resolutions. That pass needs an authenticated provider
and runs only when asked; the default proof remains model-free.

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

**Implemented (2026-11-16).** The plugin owns BB's sidebar on the same reverse channel, workspace
handles and task records phases 0–4 landed:

- `hosts/bb/plugin/sidebar/` is `plugins/thread-list` vendored from tag `desktop-v0.49.0`
  (`7b26cae7`, SDK 0.6.132) through upstream's own fork routine
  (`scripts/bb/vendor-sidebar.mjs`, which imports `scripts/lib/plugin-fork.mjs` from the checkout at
  the pin), with upstream's MIT notice, a `PATCHES.md` and a `UPSTREAM.json` recording the pin, the
  release's SDK, a SHA-256 per file, the patched and added files, the registry items and the
  forkable-list record. The patch set is four seams: the group header in `app/list/ProjectRow.tsx`,
  the `expandedTaskGroups` preference in `shared/preferences.ts` and `app/preferences/atoms.ts`, the
  fork's own `app/list/nucleusTaskGroups.tsx` (the batched read, its join and the collapse decision)
  and `app.tsx` exporting the list so the plugin's own entry registers it beside its other slots.
  The two app-level tests load that entry; every other fork test is upstream's, unchanged. The
  plugin's own `server.ts` composes the vendored `threadListPlugin(bb)` with the adapter's RPC
  catalogue and the presence socket: the list's preference store, its
  `listPreferences`/`setPreference`/`resetPreference` RPC and its `prefs` CLI register there, so the
  list hydrates and leaves its loading skeleton instead of sitting on it while every UI test passes
  against an RPC fake. `test/bb-plugin-backend.test.ts` loads the production factory with a fake
  plugin API and exercises those registrations: the preference read resolves with every key and
  round-trips `expandedTaskGroups` through the plugin's own storage, the CLI registers as `nucleus`,
  and the sidebar read registers beside them and fails closed without the service channel.
- The read is one catalogue method, `bb.sidebar-groups`, answered by the service's board layer from
  the live task rows it already computed and the `bbWorkspaces` handles joined through the task's own
  workspace id. Its labels are the strings `shared/task-state.ts` and `shared/wait-state.ts` already
  name for the Paseo board; the PR number and state are the card's own fields and the board's
  `prStates` record; a task with no attached environment is absent, so its group draws upstream's
  header. The plugin's own RPC method `sidebarGroups` forwards it over the retained connection, and
  the plugin's schema is validated against the service's in `test/bb-sidebar-groups.test.ts`.
- Live updates ride one signal: the backend watches the service's board revision on the retained
  connection and publishes `nucleus.board-signal` when it moves; the sidebar refetches its one read
  when the signal arrives. A signal that never arrives delays a header and never adds a second polling
  loop or a per-group request.
- Collapse: a Nucleus task group is collapsed unless its environment id is in the fork's own
  `expandedTaskGroups` preference, and its toggle writes that list only. `collapsedEnvironments` keeps
  governing every other group, so each group class reads exactly one list and the two cannot
  disagree. A group the read does not name — unknown, unattached, or a read that has not landed or
  failed — renders upstream's header: the state line is an addition, never a precondition.
- Cross-project nesting (nucleus#1313): the project row whose threads all resolve to another project's
  planner renders a compact pointer instead of upstream's empty state, counts one task once however
  many role threads it has under that planner, links to the planner's own route, and leaves upstream's
  empty state in place for a project with no threads anywhere.
- The container says what it works on and what its PR is (nucleus#1313): the state line leads with
  the folder icon and the repository label, and the PR is the state icon plus `#<number>` in the
  state colour with the state in its accessible label.
- The container's actions are the task's own (nucleus#1313): open the task, open the PR, detach from
  the planner — never upstream's new-thread, Edit or Archive, which every ordinary group keeps.
- Superseded participants leave the container (nucleus#1313): a role thread whose run settled, which
  no binding names and whose turn is idle, is archived; a live or pending-interaction thread, the
  planner and the task's other threads are never archived, and a worker the archive leaves alone
  returns to its phase-prefixed title.

Tests: `hosts/bb/plugin/sidebar/app/list/nucleusTaskGroups.test.tsx` names this phase's UI acceptance
in the fork's own runner (`effigy bb:sidebar-tests`): the collapsed default with number, title, shared
state label, recorded wait and PR state; upstream's header and one read for every other group; one
call for many groups plus the refetch on the board signal; an explicit expand written to
`expandedTaskGroups` with `collapsedEnvironments` never written for a task group; the stored
preference read back on a fresh mount; upstream's header when the read fails; the cross-project
pointer over the live trial's row shape (a worker in its own project nested under a planner in
Personal): pointer instead of "No threads", one task counted once across its role threads, two tasks
counted separately, a project with no threads keeping upstream's empty state, and its own root thread
drawn as a row; the repository-led state line and the icon-plus-`#39` PR chip (open, merged and closed
tones, the state in the label); and the container's own actions beside an ordinary group's unchanged
upstream actions; and the superseded-participant archive beside a live, bound and
pending-interaction thread. `test/pull-request-badge.test.ts` proves the one shared PR mapping and the
board badge that reads it, plus the shared repository label and its ambiguity rule.
`test/bb-sidebar-vendored.test.ts` proves the vendored manifest (byte-identical or named as patched,
the SDK floor at or below the release's, the forkable record, and that no patch hunk touches a drag
binding or split prop); `test/bb-sidebar-groups.test.ts` proves the projection over real stored task
rows and workspace handles, the one forwarding call, the two schemas agreeing, and the board signal.
`effigy bb:sidebar-drift` reports no drift at the pin and never runs in `effigy check`, because it
needs the network.

Evidence: `effigy proof:bb:sidebar` builds the plugin with `bb plugin build`, installs it into the
isolated BB server from phase 0, and records that it loads, that the host serves its app bundle with
the `threadList` slot registered as `thread-list`, that `sidebar.threadListProvider` starts automatic
and pinning `bb--thread-list` is accepted and read back, that the plugin reports its `prefs` CLI and
its preference RPC answers in that server with `expandedTaskGroups` present, and that the built bundle
still honours the host row-status path. The New-thread button, the navigation rail and the footer are host-rendered
chrome this plugin never registers; the proof establishes that from the plugin's slot registration and
the fork's unchanged row tests rather than from a screenshot. The header names the stage and the
recorded wait it has, never an invented check list or QA position (decision 5b's stated departure).

**Deferred exit path.** Option B — an upstream group-row metadata slot (per-environment data) plus a
collapse hint a list can supply per group — would replace this phase's fork and delete the patch set,
keeping the header read and the tenure of the requirement. It is not scheduled; it is the exit that
makes the fork a bounded commitment (5f).

### Phase 6 — board, per-project board, settings, pills and the planner terminal

The shared board's historical `plans` method name is translated by the BB bridge to the canonical
`queue.plans` catalogue method. BB threads may also call the CLI through `BB_THREAD_ID`; the service
verifies that exact thread on one online BB host before recording its host-qualified identity. An
online BB host is valid for authenticated submission ingress. A BB caller can submit and promote
tasks using the configured repository or operator-default work host, including BB when that route
explicitly selects it; caller identity alone never selects the BB work host. An offline BB caller or
selected BB host refuses with typed `invalid_input` during dry-run and before operation acceptance,
even when a separate work host is online. When no repository or operator-default route is set, the
sole online non-BB host remains the unambiguous work-host fallback. The bridge forwards
service-catalogue methods over the retained BB
connection, answers the bridge-catalogue `queue.service-state` read from `service.health`, and permits
only the board's `host.run.board` read and `host.run.capacity.release` action from the reverse host
channel. Other host-control calls remain refused.

**Outcome.** Operator parity in BB: the shared board in a `navPanel` with its attention badge in the
left rail, the same board per project in a fixed thread tab and a sub-path route reachable from the
forked sidebar's project and planner rows, a task-detail tab on a task's role threads, Settings in a
`settingsSection`, decision and native-question composer pills, the pending-interaction slot for a
Nucleus-raised blocking question, and lifecycle hints
forwarded from BB's events into the existing signal path. `bb nucleus terminal` ships
with the plugin CLI as the thread-scoped planner tab; the task-directory `host_path` terminal ships
only if phase 0 proved it appears where an operator would look.

**Acceptance.**

- UI tests through the existing board harness with the BB shell bound: the board renders, its calls
  reach the service or the bridge-owned service-state reader, Settings opens, a decision pill appears
  and resolves, a native question pill shows and answers, the pending-interaction slot submits and
  cancels.
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

**Implemented (2026-11-17).** The board, its Settings and its pills run in BB on the same retained
connection, sidebar read and board signal phases 0–5 landed:

- **One forwarding call.** The plugin backend registers `boardCall`
  (`hosts/bb/plugin/board-bridge.ts`): the BB board shell's `useRpc` sends the exact catalogue
  method and input, the backend forwards it over the retained host-executor connection with
  `via: "bb"`, and the service validates both ends against the shared contracts. It refuses
  `service.*`, `host.*` and `task.register`, and fails closed with no channel. Its bridge-catalogue
  `queue.service-state` method reads `service.health` over the same authenticated connection and
  projects the typed state response. `via: "bb"` is the
  BB Settings surface for the Settings-only capacity rule: the server accepts it only on a
  connection that holds the host-executor role ([service boundary](../contracts/service-boundary.md#settings-only-capacity-writes-tom-2026-10-25)),
  and a capacity change records `surface: "bb"`.
- **The board bundle.** BB builds a plugin from its own directory with an esbuild that has no
  react-native alias, so `scripts/bb/build-board.mjs` (`effigy bb:board-build`) bundles
  `hosts/bb/client/` (the host-client area, the one host folder allowed to import `client/`) with the shared `client/` into `hosts/bb/plugin/board/nucleus-board.js`
  (generated, ignored): react-native resolves to react-native-web as on the local web board, and
  React, react-dom and the JSX runtime stay external so BB's runtime slots supply them. The plugin's
  `app.tsx` passes BB's SDK module to `registerNucleusBoard`; `effigy proof:bb:sidebar` builds the
  bundle before `bb plugin build`. The fork's own runner resolves the bundle to a no-op stub.
- **5c, the global board.** A `navPanel` (`nucleus-board`, path `board`) renders the shared
  `MainSurface` with BB's theme tokens (CSS variables, so it follows BB's light and dark themes).
  `experimental_useBadge` counts open tasks that need the operator — the board's own attention test
  (an attention phase, a resolution marked for attention, an origin fault), an escalated hold or
  stop, or a native question — `critical` while any is failing or waiting on the operator,
  `warning` for escalations alone, labelled "N tasks need you", and `null` once they settle. The
  `settings` sub-path renders the board's Settings, which the board header's Settings button opens.
- **5d, the per-project board.** The route is `project/<nucleus-project-key>`. `bb.sidebar-groups`
  now names each Nucleus project with its planner and named-agent thread ids, its repository paths
  and the BB project ids its recorded workspace handles name, archived handles included (`projects`);
  the plugin backend adds the BB projects whose local-path source is one of those repositories from
  BB's own project list, so a project row keeps its link after task cleanup and has it before any task
  ran there. A fixed `Board` tab shows on exactly those
  threads and renders `MainSurface` preset to the project — every repository the project lists. A
  fixed `Task` tab shows on a task's recorded role threads only and renders the board's task detail
  in place (`client/task/task-panel.tsx`, `TaskDialog` with `inline`); a prerequisite link opens that
  task in the tab and Back returns to the thread's own task. The forked sidebar's project
  rows carry one "Board" menu item linking to the route when the read names their BB project (patch
  0001 plus the fork's own `NucleusProjectBoardMenuItem`), and planner and named-agent rows carry a
  "Project board" thread action.
- **Settings** render in a `settingsSection` (`nucleus-settings`) as the board's own Settings screen.
- **Pills.** One static composer customization draws the pills the shared modules register
  (`registerDecisionPills`, `registerNativeQuestionPills`, unchanged) for the composer's thread, and
  each opens its popover in the plugin's composer popup. An app overlay mounts the board host they
  run against: catalogue calls through `boardCall`, and an agent inventory of the BB threads Nucleus
  records (role threads and project threads) whose pending native questions are read through
  `question.native-list` and answered through `question.native-answer`, so the plugin never writes a
  BB interaction itself.
- **Pending interaction.** `pendingInteraction` registers `nucleus-question`, the renderer a backend
  reaches with `bb.ui.requestInput({ rendererId: "nucleus-question" })`: a question, up to ten
  options and an optional typed answer, submitting `{ answer }` or cancelling; a payload outside that
  shape says so and offers Cancel. No core path raises a blocking Nucleus question on any host yet
  (`capabilities().nativeDecisions` stays `false`; decisions ride the pills and the board), so the
  renderer is the slot, not a new producer.
- **5e, usage.** BB's card plus the operator's host-specific plugins own subscription usage. Nucleus has no subscription usage view or source.
- **Lifecycle hints.** `thread.created`, `thread.active`, `thread.idle`, `thread.failed`,
  `interaction.pending` and `thread.archived` forward as the existing `service.lifecycle-signal`
  kinds with the thread id alone; no hint carries a turn, interaction or environment payload.
- **Decision 7, the terminal.** `bb nucleus terminal [task]` joins the list's CLI registration (BB
  takes one per plugin): it creates one shell terminal scoped to the calling thread, titled with the
  task when one is given, and reads nothing back. The task-directory `host_path` variant does not
  exist, because phase 0 refuted it, and the command refuses any option. Nothing relies on a
  terminal retiring with its planner thread (phase 0's correction).

Tests: `test/bb-board-surfaces.test.ts` runs the board through the existing harness with the BB
shell bound and the real `boardCall` handler — the board renders and every service-catalogue call
reaches the service as `via: "bb"`, while `queue.service-state` reaches the bridge reader; Settings
opens (route, header button, section), a decision pill appears and
resolves, a native question pill shows and answers, the pending-interaction renderer submits and
cancels, the per-project tab and route show a
multi-repository project's every repository and nothing else, and the `Task` tab shows the real
`queue.detail` projection and follows a prerequisite link and back. `test/bb-board-model.test.ts` covers the badge (count, tone, label, drain), the routes, the
tab visibility through each tab's own `useVisible`, the planner-row action, and BB's own
registration collector accepting every surface with no warning. `test/bb-board-bridge.test.ts`
covers the forwarding call, the hints, the terminal command and, over the production backend with
a recording SDK, that no settings write, lifecycle-owner write or terminal read, list or close
leaves the adapter. `test/bb-host-channel.test.ts` proves `via: "bb"` only on the executor
connection and the recorded surface; `test/bb-sidebar-groups.test.ts` the `projects` projection
over real stored projects, archived handles included, and the BB project-list resolution; the fork's `nucleusTaskGroups.test.tsx` the project row's link.

Evidence: `effigy proof:bb:sidebar` builds the board bundle and the plugin, installs it into the
isolated BB server, and records that the plugin runs with a compatible app bundle carrying every
phase-6 registration, that `boardCall` fails closed with no Nucleus service, and that
`bb nucleus terminal --help` answers from the plugin's CLI. The rendered UI is checked in the
installed bundle by the planner after the roll.

### Phase 7 — trial and parity call

**Outcome.** One repository opts into BB and runs real tasks through it beside Paseo, through
milestone QA's own runs; the open questions this spec leaves are answered from that evidence and
written back into this document. Tom's 2026-11-17 target — "T3 dispatches, BB executes" — is part of
that evidence: the workflow's rules, from a T3 planner thread submitting the brief to the closeout
notice returning to it, are proven on the runtime layer over recorded BB rows, its two gaps are named,
and its execution on the isolated server is recorded as missing rather than implied. A switch from
Paseo stays Tom's call.

**Acceptance.** Each bullet is named here with its evidence.

1. **The parity table below**, against the Paseo plugin for the sidebar and its task groups, the
   global board, the per-project board, settings, decision pills, native question pills, usage and
   lifecycle hints, plus Tom's 2026-11-17 end-to-end addition. Each row is met, met by a different
   mechanism, or missing with the reason. Subscription usage is met by the host: BB's own
   provider-usage card plus the operator-installed Usage Pace plugin, with no Nucleus usage screen to
   compare on any host (nucleus#1302).
2. **Reload, restart and outage mid-task**, each starting from a worker turn a provider is running:
   `test/bb-lifecycle.test.ts` drives the real runtime through each fault over recorded BB rows, and
   `effigy proof:bb:trial` does the host half against an isolated BB 0.49.0 server, polling BB's own
   status for `active` — a begun turn, never a spawn's `starting` (assumption 6) — before each fault.
3. **The fork rebase** through the documented routine, with the drift report and the
   vendored-manifest test at the pin; no newer release tag exists yet, so the evidence is the routine
   re-run at the pin plus the drift report against a newer upstream ref.
4. **The operator's call** is recorded pending: the planner answered on Tom's behalf on 2026-11-17 that
   he has not made it and the merge hold stays until he does.

**Dependencies.** Phases 0–6 and the operator install route.

#### The parity table (2026-11-17)

| Surface | Paseo plugin | BB | Mark | Evidence |
| --- | --- | --- | --- | --- |
| Sidebar and its task groups | The Paseo sidebar draws Nucleus task rows and groups | A vendor copy of BB's own `thread-list` (decision 5a), with the task group header's state line, collapsed-by-default task groups and their own `expandedTaskGroups` preference | **met, by a different mechanism** — BB's list is forked because its group row is the operator's unit; Paseo's list is its own host surface. Both draw the same shared state helper | `test/bb-sidebar-vendored.test.ts`, the fork's `nucleusTaskGroups.test.tsx`, `effigy bb:sidebar-tests`, `effigy proof:bb:sidebar` |
| Global board | The shared board from `client/shell/` | The same board in a `navPanel` (`nucleus-board`) with a `warning`/`critical` attention badge and its label, drained as tasks settle | **met** | `test/bb-board-surfaces.test.ts`, `test/bb-board-model.test.ts` |
| Per-project board | The shared board filtered by project | A fixed `Board` tab on a Nucleus project's planner and named-agent threads plus a `project/<nucleus-project-key>` sub-path route; a multi-repository project shows every repository | **met, by a different mechanism** — BB's route key is the Nucleus project, never a BB project, because one Nucleus project spans repositories | `test/bb-board-surfaces.test.ts`, `test/bb-board-model.test.ts`, `test/bb-sidebar-groups.test.ts` |
| Settings | The board's Settings screen | The same Settings in a `settingsSection`, calling the catalogue through `boardCall` with `via: "bb"`; a capacity change records `surface: "bb"` | **met** | `test/bb-board-surfaces.test.ts`, `test/bb-board-bridge.test.ts`, `test/bb-host-channel.test.ts` |
| Decision pills | Composer pills from the shared registrations | The same registrations in BB's composer, opening in the plugin's popup | **met** | `test/bb-board-surfaces.test.ts` |
| Native question pills | The host's own question surface | The pills read `question.native-list` and answer through `question.native-answer`; the plugin never writes a BB interaction | **met, by a different mechanism** — BB's interactions are written by its own agent runtime, so the plugin reads and answers through the catalogue | `test/bb-board-surfaces.test.ts`, `test/bb-board-bridge.test.ts` |
| Usage | None since nucleus#1302 | BB's own provider-usage card, plus the operator's Usage Pace plugin if he installs it | **met by the host** — Nucleus contributes no usage UI on either host; a missing host display belongs in a host plugin, not here | decision 5e; nucleus#1302 |
| Lifecycle hints | The Paseo bridge forwards its lifecycle hints | `thread.created`, `thread.active`, `thread.idle`, `thread.failed`, `interaction.pending` and `thread.archived` forward as the existing `service.lifecycle-signal` kinds, thread id only | **met** | `test/bb-board-bridge.test.ts`, `test/bb-plugin-backend.test.ts` |
| **End to end: T3 dispatches, BB executes** | — | A T3 planner thread submits, BB executes as a standalone task group, the question and the notice return to T3 | **met at the runtime layer** (nucleus#1313 closed the two missing steps), on deterministic runtime coverage only | `test/bb-lifecycle.test.ts` ("a T3 planner submits…") over recorded BB 0.49.0 rows — fake-host unit coverage, not isolated end-to-end execution |

The end-to-end row, step by step, because Tom asked for each step. Every line is
`test/bb-lifecycle.test.ts`, a deterministic runtime test with the fake T3, Paseo and BB
adapters over BB rows captured from the isolated server: it proves the dispatch, review and
closeout *rules*, not a real task executed on a real BB server. No selector runs that
lifecycle end to end on the isolated server, and the merge gate would need a real forge, so
that evidence is recorded as missing rather than implied.

| Step | Mark | Evidence and reason |
| --- | --- | --- |
| A planner thread on the T3 host submits the brief through Nucleus | **met** | The task's `originHostId` is the T3 host, the lead check runs against it, and the repository selects the BB host. `test/bb-lifecycle.test.ts` |
| The task dispatches to BB | **met** | The parent link is conditional on the planner living on this BB host (decision 4, amended by nucleus#1313): a T3-only plan dispatches with no parent at all, as a standalone top-level task group, and spawns exactly once. A BB planner thread re-nests it later without a respawn. `test/bb-lifecycle.test.ts`; `test/bb-planner-presentation.test.ts` |
| The worker runs and reports | **met** | A BB worker thread on the task's unmanaged environment; the packaged helper reports against its run ticket. `test/bb-lifecycle.test.ts` |
| The independent reviewer reviews | **met** | A separate retained BB reviewer thread in the same environment; its verdict drives the same lifecycle. `test/bb-lifecycle.test.ts` |
| Merge, closeout and archive | **met** | The BB adapter's merge gate and workspace archive, the task's role threads archived after their cascade reads, the planner thread and the workspace's published-source proof untouched. `test/bb-lifecycle.test.ts` |
| The planner's questions route back to the T3 thread | **met** | A worker's question climbs the task's real planner ladder, which is the T3 thread itself when the task names it as planner or owner; the test asserts the ask reaching the T3 adapter and no send into any BB planner thread. `test/bb-lifecycle.test.ts` |
| The planner's notices route back to the T3 thread | **met** | The closeout notice reaches the T3 origin thread through its own host adapter (`notify` on the T3 adapter). `test/bb-lifecycle.test.ts` |

#### The trial repository

The trial repository is synthetic and planner-directed (planner ruling, 2026-11-17): Tom has not
designated a live repository, so phase 7's evidence uses synthetic repositories and the isolated BB
server only. Installing the plugin into Tom's BB and pointing one repository at it
(`repository.set` with `hostKind: "bb"`) are the operator's steps from
[the install route](#the-operator-install-route-landed-2026-11-17); a worker never writes into the
operator's BB.

#### Reload, restart and outage

Two layers of evidence, and they are kept apart on purpose:

- **the runtime layer** is `test/bb-lifecycle.test.ts`: the real `QueueRuntime` and the real BB adapter
  over BB rows recorded from the isolated server. It proves the lifecycle *rules* under each fault; the
  hosts on the other side of the adapter are fixtures.
- **the host layer** is `effigy proof:bb:trial`: the real plugin against an isolated BB 0.49.0 server,
  proving identity, adoption and no-resend on the host that would be there. It drives host operations
  and does not execute a Nucleus lifecycle — no task, review or merge runs in it.

**The runtime layer** starts every fault from live work: one queued message plus a bounded poll makes
BB report the worker's turn as live, one observation pass records it on the task, and only then is the
host taken away. Each fault then names the same claims — uncertain, recovered by observation, never
resent, never read as idle:

- **plugin reload mid-task**: with the worker's turn recorded active, the host claim is released before
  the re-declaration. Four observation passes touch no host read or write at all; the task's phase,
  agent, `idleSince`, `lastObservedAt` and completion are unchanged. After the re-declaration one pass
  observes the same live turn, still active and with no idle stamp, the worker's `threads.spawn` count
  stays at one, and ending the turn and reporting is accepted on the same run and ticket.
- **BB restart mid-task**: the same live turn is recorded before the server goes away; the outage pass
  reads nothing and records no observation. A fresh adapter over the same recorded state and rows (the
  restarted plugin has no memory of its own) resolves the same run workspace, reads the live turn as
  active rather than idle, records the observation, never respawns, and the same run ticket still
  accepts the worker's report.
- **host outage during observation**: the live turn is recorded first; three observation passes and
  wakes during the outage touch nothing and the lane, its reason, agent, completion, `idleSince` and
  `lastObservedAt` all stay put. When the host returns the live turn is read as active again, the
  observation is recorded, and ending the turn and reporting is accepted.

In all three, the engine then holds the review behind the worker's workspace release (its 60 s grace
after a live turn ends) — the recorded finding below — so the runtime layer asserts the accepted
completion and that hold rather than the reviewer launch; the reviewer launch is the ordinary
lifecycle test's ground.

**The host layer** mints a task workspace on the isolated server, attaches a planner and a worker
thread, and before each fault sends one queued message and polls BB's own projection for `status:
"active"` — the evidence that a provider turn has begun. `starting`, `provisioning` and
`waiting-for-host` are *not* accepted: assumption 6 is that a spawn commits before its first turn
starts, so those states would let a fault land on a turn that had not begun. A turn that ends or
errors before it begins gets another message, up to four attempts, and no fault is thrown until a turn
is `active`. It then records:

- `bb plugin reload nucleus` mid-task: the turn is `active` when the reload lands and BB reports the
  interrupted turn as `error` afterwards; a new acceptance for the same identity arrives, the plugin's
  own counters restart at zero, one observation reads the same environment id back, zero
  `threads.spawn` calls are made on the new connection, and exactly one thread names the task's worker
  in the origin walk;
- a BB server restart mid-task on the same data directory: the turn is `active` when the server goes
  away and is still `active` after it returns; the same identity and environment come back, the
  unmanaged environment is still listed at the same path, and zero spawns happen after the restart;
- `bb plugin disable nucleus` as the outage: the turn is `active` when the executor is unloaded, the
  service has no executor for the identity, so an observation is refused as *not sent*
  (`No host executor is connected for …`), which is never an idle reading; enabling the plugin again
  reconnects and one observation reads the same thread and environment, with zero spawns.

#### The fork rebase

The pin is still the newest BB release. `git ls-remote --tags` on 2026-11-17 lists
`desktop-v0.49.0` as the highest `desktop-v*` tag, so there is no newer release to rebase onto yet.
What was proved instead, through the routine in [PATCHES.md](../../../hosts/bb/plugin/sidebar/PATCHES.md):

- **The routine reproduces the pin.** A clean clone of this repository at the branch head, with a fresh
  clone of BB at `desktop-v0.49.0`, runs `node scripts/bb/vendor-sidebar.mjs --upstream <clone>` to
  completion: 154 files vendored, 4 patches applied, 44 registry items written, and no diff in the
  vendored tree or the registry paths afterwards.
- **The drift report at the pin is clean.** `effigy bb:sidebar-drift` at `desktop-v0.49.0`: no drift,
  the SDK floor `>=0.6.112` covered by the release's `0.6.132`, `plugins/thread-list` still on
  upstream's forkable list.
- **The drift report against a newer ref names the next rebase's work.** `effigy bb:sidebar-drift main`
  (upstream `1320c88e`, release SDK `0.6.149`, an unreleased branch head) reports 23 changed files, 3
  files upstream gained and none it lost, the SDK floor still covered and the plugin still forkable.
  That is the candidate list for the first release tag after the pin; the routine's rebase half runs
  then, against the tag rather than the branch head (decision 5a).
- **The routine surfaced two defects, both fixed here.** The generated `hosts/bb/plugin/vitest.config.ts`
  had been edited by hand after phase 6 (the board-stub alias) without the generator knowing, so a
  rebase would have silently dropped the stubs; the generator now emits that alias, and
  `UPSTREAM.json`'s recorded hash is re-derived from the routine. The vendored-manifest test checked
  only that the routine-owned generated files existed, not that they were the recorded bytes, so it now
  hashes every recorded path that is not patched. The vendored-manifest test and the fork's own tests
  pass at the re-derived pin.

#### The operator's parity call: pending

Tom has not decided whether BB becomes a supported host (planner, 2026-11-17). This document records
the call as **pending** and assumes nothing: BB stays an opt-in host per repository beside Paseo and
T3Code, Paseo stays the primary host (vision.md), and the task's merge hold stands until Tom decides.
The evidence above is what the decision reads: operator parity is in place on every surface, the
end-to-end row's two former gaps (dispatch from a T3-only plan, and a worker question reaching the T3
thread) are closed by nucleus#1313 at the runtime layer, the end-to-end lifecycle is proven at that
layer and not on the isolated server, and the trial in Tom's own BB is his install to run.

**Findings for the planner (not fixed here).**

- **Closed by nucleus#1313.** A T3-only planner now dispatches to BB as a standalone task group, and a
  worker's question climbs the task's real planner ladder to the T3 thread. The two parity-table steps
  that were missing are met at the runtime layer; the rulings are recorded in decision 4.
- **The end-to-end lifecycle is not executed on the isolated server.** It is proven as runtime rules
  over recorded BB rows; an isolated selector runs host operations, not a task with a worker turn, a
  review, a merge gate and a closeout. Proving it for real needs an agent turn that reports, which
  means a provider and a forge, and a merge gate that would create an outward GitHub resource — an
  operator-authorised run, not a worker's proof. The planner's trial is the route.
- A worker observed mid-turn whose turn then ends and reports holds at the engine's worker-release grace
  ("Completion received; waiting for the worker to release the workspace") before the reviewer starts.
  All three fault tests assert that hold rather than the reviewer launch. Whether a live trial shows it
  as a visible pause deserves one bounded diagnostic during Tom's trial.

### The operator install route (landed 2026-11-17)

The plugin installed into the operator's own BB: it ships in the Nucleus package, one command installs it,
and it is pinned to the service build it came from.

**What the release build produces.** `build-runtime.mjs` bundles the shared board first
(`scripts/bb/build-board.mjs`, phase 6: the plugin's `app.tsx` imports that generated module), runs
`bb plugin build hosts/bb/plugin`, copies the built `dist/` beside the plugin manifest under `bb-plugin/`,
and writes `nucleus-build.json` naming the Nucleus build (the packaged manifest names the built entries, because BB's install validates that
`bb.server`/`bb.app` exist and the package ships no sources to build from). The publication check's
package mode (`node scripts/check-publication.mjs --package <package>`) fails when the plugin, either
bundle, the manifest's built entries or the build identity is missing or names another build; the release
build runs that check on its own output. The generated board bundle is excluded from the source digest
alongside `dist/`: both are build output, so identifying a package by whether a developer had built the
plugin would be wrong. Preparing a release therefore needs an installed `bb` command
(decision: the build uses BB's own build command, per this phase's outcome, and refuses by naming the
paths it looked in when there is none).

**The commands.** `nucleus bb install` copies the packaged plugin under this Nucleus data home at
`bb-plugin-install/nucleus`, then wraps BB's CLI: `bb plugin install path:<managed copy>`, then
`bb plugin config nucleus set serviceDataDir <this Nucleus data home>` and `bb plugin reload nucleus`. The
copy is required because BB's install/build can rewrite `dist/`; after BB finishes, Nucleus makes the
copy read-only. Upgrades replace that managed copy, and uninstall removes it after BB removes the plugin.
The setting is not optional: without it the plugin loads and waits, installed and never connected, which reads
exactly like a healthy plugin with nothing to do — so the route writes it through BB's own `plugin config`,
reads it back, and fails if BB did not keep it. `nucleus bb status` reports the installed plugin's version
and build against the running service's build (`match`, `behind`, `unpinned`, `not-installed`,
`unrecognised`, `service-unavailable`), names the `serviceDataDir` it read, and says when the plugin is not
configured to connect to this data home. `nucleus bb uninstall` runs `bb plugin uninstall nucleus`. Every
command names only the plugin with ID `nucleus`: a locally patched plugin loaded from thread storage (the
operator's Usage Pace) and every other plugin are never read by id, never written and never removed.
`--plugin-dir` installs a built plugin from an explicit directory instead of the packaged copy (the
isolated proof uses it), and that directory must itself be a built Nucleus backend.

**Installed version integrity.** A main-channel roll catches a failed verification while opening the
current installed version, records a failed service roll with the changed file, and keeps the active Paseo
bridge serving. Service health and the board surface that failure; its notice recommends reinstalling the
current version or rolling to a fresh build.

**Refusals.** "Ours" is not the plugin ID and not the package name: a plugin with ID `nucleus` is a package
named `bb-plugin-nucleus`, so a namesake shares both. Ours means the directory carries the Nucleus build
identity (`nucleus-build.json`, which also keeps a plugin from an earlier package version ours across a
roll) or is one of this package's own plugin directories (the checkout install a developer or a private
proof makes). A plugin with ID `nucleus` that is not ours is named and refused for install **and**
uninstall — never overwritten, never removed — and an install source that is not a built Nucleus backend
(the Nucleus package name, a `dist/server.js` built for plugin id `nucleus`, and the build identity for a
packaged or explicit directory) never reaches `bb plugin install --yes` at all. The pin is enforced at
connect: the plugin announces the Nucleus build it came from
on its executor declaration, and the service refuses a different build — or an unpinned plugin against a
packaged service — before the identity probe, with a message naming both builds and `nucleus bb install`.
Nothing registers, so the host is unavailable with that reason rather than connected and half-working.

**Rolls stay in step.** A main-channel roll changes the service's build without touching BB. `nucleus bb
status` then reads `behind` and names both builds, the plugin's next declaration is refused as above, and
the board shows the BB host unavailable with that reason. Reinstalling stays an explicit operator command;
nothing writes into the operator's BB automatically. A source checkout's service and a plugin installed
from `hosts/bb/plugin` carry identities of the same shape, so the private proofs keep working: a source
service pins nothing against an unpinned plugin, and a packaged service refuses one.

**Documents that own the facts.** The release contract owns what the package contains and how it is
published; the README's BB section is the operator's steps; `shared/bb-plugin-build.ts` owns the file name,
the record shape and the pin decision; `bin/bb-plugin.ts` owns the three commands and their refusals (`bin/` may not import
`service/`, so the commands live beside the CLI while the package layout and the pin
decision stay in `shared/`).

Operator steps (the same text the README carries):

1. `nucleus bb install` (after installing or rolling the Nucleus package).
2. Point one test repository at BB: `repository.set` with `hostKind: "bb"`.
3. Expect: `nucleus bb status` reports `match`; the board names the BB host online with its BB and plugin
   SDK versions; a dispatched task's worker thread appears under its planner in BB, and the sidebar's
   Nucleus task groups carry the task state.
4. Remove it with `nucleus bb uninstall`; no other plugin, project or thread is touched.

Usage Pace is an optional companion the operator installs separately; Nucleus never installs, updates or
removes it.

**Tests and proof.** `test/bb-plugin-install.test.ts` names the route's facts (install, the `serviceDataDir`
write and reload name only ID `nucleus`; a namesake is refused for install and uninstall and written to
nothing; an unrelated or namesake `--plugin-dir` never reaches BB; `status` for every state, including an
unset or foreign `serviceDataDir`; the plugin's own reader agreeing with the shared record; the publication
gate failing a package without the built plugin),
and the pin cases live in `test/bb-host-registration.test.ts`. `effigy proof:bb:install` runs the whole
route against the isolated BB server from phase 0: two pre-existing plugins (one an unrelated plugin, one
standing in for Usage Pace) stay byte-identical and are named by no command across install, status and
uninstall; the packaged plugin connects on the setting `install` itself wrote, is refused by name when
rebuilt from another build, and reconnects after reinstalling the matching one; a namesake with ID `nucleus`
is refused for install and uninstall and left byte-identical; and an unrelated plugin directory passed to
`--plugin-dir` is refused before BB's install sees it.


## Sandboxed role threads (nucleus#1315)

Tom's live trial (poodle-lab#29) ran Claude Code threads inside Claude Code's own
sandbox (`provider-claude-code`'s `sandboxEnabled`, on by default, applies in
Accept Edits and Approve for me modes). It found that a Nucleus role thread
could not deliver its report, could not write its recorded scratch root, and
could not run Effigy at all. This section records what was measured, what
landed, and the mode the planner ruled (Full Access) once no sandbox allowance
could satisfy a validating run.

### What the sandbox allows (measured, Claude Code 2.1.326)

Probed with BB's own sandbox shape (`enabled`, `failIfUnavailable`,
`autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`, `network.allowLocalBinding`):

| Operation from inside the sandbox | Result |
| --- | --- |
| write under the checkout (`cwd`) | allowed |
| write under the session's `$TMPDIR` | allowed |
| write anywhere else (the recorded run scratch root, a sibling of `$TMPDIR`, `~/.nucleus`) | denied (`EPERM`) |
| connect to `~/.nucleus/callback.sock` (any Unix socket) | denied (`EPERM`) |
| connect to `127.0.0.1:<BB server port>` (loopback TCP) | allowed |
| `proc_pidinfo` for its own pid | allowed |
| `sysctlbyname("kern.bootsessionuuid")` (Effigy's boot identity) | denied (`EPERM`) |

The Codex provider's workspace scope is the same shape for the reporting route:
BB builds `workspaceWrite` with `networkAccess: true`, and Claude's sandbox
leaves loopback reachable on purpose (its own documentation names loopback
reachability as a risk). Both providers therefore reach a loopback service from
inside the workspace sandbox; neither reaches a Unix socket.

BB's Claude provider builds the workspace sandbox itself
(`filesystem.allowWrite` from `additionalWorkspaceWriteRoots`, plus
`network.allowLocalBinding`), and that provider option is not on the thread
creation path (`sessionOptions` carries `string | boolean` only). No surface a
plugin or a thread can reach adds `network.allowUnixSockets` or a write root, so
the choice was never "which allowance": route (a) of the brief does not exist in
BB 0.49.

### The route that landed

- **The mode: Full Access (planner ruling, 2026-11-18; recorded in the task's
  Nucleus-held brief v2, `sha256:af17b0ce…`; carried into v3, `sha256:2c7bf152…`).**
  A sandboxed BB role thread cannot
  run Effigy at all: Effigy's foreground identity needs the boot
  session (`sysctlbyname("kern.bootsessionuuid")`), which Claude Code's sandbox
  refuses with `EPERM` (measured above), so Effigy refuses "foreground owner
  identity unavailable" before any command. Claude Code's sandbox settings expose
  no sysctl allowance, and BB's provider builds that sandbox itself. A BB role
  thread therefore runs in BB's **Full Access** mode — the explicit sandbox and
  approval bypass for unattended work — exactly as Paseo role threads run
  full-access / `bypassPermissions`. The provider setting `sandboxEnabled`
  remains on; the run's mode is what does not apply it. `commit`/`hosts/bb/threads.ts`
  sets `permissionMode: "full"` for every role thread, and the profile's mode
  still describes the run. The planner raises Effigy's sandboxed boot-identity
  read with the Effigy planner separately; until then a sandboxed mode (Accept
  Edits or Approve for me) is not a mode a Nucleus BB role thread can validate in.
- **Reports.** A run ticket records its host (`writeRunTicket`). A `bb:` ticket's
  generated helper POSTs the exact payload it would have sent to the socket, to
  the BB backend's own loopback route
  (`POST /api/v1/plugins/nucleus/http/report`, `auth: "local"`); the backend runs
  in the BB server process, and forwards it to `<data home>/callback.sock` with
  the ticket's own token. The route reads only this data home's
  `tickets/<runId>.json` (by run id — never a path from the invoking machine,
  which would name the wrong host's disk), requires an owner-only regular file,
  the ticket's exact token, task and run, and forwards only the helper's routes
  (`/complete`, `/ask`, `/message`, `/answer`, `/task-next`). No token is logged
  or echoed. A relay that is not there (an older BB server, a fixture) falls back
  to the callback socket, and the deterministic event id keeps a lost answer
  idempotent. Every other host keeps the socket unchanged, and the prompt still
  says `nucleus helper report`.
- **Scratch.** BB hands a provider no per-thread environment. The BB adapter
  creates the run's recorded scratch leaf (owner-only, repository namespace)
  before `run.attach`, and refuses the launch when the leaf cannot be proved.
  #1314 owns the same creation on the general launch path; this is the BB-side
  guarantee beside it and is idempotent.
- **Sibling checkouts.** A Paseo worktree root holds the sibling clones the
  repository's own link tasks placed there, shared by every task of that
  repository. On BB the root is the same shape, so
  `WorkerLauncher` has the service make that shared checkout for a `bb:` task:
  `WorkspaceProvisioning.ensureSharedSiblingCheckouts` creates one detached
  worktree per project sibling member under the canonical worktree root at the
  sibling's fetched `origin/<base>` when it is first created, never replaces an
  existing path (Spec 028's refresh owns freshness and another task may be
  reading it), records `shared_sibling_checkouts`, and the worker prompt names the
  checkouts so `../<sibling>` resolves. Because it is shared per repository, a
  second BB task on the same repository resolves the same checkout rather than
  colliding with the first task's pin. Only a `bb:` host is affected; every other
  host's worktree root is untouched.

### Effigy in a BB role thread

With Full Access, Effigy runs in the thread: `scripts/acceptance/bb-sandbox-private.ts`
prints a report only after `effigy qa:docs` succeeds inside the worker thread, so
the report's arrival proves Effigy's foreground guard started and completed. The
sandboxed-mode limitation above is Effigy's (its boot identity read); the held
brief's amendment says Effigy has been told and that running inside a sandbox
later is its own decision.

The amendment restates acceptance 1 as: on the isolated BB server, with role
threads launched as production launches them (Full Access), two role threads
(worker and reviewer) each deliver their report; each run's scratch directory is
present, owner-only, before launch; an Effigy selector runs in a role thread; and
a test reading a sibling path passes through the production placement. The proof
records every one of those, including each run's scratch leaf (`0700`, a real
directory) created by the same `runTemporaryEnvironment` call the BB adapter makes
before `run.attach` and before either thread exists, and it keeps the sandbox
probes as the evidence for the limit.

**Brief v3 (2026-11-18) rules the hand-built launch production-equivalent for
this task.** The proof writes its own run records, scratch, tickets and prompts
and spawns the threads with the BB CLI in Full Access. That is sufficient here: it
shows on a real BB that the relay, the callback socket, Full Access, the sibling
placement and Effigy all work. The adapter's own scratch and ticket creation is
covered by `test/bb-run-scratch.test.ts`, and the end-to-end production launch
(Nucleus dispatch creating the runs and `BbThreads` spawning the threads) is the
planner's live BB trial after this merges, not part of this PR.

### Tests and proof

`test/bb-report-relay.test.ts` pins the relay's gate (ticket by run id,
owner-only file, exact token/task/run, allowed routes only, the service's own
status and body, no forward on any refusal); `test/callback-client.test.ts`
pins the generated helper choosing the loopback route for a `bb:` ticket and
never printing the credential; `test/bb-plugin-backend.test.ts` pins the
registered route and its refusals; `test/bb-run-scratch.test.ts` pins the
owner-only leaf existing before `run.attach` and a launch refusal when it cannot
be proved; `test/siblings.test.ts` pins one shared sibling checkout per
repository for a `bb:` host, a second task re-observing it, no change on another
host, and an occupied path left untouched.
`effigy proof:bb:sandbox` runs two Claude Code role threads against an isolated
BB server (the plugin installed into it, `sandboxEnabled` on, Full Access) in a
real task worktree under the canonical per-repository root. The sibling checkout
`../sylib` is placed by `WorkspaceProvisioning.ensureSharedSiblingCheckouts` — the
production code — and a second task on the same repository re-observes it. Each
thread's single command requires the sibling read (`test -s ../sylib/README.md`)
and the worker's also requires a real `effigy qa:docs` run, then hands its report
to the helper: a delivered report proves all of it. Both reports arrived at the
recorded callback socket, the checkout stayed clean, and the evidence records each
run's owner-only scratch leaf as present before either thread was spawned.

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

Proof selectors: `effigy proof:bb` for the private run, `effigy proof:bb:sidebar` for the built bundle's
install, `effigy proof:bb:install` for the operator install route and the build pin, `effigy
bb:sidebar-drift` at a planned rebase, the affected unit files for each phase, and `effigy check` plus
`effigy qa:docs` for every phase. No
phase runs the full suite; milestone QA does that on `main`.
