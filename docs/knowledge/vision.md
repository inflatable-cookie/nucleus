# Nucleus

Owner: operator and planner

Make Northstar orchestration quieter and more reliable through a durable local
Nucleus service, with Paseo providing the agent host and a thin native bridge.

Automate the routine work of dispatch, state observation, review, merge and closeout while keeping operator planning conversations focused. Durable task ownership and recoverable side effects matter more than hiding uncertainty.

Agents submit approved work through the queue API. The operator controls pause/drain, task-slot limits, profile eligibility, cost gates and subscription availability. Small per-task coordinators resolve operational ambiguity and supply evidence; the task project's Chatterbox owns the disposition through Nucleus's controls, and the Nucleus owner fixes product defects rather than serving as a mandatory relay (2026-10-13, below).

The standalone Nucleus service is a Paseo adapter for Northstar, not a dependency
introduced into Northstar core. The Paseo plugin is its thin native UI and RPC
bridge. Neither grants execution authority from document promotion, invents
planning decisions, or bypasses exact-head review.

## Planner frontier grants

Tom, 2026-11-06: when frontier is needed, it is generally needed for a string of dispatches. The planner asks for standing permission and handles the routing; the operator only says yes, then can revoke when the block of work is done. See [Spec 052](specs/052-usage-level.md).

## Responsible tasks settle their own questions

Tom, 2026-11-06: an escalation answer should resolve the problem, not merely advise someone to act. It must apply an available action or name what the task waits for and resume when that happens, without asking a planner a second time.

Tom, 2026-11-05: workers and reviewers act on recommendations within the approved outcome, including bounded diagnostics and retries after transient forge failures, and record material decisions in the PR. Remaining worker questions go to the retained reviewer first; only a needed planning ruling climbs to the planner, while operator-only matters keep their existing route. See [Spec 058](specs/058-responsible-tasks.md#slice-17--the-blocker-ladder-climbs-worker--reviewer--planner--tom-task-584).

Tom, 2026-11-05: authenticated worker, reviewer and recovery threads may force their own task's `move` and `retry_effect` with observed evidence. Exact-head approval remains required; only the retained reviewer may waive an unrelated failed check at its own applied approval head, with the check name, job URL and reason, and GitHub-required checks remain binding. A forced archive settlement leaves its workspace visible and retryable.

Tom, 2026-11-05: `queue.critical: true` disables all self-force and asks automatic selection for a different reviewer model rated at least as capable as the worker. If no eligible, rated and available profile exists, ordinary reviewer selection proceeds immediately and records the fallback in the task, `next` and closeout; only a planner or operator may change the flag after dispatch.

## Delegated questions stay out of the conversation

Tom, 2026-11-05: planners answer delegated questions through a command, never chat output. Nucleus sends one short, consistently labelled system message only when the planner is idle; a busy conversation keeps its flow while the existing answer window bounds the wait. The same command serves reviewer consults and deciders; see [Spec 058](specs/058-responsible-tasks.md#delegated-answer-command).

## Recovery should keep work moving

Tom's product direction (2026-10-13, told directly to Nucleus's owner thread):
Nucleus is too brittle and finicky; it must be more flexible, adaptable and easy
going, because most effort is going into stuck tasks rather than completed work.
This is a design requirement, not a claim that every existing control already
meets it.

Routine mechanical recovery should have ordinary supported exits. An exhausted
provider route, a rejected report format, a settled recovery record or a clean
integration base behind origin should not strand a task. A concrete owner answer
should enable the matching transition without inventing an incident, handing
unchanged work back to its author, or requiring a new code change for each
occurrence. Related bookkeeping changes belong in one atomic transition, with
their original evidence retained.

Automate mechanical recovery where existing authority and positive evidence
already suffice. Otherwise ask once for the smallest missing decision and
resume the same task when it arrives, keeping unaffected work moving. A refusal
must identify the real unmet condition and a supported next action; generic
attention, phase labels and stale incident prose are not sufficient causes.

Preserve substantive exact-head review (an independent reviewer is preferred, not required; see below), source identity, authentic invocation
and effect provenance, unknown-delivery reconciliation, existing budgets and
task scope. A checkpoint is not approval, and a reviewer owns its own reading
(see [Retained reviewers review changes](#retained-reviewers-review-changes)).
These safeguards protect the work without making formatting or historical
metadata another review of its content.

Evaluate recovery by completed work and operator effort: fewer repeated
questions, author handbacks and task-specific escape hatches; no circular
control guards; and board states that distinguish a live run from a parked
checkpoint or a missing external capability. These are requirements for future
implementation, not permission to clear records or waive gates.

## Project owners resolve task issues

Tom's ownership ruling (2026-10-13, told directly to Nucleus's owner thread):
"Chatterboxes should be able to resolve all task related issues directly via the
tools Queue provides - they should not need to escalate to you at all unless
something is actively broken with the Queue". It was recorded here through the
normal Nucleus route after a draft recorded outside Nucleus was closed unmerged.

So a project's Chatterbox owns its tasks' disposition and control within the
task's actual authority, through a coherent task-scoped control surface:
reviewer selection, stopped-run recovery, answered incidents, brief corrections,
fresh review, retained-PR continuation, integration follow-through and closeout.
Each control states its actual eligibility and preserves the task's identity,
evidence and authorization. Authority binds to the authenticated owning thread
or trusted invocation boundary; a project-owner label alone does not identify a
caller.

Per-task coordinators supply operational diagnosis and evidence; the project
Chatterbox decides the disposition and applies supported controls. Nucleus's owner
maintains the control surface and handles product defects. Escalation to
Nucleus's owner is for a missing or broken Nucleus capability, not a routine task
decision or a mandatory relay of an already authorized action, and a genuinely
new operator or product decision still belongs to Tom. Task authority grants no
cross-project, settings or global administration effect.

Existing implementations are brought into line through normal reviewed changes.
This ruling creates no synthetic approvals, no private state-clearing route and
no installed behaviour by itself.

## Reviewer choice, review-loop caps and coordinators that act

Tom's rulings (2026-10-13, told directly to the Nucleus simplification thread):

- "I don't think a different reviewer should be _required_ - preferred, yes..
  owners should be able to pick and choose freely". Review at the exact current
  head stays the merge gate. Nucleus's automatic selection prefers a reviewer
  independent of the author's agent and model; a project owner may pick any
  reviewer, including the author's model, with a reason.
- "After 3 rounds it should escalate and switch to a higher capability model if
  there is one available. After that cap at 6, after 6 a different approach
  should be considered." Spec 058 cutover 3 retired the automatic author
  upgrade: non-converging reviews now use the #584 planner ladder, and a planner
  who wants a stronger model uses `route role=worker`. The six-round cap remains
  and hands the task to the planner for a different approach, not another round.
- Coordinators run automatically: "that's the point of them, to keep things
  moving without needing to escalate". A coordinator that assesses a stopped
  task must get it going again through Nucleus's controls; diagnosis without a
  resumed task misses the point.

These are design requirements. Installed behaviour still enforces the earlier
reviewer-independence gates and budgets until the simplification lands; they
are not permission to bypass a gate today.

## Retained reviewers review changes

Tom's ruling (2026-10-31, in the Nucleus owner thread, on 14 days of live data:
1,771 reviewer runs for 341 reviewed tasks, nearly every one a fresh agent;
2,270 coordinator runs over 159 tasks, 1,200 of them only continuing a
reviewer checkpoint): "Confirm. I agree with your proposal." The proposal it
confirms:

- A reviewer checkpoint continues automatically within its budget, as a worker
  checkpoint already does. Continuing saved reading is not a decision and
  needs no coordinator.
- Across revision rounds the retained reviewer reviews the change. After
  `changes_required` and a new head, the same reviewer agent gets its earlier
  findings plus the exact SHAs and git commands that read the delta (or
  confirm a pure rebase) from the head it last reviewed to the new head; the
  diff itself stays in the checkout and never enters the prompt. It checks the
  fixes, judges the new code and
  issues its verdict at the new exact head, so the exact-head gate stands. A
  fresh reviewer is the exception: the agent is closed or out of context, the
  author was upgraded, an owner asks for one, or a periodic independence
  check. A head move whose range-diff is empty is not a content change and
  gets no content re-review.
- A reviewer that finds the source clean but an owner-gated proof missing
  records source approval and parks the task with one notice. The arriving
  proof is judged on its own; the source is not re-reviewed.
- An escalation asks once: a repeat of an open question joins it. Each task has
  one retained coordinator thread for genuine ambiguity, and Nucleus applies
  deterministic moves itself.

This replaces "a new reviewer owns its reading" and the fresh review per moved
head in the [orchestration contract](contracts/orchestration.md#mechanical-integration-without-repeated-content-review).
Installed behaviour changes through normal reviewed PRs.

## Simplification rulings (2026-10-31)

Tom, in the Nucleus owner thread, on the four-track codebase audit: "I don't
want to lose papercuts - don't do R6, the rest are approved". Each line is a
direction for reviewed PRs, not installed behaviour.

- **R1. Rules, not stories.** Knowledge files state current rules in one to
  three sentences and link the spec for oracles. A ruling is recorded as the
  rule plus its date and owner; quotes, relay chains, incident narratives and
  task or review numbers stay in Git and Nucleus. See
  [writing style](contracts/writing-style.md).
- **R2. One admission route.** Retire Nucleus contract 010 in favour of the
  Effigy hook once Effigy 0.15 is installed
  ([Spec 035](specs/035-host-run-scheduler.md#cutover-and-rollback)). Nucleus
  keeps the admission decision.
- **R3. End the Nucleus records pilot.** Remove the shadow-run stream
  ([Spec 034](specs/retired/034-shadow-run-stream.md)) and portable records
  ([Spec 029](specs/retired/029-portable-records.md)), coordinated with Nucleus,
  which reads both. Store backups stay. The producers and their RPC/CLI surfaces
  were removed on 2026-10-31; written stream files, seed directories, export
  directories and journal rows stay as inert history.
- **R4. No migration ladder.** The store opens schema 50 and later only; an
  older store or backup is upgraded with an older build first.
  Tom clarified admission on 2026-11-01 (decision
  `52f24b67-fd74-4d69-91a5-4c76174c6593`): "Allow native SQLite coordination;
  reject without application schema/data writes". Native SQLite locking and
  auxiliary-file activity are permitted; rejected inputs must receive no
  application schema changes, migrations or data writes. This replaces the
  filesystem-zero-write preflight requirement, not the schema floor or
  preservation of committed history. Admission must use SQLite's consistency
  boundaries rather than infer a coherent snapshot from file metadata.
  Tom then ruled on late source replacement (decision
  `7af9d711-736c-4e0c-beef-43c54f3bf483`, 2026-11-01): "Allow bounded
  publication effects; preserve existing backups and reject startup on
  replacement". After validated publication begins, a rejected startup may
  leave this attempt's new directory, staging files or verified backup of the
  admitted original. It must not commit migration changes to either database,
  publish replacement contents, or change existing backups, status or retention
  history. Failed admission cannot prune or clear unrelated interrupted files;
  that maintenance belongs to the successful lifecycle. This replaces only the
  requirement for zero managed effects after a late pathname replacement.
  Admission assumes SQLite's file-lifetime contract: external replacement of
  the database or its recovery files requires all connections to be closed.
  Renaming an open database during commit is outside R4's guarantee; SQLite
  documents that operation as a corruption hazard. Observed identity changes
  still refuse admission, but metadata checks do not provide namespace
  exclusion. Native concurrent writers, WAL consistency and crash recovery
  remain supported and require their preservation proofs. R4 adds no VFS or
  global filesystem writer protocol.
- **R5. Lean repository hooks.** Retire the integration-write mode, its
  isolated publication and closeout authority, and
  collapse the control and event schemas to one version each, moving the live
  consumer manifests onto it. The trusted runner approval registry is retired;
  hooks may name host tools directly (Tom, 2026-11-08).
- **R7. Owner restart is the authorization.** Implemented: the eight-retirement
  ceiling remains a loop breaker, and an operator-relayed `restart role=worker
  fresh` is the deliberate path past it. The separate extra-replacement grant
  is removed.
- **R8. One sibling mechanism, and no Cargo handling.** Keep one way to prepare
  sibling checkouts (chosen from current callers between
  [Spec 027](specs/027-multi-repository-projects.md) and
  [Spec 028](specs/028-fresh-sibling-checkouts.md)). Cargo build-output
  deletion and Cargo environment injection leave Nucleus for repository teardown,
  Effigy or the Paseo profile; this reverses the 2026-10-15 ruling.
- **Declined: R6.** Papercuts stay a first-class Nucleus surface: the
  `papercut.*` methods and their records are kept, and `set_routing` and
  `exclude_worker` stay separate verbs. Papercuts are stored as leads tagged
  `papercut`; Tom then approved (2026-10-31, "keep the interface, agents need
  it, get rid of the old table") removing the legacy `papercuts` table, its
  migration and the `PAPERCUTS.md` importer (`papercut.import`,
  `server/papercuts.ts`) with R4. Every other `papercut.*` method stays.

## Queue becomes Nucleus

Tom's ruling (2026-11-02, in the Nucleus owner thread): "rather than building a _new_ system, I want
to make Queue general purpose (not just Paseo), then carefully replace parts where we can so that it
_becomes_ what we need", and "I want to turn _this_ repo into nucleus". Nucleus, the separate Rust
re-imagining of Nucleus, could not be made to work in line with Nucleus and is retired: its repositories
are deleted and its backups kept outside Git.

- This repository is the one system. It grows from a Paseo plugin and service into a general-purpose
  orchestrator by incremental replacement, never by a parallel rewrite.
- Paseo becomes one host among others rather than a built-in assumption.
- The parked Nucleus project `nucleus` keeps its open design leads (core decisions, control and execution
  plane topology, conversation endpoints, broader operation) and the "Queue convergence" lane as
  input to that work. They grant nothing by themselves.
- Contract 010 now lives here ([host-run-scheduling-010](contracts/host-run-scheduling-010.md)).

First step (Tom, 2026-11-04, in the Nucleus planner thread): rename to Nucleus. "This isn't just a naming
exercise, the point is making this project a general purpose system that can be used across multiple
agent apps like Paseo, T3Code, BB, etc, with separate plugins / integrations for each. Paseo should be
just one of many targets - this first step removes it from the name, further steps after that will
require splitting out the Paseo-specific parts of the system, reorganising the repo and consolidating
those parts as their own internal package."

Names and boundaries (Tom, 2026-11-04, in the Nucleus planner thread): "Queue" goes. "The product is
Nucleus, queue is the dispatch concept." Northstar leaves this repository: "that is a documentation
system and ultimately shouldn't have anything to do with Nucleus; this repo will provide all of the
skills needed to use it and Northstar should be kept separate."

Tom, same day, on where the line falls: "we keep using Northstar for what it was intended - documentation
structure. That's fine. The plan.get and papercuts stuff needs to move to the Nucleus skill and be removed
from Northstar - Northstar shouldn't have any knowledge of Nucleus / Queue by the end of this."

Distribution (Tom, same day): "We need a better way to distribute the system - hard coding the dev path
in the skill is not portable at all!!" Using Nucleus must not depend on where a development checkout lives.

Releases (Tom, same day): GitHub Releases is the delivery route for now, but "I don't want a release on
every merge - it's fine testing changes locally, a release should be treated like releases normally
should, be fully tested and a known working snapshot, not just a rolling commit mirror." A development
machine builds merged `main` locally and rolls from that; a release is a deliberate, tested snapshot.
The install is a Node runtime shipped per platform under `~/.local/share/nucleus`, with the command in
`~/.local/bin`. The data home is `~/.nucleus`, or `NUCLEUS_DATA_HOME` when set (Tom, 2026-11-09: retire
the move machinery).

Next target (Tom, same day): T3Code. "I ultimately want to settle back in T3Code (it's a nicer
environment than Paseo) but it has different thread semantics that we will need to work out how to
integrate first. I'm thinking queue driven threads become subagents of the worker thread in T3, but
we can look more in depth at that when we get there."

T3Code rulings (Tom, 2026-11-11, after the design note in the `nucleus-t3code` lane): worker,
reviewer, recovery and coordinator stay separate top-level T3 threads ("isn't my favourite but I
guess it's the only way to make it work in t3"); reporting goes through the CLI helper for now; no
patches to T3 ("we need to work around the gaps - no patches"); the Nucleus web board is the operator
UI alongside T3; and T3 is a trial before any commitment ("the gaps may affect the workflow too
much"). Paseo stays the primary host until Tom decides.

T3Code compatibility follows the auto-updating nightly, with read-only structural
probes rather than a server-version pin (Tom, 2026-11-11). The connection and
first-use command checks are owned by the [host boundary](contracts/service-boundary.md#host-identity-registry).

Profiles (Tom, 2026-11-06): Nucleus takes its agent profiles from Paseo's profile system today, and other apps have none. "We'll need to switch nucleus to a more traditional model picker system - have the host app provide a list of all the providers and models, then allow the operator to create profiles based on their selections". Profiles become Nucleus's own, and the host only lists what's available.
On provider options (Tom, 2026-11-06): the picker shows whatever the host reports for a model. "We need to be able to control permission settings and agent-specific modes".

Hosts and the daemon (Tom, 2026-11-06, in the Nucleus planner thread): one Nucleus daemon serves every host. "The first capable host to launch also launches the daemon and the last registered host to close also closes it. The operator shouldn't have to manage the daemon, and it shouldn't be permanently spinning in the background when not in use."
The CLI doesn't launch it (Tom, same day): "there's little value in the daemon running without a host.. it can't _do_ anything. The exception to that might be maintenance, trimming the db, that kind of thing?" Effigy needs nothing from it: its admission hook is generic and only Nucleus-launched agents set it.

Profiles are central (Tom, same day): "a profile list created on one host should be portable to another host. If a provider or model is unavailable in host 2, then the profile is unavailable under normal semantics. I don't want to have to maintain multiple model lists."

The profile manager comes first in the split (Tom, 2026-11-07, in the Nucleus planner thread):
- The profile list set up in Nucleus is the one that's kept. Tom trims Paseo's own profiles to the few he uses for new planner threads, which stay useful in the composer's model picker.
- Hosts may name the same provider differently, so Nucleus keeps a provider map that normalises provider keys. A profile names the normalised key.
- Options don't vary by host: "Let's go with no for now and look at it again if the need arises".

The UI for other hosts (Tom, 2026-11-07, in the Nucleus planner thread): T3Code has no plugins yet, so the daemon serves the board over HTTP, to open in T3Code's browser pane or a real browser. "It's the best we can do until T3 adds plugins, and can be a useful central interface."
- **One shared UI with two shells.** The board's React Native components build once as the Paseo plugin and once for the web with react-native-web. Only navigation, composer pills and the data binding differ between them. "We may as well start there with a single shared implementation and only split out when we need to", for example when a host that doesn't use React Native arrives.
- **The HTTP server goes into the current daemon,** not waiting for the Rust port. The port then serves the same HTTP calls and the same bundle.
- **Localhost only, with a token:** a random port, and a fresh token in the link the host opens. The token keeps operator-only actions as accident-proof as the plugin's Settings screen is today.
- **The web board ports the whole plugin UI, Settings included.** Tom, 2026-11-07: "We'll definitely need settings, most of the important stuff is in there". A request with a valid token and the Settings screen's marker counts as the Settings surface, so dispatch limits and the other Settings writes work from the web. The CLI, task shells and any request without a token refuse as before. Like the plugin's Settings screen, this is accident prevention: it does not stop a deliberate imitation by something running as the same user. The contract is [service-boundary, Local web board](contracts/service-boundary.md#local-web-board).
- **Then it becomes a professional product.** Tom, same day: "We need to port the current plugin's UI, simplifying, tidying and improving it as much as possible to turn it into a professional product". The port is faithful. A design pass follows in its own lane, and since the components are shared, it improves both shells at once.

Split details (planner's calls, 2026-11-07, under Tom's "get the split done with the new UI work"; Tom confirmed them on 2026-11-08: "Go with your recommendations"):
- **Data folder:** `~/.nucleus`. The retired Nucleus project's own `~/.nucleus` (config, `state/nucleus.sqlite`, task-review snapshots, last written July 2026) was archived to the operator’s external archive (`nucleus-retired-2026-07`) with a SHA-256 manifest and removed, on Tom's ruling to archive externally before removal (2026-11-08), so the data move can publish there. The move ran on 2026-11-09: cutover finished at 08:05 UTC, the service now runs from `~/.nucleus`, and `~/.paseo/northstar-queue` is the sealed read-only old view with its redirect marker. Before the move, data from retired producers (shadow-stream seeds and stream, portable-records exports, runner-registry artifacts; 9.2 GB) was archived to the operator’s external archive (`nucleus-retired-data-2026-11-09`) with SHA-256 manifests and removed, on Tom's word (2026-11-09, "no point keeping data from retired systems"). After nucleus#1006 retired the move machinery (rolled 23:05 UTC the same day; Tom: "Retire the move machinery"), the migration journal moved to the external archive (`nucleus-move-journal-2026-11-09/`) and the sealed old view `~/.paseo/northstar-queue` to the external archive (`nucleus-old-data-home-2026-11-09/`) (274,609 files, store bytes verified), then both were removed from the machine.
- **Daemon shutdown grace:** 10 minutes after the last host closes. Active host runs keep the daemon alive, and a reconnect cancels the shutdown.
- **Paseo profiles:** once selection reads Nucleus's own profiles, Nucleus stops reading Paseo's. There's no re-import.
- **Restarts:** a step that needs only the Nucleus service restarted is the planner's to schedule. Tom, 2026-11-08: "If just Nucleus, do it whenever you need to". Restarting Paseo or its daemon stays Tom's.


Tasks stay on one host for now (Tom, same day). Distributing a task across hosts may not be worth much; "the greater value may come from having a planner in one app and the workers in another".

The order is the rename, Northstar out, the Paseo split into its own internal package, then T3Code. Between the split and T3Code comes the first GitHub Release, once the 2026-11-09/10 audit and its god-file splits land (Tom, 2026-11-10: "we should do a first github release once we've got this lot done, before starting on t3"). Publishing stays Tom's call.
The detail of each step is still to be planned with Tom.

Rust port (Tom, 2026-11-06, in the Nucleus planner thread): once the split is done and running smoothly, port the daemon to Rust "for better performance and memory usage, drop the node dependency". Until then, "the most important thing between now and then will be tidying up and formalising the logic the daemon uses, simplify the codebase, make the port as simple and dependable as possible". This is a later port of one settled system, not a return to the retired parallel rewrite.

Storage placement in the port (Tom, 2026-11-10, a note for later): use the shared
storage service, still in development. The operator defines a drive and its settings
once; participating apps reuse that central configuration for their data and caches.
Until then, Nucleus's `workRoot` and `workVolumeId` settings (nucleus#1096) own placement.
The port replaces them with the shared target instead of adding a second source.
Coordinate with that service's planner when the port starts, not before. Shared
placement is its fundamental purpose, so this should need only modest changes.

## Queued work costs nothing

Tom, 2026-11-06: "The number of queued tasks shouldn't make a difference - if it's queued then it's not active!? Nucleus shouldn't be going through every task on the board". The service's work scales with active tasks. A project's queue length isn't something to cap or ask planners to manage. Queued waits are read from current facts; the board shows a bounded head and counts, with the rest available in pages.

## Responsible tasks

Tom's direction (2026-11-02, in the Nucleus owner thread): a task on the board is a unit of work one
thread is responsible for. It decides, uses subagents and gets the work done to a high standard, kept
mindful of efficiency and tokens, in an isolated worktree without ceremony. One reviewer thread per
PR works with the worker and checks only the diffs. A coordinator exists only for real system faults
and is a single retained thread. No owner, Chatterbox or Supervisor threads as they are now: one
planner plans with the operator; workers ask the operator directly, return to the planner only when
the plan is unclear, and may coordinate with each other. Any thread can register itself as a task and
then follows the same workflow. Rulings the same day:

- **Merge holds:** "only useful if another thread requires it". That thread manages the hold with the
  worker or reviewer for a specific reason; there is no default hold.
- **Budgets:** an exhausted budget pauses the task and asks the operator "in a simple visible way
  (eg composer pill in Paseo)".
- **Pilot:** this repository first, provided piloting on Nucleus itself does not make developing it
  difficult (the old lifecycle and direct operator-accepted PRs stay available as the escape hatch).
- **Threads:** the Sol Supervisor goes; the Nucleus owner thread becomes the planner and may itself be
  archived once planning is done ("see how we go").
- **Ownership:** project ownership retires as a standing role ("Do we actually even _want_ project
  owners any more?"): the operator holds authority, and this repository's owner was cleared rather than
  reassigned. The Sol Supervisor was archived the same day.

Design: [Spec 058](specs/058-responsible-tasks.md), approved 2026-11-02.

Installed: rollout step 4 deleted the old lifecycle on 2026-11-02 (cutover
batches 1–7). Every task runs the responsible lifecycle; the per-task coordinator
relay, the Chatterbox and Supervisor routing roles and the old lifecycle's owner,
coordinator and incident panels are gone, and the code runs one lifecycle with no
`responsible` branches. The closeout coordinator (repository manifests), the one
retained recovery thread, the owner verbs as the operator's board surface and
proof admission stay, deliberately.


## Nucleus wire names

The session wire is `nucleus_*`: launches register `nucleus_report`,
`nucleus_ask` and `nucleus_message`, set `NUCLEUS_*` variables, and write only
`nucleus.*` identity labels with the `nucleus` plugin value. The retired
`northstar_*` tools, `NORTHSTAR_*` variables and `northstar.*` labels are never
emitted and never accepted for a live session, and discovery queries ask only
for the current labels.

Stored history keeps its recorded names readable: an archived or terminal
thread, and a process group recorded before Nucleus, are read through the old
labels and the old process-identity marker. A split identity is refused rather
than guessed, and nothing renames what is stored.

Submitted handoffs keep `queue_dispatch: northstar-queue` support permanently;
new handoffs use `queue_dispatch: nucleus`. Stored events, fence and idempotency
identifiers, the review and cancel markers in `core/forge/index.ts`, the hook-commit
trailers in `core/hooks/hooks.ts` and the `queue_dispatch` authorization role are
unchanged.
Plugin-ID discovery knows only `nucleus` (nucleus#971): a Paseo config that
still names the retired `northstar-queue` plugin ID is ignored, not migrated,
and the capacity authority's privileged paths are the Nucleus ones.
