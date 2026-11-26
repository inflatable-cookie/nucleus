# Spec 070 — A small task engine, in Rust

Status: approved (Tom, 2026-11-23: "Approve, let's get this working."). It is built
alongside the current engine, switched on for new tasks, and the old engine is
deleted once its tasks drain.
Replaces the control plane of Specs 050, 066, 067 and 068. Spec 069's lesson stays:
cost grows with active work only.
Audience: engine implementers, reviewers and planners

## Outcome

Tom, 2026-11-23: "The mechanics of tasks are STILL too fiddly, too brittle, too
finicky for agents to manage. We've GOT TO get on top of this." And, on the first
proposal (one escape command): "it feels like the mechanics are fundamentally too
complicated - you're suggesting yet another band aid to a problem that needs a
chainsaw taking to it."

On 2026-11-23 the engine was 283,000 lines of production TypeScript. A task record
had 108 top-level fields plus 72 more in its resolution block, and there were 554
event kinds. A stuck task could be held at once by stops, waits, incidents,
escalations, recovery episodes, effects, run pointers and coordinator bindings. Each
had its own clear command, ID and refusals. On the same day, a brief timeout took
four commands to clear (nucleus#1560), and one task had no command at all, because
every route led into the same proof-gated launch (praxis#391).

The Rust engine has its own [production source line budget](#validation).

The new engine:

- **Stores almost nothing.** It reads the world fresh on every pass.
- **Decides with one pure table.**
- **Recovers mechanical faults itself.**
- **Asks a person only about the work.**

An agent can't get a task stuck in a way that `move` can't undo.

## Rulings

Tom approved the original rulings on 2026-11-23 ("Approve, let's get this working.").
Later decisions carry their own attribution.

1. **The recovery coordinator role is retired.** Code handles mechanical faults. This
   replaces the AGENTS.md product rule "one retained recovery thread handles
   operational faults" when the new engine is switched on.
2. **The planner ladder collapses.** A task's question goes straight to its planner.
   The worker → reviewer → planner rungs, the blocker classification and the ladder
   records go.
3. **Build alongside and switch over.** Don't refactor in place. The old engine gets
   only fixes that unblock live tasks until its tasks drain. Then it is deleted.
4. **The new engine is Rust.** The web board UI stays TypeScript and reads the
   engine's JSON API. The existing board is the basis, not a constraint (Tom: "It
   can reuse the UI we've built - it's not perfect, but it's about 85% of the way
   there", then "it shouldn't just reuse the current UI as is - the basis is good,
   adapt it to the new model though, not adapt the model to the ui!!"). The model
   and API come from this spec alone. The board keeps its layout, theming and
   primitives, and its components are reshaped to the new model. Components that
   exist only for the old machinery are deleted. T3 is called directly over its RPC.
5. **T3 is the only host.** BB and Paseo are dropped, not ported (Tom, 2026-11-23: "Regarding BB and Paseo - I wouldn't be upset if we drop them. I like T3, the workflow can work well.. I'd be tempted to not bother with those two. If I was going to support more ADEs, I would look at something like Zeron, which would get a similar integration to T3."). The host trait stays, so a future ADE gets an adapter shaped like T3's. Tom, 2026-11-24, after a planner assessment of the Orca ADE: "Realistically, Orca + Nucleus would be a strong fit - Orca has a plugin surface so a combination of plugin and ACP integration with the orchestration and task tools would be strong. Orca would be a solid aim for a second ADE to support after T3". Orca is the target second host after T3. Its adapter combines an Orca plugin with the ACP task session (ruling 6) and Orca's orchestration and task tools. Planner reading: work on it starts once the T3 integration is finished.
6. **The ACP task session is a core component.** Tom, 2026-11-23: "Is the fake ACP provider part of the T3 integration? That part would be what unlocks supporting other ADEs with the same workflow so it needs to be a core component". This carries over the 2026-11-17 decision 5e9a3193 behind [Spec 065](065-acp-task-session.md): a generic ACP agent in core, with parenting per host. Nucleus is an Agent Client Protocol agent over stdio with no model. Each task is one ACP session, which is one thread in any ACP-capable ADE. The session presents the task's phase, current run, wait and question, and it carries the five commands. A host adapter adds only how that host parents the worker and reviewer under the session. The ACP agent knows nothing about T3. Workers and reviewers are never top-level threads. They are child threads under the task's ACP session, as in the TypeScript engine. Tom, 2026-11-23: "when I said no worker or reviewer threads, I meant top-level.. it should work with the ACP the way the TS version does now". A person sees one row per task, and each run appears inside it as that session's `tool_call` (ruling 7).
7. **The ACP session is written for a person.** Tom, 2026-11-23: "I would like the Nucleus ACP to be much more human friendly than it is now - provide actual useful feedback about the task as things happen, avoid too much noise, make it obvious what each sub agent is doing." The rules:
   - The lifecycle is one ACP `plan`. Code tasks show Queued, Working, Review (round N), Merge and Close. Report-only tasks show Queued, Working, Report ready and Done. Each step is pending, in progress or done. A wait shows as that step's status (for example, "Waiting for a review slot"). Waits are never messages.
   - One lifecycle audit projects the plan, the task detail's progress strip
     and the task session's role cards from the committed task and local records.
     Applied reviewer verdicts determine the round.
     Role durations use the recorded send and report times. A reservation alone
     does not start the clock. The task retains its worker and reviewer bindings
     between runs.
   - Each worker or reviewer run is one `tool_call`, titled with its role and what it's doing ("Worker: adding the retry test", "Reviewer: checking round 2"). It's updated in place with the agent's current activity and elapsed time, drawn from the observed turn: the running command, a file being edited or tests running.
   - A role's outcome is one message on its card. The transcript also records the task's finish and any decisions made outside a run.
   - No noise. Retries, timeouts, deferrals, unknown reads and repeated identical states produce nothing. A state that persists becomes a status change, shown once.

   Tom approved the transcript design on 2026-11-24 (“The mockup looks good,
   lets try it”). A short step label opens the turn. Its hold identity stays
   in metadata. Each run has one card with its role, provider, model, start
   time and link to the child thread. The same card survives reattach and
   gains a duration and one outcome when the role finishes. Every worker
   outcome includes a one-line summary, with a PR link when available. A
   reviewer shows the verdict and findings. A question stays actionable in
   the role's outcome until answered. Waits update the plan once per episode.
   The finish records the merge or report, closure, elapsed time and review
   rounds. All of this comes from engine records without additional T3 reads.
   Card updates reuse the run instance, and plan updates reuse the session plan.
   Parent holds end with their existing launch or child custody. The next
   update or attach shows outcomes and the finish from the lifecycle audit.
   When the engine has no recorded change summary, the worker outcome says
   so. If the recorded send and report times cannot establish a duration,
   the finished card says it is unavailable. Older cards show participant
   details when an exact binding survives. Provider and model show as
   observed only with evidence from that exact run. Otherwise the card labels
   any recorded assignment and leaves missing details unknown. Previously
   journalled hold payloads replay with their original text.
8. **The settings carry over.** Tom, 2026-11-23: "we need to make sure the vast majority of the settings view comes over - all the profile management, limits, projects, etc need to transition over.. adapted to the new model". Profiles and model selection, dispatch limits (slots and usage levels; no machine-load gate, ruling 21), projects (repositories, planners and lanes), storage and host settings are part of milestone 2. They're reshaped to the new model: settings for machinery that no longer exists are dropped. Tom, 2026-11-23: "Feel free to tidy up / improve the project management system as that's transferred - it's currently OK, but a bit fiddly" (meaning the Projects section of Settings; planning can be improved too, see [Planning model](#planning-model-milestone-3)). The Projects section keeps:
   - each project's name;
   - its repositories (origin, path, base branch);
   - per-repository merge checks (command and timeout), with an optional required reviewer;
   - its verified planners, shown from their live bindings;
   - an archived toggle;
   - removal. Tom, 2026-11-24, after the port had left only the archived toggle: "Yeah, let's get removal back in, as per your spec". The planner's proposal he accepted:
     - The board's project selector offers Archive and Remove. Its saved filter binds to project identity across registry changes. A unique legacy filter migrates on read. Removed projects still count when checking whether its old name had more than one owner. An ambiguous legacy selection asks the operator to pick again. The board and Settings accept project names up to the registry limit of 240 UTF-8 bytes. Project names use regular-weight card title text, with full foreground on hovered, focused, checked or open rows (Tom, 2026-11-24). The Rust board applies Spec 026’s two-item, three-day activity rule using work timestamps and linked planning items. Housekeeping events leave the last work timestamp unchanged.
     - Archive hides the project from the selector and refreshes the board's planning counts.
       Restore in Settings → Projects reverses it. Both actions write the same archived flag.
     - Remove ports the TypeScript removal dialog. It previews blockers, refuses while tasks are open or offers to cancel them, then deletes the project and its planning records.
     - Finished task history stays readable by repository, but nothing new routes to the removed project.
     - Rust refuses removal while tasks are open or a bound role shows active work. A leftover run record alone does not block a finished task's project removal.
     - A removal receipt blocks first-contact registration until an operator explicitly re-adds the repository through the Projects settings API. First contact verifies its T3 route again. A project ID can be reused after its old planning cleanup commits. Startup recovery and receipt replay preserve planning in the recreated project. Finished tasks from the removed project remain in history and cannot be reopened.

   It drops agent registration and the preferred and responsible thread fields (rulings 2 and 23), QA settings (ruling 12), Paseo and BB fields (ruling 5) and the separate dormant-projects view. Repository routes come from first contact (ruling 23). Editing autosaves, one noun per control, with explanations only in help popovers.

   Tom, 2026-11-24, confirmed that one project can contain several repositories. It keeps its stable TypeScript key, display name, plan and lanes. Settings can move a repository in one save and its verified planners follow the repository binding.

   **Profiles.** The shared editor reads and saves the paired engine's stored
   profiles. Provider and model use the engine's held T3 config catalog. Refresh
   reloads that cache through the paired API. If T3 is unavailable, the editor
   reports it and keeps the last usable choices for the lifetime of the service.
   Profiles uses the dispatch resolver and the current cached catalog to show
   each profile's subscription group. An explicit group takes precedence over
   an instance pin or the instance that can launch the model. Profiles without
   a resolved group do not add a Pause control. Paired sessions read stored
   enabled flags, subscription pauses and recorded usage even when their
   Settings controls are read-only. Only an authenticated
   operator session can edit. Usage strips show up to the last 50 assignments
   in the selected view across both roles or for one role.

   **Limits (Tom, 2026-11-24).** Dispatch owns the global limit, per-project default and a sparse map of overrides keyed by project. Limits is the shared editor for all three. Edits to the global ceiling and project default use the Dispatch revision displayed in Settings. A conflict refreshes the values for a new edit. A run needs room under both ceilings, counting the project's member repositories together. A first worker checkout also needs room under twice the effective project limit. An existing managed checkout counts while its task is nonterminal, including when the task is held or awaiting recovery. An absent checkout occupies no workspace capacity. Review entry and existing work continue through their own gates. The Rust Limits editor shows usage, global slots, the project default and project overrides. It omits Concurrent host calls and the Advanced disclosure. The TypeScript editor remains available during drain.

   Fresh installs start at 32 global slots and 5 per project, matching the TypeScript defaults. During cutover, `limits.import` read five capacity and retention meta keys from a fenced TypeScript copy and published them to Dispatch under the stopped profile lock. Projects without an imported override inherit the per-project default. The active CLI retires this command in milestone 4. The settings loader accepts profiles written with the retired import marker.

   Tom retired Papercuts slots, Stall threshold, Hold reminder, Hold escalation and Host outage notice on 2026-11-24. Ruling 12 retires Lane drain and Lane drain escalation. Default host stays. Tom, 2026-11-26: “those mechanics were valid - we may only support T3 now, but I was aiming on adding support for most ADEs so it would have still come into place”. Its options are the registered hosts plus the planner's host, never a static list of supported host kinds. A stored kind absent from registration stays unavailable and is not rewritten. The import carries retention settings ahead of the scheduler pruning change.

9. **The profile matrix carries over exactly.** Tom, 2026-11-23: "The profile matrix we agreed earlier definitely needs to come over, we've finally got that working just as I want it". The usage-level matrices in [Spec 052](052-usage-level.md), as amended on 2026-11-23, are ported cell for cell. That covers worker start brackets by complexity and level, the reviewer bracket relative to the worker, the step-up after an applied changes-required review, the smoothed Maximum, the Frontier request rule and critical tasks. So is [Spec 053](053-demand-based-selection.md)'s demand-based selection (the five-stop weight slider). They become pure functions with a test for every cell of both matrices, matching today's `test/demand.test.ts`. The only change is that the retired coordinator role drops out. A climb to a new profile starts a new worker child thread, as the TypeScript engine does. Tom, 2026-11-23: "The current TS policy of creating a new child thread is correct, we won't be able to switch profiles in the same thread when they have different providers".
   New tasks and item promotions require `queue.complexity` in the brief. For a papercut, the board choice or `item.promote --complexity` supplies it in the task brief. Board promotion sends the selected repository with that complexity. Existing tasks remain readable. A High or Very High admission at Low usage commits its operator decision with the task. The scheduler waits for approval through the Inbox, preserving independent holds. Raising usage or lowering complexity below High withdraws that permission requirement.
10. **Reuse in-house crates.** Use Longhorn for configuration and anything else that
   fits (Tom: "use longhorn for config and anything else you think would be
   useful"). Barge provides worktrees when its pool setting is on.
11. **Keep it light: reads and edits never call the host.** Tom, 2026-11-23: "We need to keep things light and optimised - remember to treat CRUD operations separately from scheduler interactions with the host and to avoid hammering the host with calls". The rules:
   - Board, ACP, CLI and settings reads and edits (create, read, update, delete) touch only the store and the in-memory read model. They never call T3, GitHub or the process census. A command writes its row and wakes the task, and the scheduler does any host work on its next pass.
   - Only the scheduler talks to hosts. Each pass makes one bounded set of host reads per host, shared by every task in that pass (for example, one thread listing rather than a read per task). It reads one thread or PR exactly only when a due decision needs it.
   - Host calls are serialized per host. The Rust Dispatch domain ignores an old Concurrent host calls value on read. An unavailable host backs off to a due time.
   - Views update by push (task and version invalidations), never by polling. Nothing a viewer does causes a host call.
   - Tom, 2026-11-24, after T3 began deferring the engine's requests: "Nucleus needs to be light on calling T3 - I did ask for that more than once". Following TypeScript's `T3Reads` (one held shell subscription, thread snapshots reused while their change marker holds, exact reads only for threads a command just wrote to) and `reconcileTaskRow` (write a title or snooze only when it differs), a pass with nothing changed makes no thread reads and no writes. Each pass records its host call counts. A host deferral is honoured as a due time for the whole host, never retried sooner.
   - Tom, 2026-11-24 (fourth time of asking): "we need to audit the system for any place that calls T3, justify its existence and make sure it's asking for the minimum amount of information it actually needs, and on a reasonable schedule". From that audit, every T3 call follows these rules:
     - One held shell per host answers project, lifecycle, identity, title and visibility questions. No one-shot shell reads.
     - Thread reads are bounded and decide from T3's coverage fields. A full thread history is never requested.
     - Monitoring reuses a thread's last observation while its shell marker holds. Exact reads happen only for a due effect, an ambiguous reply or an ordered safety fence, and one read is shared across the steps of that effect.
     - Done thread housekeeping uses the synchronized shell. It makes no thread reads on ordinary ticks.
     - Presentation writes (titles, snoozes, refreshes) happen only when the shown value differs. Readback is due-scheduled, never immediate, and never after a failed write.
     - One host budget covers every background worker. Safety probes and operator actions come before presentation. One failure deadline applies to every call and reconnect.
     - Rare reads (provider catalog, setup) happen on demand and are cached by revision, not refreshed per pass.
     - Each pass records its host calls by method, timeouts, and reads of terminal or archived threads.

   `hasMoreHistory` describes the history window. `turnItemsOmitLocalVisible`
   describes the compact timeline representation. Native run and request
   evidence keeps its meaning in either form. Custody checks use the rosters and
   the held shell's background-work summary for the same settled revision.
   Workspace custody also needs a quiet local process census. Delivery follows
   the matching native run or the command receipt. A missing timeline item
   cannot prove past delivery or absence. T3's `message.dispatch` deduplicates
   the exact frozen command ID, so a parent hold pinned to the ACP provider and
   model can queue while busy and reconcile an ambiguous send under that ID.
   A pinned retry reuses the original intent and prompt. A check that fails
   before an intent is recorded leaves no attempted-send record. A refusal
   after that point names its exact attempt. Re-entry uses one bounded read
   to identify the ended hold and rechecks current child activity, parent
   availability, binding and operator snooze at send time.
   Older parent holds still require an idle thread. Delegated launch absence
   still requires an exact terminal parent run and an authoritative child absence.
   New retained role continuations pin provider and model and can enter the
   native queue without waiting for idle coverage or a prior send deadline.
   The engine respects operator snoozes and checks the exact destination. A reservation proven
   unsent is replanned with a pin and a fresh command ID. For an older
   reservation that may have been sent, the engine waits for matching native
   evidence and uses the actual run's provider and model when it observes it.
   Done thread housekeeping follows ruling 34 after checkout removal. The
   synchronized shell supplies the known task, reviewer and worker rows and
   rechecks the target before dispatch. Closure follows when all three are
   archived, deleted or absent from the shell.

   The same synchronized row keys a decision and its final write fence. It
   confirms a presentation write when it shows the intended change. Planning
   and wire both require held evidence that attached and retained children
   are quiet before snoozing. Parent and role messages clear settlement on their own destination at dispatch. Planner notices share a
   bounded observation for delivery and authorization. Inbox reconciliation
   uses the shared shell for project and lifecycle and reuses its bounded
   observation while the marker holds. Explicit setup checks on a bounded
   schedule after a mutation. Status shares one native client for registration,
   Inbox state and favicon.

12. **Planning moves in at milestone 3, simpler.** Tom, 2026-11-23: "Yes, they will need to go in in milestone 3. Planning can be optimised, made a bit simpler, tasks shouldn't _need_ to be a lead first before promotion - leads should be ideas that can be turned into tasks, papercuts are issues that can be turned into tasks (still using the same surface just with a type), if you're just adding a task it can go straight on the board though. QA doesn't come across - we've already removed it from the TS version with QA sessions going in as normal task record". The rules:
   - Plans, lanes and lane documents, decisions, leads and papercuts move into the Rust service in milestone 3, as plain local records under ruling 11. Existing records are imported once from a rehearsed copy.
   - Leads and papercuts keep their names and share one surface, told apart by a type (`lead` or `papercut`). A lead is an idea and a papercut is an issue. Either can be promoted to a task, but neither is required: a task can be created directly and goes straight onto the board. Tom: "I didn't mean to literally rename leads and papercuts!!"
   - During cutover, `project.import` restored registry membership, plans and lane documents from the fenced TypeScript copy. It moved imported items and their history to stable project keys, kept repository task numbers and reported conflicts before publishing. The active CLI retires this command in milestone 4. An interrupted publication still fences startup. If a restored profile holds a pending journal, the operator must authorize forward recovery of the recorded Projects settings before serving it.
   - Milestone QA is not ported as its own record. A QA run is an ordinary task with a report, like any other.
   - The planning system may be simplified as it moves. Tom, 2026-11-23: "Feel free to tidy up / improve the project management system as that's transferred - it's currently OK, but a bit fiddly". See [Planning model](#planning-model-milestone-3).

13. **No Nucleus-held merge turn.** Tom, 2026-11-23, approving the planner's surface review ("Sounds good, go for it"). The engine merges at the exact approved head and lets GitHub's mergeability and required checks decide. A project's pre-merge validation is a GitHub check (CI or a required status), not a Nucleus turn. There is no per-repository integration turn, prospective-merge candidate, warm checkout, `task.pre_merge` hook manifest or closeout reservation. Tonight's old-engine deadlock (concurrent merge intents each waiting for a turn none could take) is the reason.

    A task with a retained worker goes back to that worker when GitHub confirms
    a conflict or a read verifies that the base moved at the approved head.
    The ordinary readback after a refused merge can supply that evidence.
    Confirmed required check failures return with the check names GitHub marks
    required at that head. Pending checks wait. Non-required check failures do
    not block merge when GitHub reports the PR mergeable; there is no
    Nucleus-side checks list (ruling 53). Incomplete
    evidence and unrelated branch protection keep their own gates.
    Recovery retires the old merge authority and freezes the instruction in
    the retained worker's next run. It uses the same provider and model and
    keeps the native command ID on replay. The worker publishes a new head
    for independent review. If it reports the same head, the task asks for a
    revision and waits. A legacy merge-blocked work answer or
    `move <task> work --instruction …` uses the code worker continuation.

14. **Messages go by project, through the host adapter.** Tom: "we sometimes need to send a message from one planner to all the others".
    - New messages address a project, a list of projects or `all` planners. Rulings 40 and 41 below govern exact replies, claims and fallback delivery.
    - Nucleus resolves each project's current planner from the in-memory authority snapshot (ruling 11). It then hands the text to that planner's host adapter, whose one delivery operation queues a notice and never steers a running turn. T3's adapter un-settles a settled thread to deliver. An adapter for another ADE implements the same operation its own way, so a broadcast can reach planners in different ADEs at once.
    - Each message names its sending project. Its recipient can reply directly to the sender for seven days (ruling 40).
    - Each recipient's delivery is recorded (queued or delivered) so the sender can see who it reached.
    - The Rust CLI takes `nucleus tell <project|all> <text>`, with repeated `--project <id-or-name>` for a list. IDs take precedence over names. A name shared by multiple projects requires an ID. The caller needs an existing verified planner binding for the sending project, and can address any active project. `all` snapshots the active project IDs for that request.
    - A project address prefers the live claimed planner, then the most recently verified eligible planner. Both exclude the sending thread. When recipient proof is cold, the scheduler verifies saved candidates against the exact thread and checkout before admission records any deliveries. After an inconclusive check, that recipient is reported as having no live planner for this request. Other verified recipients proceed, and the saved binding remains available for a later check. A list or broadcast groups the resolved projects by exact thread and names each group's projects in one notice. Definitive rejection before delivery allows a fresh attempt. An uncertain send retains its exact binding for readback. Native queue acceptance stays queued until the receiving turn starts.
    - Messages allow 4,000 UTF-16 units. Project addresses allow 20 new messages per receiving project per hour. Each receiving thread can take 20 deliveries per hour across routes. A request that reached no recipients can be retried immediately. An identical retry with receipts returns the originals within the hour and while any delivery is outstanding. Repeated content from the same sending thread shares each recent or outstanding project receipt. Replies are scoped to their handle.
    - The task question stays the only blocking ask: one per task, answered by its planner.
15. **A small CLI and skill.**
    - The CLI covers the five commands and the planning verbs, takes plain arguments, and identifies its caller by binding token, with no host identity lookup.
    - The skill shrinks to a page or two.
    - This sets the target for milestone 4's documentation rewrite.
16. **Diagnostics you can read.**
    - The audit keeps a small set of typed events (the milestones the ACP session shows, plus faults).
    - One health endpoint reports queue depth per host lane, the oldest waits and host status, readable without opening the database.
    - There is no catalogue of hundreds of event kinds or telemetry stages.
    - The planner ruled on 2026-11-24 that a pre-wire refusal names the failed
      predicate and the relevant compared values. The diagnostic omits secrets
      and message contents.
    - Task rows and detail name the check and show its due time while scheduled.
      After an inconclusive delivery check, the owner opens the task thread to
      verify the outcome. The UI reports a host fault only when there is evidence.
17. **Settings beyond Projects shrink too.**
    - Hosts lists ADEs registered with the engine, not static supported host kinds; the Default host picker uses those registered hosts plus Planner's host. Paseo and BB are not offered by a static list.
    - Storage folds in backups, retention and worktree roots.
    - Each task has one wall-time allowance. Very Low and Low start with 60 minutes, Medium with 180, High with 480, and Very High with 960. A pinned repository tree declaring the Effigy `test:affected` selector doubles the Low and Medium allowance. Existing briefs without complexity use Medium. Admission records the declaration once.
    - The clock starts at the first run reservation. Holds, waits, dispatch pause, host outages and service downtime do not spend it. Tasks already running at cutover begin accounting at their first observation under the new clock when their historical exclusions are unavailable.
    - At the first spend, Nucleus grants one default increment above the greater of use and the current limit. At the next spend, the task waits before another run and asks its planner to extend under approve-by-default, including beyond twice the default. A sent run finishes under normal custody. The task detail and `next` show measured use and limit.
    - The profile matrix is unchanged (ruling 9).

18. **One pinned Nucleus Inbox.** Tom, 2026-11-23: "do we get the equivalent pinned Nucleus Inbox thread via Nucleus ACP? That is vital to my workflow".
    - The planner ruled on 2026-11-24 that the board preview opens once when T3
      first synchronizes, after a real disconnect and reconnect, or after a
      runtime replacement. Routine subscription rotation invalidates shell
      proof and resynchronizes without opening the preview. Typing `ui` still
      opens it on request.
    - The title shows pending operator decisions first, then the host's running tasks, then `All quiet`. `Paused: ` covers Pause, Dispatch hold and Stop. The engine derives the counts locally and updates only the title metadata using a new receipt generation when the text changes.
    - The ACP agent has an inbox session alongside task sessions, carrying over Specs 032 and 065: one pinned inbox session per host. Each operator decision appears as a native form answered in place, and the answer reaches the asker on the ordinary answer path. A task session never takes a decision; it names the decision and points to the Inbox.
    - Before native Rust Inbox setup, the scheduler sent Rust operator questions
      through the TypeScript decision store. Both pins could coexist during
      cutover. Each active Rust bridge version had to return a recorded answer
      or confirm withdrawal before the scheduler could offer it in Rust.
    - Milestone 4 retires the TypeScript decision bridge and its Rust client.
      A restored profile that still holds a legacy decision binding keeps its
      native offer fenced until the operator authorizes forward recovery.

19. **Configurable storage; an external volume is opt-in.** Tom, 2026-11-24: "Need to make sure the rust version uses paths on Stash when it gets going - should all be configurable, need the config in place so we don't churn on the internal SSD", then "An external drive shouldn't be a requirement - most people won't want that. It should be opt-in, default to sensible internal drive locations".
    - Storage exposes the active roots and the configured placement for worktrees, scratch and builds. Existing explicit roots take precedence. `TMPDIR`, `TMP` and `TEMP` for engine commands point at scratch, which also holds run tickets and evidence.
    - New runs reserve `<scratch-root>/r/<12-hex run key>`. The key is derived from the run instance, and the absolute directory is frozen with the launch. The assignment and custody checks use that directory. Older reservations keep their original paths. This keeps room for local Unix sockets under the assigned `TMPDIR`.
    - Placement follows Barge's resource classes and is entirely optional. Tom, 2026-11-24: "We shouldn't be using a `nucleus-engine` folder in the root of stash - we're trying to keep it clean … Happy for it to be on Stash, but it needs to be organised as per Barge's class system, and it needs to be entirely optional."
      - The engine home (database, settings, keys, local configuration and schema backups, and the service log) is durable state that no Barge class holds, so it always stays on the internal drive. It defaults to `~/.nucleus`, where the TypeScript engine kept its data; during the transition the Rust home is `~/.nucleus/engine`.
      - Bulky expendable data goes where Barge places its class: worktrees in the `worktrees` class (`worktrees/nucleus`), scratch and run evidence in the `scratch` class (`scratch/nucleus`), and install builds in the `builds` class (`builds/nucleus`). The engine asks Barge for those class paths when the operator enables Barge placement. Without Barge, they use the internal platform defaults.
      - Nothing is written at a volume's root. When Barge placement is on and a class's volume is absent, the engine refuses to start rather than falling back to the internal drive.
      - Existing volume-pinned profiles remain readable and keep enforcing their pin until the operator moves the profile and explicitly clears it. See the [offline move procedure](../../../engine/README.md#move-an-existing-engine-home).
    - The rule covers the engine's own roots. A project's registered checkout and its Git common directory belong to the project and stay where the operator keeps them, as with the TypeScript engine's Stash worktrees today. Git's small per-worktree metadata and the task's commit objects land in that common directory. The bulk (worktree files, build output, dependencies, scratch, logs and the database) stays on the configured roots. The engine never makes its own clone of a project to satisfy this (planner decision, 2026-11-24).
20. **One binary.** Tom, 2026-11-24: "The single binary is perfect yes".
    - The engine ships as one `nucleus` binary with subcommands: `serve` runs the service, `acp` runs the stdio ACP agent, `ensure` starts the service when it isn't healthy, and the other subcommands are the CLI.
    - `serve` can name its process `nucleusd` so the daemon is recognisable in process lists. There's no second binary.
    - The CLI, the ACP agent and the service then share one build and can't drift apart.
    - Milestone 3 does the fold. The pilot's `nucleus-engine` and `nucleus-acp` binaries and the Python startup helper are interim. When `ensure` moves into the binary, the service opens its storage before binding its port, so a caller sees only "refused" or "healthy".
21. **No machine-load gate.** Tom, 2026-11-24: "running tasks on the queue isn't the load issue, it's them running tests, etc, which is ultimately a separate problem. We shouldn't hold up doing task work because the machine is loaded".
    - Dispatch never reads the machine's load average. Slots and the allowance are the only dispatch limits.
    - Heavy test runs are dealt with where they happen (each repository's test selection and concurrency), not by holding task launches.
    - The Dispatch settings domain drops `max_load`, and a saved domain that still carries it loads with the field ignored.
22. **Native task titles.** Tom, 2026-11-24: "We need proper thread titles again - take the naming policy from the TS version".
    - Finished task threads archive independently of workspace cleanup. A retained checkout stays visible on the board and in Next.
    - Tom, 2026-11-24: "We'll need the generated project badge icons that match T3 (the screenshot shows a card from rust version and a card from TS version) along with task numbers". Each repository gets its own durable allocator. Seed it from the fenced TypeScript allocator before admitting into a migrated repository and backfill the three pilot tasks in admission order.
    - The task row shows `<State>: #N <brief title>`. Worker children use `#N: <brief title>` and reviewer children use `#N review: <brief title>`. T3 already shows the project. Use the assigned number without padding, and omit the number until it is assigned. Strip a trailing `worker` and fit the title to the host's limit at a word boundary. Update existing live task rows through the title receipt. Already-launched child titles keep their frozen value.
    - Rust CLI task commands and task API paths accept `repo#N` wherever they took only an internal task ID. The engine uses its assigned numbers and the authenticated controller's scope. Bare `#N` requires a project with exactly one repository. When a slug matches multiple visible tasks, use `owner/repo#N`. Internal IDs remain valid.
    - The Inbox title shows decisions first. Its running count follows visible,
      unfinished Working rows with a child holding an active turn or positively observed
      background work, or a two-minute handover after the child ends,
      using the held shell. With neither decisions nor Working rows it reads “All quiet”.
    - Tom, 2026-11-25, on finished tasks reading "Starting" while closing: "it's pretty confusing. Can we improve the labels?" The label leads with the phase: Queued, Working, Reviewing, Changes, Merging, Closing, Done or Cancelled. Starting means only that a worker or reviewer launch is in flight. A hold that does not block adds `*` to the phase. Done and Cancelled take precedence over waits.
    - Tom, 2026-11-25: ‘The "you snoozed this thread until…" messages need to go - these are working threads, not snoozed, and T3 already tells me how long a thread has been snoozed from in the UI if it is snoozed. this is just noise, and means I can't read what the task actually is! State labels should be 1 to 3 words, longer is an exception, this is WAY too long’. A row label uses at most three words, including the phase and an optional short cause, as in "Queued · capacity", "Reviewing · paused" (a capacity wait on a paused subscription group, ruling 51) or "Closing · GitHub". Snoozed rows keep the same current title. T3 displays the snooze deadline. A matching Nucleus receipt owns its horizon until the shell observes the clear.
    - Retitling is a scheduler presentation effect. A new desired title gets a durable receipt and a fresh native command ID. Retries keep the same ID and back off from five seconds to five minutes. The title write uses the existing synchronized shell proof, never gates task progress or archival, and confirms only when synchronized shell readback shows the desired title. A confirmed generation whose held shell still displays older wording is reopened under its existing command ID while preserving any newer generation, and an idle tick with matching or absent shell readback makes no native call.
    - One local attention projection feeds the board and `task.next`. A missing or cancelled prerequisite needs an owner edit.
    - **T3 task rows follow one rule.** Tom, 2026-11-25: "The logic doesn't need to be complicated - if an agent is running, put it in Working, otherwise Snooze it until it's done, then Archive. It needs a little bit of smoothing off so they don't jump between Working and Snoozed when transitioning states. It shouldn't need to be this complicated?" This replaces the attention-based row reconciliation and its special cases.
      - A row is visible while a worker or reviewer child is running, as the held shell shows it.
      - Otherwise the row is snoozed until the task finishes. A finished task's row is archived.
      - Smoothing (planner reading): a row shows as soon as a child is running. It snoozes only after no child has run for two minutes. Handovers and Nucleus's own sends inside that window leave the row as it is.
      - Tom, 2026-11-25: "we could use "Waiting" while in the Working group to show when a thread is waiting for something imminent". During the two-minute window the row stays in T3's Working group and reads Waiting. When a child runs again the visible row shows its task phase. Otherwise it snoozes when the window ends.
      - Tom, 2026-11-25: "Questions and decisions need to bring the row back". A task with an open question or decision for a person is visible until it is answered, in addition to its Inbox entry. Operator snoozes are respected.
    - A waiting row gets a 48-hour snooze, renewed with less than 24 hours remaining. Nucleus records the wait episode and horizon before dispatch and confirms a snooze from T3's `snoozedUntil`. A refusal or unknown delivery stays recorded for that wait. Showing a row clears only the exact owned horizon. Finished tasks forget their record. Background reconciliation leaves settled, archived and deleted rows and operator snoozes alone.
    - A native message can wake the exact Nucleus-owned snooze on its destination. T3 clears settlement when it dispatches the message. Child activity drives parent visibility through row reconciliation. Operator snoozes defer delivery. Nucleus never sends a settle command.
    - A retained role can send directly to its own thread. The scheduler uses
      the exact parent read under the task fence to hold delivery while an
      operator snooze is in effect. It records Starting with the first role send intent and
      updates the native title through the existing receipt.
23. **Projects register on first use.** Tom, 2026-11-24: "We need nucleus to work seamlessly on a fresh install where a new planner thread without any ceremony can start dispatching tasks and the project gets registered in the db".
    - When an unknown T3 planner calls a planning command, the scheduler reads that exact thread and uses its root from the synchronized project snapshot. It reads both origin remotes and the default branch at that checkout. It attaches the verified T3 checkout to the matching repository in its project, or creates a project with the T3 display name for a new origin. The initial request asks for a retry. Admission defaults to the caller's verified repository. An explicit repository must already have its own verified checkout in the same project.
    - Several verified planners can bind to the same project through any of its repositories. Projects settings retain those thread IDs with their native project and repository route. After restart or loss of host observation, the scheduler rechecks a candidate on demand against the exact current T3 identity and checkout before restoring authority. A positive read that the thread is gone, archived, a child or in a different native project removes the binding. Uncertain reads and checkout mismatches keep the record pending verification.
    - Task commands accept any live planner binding for the project. A command missing PR-head evidence reads it within the request and checks the same task revision and caller before committing. If the proof times out or fails, the caller receives the cause. Nucleus does not queue the command for later replay. Notices try the task's origin first and fall back to another verified planner in the project after positive evidence rules the origin out. An unresolved origin read leaves delivery pending.
    - The remote and exact-root checks run automatically at registration. A mismatch refuses with a readable reason.
    - Limits edits slot counts in Dispatch. Planning edits lanes. Projects shows the live planners. Dispatch uses the verified repository route automatically.
    - During the transition, one global setting stops the TypeScript engine taking new work. Its existing tasks drain.
24. **Host setup commands.** Tom, 2026-11-24: "we'll need the `nucleus t3 install/uninstall/status` surface for setting up the ACP, etc".
    - `nucleus t3 install` registers the Nucleus ACP provider through T3's provider mutation, idempotently, with no T3 restart and other providers untouched. `uninstall` removes only that provider. `status` reports the provider, launcher, engine health, version and storage roots.
    - Install keeps the launcher under the engine home. Explicit `install --adopt` can update the launcher of an existing local `nucleus-rust` instance in place. A conflicting registration otherwise stays untouched.
    - Install also creates the pinned Nucleus Inbox session (ruling 18) if it's missing, or adopts the existing one, so a fresh install has its Inbox with no further steps. Uninstall unpins and archives it; decisions stay in the store. Status reports the Inbox thread. Tom, 2026-11-24: "The install/uninstall surface should also set up / tear down the pinned inbox thread, right?"
    - A later ADE gets the same three commands under its own name.
25. **Subscription groups pause on confirmed provider limits** (planner decision, 2026-11-24).
    - The adapter requires a failed native run started by the reservation's message and a usage-limit classification, provider payment refusal (402), or quota-specific 429 on its latest failed root error. An active run, an earlier or nested error, unstructured text and an unknown read cannot establish a limit.
    - A bounded thread can prove a terminal failure. If the compact view omits its error, use the held shell's lookup of the presented run's latest failed root error at the matching revision. This adds no per-pass host request.
    - The scheduler excludes the run's subscription group until the error's reset or the latest reset among exhausted windows on the run’s provider that explicitly cover its model or model family. When neither gives a usable reset, pause for 24 hours from the failure. Next and Profiles identify the reset as unknown. An operator can clear that fallback in Profiles after topping up. A known or operator deadline takes precedence and stays protected. The deadline survives an engine restart and expires automatically.
    - Profiles settings can also pause a group until an operator edits the setting. Both pauses apply across roles and projects. An otherwise eligible task waits for Capacity until its earliest eligible reset or a settings change.
    - A terminal provider limit without an authenticated report skips the reminder and uses the role’s existing attempt budget. Retry on another eligible profile, or wait for the reset when the exhausted profile is required. Next records the last settled role’s subscription and reset. At exhaustion, the existing planner retry question or report-only block includes that cause. Existing send receipts and verified replay rules still apply.
26. **Inbox answers carry the TypeScript trust level.** Tom chose this on 2026-11-24 after the planner found that T3 records no author on a native form answer: a person's click and an agent's `t3_pending_request` reply are identical, in the TypeScript Inbox as well.
    - A pinned Inbox form can appear in raw turn items or in the compact snapshot’s local visible items. It must match the pending request on the Inbox thread.
    - The Rust Inbox accepts operator answers from its pinned session's native forms, the same trust the TypeScript Inbox has today. The recorded actor says the answer came through the T3 Inbox; it never claims the answer was attested.
    - Agent instructions forbid answering Inbox requests or operator decisions.
    - Request for T3: server-attested provenance on a request response (UI versus MCP or relay, bound to host, thread, request and choice). When a host provides it, the engine requires the UI source for operator-only decisions.

27. **Inbox commands.** Tom, 2026-11-24: "I could send `ui` as a message and it would spawn the UI in the browser. I need that, and I would like to expand it to a full command interface via the ACP", then approved this set: "That looks great. Go for it".
    - The pinned Rust Inbox currently accepts `ui`. To change slots, enter `ui` and open Settings → Limits. The approved command set for the port is: `ui`, `settings` and `help`; `status`, `tasks [project]`, `task <ref>` and `decisions`; `pause`, `hold`, `stop` and `resume` (the board's pause modes); `hold <ref> [reason]`, `release <ref>`, `cancel <ref>`, `move <ref> <phase>`, `accept <ref>` and `decline <ref>`; `level <low|normal|high>`, `slots <n> [project]` and `tell <project|all> <text>`.
    - The port uses one parser for the same service APIs as the CLI and board. Reads and browser commands run at once. Mutations confirm first. Each message is served once, and unknown input replies with help.
    - Commands come only from operator messages typed in the T3 UI. Installed T3 records those as `createdBy: user`, `creationSource: web` with no sender, while agent sends through MCP or the `t3` CLI are stamped `agent`/`mcp`.
    - A mutation is confirmed by typing `yes` as the next message (planner decision, 2026-11-24). One command can be pending; it expires after two minutes and any other message cancels it. Typed `accept` and `decline` answers are recorded as attested. Native form answers keep the ruling 26 trust level and are recorded as unattested.

28. **TypeScript features retired at cutover.** Tom, 2026-11-24, from the source inventory triage: retire author-side proofs and the proof executor (proof files, receipts, the GO release gate); worker and reviewer checkpoints ("Context limits shouldn't be a problem? Context gets compacted and it just continues?"); and interactive tasks. Task dependencies are ported. Retired with earlier rulings: merge check command and timeout, and the optional required reviewer (ruling 13); repository rekey, bulk dispose, reparent, detach, outcome search and removal, review-entry reconcile, receipt acceptance and task registration (rulings 1, 2 and 15); planner handover (ruling 23); and TS-only runtime settings. Everything else in the inventory is ported from the TypeScript source, which is the reference for migrated behaviour.

29. **Role protocol and run facts.** Tom agreed to this split, as reported by the
    Nucleus planner on 2026-11-24. AGENTS.md owns each repository's validation
    selectors, test bounds, changelog format and project-specific scratch
    instructions. The installed Nucleus skill owns the shared worktree rules
    and worker and reviewer protocol. Each assignment carries the run's
    identity, brief, relevant recorded context and authenticated report route.
    When the selected provider does not advertise the matching installed
    protocol, the engine includes the same skill sections with the assignment.

30. **T3 owns the engine's lifetime.** Tom, 2026-11-24, asked the engine to
    start with T3 and exit after the last host disconnects. The pinned Inbox
    uses the ACP ensure path on reconnect. Shutdown waits 300 seconds, matching
    TypeScript's `idleTimeoutMs` in `service/standalone.ts`. A reconnect within
    the grace period cancels shutdown. After the grace period the engine
    reaches a durable safe point, releases the profile lock and listener, and
    exits. Normal startup reconciliation checks existing tasks.

    Tom, 2026-11-24, confirmed the [Spec 069 restart rule](069-scheduler.md#2-host-health-is-the-connections).
    A roll leaves live workers and reviewers running in T3. An uncertain
    in-flight send is the only live-role condition that defers a roll. After
    restart the engine re-reads the recorded role's native evidence before
    deciding what to do with the assignment.

    `nucleus report` retries transport failures before an HTTP response for
    up to 60 seconds. It sends the same body and credential to the same run
    endpoint on every attempt. An HTTP refusal ends the request. An existing
    assignment pinned to an older binary keeps that binary's single attempt.
    If it hits the restart window, the role can retry the same report when
    the endpoint returns, while the run still accepts it.

    T3 requires an active parent turn to launch a delegated child. Tom kept
    the scheduler's read-only hold during launch preparation. The held turn
    follows the task through preparation, reservation and send, and stays
    open while the role child is active. Dispatch mode and uncertain reads
    leave a live hold intact. It ends when the task is terminal or waits
    with no active or pending role. Terminal and agent prompts render the
    current view and end normally. Mutating commands require attested input under
    ruling 27. A native turn failure is recorded against the task version,
    T3 session and engine instance. A change to any of these permits one fresh
    attempt. A fenced task without a sent run leaves room for other project work.

    The planner ruled on 2026-11-24 that an effect proven unsent replans on the
    next eligible pass, even at the same task version. Ambiguous delivery keeps
    its readback deadline and may block if it stays unresolved. A completed
    hold uses its own native outcome across subsequent retries and restarts.
    Retained reads record a missing bounded projection separately from missing
    idle coverage. Before a missing working directory leaves local custody
    unknown, the existing targeted cwd check removes exited PIDs and reports
    the census stage and one still-unverified PID.
    Title, settle and snooze changes preserve matching custody evidence.
    Delivery still checks current binding, requests, children, background
    work and row visibility, including ownership of any snooze it clears.
    A pre-wire retry keeps the row visible and releases the ACP turn while
    it waits. An exact terminal parent and an exact absent child let Nucleus
    discard a delegation that has no send intent and prepare it again.
    A delivery fence protects an unresolved Nucleus send at the same task
    version and T3 runtime. A legacy generic block with no matching attempt
    does not park a runless task. A known pre-wire refusal or positive
    native readback of the exact frozen message lets the normal scheduler
    replan. A bounded view that omits the message cannot clear an uncertain
    send. Readback of a fenced attempt never sends a message.

    The planner ruled on 2026-11-24 that a human wait or a typed custody block
    releases the ACP parent. A verified running role or a launch inside its
    delivery deadline holds it, and expiry publishes at the same task version.
    An authenticated report on the current unrevoked assignment ends that
    assignment for reconciliation. Nucleus applies the report with the ordinary
    head and forge checks, even while the role thread has activity or missing
    background coverage. A stale report about an earlier PR head carries no
    authority at the current head. Fresh role sends can proceed while a
    retained role or local process is still active. A reviewer still needs the
    exact clean head. Checkout removal and revoked runs still check writer
    custody. An exact terminal role with no pending native background work
    releases the parent. A synchronized bound shell can establish an empty
    background roster after the exact run is terminal. A prepared report
    reminder does not extend that hold.
    Local process custody is checked at checkout removal.

    Child activity remains evidence for checkout custody and parent release.
    Task-row visibility follows ruling 22. Operator snoozes keep their horizon.

31. **The TypeScript engine is stopped.** Tom, 2026-11-24: "I'm not using
    legacy TS nucleus now so should we start taking it down? Keep the code
    around, but stop running the daemon, acp and legacy tests". The TS service
    and roll owner are stopped, the T3 `nucleus` provider is disabled, and its
    Inbox thread is archived. Its last database is kept as a read-only backup.
    The TS code stays in the repository until milestone 4 deletes it. The
    board's client screens and their tests stay live because the Rust board
    reuses them. The old engine's test families leave milestone QA
    and the affected-test selection.

32. **Role prompts stay lean.** Tom, 2026-11-24, after Rust worker assignments
    passed T3's 120,000-character limit: "worker and reviewer prompts need to
    stay lean". A role prompt carries run facts, the held brief and only the
    context the brief pins. Lane membership adds the lane's title and aim. A
    lane document is inlined only when the brief links or cites it, and is
    also written read-only to the run scratch (TS `queueLaneDocumentBlock`,
    Spec 026). The role protocol stays in the skill (ruling 29). Every launch
    records its prompt's per-section character counts in the run scratch
    (TS `measureRunPrompt`). An assignment that would pass the host's message
    limit fails before sending, with a typed cause that names its largest
    sections. Reviewer assignments show both verdict forms, approve and
    request changes, with the same exact PR head and space for findings.

    The planner set a **65,536 UTF-8 byte** limit on new and replacement task
    briefs on 2026-11-25. This covers `task.add`, `amend` and the final brief
    produced by `item.promote`, including added frontmatter. A refusal names
    the limit and the submitted size. Older briefs remain readable and can
    be amended to fit. Task answers can still append recorded guidance. Use a
    short brief and link supporting material in lane documents. The host limit
    still applies to the composed assignment.
    The task and command endpoints allow a separate 458,752-byte JSON
    envelope for escaped briefs. Ordinary task commands keep their 64 KiB
    request limit.

33. **Sibling sources are pinned, not linked.** Tom, 2026-11-24, to the Acowtancy planner (relayed to the Nucleus planner): "We should be pinning them properly rather than using siblings - longhorn has a newer release (we cut 0.6.0 today and working towards 0.7.0), poodle is fairly stable on its current version..". A task worktree's sibling sources are materialized at the revision the repository pins in its `effigy.toml` `[sources]`, not linked to the operator's local checkout. This differs from TypeScript's `nucleus worktree prepare` symlinks on purpose. A stale pin is the consuming repository's to update. Tom, 2026-11-25, on tasks that pin different revisions of the same sibling: one copy per pin. Each pinned revision materializes in its own directory keyed by commit, so tasks on different pins never share a stale copy.

34. **Archiving a Done task is housekeeping.** Tom, 2026-11-24: "it shouldn't matter that the workers are archived already. We're just archiving task containers! It's all getting too fiddly." Custody is proven once, when a task's checkout is removed. After that, archiving its threads proves nothing further. The archive step archives each of the task's threads that the held shell shows as present, unarchived and idle. A thread that is already archived, absent or deleted counts as done, with no read. A thread showing activity waits with a plain cause. The task is closed when none of its threads remain unarchived. This replaces family-closure receipts and archive proofs. For owner acceptance of an exact report, the synchronized shell must identify the bound worker and show no running turn or outstanding input. Missing background metadata leaves that acceptance available. Checkout retirement retains its writer and cwd checks.
   On the volume-wide open-file scan, Tom, 2026-11-25: "That's way too heavy a check - we need to find a better way of doing that". At retirement the held shell supplies role activity, Git supplies publication and worktree state, and one cwd census per pass covers every closing task. A process with its working directory in the checkout or any retained run scratch for the task holds removal. An open file alone does not.
   At terminal closeout, stop an orphaned process tree only when its root has parent PID 1, its working directory is in the task’s verified checkout or its settled run scratch, and one of its processes runs the task’s own code. Own code means the process’s executable path, or an absolute path argument on its command line, is inside that checkout or scratch. A relative argument does not count, because the inherited cwd would place it in the checkout. Protect T3 and its descendants. Record each process, signal and outcome in task history. This also applies to retained terminal checkouts.
   A tree whose processes all run external programs and only inherited the cwd is a shared service that merely started there. Leave it running and record each process’s PID and command in task history as `checkout_process_retained`. Its cwd keeps the checkout held, and the wait names the PID. The operator restarts that service; Nucleus never stops it. (Clarified 2026-11-26, nucleus#1594.)


35. **A lubricated workflow.** Tom, 2026-11-24: "We need to apply this kind of thinking all the way through the workflow - 'lubricate' the whole thing so we stop getting stuck like this." Ruling 34's principle applies to every step:
    - Only destructive or irreversible steps (removing a checkout or worktree, merging, closing a PR) prove custody, and they prove it once.
    - Every other step acts on what it can observe now and is idempotent. Repeating it is harmless. A T3 effect is re-sent under its same command ID, which T3 deduplicates, rather than proved absent.
    - An operator-owned future snooze is the delivery exception carried forward from #1445 and the TypeScript `wakeBeforeDelivery`. T3's ordinary message dispatch clears its destination's snooze. Before a parent hold or retained continuation enters the wire, the synchronized shell's future horizon must be absent or match the existing Nucleus ownership record. The operator's horizon stays visible as a timed wait outside **Needs you**. A shell wake or horizon expiry resumes the same command.
    - A bound role's active run or positively observed background work can keep the ACP task turn open, including after an authenticated report. Re-entry uses the same activity evidence. The first hold keys on the role launch and its activity. A successor requires changed role activity and the exact ended parent run. An uncertain reply retains the existing intent and command.
    - A parent turn that ends within one second imposes a three-second backoff from completion. Three consecutive instant turns stop re-entry and show an owner action until new role evidence arrives. Shell updates and startup drive re-entry. The existing three-second recheck for an unproven continuation remains bounded to its first 30 seconds.
    - After an authenticated report or an observed terminal role, the ACP hold releases when the bound role is quiet. The next engine change for that task rechecks the current hold even if the completion notification was missed. A queued successor owns its own prompt.
    - Parent delivery respects operator snoozes and can send across a Nucleus-owned snooze. Task-row visibility follows ruling 22.
    - A failed parent turn with the Nucleus ACP provider’s own unavailable or engine-error message on the exact command, run and root node gets a fresh journaled hold on the next pass. Other parent failures retain their owner action; already recorded failed deliveries stay blocked.
    - ACP request failures and requests slower than two seconds record UTC time, route, status or transport outcome, latency and attempt in `acp.log`, without request content or credentials. Engine errors retain the response message; transport failures and deadlines remain unavailable errors. The service timestamps its log lines and records ACP 5xx responses. Slow ACP detail reads record state-lock wait and hold time to distinguish contention from response errors.
    - A report-ready or prerequisite-release notice can make one fresh attempt
      after T3 proves it rejected the exact command. See [Commands](#commands).
    - No step parks a task silently. Every wait has an observable condition that ends it, or a deadline after which it shows a plain cause and the owner action that clears it.
      T3 backoff delays native requests while local decisions continue. A retryable preflight or unavailable observation has a due time.
      Only a non-queueable, possibly sent role uses the late-reply grace, after a successful read found no receipt.
      For a parent command that cannot replay, a deferral before the exact read stays pending. An inconclusive read once issued, or a successful read with no command match, sends one notice to the responsible planner. The notice asks them to check the earlier turn and use **Next** to review available actions. Next reads the task and leaves the held occurrence in place.
      An unavailable planner route stays due. Once the routing check confirms there is no responsible planner, the card asks the operator to review recovery. The held delivery opens no Inbox form.
    - The board's **Needs you** and T3 task rows share one attention rule.
      Operator decisions, unanswered Inbox forms and typed blocks with a
      concrete operator action need the operator. Planner questions, including
      an Inbox decline handed to the planner, wait for the planner. Scheduled
      rechecks, unexpired deadlines, capacity and dependencies are waiting.
      T3 row visibility follows ruling 22.
    - Already done counts as done. A step never fails because the world is already in the state it wanted.
    - A stall audit inventories every wait, fence, receipt and proof state in the engine against these rules, and the reduction pass applies its verdicts.

36. **Queue admission checks capacity.** The scheduler takes eligible tasks in
    admission order and checks dispatch mode, prerequisites, and global,
    project and checkout capacity under the task fence before entering Working.
    This also applies to report-only work. A first worker without a run or a
    retained role returns to Queued if capacity closes before reservation.
    When both are due, Closing and terminal housekeeping alternate with
    ordinary scheduler work. Capacity ordering applies on the ordinary turns.
    An unresolved parent attempt keeps its task version and waits for capacity.
    Schema 12 reads that decision from the current delivery occurrence. Exact
    acceptance, refusal before send or failure releases that occurrence's guard.
    The task keeps its original admission order and reuses its native parent row
    on a later dispatch.
    Admission creates no T3 parent. The TypeScript path uses
    `Dispatch.dispatchQueued` and `WorkerLauncher.launchAgentOnce`, then
    `T3Nesting.create` calls `launchParent` during native preparation.
    On restart a reservation preserves its existing visibility through the
    first decision. Positive child activity keeps the parent visible.

37. **Workspace observation has one recheck.** A workspace observation error
    schedules one read after fifteen seconds. If the read still fails, the
    card shows the cause and the task waits for its owner. After fixing the
    checkout, use the version-bound Recheck action (ruling 48). Successful Git status output
    beyond the capture limit proves the checkout is dirty.
    Before any role has been dispatched or a worker bound, the engine can
    recover an owned Git initialization with no published index. Under the
    task fence it renames the checkout into configured scratch, retires only
    its Git registration, and deletes the branch at the original observed
    head before allocating at the verified start. After a partial failure,
    ordinary allocation can reuse a branch at its verified start. The
    original attempt is the only one authorized to delete its observed tip.
    A failed rename, including a cross-volume move, leaves the directory in place.
    Linked worktree creation follows the ten-minute `gitBulk` timeout from
    `core/git/git-command.ts` and `core/workspaces/workspace-lifecycle.ts`.

38. **GitHub accounts are configurable.** Tom, 2026-11-25: "I want nucleus to be
    a packageable product.. this stuff needs to be configurable [...] Ideally I
    would like to be able to configure separate optional accounts to use for
    workers and reviews, if either is unset fall back to installed `gh`
    credentials. We'll need to pull together oauth log in and keychain storage
    to make it work. Keychain stuff should be in Longhorn."
    - Two optional accounts: one for workers, which push and open PRs, and one
      for reviewers, which post formal reviews. Each falls back to the
      installed `gh` credentials when it is unset.
    - The engine publishes the reviewer's verdict itself, as a formal GitHub
      review (approve or request changes) at the exact reviewed head, using the
      reviewer account. A reviewer account distinct from the PR author lets a
      review approve. When the reviewer is the PR author, a changes verdict
      uses a comment review with the same findings. Approval requires a different author.
    - Nucleus records one publication intent for the authenticated reviewer run,
      with the PR, head, verdict, findings digest and effective GitHub user ID.
      An uncertain POST is reconciled from the original marker by the operator
      credential. After 30 seconds, a complete inventory without the marker
      permits one journaled resubmission with the original identity, body and marker.
      Planner ruling, 2026-11-25:
      GitHub 5xx responses, including 502, leave delivery uncertain. Before each
      attempt the engine looks for the same marker. If an inventory begun at
      least ten minutes after the second attempt is complete and marker-free,
      the engine may claim a third and final attempt on the same binding.
      The earliest verified matching review wins. If the third attempt remains
      unconfirmed, ReviewPublicationBlocked names the cause and offers Move to review.
      The journal retains the review POST’s HTTP status and bounded GitHub error
      message when available. A marker check on a responsive forge reads “confirming review”.
      A definite throttle preserves the attempt and deadline across restarts.
      Publication errors classify the scheduler wait and card detail together;
      changing the wording does not change the wait or its deadline. Wait
      retention follows the task's authority, not its rendered label.
      Nucleus verifies the review ID, author, head, state and body
      before applying the verdict, and rechecks a published approval before
      merging. Previously applied approvals keep their original exact-head gate.
    - An account is added through an OAuth sign-in from Settings, and its token
      is stored in the platform keychain through Longhorn's credential store.
      Tokens never appear in settings files, logs or prompts.
    - The planner's baseline before this ruling was to restore the TypeScript
      per-org reviewer token from the keychain. That baseline becomes this
      ruling's reviewer fallback path.

39. **Releases use Effigy's pipeline. Homebrew waits.** The planner proposed a
    release baseline on 2026-11-25. Tom: "I think to begin with we hold off on
    homebrew until we've got Nucleus _properly_ ready for other people to use..
    there are a few things to do before then. The rest is good though".
    - A release is one archive per platform holding the engine binary, the
      board assets and the Nucleus skill. Installing it unpacks into the engine
      home. Activating the live engine is a separate operator step.
    - macOS on Apple Silicon comes first. Linux follows later and has no
      keychain account storage (ruling 38).
    - Releases publish to GitHub Releases. A Homebrew tap waits until Nucleus
      is ready for other people to use.
    - Each binary carries a SHA-256 sidecar. Apple signing and notarisation
      wait for outside users. Local builds sign with the stable local identity
      described in the [engine README](../../../engine/README.md#stage-an-engine-release).
    - Effigy's `release:run` pipeline certifies a commit with Nucleus's gates
      (QA, dependency checks, docs QA) and stops for operator approval before
      it tags or publishes.

40. **Every delivered message carries its own reply route.** Tom, 2026-11-25:
    "In the TS version, we provided a reply route in messages from which you
    would expect a reply back to the originating thread. We should bring that
    over". Today a reply goes to project `{from}`, which reaches that project's
    most recently verified planner, often not the sender. The TypeScript design
    (nucleus#1387, `core/questions/agent-messages.ts` at `737246d22`) carries over:
    - Each delivered message gets an opaque reply handle (`nreply_` and random
      bytes), never derived from a thread or agent ID. The handle is bound to
      the sender's verified thread at send time.
    - The delivered text ends with the exact reply command, for example
      `Reply: nucleus tell {to:{reply:"nreply_…"}}`, and says the handle
      reaches this sender, belongs to this recipient and expires after 7 days.
    - Only that message's recipient thread can use the handle. An unknown,
      expired or foreign handle sends nothing and reveals nothing about the
      sender.
    - A reply reaches exactly the sender's thread through the ordinary
      delivery path, which observes the thread first. An archived or gone
      sender is not revived. The reply then falls back to the sender's
      project, as a fallback delivery under ruling 41 that names the original
      sender as gone. This is the planner's reading of Tom's "we don't want
      messages getting lost".
    - A reply is itself a message with a new handle, so a conversation can
      continue. A per-recipient rate limit (the TypeScript limit was 20 an
      hour) keeps two agents from looping.
    - Messages still carry information only.

41. **A thread opts in as a project's planner.** Tom, 2026-11-25, after a
    Bovine planner's new message reached the engine build thread because that
    thread was the most recently active in the Nucleus checkout: "I don't
    really want messages going to the build thread unless they're meant for
    it." On the planner's proposal to queue messages when no planner is live,
    Tom answered: "we don't want messages getting lost. If the planner is
    archived then you would _expect_ messages to go to the build thread".
    - Running planner commands still needs no setup. Any thread in a project
      checkout can plan and dispatch, as ruled on 2026-11-19.
    - One command (planner reading: `nucleus planner.claim`) makes the calling
      thread the project's claimed planner. A project has at most one claimed
      planner. A new claim replaces the old one, and Nucleus tells the
      previous thread it was replaced.
    - Project messages go to the claimed planner while its thread is live.
      With no claimed planner, or an archived or gone one, delivery falls back
      to the most recently active thread working in the project. A fallback
      delivery says it is a fallback, so the recipient can claim the project or
      pass the message on. Messages are never dropped.
    - Settings → Projects shows each project's claimed planner and can clear it.
    - Task workers and reviewers still reach their task's dispatching planner.
      Replies use the message's reply route (ruling 40).

42. **Completion notices are opt-in.** Tom, 2026-11-25: "Do we have completion
    notices in rust nucleus? I don't see any planners being notified when a task
    is completed.. they were opt-in in TS version, can be here too, just want to
    make sure agents know how to use them". This ports the TypeScript
    `queue.notifyOriginOnCloseout` field.
    - A brief sets `queue.notifyOriginOnCloseout: true` at admission or amend.
      When the task reaches Done or Cancelled, Nucleus sends one notice to the
      planner thread that dispatched it. The notice reads "#N title is done",
      followed by the merged PR when there is one, or "#N title was cancelled".
    - If the dispatching thread is archived or gone, the notice goes to the
      project's claimed planner, or by fallback to its most recently active
      planner (ruling 41). The notice is never dropped.
    - It uses the existing planner-notice delivery: one notice per task, an
      exact T3 rejection gets one fresh attempt, and uncertain delivery is not
      resent. The engine sends it, so there is no sender to answer and it
      carries no reply route. The text omits the Reply line. To follow up,
      the planner uses the task's own commands.
    - The skill shows the field in its admission example. Without the field,
      nothing is sent.

43. **Storage stays bounded.** Tom, 2026-11-25: "What's the current state of
    pruning the database and T3 archived threads? They will grow really big if
    we don't deal with them". He approved the planner's proposals in the same
    exchange.
    - Archived Nucleus task threads are pruned under the Dispatch thread
      retention settings, defaulting to 3 days and a 12-hour sweep, as ruled on
      2026-11-19. Only the engine's recorded task parents, workers and
      reviewers are deleted. Your own threads are never touched.
    - The 1,500 archived threads left by the stopped TypeScript engine, each
      matched to its recorded task agents or parent bindings, are deleted once
      in bounded batches.
    - Planning history keeps every version from the last 30 days plus the
      newest 20 versions of each record. Older versions are compacted after a
      verified backup. Byte-identical snapshots count once per record, at their
      earliest sequence. Imported versions use their original timestamp when
      available. Item timestamps, edit revisions and artifacts awaiting
      acceptance survive compaction. Existing backups keep the full history until they age
      out.
    - Scheduled database backups retain 24 six-hourly copies, 14 daily copies
      and eight weekly copies. These quotas are fixed. See
      [Rust engine capture](028-store-backups.md#rust-engine-capture).

44. **GitHub requests are throttled.** Tom, 2026-11-25, after a burst of
    closing tasks tripped GitHub's secondary rate limit: "We need to throttle
    github requests sensibly". The planner's reading follows GitHub's guidance
    for automated clients:
    - One shared GitHub client per account serves every task. It allows one
      request in flight at a time.
    - Writes (merge, review, branch delete) are spaced at least one second
      apart.
    - Rate limits come from GitHub's response headers. A retry deadline or
      reset time pauses that account's requests until the deadline, as today.
      A secondary limit backs off for at least a minute.
    - Reads that GitHub can answer as unchanged use conditional requests.
      Per-commit verification facts, such as whether a merge commit is on the
      base, are reused rather than read again on every pass.
    - Throttling delays work. It never fails work and never reorders a task's
      own steps.

    The Rust forge shares pacing by numeric account ID across operator and
    reviewer credentials. REST reads revalidate cached representations by URL
    and bearer. The GraphQL checks query runs on every open-PR observation
    that needs checks. Every page must identify the head and base commit from
    the PR read. Every selected field must be present on every page, including nullable fields. Incomplete or inconsistent evidence keeps the merge gate closed.
    An open PR needs no merge commit. When a merged REST pull omits the commit,
    GraphQL must confirm it at the same head and base before closeout.

45. **A worker that stops early continues.** On 2026-11-25 the Bovine planner,
    asked by Tom to agree a fix, reported Terra workers ending their first
    turn after two to three minutes with plenty of allowance left. The report
    reminder then told them not to redo the work and to file a planner
    question. Each case cost a planner round trip, and the second run finished
    the work. Planner ruling, following ruling 28 ("Context gets compacted and
    it just continues"):
    - When a code worker's turn ends without an authenticated report, its one
      follow-up turn tells it to continue the assignment in the same checkout
      and report when done.
    - The first code-worker assignment tells the worker to continue until done.
      An early turn ending does not call for retry or reassignment.
      The worker asks the planner only about a concrete impediment: a failure
      it cannot fix, missing access, or a scope decision. An unfinished task is
      not an impediment.
    - A reviewer's follow-up still asks it to report the review it performed,
      so a review never repeats.
    - If the code worker or reviewer finishes that turn without reporting, the
      planner gets the missing-report question. A report-only worker instead
      gets one reminder to report its existing delivery or impediment. If it
      still sends no report, the task is Blocked. Use **Move to work** to resume.

46. **Reviewer report reminders and recovery.** On 2026-11-25 Tom ruled
    “Keep Rust behaviour.” When a reviewer ends without an authenticated
    report, the engine sends one reminder for that run on the retained
    reviewer thread. After a confirmed failure it relaunches the reviewer
    within the attempt limit, then routes exhausted attempts to the task
    planner. Neither step requires operator authorization. For the Rust
    engine this supersedes Tom’s 2026-10-07 rule “Further reviewer turns
    require explicit operator authorization.” No verdict is ever manufactured.

47. **Review the whole engine and board after the correctness rounds.** Tom, 2026-11-25:
    "I feel like we might need to do another level-up after a full 24 hours of fixes and tweaks. We need to make sure we're not recreating the mess from the TS version".
    Pin milestone QA to the round-four merge. At the same commit, independent readers assess
    accumulated special cases since `1803c1971`, features and states against rulings 11, 34 and 35,
    Rust module responsibilities, and tests coupled to implementation. The planner reviews one
    ranked consolidation plan, including the rule and risk for each proposed cut, before implementation.

48. **Recheck after a mechanical repair.** On 2026-11-26 Tom was asked:

    > When a task is stuck on something mechanical (say a missing GitHub field or a timed-out check) and the cause has been fixed, owners currently nudge it by placing a Hold and then Releasing it, which forces a fresh check. The structural review suggests one 'Recheck' action instead: it looks once at the current state and can never release a hold someone else placed. Should we add Recheck?

    Tom chose “Add Recheck (Recommended)”. Recheck observes once at the current task version.
    It cannot release another person’s hold. Hold and Release remain available for actual holds.

49. **Keep native execution and cap production Rust.** On 2026-11-26 Tom answered two questions:

    > Spec 070 caps the Rust engine at 30,000 lines. It was 33,000 on 24 Nov and is 41,800 now. An independent costed review found only ~300–550 lines removable without changing what Nucleus does; the growth is mostly features you asked for (native Inbox, GitHub accounts, reply routes, recovery). Reaching 30k would mean giving up Nucleus running workers/reviewers in T3 itself. How should we treat the budget?

    Tom chose “Freeze at today's size (Recommended)”. Later on 2026-11-26 he amended the ceiling: “We don't need to be that tight with budget - let's cap at 50k”. The ceiling and PR accounting rule are in [Validation](#validation).

    > Separately, three optional features each cost 600–1,200 lines and could go without touching core execution. Do you want to retire any of them?

    Tom chose “Keep all three (Recommended)”. The pinned T3 Inbox, GitHub account sign-in UI and planner messages with replies remain supported. The compatible reductions (estimated at 275–560 lines) and the structural consolidation continue.

50. **Promote queued work ahead of a backlog.** Tom, 2026-11-26, with about 60 tasks waiting for capacity: “We should probably look at adding a queue priority field so when there's a backlog like this we can tag tasks that need to get dispatched first?” Planner ruling, following the TypeScript queue priority: a task has two orders, Normal and Promoted. When a slot frees, promoted capacity waiters take it before normal ones, oldest first within each order. Promotion never bypasses the global or project slot limit. A held or parked task keeps its order and original age when it rejoins. The operator promotes or demotes from the board. The task's planner uses the command line or `queue.priority: promoted` in the brief at admission (`amend` rejects changes to `queue.priority`). Queued cards show “Promoted”.

51. **Step up a tier when every eligible profile is paused.** On 2026-11-26, 15 tasks waited until 5 December because the only eligible reviewer or worker profiles at their tier were in a paused subscription group. Tom was asked: “How should Nucleus handle 'every eligible profile is paused'?” He chose “Step up one tier (Recommended)”: when every eligible profile for a role is paused, use the next tier up, still with a different model from the author. It reverts automatically when the group unpauses. A required profile in the brief still waits. A task waiting on a paused group shows “paused” with the group and its reset, not “capacity”.

    Tom, 2026-11-26: When a retained worker or reviewer would continue on a paused group, including an operator pause, select again under the usual profile rules and start a fresh role thread with the existing review and continuation context. A brief-required profile still waits for its group.

52. **Decision answers notify the asking planner.** Planner ruling, 2026-11-26: when an operator answers a decision from the board, the Inbox or the CLI, Nucleus records one notice in the same store transaction for the planner message queue (`tell`) to the decision's asking planner thread (or the task's origin thread for a task-linked decision). The notice states the decision ID, brief question, chosen option label and ID, any note, and the answer time, with no reply route, and is exempt from the 20-per-hour direct `tell` recipient cap so an operator answer always commits, wakes any linked task, and queues its notice even when the planner thread is at the cap. If the asking thread is archived or gone, delivery falls back to the project's planner under rulings 40 and 41. Uncertain delivery never resends, replaying the same answer sends nothing more, and a task-linked decision still wakes its task.

53. **Retired concepts stay out of the Rust port.** Tom, 2026-11-26, after profile roles and scopes (retired by Spec 053 on 2026-10-21) turned up gating selection again: "Those concepts should never have made it into the rust port." He answered four questions about other leftovers, choosing the planner's recommendation each time. Remove the per-repository "Hung tool limit" ("Remove it"). The merge gate uses only the checks GitHub marks required on the branch, with no Nucleus-side checks list ("GitHub's only"). Hide the Default host picker until a second host is registered ("Hide until Orca"; Default host itself stays, as recorded above). Remove pilot mode, `serve --project` and its planner registration ("Remove pilot mode"). Interactive tasks (ruling 28) are rejected on submission like `queue.preferredProfileId`. The unused provider-limit cooldown setting goes. Board code that only served the TypeScript engine is deleted.

54. **Merge with merge commits; honour brief merge holds.** On 2026-11-26 a brief's `queue.mergeHold` was ignored and its PR was squash-merged. The project's release tag had to sit on the certified candidate commit, which was then not on main. The Rust port had dropped both TypeScript behaviours. Tom, asked to confirm merge commits: "It sounds like merge commits are the right choice for the reason this incident brings up - squashes change the commit". Nucleus merges with a merge commit, so the exact reviewed head is an ancestor of the base. Squash and rebase merges are not used. A brief's `queue.mergeHold: true` with a required `queue.mergeHoldReason` holds only the merge step until the owning planner or the operator releases it (Specs 040 and 058). Admission refuses unknown `queue` keys and names them.

## The model

### Stored state per task

| Field | Meaning |
|---|---|
| `id`, `reference`, `repository`, `base`, `entry`, `origin_thread` | Internal identity fixed at admission. Entry is `brief` or `review_entry`. The submitting or promoting thread is the origin when the caller has one. |
| Task number | Per-repository counter allocated with admission. API task views expose `number` and the public `reference` separately from the immutable identity. |
| Prerequisites | Resolved task IDs for first dispatch, plus an optional post-dispatch wait with its reason and release time. Task edits and wait release commit with the row version and audit event. |
| `brief` | The brief text, its version and digest. |
| `phase` | `queued`, `working`, `reviewing`, `merging`, `closing`, `done` or `cancelled`. Report-only tasks also use `report_ready`, `blocked` and `error`. |
| `threads` | Retained worker and reviewer thread IDs, their canonical profile bindings and a monotonic launch sequence. Reuse each role's exact bound thread when it can receive the next pinned assignment. Replace a thread only when the host confirms it is gone or the role's profile changes. A profile change starts a fresh child (ruling 9), and an unknown read never replaces a thread. The worker binding records which applied review launch authorized its most recent climb. |
| `run` | The current role, thread ID, credential digest, label, start time and launch instance. It holds the immutable launch request and selected profile, the last possible send time and at most one authenticated report. A revoked run stays bound until the engine observes it quiescent, even after cancellation. |
| `work_continuation` | The next code worker instruction and, for automatic merge recovery, the head that must be replaced before review. Cleared when the task leaves work. |
| `report_task` | For a [report-only task](../contracts/milestone-qa.md), the delivery lane, planning base, authenticated reports and planner disposition. |
| `pr` | URL and head SHA. |
| `verdict` | The reviewer's verdict at a given head: `approve` or `changes`, with its summary. A verdict at any other head is history. Step-up requires an applied changes verdict at the current head with a review launch sequence newer than the climb recorded on the worker binding. |
| `attempts` | Failed launches or silent ends at the current phase and head. The first observed PR starts a fresh count. |
| `question` | At most one open question, with its options and the head it was asked at. The planner answers work questions. The operator answers review-entry acceptance in the pinned Inbox. A decline parks the task and notifies its planner once. Observing a new head clears the question. |
| `hold` | An optional operator or planner hold, with its reason. |
| `queue_priority` | Queue order (`normal` or `promoted`), defaulting to `normal` for existing rows. |

Anything else is observed, never stored as a record that something must clear.
History is an append-only event log for display and audit only. The engine never
reads its own events to decide anything.

### Observations

Each pass reads, for active tasks only:

- **Host:** for the exact run's thread, whether it exists, its turn state (running,
  idle or ended), the report if one was sent, and pending permission or user input.
  On local T3, settlement also checks for processes using that checkout.
- **Forge:** the PR's state, head, mergeability and checks, and whether it was merged
  and at which commit.
- **Workspace:** whether it exists, its head, and whether it is clean.

A read that fails is `unknown`. Unknown never releases, never terminates and never
counts as idle. The engine just decides again on the next pass.

### The decision table

A pure function, `decide(task, observation) -> Action`, written as one exhaustive
`match` on `(phase, run state, observation)`. The actions are:

- `Launch(role)`
- `Wait(reason, next_check)`
- `Advance(phase)`
- `Merge`
- `Close`
- `Relaunch(role)`
- `Ask(question)`
- `Nothing`

Every action is idempotent:

- Launches and sends use a deterministic label, `task-{id}-{phase}-{head}-{attempt}`.
  The task assigns each reservation a distinct launch instance and bearer. Revisiting
  the same phase and head after `move` uses new native command and message IDs.
  Only the current reservation can be replayed. An unrevoked replay can start
  work. A revoked replay only reconciles uncertain delivery and stops the turn.
- Before any send, the engine reads the exact native thread and message identity.
  It records the possible send before writing. If a reply remains unknown, it
  waits out the host's late-reply window and replays the identical request under
  the same command ID. An unsent revoked reservation clears directly.
- A merge is the guarded GitHub merge at the exact head.

### Faults

- **An exact terminal role run without an authenticated report** gets one
  follow-up on the same thread, provider and model with a run-bound report
  credential. An ordinary worker continues in its checkout and reports when
  done. It asks the planner only about an unresolved failure, missing access
  or a scope decision. A report-only worker reports its existing delivery or
  the impediment. A reviewer reports only the review actually performed at
  the original exact head. If the reviewer run confirmably failed, the engine
  relaunches the reviewer within the attempt limit. After exhaustion it asks
  the task planner. No one manufactures a verdict. The durable reservation
  reuses its command ID across a lost reply or engine restart. A terminal reminder with no report
  gives the owner a cause and an action. A missing slice of host history cannot
  establish that the turn ended.
- **A run that's gone or a reliably rejected dispatch** is relaunched in the
  same role, and `attempts` goes up.
- **Three failed attempts** at the same phase and head end in one question to the
  planner. A report-only task parks as blocked and awaits an owner instruction.
- **Uncertain T3 observations** have a due check after the host's deferral or
  the possible send's late-reply window. If that check remains inconclusive,
  the task shows a blocked cause and waits for a task or T3 session change.
  An engine restart also reconciles it again. The row stays visible during
  uncertainty and while a role starts or runs. A guard that proves a command
  never reached T3 records that outcome separately from unknown delivery.
- An open repair question is rechecked against the next fresh observation. If
  that observation shows the condition has cleared, retire the question and
  decide again through the same gates. Unknown evidence keeps the question open.
- A prepared review can send only with a fresh clean checkout at the open PR's
  exact head. A reservation that no longer fits proceeds to reconciliation
  without charging a failed attempt. A failed attempt counts only when the
  required head observation is known.
- Cleanliness checks include tracked files and non-ignored untracked files.
  The engine scans the whole Git index for flags that can hide changes and
  retains only the result. Git failures report the command, checkout and
  redacted diagnostic instead of treating an unreadable tree as clean.
  Fresh evidence of a clean checkout at the exact open PR head resolves an
  existing workspace mismatch question at that head.
- If the head moved while delivery was uncertain, reconciliation can replay the
  old request after revoking its credential. It stops the exact turn and archives
  the thread before clearing the run. The old review cannot report a verdict.
- **A task needs a person only when the question is about the work itself.**

### Commands

`queue.dependsOn` resolves on admission, promotion and eligible brief amendments.
Use a task ID, `owner/repo#N`, `repo#N` or `#N` in the target task's repository.
The engine stores task IDs. Before dispatch an authorized planner or operator
can replace the list with `nucleus set-dependencies <task> --version <n>
[<prerequisite> ...]`. Read the current version and available edits with
`nucleus next <task>`. An empty list clears it. A self-reference, an ambiguous
reference or a dependency cycle refuses the write.

After dispatch, use `nucleus set-prerequisite-wait <task> --version <n>
--reason <text> [<prerequisite> ...]` to park subsequent work before merge.
An empty list clears the wait. The current run keeps its binding and can settle.
An already-open wait stays editable if review settles into the merging phase
while the merge is still fenced by the wait. A prerequisite satisfies the gate
when it reaches `done`. A cancelled or missing prerequisite needs an owner edit.
The final prerequisite's phase change wakes its dependents. Release records an
informational planner notice and returns the task to ordinary scheduling, where
the existing run, question, hold and exact-head rules still apply.

Report-ready, work-question, operator-decline and prerequisite-release notices
stay pending while a planner route is unavailable. A binding change wakes the
waiting notice, and the next due pass can also retry routing. The scheduler
records the concrete send intent after checking the recipient and snooze horizon. T3 wakes a settled planner in the message dispatch transaction.
A queued notice remains read-only if the planner settles again. An uncertain
question or operator-decline send keeps its exact attempt.
For report-ready, prerequisite-release and held parent recovery notices, a
structured T3 rejection of the exact command reopens the notice once. The fresh
attempt uses a new command ID, the same notice text and a currently verified planner.
A second rejection spends the retry. Uncertain replies and previously spent
notices stay closed, including legacy `report_ready_planner_unavailable` records.
A finished report worker that publishes a different exact lane artifact opens
that artifact's own notice and retry allowance. An authenticated callback
replay or a new run reporting the same artifact keeps the existing allowance
and delivery status.

Task cards, details and `next` return `dependencyStatus` and caller-specific
`dependencyEdits` from local state. The `next` command list includes
`set_dependencies` and `set_prerequisite_wait` with caller-specific readiness,
including when a command is unavailable. The scheduler uses the same recorded
edges for first dispatch and open waits. Native assignments carry the recorded
prerequisite references and any released wait as context.

The board skips unrecognized `next` command names and logs a browser console
warning once per name. It validates the readiness of each recognized command.

| Command | Effect |
|---|---|
| `move REF PHASE` | Ends any live run and moves the task when preflight allows it. Return a delivered report to work with `move REF work --instruction TEXT`. |
| `complete REF --version V --lane KEY --artifact-version N --digest DIGEST --reason TEXT` | Accepts the exact delivered report for a report-only task. |
| `answer` | Answers the open question. Work guidance becomes a new brief version, retry clears the capped count, and authorized acceptance binds to the exact observed head. |
| `cancel` | Ends any live run and sets `cancelled`. Leaves the worktree if it is dirty. |
| `amend` | Replaces the brief and records the new version; rejects changes to delivery policy or `queue.priority`. |
| `hold` / `release` | Pause or unpause one task. |
| `promote` / `demote` | Move a queued or capacity-waiting task between `promoted` and `normal` order at `--version N`. |

`nucleus next REF` lists the commands available at the current version. For
prerequisites, use `set-dependencies` before dispatch or `set-prerequisite-wait`
after dispatch. See [milestone report acceptance](../contracts/milestone-qa.md).

### Hard gates

There are only two:

1. **Merging needs an exact-head `approve` verdict, or a recorded acceptance of that
   head.** The task's planner can accept an externally merged, unreviewed `brief`
   task (Tom, 2026-11-23). For a `review_entry`, only the operator can accept it.
2. **A worktree with uncommitted work is never deleted.** Tracked changes and
   non-ignored untracked files keep the worktree. Git-ignored output goes with
   the worktree, including when the only tracked changes are deletions at the
   exact published head. A clean cancelled checkout can retire after proof of publication.

## Engine shape

A Cargo workspace inside this repository, at `engine/`:

| Crate | Role |
|---|---|
| `nucleus-core` | Types, the decision table and the state transitions. No I/O. |
| `nucleus-store` | SQLite for tasks and the event log, through a small schema of its own. |
| `nucleus-hosts` | The host trait and the T3 adapter. No BB or Paseo adapters (ruling 5). |
| `nucleus-forge` | GitHub: the PR, checks, merge at the exact head, and reviews. |
| `nucleus-work` | Worktrees under `workRoot`, or from a Barge pool when the setting is on. |
| `nucleus-acp` | The host-neutral ACP agent (stdio JSON-RPC): one session per task, presenting its state and carrying the five commands, and a host-scoped Inbox session offering native forms. A thin client of the service (rulings 6 and 18). |
| `nucleus-service` | The pass loop, the JSON API for the board and the ACP agent, and callbacks. |
| `nucleus-cli` | The single `nucleus` binary: `serve`, `acp`, `ensure` and the CLI verbs (ruling 20). |

Reuse, to be confirmed by the build when it reads their contracts:

- **Longhorn:**
  - `longhorn-config` for settings and the Storage page values (versioned domains,
    atomic writes, backups);
  - `longhorn-storage-layout` for roots;
  - `longhorn-git-workspace` for git operations;
  - `longhorn-operation` for action lifecycle, if it fits idempotent labels;
  - `longhorn-support-log` and `longhorn-redact` for logs;
  - `longhorn-update-install` for installing a verified build on roll.
  - Use the exact Longhorn worktree-identity API. Tom's interim pin (relayed
    2026-11-23) is `rev = "049392e27f93d642839b82c28d217c1f353e569e"` until
    the `v0.6.0` tag is available.
- **Barge:** the storage library and the worktree lease contract (lease, return, run).
- **Toolchain:** the rs-toolchain gates (clippy, rustfmt, nextest, cargo-deny), run
  through Effigy.

## Validation

For a scheduler or board latency investigation, start the engine with
`NUCLEUS_TRACE_SCHEDULER=1` to log state-lock acquisition wait and hold times
separately for the scheduler pass and task list. The first-service record
after Dispatch resumes includes the task, phase, selected priority, due and
service times, and queue depth.

Tom, 2026-11-24: "How are we doing on complexity? No horrible extra narrow fixes as issues come up? We need to stop this version from descending into madness like the TS version did."

Every fix states its general rule and what it replaces. An independent review
checks for special cases, duplicate paths and dead code before the milestone 3
cutover. The ceiling is 50,000 production Rust lines by `scripts/count-engine-rust.py`.
The measured baseline at `1d92ea014` is 41,785.

Count nonblank lines of operator-shipped Rust after removing comments, tests,
fixtures and generated source. Keep lines with code alongside comments, the
nonblank contents of multiline literals and production platform variants.
The counter reads tracked crate `src` files from each commit's own Git tree
and follows module declarations to exclude test-only source files.

In a Python 3.11 virtual environment, install the pinned parser with
`python -m pip install tree-sitter==0.25.2 tree-sitter-rust==0.24.2`.
From the repo root, run this on the committed PR head:

```sh
python scripts/count-engine-rust.py "$(git merge-base origin/main HEAD)" HEAD
```

Use the checkout containing the counter for both revisions. You can pass older
commit IDs even if those commits predate the counter. Every engine PR reports its net
production Rust delta. Justify any growth in the PR body, explaining why
existing code cannot supply the behavior. Land an offsetting
cut first if the PR would cross 50,000. Each consolidation PR covers at most
three production modules and identifies the rule that replaces the removed code.

Tom approved Rust for the engine on 2026-11-23. That replaces the 2026-10-04 "no
Cargo builds" rule for the `engine/` workspace only:

- **Each change:** `effigy engine:check`, `engine:clippy`, and `engine:nextest` for the affected crates.
- **Milestone QA:** runs the whole workspace.
- **Shared build cache:** Oxide leases reusable Cargo intermediates and keeps
  final outputs scoped to each checkout. The check, Clippy, and nextest selectors
  use Oxide, as does the release build. Staging copies the binary and bundles the
  board into a revision directory under the configured builds root, outside Oxide storage.
  The current and rollback launchers use these release copies. See
  [engine release staging](../../../engine/README.md#stage-an-engine-release).

### Parent delivery storage and upgrade

Planner ruling, 2026-11-24. Schema 12 stores one frozen parent command, due
time and result per occurrence. The engine persists the exact method, wire
payload, binding and verified native runtime before sending. An accepted reply
or exact command-linked evidence settles that occurrence. The task version,
current destination, role and operator snooze still authorize the wire. A
pending command can replay only in the same native runtime. On a due send,
the engine checks the descriptor PID and process start against the exact RPC
socket. The socket carries that proof until it closes. A replacement connection
must prove ownership again, even if the descriptor survives. Earlier records
that only store the descriptor key also require readback. A new or unverified
native runtime gets one bounded opportunity to confirm delivery
from exact positive evidence. A missing or inconclusive result parks the
occurrence and directs the operator to open the thread and use Next. A
replacement store may advertise the same environment ID and sequence, so those
values do not establish continuity.

Before a schema upgrade the engine copies the committed database into its
configured backup root and verifies the copy read-only. Schema 12 decodes
schema 10 and 11 parent history once. Historical events remain readable as
history. New parent delivery does not write a compatibility ledger. Installed
releases move forward. Earlier engines reject schema 12, and restoring an older
backup is an explicit operator-directed recovery with dispatch held until
native effects after that backup are reconciled. Ship schema 12 as a
standalone release after project removal (#642). The planner approved the
measured 76-line production Rust increase for this scoped change.

The shared role and parent wire is a separate reduction after scheduler
retry deadlines (#644). Consolidate common command construction, frozen
payload and receipt handling while keeping each role's authorization.
Limit each review unit to three production modules and report its measured
production Rust delta.

## Migration

1. **Milestone 1:** one task runs work → review → merge → close through the new engine
   on T3, behind a setting, and is checked by hand. Tom, 2026-11-23: "Yes, you can
   create a throwaway repo on inflatable-cookie". The live proof uses the private,
   synthetic `inflatable-cookie/nucleus-fixture` repository and its own T3 project.
   For this proof only, the engine uses standalone top-level role threads and its default
   worktree allocator. Milestone 2 parents them under the task's ACP session (ruling 6).
2. **Milestone 2:** the board reads the new engine's API, and its settings (profiles, limits, projects, storage) work against the new engine (ruling 8). New tasks for one project go
   to the new engine. The first project is Barge (Tom, 2026-11-23), starting with one small docs or test task once the repository binding, real profile launches, the installed ACP provider and per-project routing are in place. Tasks are presented through the core ACP session (ruling 6), one row per task, before the first real project.
3. **Milestone 3:** new tasks for every project go to the new engine. The old engine
   takes no new work. Planning records move into the new service (ruling 12).
4. **Milestone 4:** once the old engine's tasks drain, it is deleted. AGENTS.md, the
   skill and the contracts are rewritten for the new commands.
   The old engine's tasks have drained: its final database holds only finished and cancelled
   tasks. Tom, 2026-11-25: "Yeah, queue those tasks.. it should probably go before level up though
   otherwise we'll be assessing redundant code". The deletion follows the builder's current queue and runs
   before the quality pass, in this order:
   - a dependency audit separating the TypeScript code the Rust board reuses from engine-only code, together with
     the parity inventory. For each missing port, record its TypeScript source path and function at
     `737246d22` and the governing ruling, if one exists. The planner lists these ports for Tom to prioritise; they don't block deletion.
     Files the Rust board or its tooling still imports stay in use;
   - retiring `nucleus worktree` (Tom, 2026-11-25: "Yes, retire"). Its callers were Paseo setup and teardown hooks.
     The consumer sweep removed or replaced those hooks before the CLI route was deleted. The planner excluded an
     archived checkout and a Paseo-only setup that requires a private sibling source. Rust tasks allocate Git checkouts.
     Repositories use Effigy's pinned source declarations for sibling dependencies (ruling 33);
   - retiring the TypeScript decision bridge and importers;
   - removing `nucleus-legacy`, the read-only archive tool (Tom, 2026-11-25: "Remove nucleus-legacy, we've already migrated")
     and the disabled TypeScript `nucleus-acp` launcher. The read-only
     TypeScript database backup stays on disk. The old ACP entrypoint stops
     starting the TypeScript service and roll owner. The Rust T3 provider and its
     `nucleus-rust-acp` launcher stay installed;
   - deletion in batches of at most three modules. The retired Engine dependency cycle
     uses one review after its external imports and board inputs clear. Each commit
     builds the shipped board, and the complete deletion passes typecheck and affected tests;
   - the documentation rewrite.

A task never moves between engines.

### Standalone board

Build browser assets with `effigy engine:board-build -- /absolute/asset-directory`
or stage them with the executable using `effigy engine:stage`. Pass the matching
directory to `nucleus serve --board-assets`. Axum serves the board at `/` and
Settings at `/settings` on the engine’s loopback listener. The browser subscribes
to changes on the same origin.

The standalone board is the TypeScript web board itself: the same navigation,
cards, task dialog, Inbox list, planning screens and Settings sections. One
client data adapter (`client/web/rust-adapter.ts`) answers the shared screens'
board contracts from the paired API, so there is no second set of screens.

A Rust card uses the TypeScript three-line layout (Tom, 2026-11-24). The first
line shows the task number and project badge, with age alone at the right. The
age uses state entry, then the latest task event, then admission. History pages finished tasks
newest first by that same timestamp, breaking ties by descending task ID. Leads and
papercuts use the last update or creation time. The second line uses a regular-weight title on one
line with ellipsis, the full title on browser hover, and wrapping in detail.
Labels and status detail use T3's secondary label colour, resting titles use
its sidebar title colour, and open titles use its full title foreground.
The third line shows a dot and the state. A cause remains in detail and in the
status line's browser tooltip.

Task, lead, and papercut cards generate their T3-style project badge from the
Nucleus project name or key, including before dispatch. A saved T3 title refines
the generated badge, and a saved custom mark takes precedence when available.

Thin lifecycle bars sit below the body, aligned with its text. The strip uses
the same steps and colours as task detail, with five bars for code tasks and
four for report-only tasks. Each segment shows its step and recorded progress
on hover. The strip's accessible name summarizes the steps, and task detail
shows the labels, recorded durations and review round.

List, detail, `next` and native task titles share the label. A blocking hold
supplies the label. A hold that lets the
current turn finish adds an asterisk when the phase is shown. The engine
records a label change with the task update or scheduler wait that caused it.
Unrelated updates and repeated observations leave the entry time intact. Reads
use local task state and the recorded entry time. The first scheduler observation after restart
establishes a volatile wait without dating it. A label fixed by committed facts,
such as a blocking hold or a finished phase, keeps its recorded entry time.

The list reuses task cards while the row, journal and displayed wait facts
are current. Each request checks scope, prerequisite status, edit authority,
lane sources and the next scheduled check against current state.

The paired API mounts the same planning handlers as the controller API (plans,
lanes, items, decisions) and the repository reassign action. The session response
reports the engine's current project scope. On entry, the board reads scoped
plans, items and decisions from the store to populate the menu counts. It caches
the collections across views and identifies unreadable items, decisions and lane documents beside their healthy siblings. A malformed saved step withholds its project’s versioned plan so the board cannot edit a partial order. The board refreshes collections from engine events and stops
requesting a denied project until the session or its scope changes. Settings
needs no planning reads. Lane edits from the board and from an authenticated
report worker both signal a planning change. Decision changes refresh Needs you
independently of task activity. The paired board refreshes task cards on
list-visible changes, and an open task also refreshes on changes to its detail.
Profiles reads usage on entry and when recorded assignments or timed pauses change. The snapshot identifies malformed project or profile records and keeps their healthy siblings visible. Project diagnostics follow the paired scope. Settings reads
backup health with storage, and the board derives project activity from the task
list it already displays. Reconnects resync active views. Ages and running
durations advance locally. Screens leave out
controls for machinery these rulings retire; `client/engine-features.ts` names
the ruling behind each one. Settings writes send the whole domain value back
and keep fields the client does not know.

The board's Pause, Dispatch hold and Stop controls write the Dispatch domain's
`mode` (`running`, `held`, `paused` or `stopped`), which only Settings writes
change. Stop writes `stopped` in one revisioned settings update. The scheduler reads it from the in-memory read model: `held` starts no
task's first run, `paused` starts no run, and `stopped` also revokes each live
run so the ordinary stop custody settles it. A gated launch waits as Capacity.
Running again relaunches the work; no task carries a hold for it.

The board theme follows the host's settings and published themes. The scheduler's
host watcher keeps T3's `subscribeServerConfig` stream open, applies only its
`snapshot`, `settingsUpdated` and `environmentThemesUpdated` events, and caches
the result. `GET /api/engine/theme` reads the cache and never calls the host. A
change emits a `theme` event. The board resolves its palette through the shared
TypeScript theme converter, which has no dependency on the legacy RPC client.

`nucleus ui` prints a two-minute, one-use pairing link. The board discards
the link fragment and exchanges the token for an HttpOnly, SameSite=Strict
session cookie. The paired browser can reconnect after a service restart.
Its session expires after 30 idle days and renews at most once per day.
`nucleus ui --revoke` revokes sessions and pending links. The controller
credential stays with the CLI and service.

## Planning model (milestone 3)

Planning is plain record-keeping in the Rust service. It never calls a host (ruling 11), and it replaces about 35 TypeScript commands with these records and verbs.

**Records**

| Record | Fields |
|---|---|
| Lane | key, title, aim, document (Markdown), status `open`, `done` or `dropped`, with a closing note |
| Plan | the project's ordered lane keys, each with horizon `now`, `next` or `later`, a "done when" line and a status note |
| Item | kind `lead` or `papercut`, title, body, lanes, state `open`, `parked` (with a reason and an optional revisit date), `promoted` (with the task ID) or `dropped` (completed or deprecated, with an optional note), and the author |
| Decision | an operator question with options and the answer, shown in the Inbox |

The board and `item.drop --disposition completed|deprecated` preserve the closing
disposition and the separate reason. Older dropped records and calls that omit
the disposition default to deprecated.

**Verbs:** `plan.get` and `plan.set`; `lane.put` and `lane.status`; `item.add`, `item.edit`, `item.park`, `item.drop`, `item.reopen` and `item.promote`; `task.add`; `decision.add` and `decision.answer`.

**What gets simpler**

- **Promotion is one step.** `item.promote` admits a task from the item's body, using the brief frontmatter if present, and links the two. Concurrent or repeated promotion returns the linked task and its number without a second admission wake or capacity charge. Admission rechecks the selected scope after consulting Git before publishing the task. A promoted papercut without a frontmatter title takes its task title from the linked item. A planner's promotion is the authorization (Tom confirmed, 2026-11-24). The separate check and approve steps, with their relayed notes, are gone. The operator can still hold any task.
- **A task needs no item.** `task.add` takes a brief and puts it straight on the board (ruling 12).
  An existing PR may be supplied with its URL and expected head to start at
  review. The scheduler reads that exact PR in the configured repository and
  base. A changed head retires the old question, and an external merge of a
  review entry still needs operator acceptance. Before offering external source acceptance, the engine checks that the merge commit is on the configured base. A changed source must be the exact published PR ref and descend from the recorded source. A rewritten source or base puts the task in Needs attention with the cause. Hold and release the task to recheck. Closeout checks publication again before removing a checkout.
- **Concurrency is checked only where edits collide.** The board preserves the native spelling of lane keys in reads and edits. A long decision question keeps its full text in the detail view. A lane document and the plan carry a version for optimistic writes. Opening an earlier version shows the saved contents, author and time from that project’s history. Lane edits accept up to 4,000,000 UTF-8 bytes. The board can read the full stored document. The paired board edits a papercut's title and Markdown body at the item history version it opened, preserving its lanes. The engine checks that version in the item edit transaction. Unversioned CLI item edits and other planning writes keep their existing rules and history.
- **No ceremony records.** Lane keeps, drain prompts and idle marks are gone. The open lane lists unfinished tasks in its project. Membership comes from the brief, the promoted source item and the report delivery lane. Pinned documents alone do not attach a task. The board shows a lane with no open tasks, and a plan with no `now` lane is idle. Notes are short sentences with no hard 200-character cap.
- **The author comes from the caller's binding**, not from a free-text agent ID that breaks a later check.
- **Triage and milestone QA records are not ported** (ruling 12).

The Rust engine keeps these records by project in schema 8. A T3 planner can
omit the project from planning commands (planner ruling, 2026-11-24), for example
`nucleus plan.get`, `nucleus item.list` or `nucleus item.add papercut "Title"`.
The project comes from the caller's verified T3 binding. An explicit first
argument accepts the exact project key or a unique case-insensitive display
name, and the planner must be bound to that project. Exact keys take precedence.
Planning record reads and writes use that live binding. Task admission also
checks the cached checkout before using the repository.
The loopback API retains `/v1/planning/{project}` and exposes the same handlers
under `/v1/planning-current` with an optional `project` query parameter.

`plan.get` returns the order and lane documents. Use version zero for a new
plan or lane and the returned version for the next edit. `lane.status` updates
the disposition independently. The browser keeps the selected project with the
lane key on document reads, edits and status actions. Lane keys can repeat
across projects. `item.list` and `decision.list` read the current records.
New decisions require at least two options with distinct IDs and labels.
Labels are compared after trimming. The board retains each option's ID from
the read through the answer, including older decisions whose labels repeat.
Answering requires an operator binding and an explicit project. Answering a
planner-authored or task-linked decision also delivers one answer notice
through the planner message queue under ruling 52. A decision that belongs to a
task question accepts one answer for the bound task version, then wakes the
ordinary answer path.

`task.add` reads a brief from stdin. `item.promote` admits the current item
body and commits the task, source link and item history together. When the
board names a repository, promotion verifies and uses that repository in the
item's project. The reply gives the admitted task's public reference. A retry
returns the task already admitted from that item.

During cutover, the offline `item.import` command copied the retained Planning
items and profile settings from a fenced TypeScript backup. The active CLI
retires this command in milestone 4.

A stored profile with no enabled flag defaults to enabled. Dispatch checks the
flag for each new reservation and uses the demand and capability rules in
[Spec 053](053-demand-based-selection.md). The T3 adapter translates canonical
mode, effort and options against the matching provider instance and model. It
uses the same thinking carrier precedence as the
[TypeScript adapter](t3code-host-adapter.md#model-options) and leaves canonical
feature defaults to the provider. A profile with an option the adapter or model
cannot express stays out of dispatch.

## Out of scope until milestone 3

- Papercuts, leads, decisions and plans keep their current store and CLI until they
  move in (ruling 12). Until then the engine reads leads only to admit a promoted task.
- Usage levels, model selection and budgets carry over as plain settings, not as new
  state. They're part of milestone 2's settings (ruling 8).
