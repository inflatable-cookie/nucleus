# 052 — Usage level

This is a dispatch policy setting, not subscription usage monitoring. Provider
subscription displays belong to host apps and their plugins (Spec 059 is
retired).

Status: implemented
Owner: Nucleus runtime maintainers
Created: 2026-10-18
Decision owner: operator (Tom, 2026-10-18: "slide the slider all the way to the
right and the Queue will pick those models by default without having to ask for
it")
Governing refs: [Spec 030](030-routing-changes.md) (routing, cost and capability),
[orchestration contract](../contracts/orchestration.md) (frontier profiles)

## Problem

Frontier profiles are by request: automatic selection never lands on one, and
every role needs an explicit profile and reason. When the
operator has plenty of usage, for example free resets, asking per task is
friction. When usage is tight, nothing holds automatic selection to cheap
profiles.

## Rule

- **The profile list is Nucleus's own** (Tom, 2026-11-06: "have the host app
  provide a list of all the providers and models, then allow the operator to
  create profiles based on their selections"; 2026-11-07: the list set up in
  Nucleus is the one that is kept, and hosts may name a provider differently).
  Nucleus stores its own profile records — id, name, provider, model, mode,
  thinking level, feature values and notes — read and edited with
  `profile.list`, `profile.create`, `profile.update` and `profile.remove`. Each
  host reports what it can run through `host.catalog` (every provider, its
  models with thinking options, and the modes and feature values each model
  offers), in its own spelling.
- **One canonical vocabulary; each host translates it in code** (task 1158,
  Tom 2026-11-12: "It shouldn't touch the profiles themselves.. feels like we
  might just need to hard code the mapping that each host gives to each provider
  and have them converge on one canonical corpus that we use in the settings
  form"). `shared/profile-vocabulary.ts` owns the corpus: providers (`codex`,
  `claude`, `pi`, `grok` and the others hosts report), the provider's own model
  ids, one ordered thinking scale (`off` … `ultra`) and one set of runtime modes
  (`plan`, `supervised`, `accept-edits`, `auto`, `auto-review`, `full-access`).
  Feature values are the provider's own options. Profiles store only canonical
  values; create and update refuse anything else. Each host adapter owns one
  table (`hosts/paseo/vocabulary.ts`, `hosts/t3code/vocabulary.ts`) that
  translates canonical values to its own: Paseo spells Claude's `full-access` as
  `bypassPermissions` and `supervised` as `default`, and carries Grok's
  `full-access` as its `auto_accept` option; T3Code names Claude `claudeAgent`
  and carries its thinking as the `effort` option (`ultra` is `ultrathink`) and
  Pi's as `thinking`. A value a host's table can't express makes the profile
  unavailable on that host with the reason computed (`T3Code can't run codex in
  mode plan`); nothing is configured per profile. Selection marks a profile
  unavailable when its requested thinking level is absent from the host catalog.
  If that catalog changes between selection and T3 launch, the adapter instead
  chooses the nearest supported canonical level from the launch snapshot, with
  ties going lower; it can choose a higher level, and refuses before send if no
  level can be carried. This handles catalog drift without selecting a profile
  already known to be unsupported. Each
  host's routing snapshot carries the translated launch values, judged against
  that host's catalog, and a profile edit rebuilds the snapshots from the
  catalogs already read. `profile.compatibility` answers, for every stored
  profile and every known host, `works`, `unavailable` or `unknown` (catalog
  never read) with the reason naming the host, the fields that host spells
  differently and the values a launch there sends; `routingPolicy.host.effects`
  lists each enabled profile a task's host rules out or translates.
  `profile.vocabulary` answers Settings' form: every registered host's catalog in
  canonical values, merged, so each dropdown offers what at least one host can
  run. Settings → Profiles edits canonical values only; a row shows one quiet
  warning icon when Nucleus serves more than one host and the profile can't run
  on one, with each host's reason in its popover. Stored profiles moved to the
  canonical vocabulary once on open (`profileVocabularyMigration` records what
  changed); a profile with a value the migration doesn't know is left as stored
  and reported. The per-profile host setting (nucleus#1151) and the provider map
  (2026-11-08) are retired.
- The
  earlier migration copied Paseo's `config.agentProfiles` once with
  ids unchanged and records that it ran, so the pool, routing requests, grants
  and history keep matching; a Nucleus profile is never overwritten and a later
  Paseo change imports nothing. Availability is read from a stored profile and
  one host catalog, with no silent fallback: a host lacking the provider or model
  makes the profile unavailable with a plain reason. Settings → Profiles is the
  picker (Tom, 2026-11-06: "show whatever the host reports. We need to be able to
  control permission settings and agent-specific modes"): it creates, edits and
  removes the stored records, showing each one's availability and plain reason
  on this host, and a new profile picks a provider and model from the host
  catalog, then a mode, a thinking level and that model's feature values, plus a
  name and notes. The catalog is read for a configured repository directory,
  because the host resolves feature values per working directory. Routing reads
  the stored records and the host catalog.
  Options don't vary by host (Tom, 2026-11-07: "Let's go with no for now and look
  at it again if the need arises").

The operator sets one host-wide usage level on a five-stop slider (Settings →
Dispatch limits, or `queue.usage`): **low, normal, high, extra high and maximum**
(Tom, 2026-11-17; `minimal` is removed). The level carries an optional end time
when it returns to Normal, picked from a calendar in local time. Settings offers
the end time above Normal (High, Extra high and Maximum), as small text on the
section's heading row ("No end" or "until <date>"), and moving to a lower level
clears it (Tom, 2026-11-09). Dispatch limits has no save
buttons: the level, its end time, role demand, task slots and project overrides
save as they change, an invalid value is not sent, and each section shows
a brief Saved or the reason it was not saved (Tom, 2026-10-22; Saving… stays quiet, Tom 2026-11-08).

"Tiers" here are the capability scale profiles already carry. "The top two
tiers" are `frontier` (Opus-class) and `very_high` (Sol extra-high-class).

| Level | Where a task's worker starts | Permission |
| --- | --- | --- |
| **Low** | Every task starts one tier below its complexity. | High and very-high complexity work needs permission at submission: a decision opens on the board and the task is held until the operator approves. Once approved, the Low rules apply. Any run on the top two tiers needs permission. |
| **Normal** (default) | High and very-high complexity tasks start one tier below; lower complexities start at their requested tier. | Any run on the top two tiers needs permission, except climbing back to the task's own requested tier, which is always allowed. |
| **High** | At the requested tier. | Frontier needs permission. |
| **Extra high** | At the requested tier. | None. |
| **Maximum** | Workers and reviewers run on frontier or very-high models regardless of complexity. | None. |

- **The task's requested tier** is its complexity on the profile capability
  scale (`very_low` and `low` ask for `low`; complexity never asks for
  `frontier`). A run above the requested tier is an explicit planner or
  operator route, never automatic.
- **Step-up.** When an applied review requests changes on a task that started
  below its requested tier, the next worker run climbs one tier, up to the
  requested tier and never past it. The applied review outcome
  (`resolution.review.status === "changes_requested"`) authorizes it, never the
  `changes_requested` phase alone (an owner move or recovery also takes that
  phase), and one climb is recorded per review run
  (`resolution.workerClimb`). A retained worker thread cannot change profile, so
  the climb is the one automatic worker replacement: the ordinary revision
  launch records the climb, retires the retained worker (for the archive sweep),
  and continues as its usual revision run on a fresh agent at the climbed
  profile; delivery binds that agent and run as the task's retained worker,
  keeps the selected subscription group on both the run and the task, and
  charges that fresh binding's assignment, so a later same-tier revision
  continues it. A retained revision, re-review or coordinator turn keeps its
  thread and charges nothing: the rotation history counts fresh and explicitly
  selected bindings only. The climb is recorded before the launch
  so its tier stays permitted, and the `changes_requested` phase alone never
  authorizes it. Request reconciliation (`reconcileRoutingSignoffs`) and route
  admission read the same recorded climb, so a request or route at the earned
  tier needs no second sign-off; the same-capability non-delivery and rate-limit
  replacements read it too, so an eligible alternate on the earned tier is not
  discarded. Climbing back to the requested
  tier never needs permission; going above it is an explicit planner or
  operator route.
- **Automatic selection stays at or below the requested tier.** The run's tier
  is its demand: it rotates inside that tier, takes the nearest tier above only
  when nothing carries it, and falls back to the most capable profile at or
  below the requested tier on a shortfall. A profile above the requested tier is
  never automatic for a worker, and neither a worker preference nor a `preferredProfileId`
  reaches it; only an explicit request or owner route does. Maximum's own rule
  is the top two tiers for workers and reviewers, an explicit worker request
  included, and an unrated retained reviewer is below it too; a coordinator keeps
  its configured offset instead.
- **The reviewer offset sets the reviewer's tier.** A reviewer's demand is the
  worker's actual tier (its calculated demand before a worker ran) moved by the
  reviewer offset, so a negative offset reviews below the worker. No reviewer
  floor parks review: when no independent profile carries the reviewer's tier,
  the nearest permitted tier above serves, and otherwise the most capable
  permitted profile. A critical task prefers a reviewer at least as capable as
  the worker when one is permitted, and falls back the same way. At Maximum
  reviewers still use the top two tiers (Tom, 2026-11-18: "a reviewer should be
  able to be lower tier"; "a Sol reviewer for an Opus worker is fine"; the
  earlier absolute floor was never his rule).
- **Nothing waits for an escalation sign-off** except the Low submission gate.
  A role whose preferred profile needs permission runs on the best allowed tier
  while the decision is open on the board, as before.
- **Other roles.** Reviewers keep the independence rule, and a retained
  reviewer below the reviewer demand (the worker's actual tier moved by the
  reviewer offset) is replaced on the next round.
  Coordinator and recovery runs keep their existing offset under every level,
  including Maximum.
- **Eligibility** (Tom, 2026-11-09). Automatic selection may use a profile when
  its capability tier and its On/Off switch allow it at the level in force,
  nothing else. Outside that, a profile needs an explicit request with a reason
  and sign-off. Cost is a rotation lean ([Spec 053](053-demand-based-selection.md)),
  never a permission rule (Tom, 2026-11-17).
- **Frontier is a capability tier, not a cost** (Tom, 2026-11-09: "Can we get
  rid of very low, and instead add `frontier` to the other end of the scale?…
  then Opus would move to `frontier` to distinguish it better from Sol"). A
  profile's capability runs `low, medium, high, very_high, frontier`; a stored
  `very_low` reads as `low`. The 2026-10-01/15 rule that very_high cost meant
  frontier is retired.
- **The Low submission gate** (Tom, 2026-11-17). Submitting a high or very-high
  complexity task while Low is in force opens one operator decision linked to
  the task and places a dispatch hold naming the level and the complexity. The
  gate is decided at admission: `store.insert` records it only when the level in
  force then is Low and the complexity qualifies, so work submitted earlier or
  already running when the level changes is never held. If the task already
  carries a board or planner hold, the gate opens its question beside it and
  places no fence of its own; later approval clears only a fence the gate
  placed. The task does not dispatch until the decision is approved on the
  board; a relayed answer does not approve it. A decline keeps the hold, and the
  owner's exit is lowering the complexity (`set_routing`) or raising the level,
  either of which withdraws the question and clears the gate's own fence.
- **By request is retired** (Tom, 2026-11-09: "Retire it, fold into #1002";
  earlier the same day: "lift it at maximum slider? That's sort of the point of
  that slider setting"). The pool's `byRequest` flag, its toggle and its row
  status are gone; the store drops stored flags on open, and a pool write that
  still carries one reads without it. Requests and grants still work for any
  profile the level's permission rule holds.
- **Preference.** The level sets each run's start tier, not a weight: since
  [Spec 053](053-demand-based-selection.md) (Tom, 2026-10-21; 2026-11-04) the
  set is every profile rated at or above the demand, with rotation and fair
  share inside it, weighted by a cost lean that never removes a profile. The
  2026-10-18 soft leans and tier orders are retired. An unavailable
  subscription group leaves the set; when nothing meets the demand, selection
  takes the most capable eligible profiles.
- **Roles.** The level applies to every automatic selection: worker, reviewer,
  coordinator and replacements. Review independence is unchanged; the reviewer
  still excludes every author model.
- **Coordinators.** A coordinator's `route` is refused to a profile the level's
  permission rule holds: a top-tier profile above the task's requested tier at
  Low or Normal, or a frontier profile at High.
- **Explicit requests and sign-off** (Tom, 2026-10-21: "fully bound by
  default, but allow explicit override with reason _and_ sign off from me").
  A request (`profileRequests`, owner or coordinator `route`, `set_routing`)
  for a profile the level's permission rule holds applies only
  once the operator signs it off on the board. Nucleus asks through an operator
  decision linked to the task, on the requester's behalf: approve the
  requested profile, pick another from the role's pool, or decline. A required
  legacy worker preference for such a profile enters the same request and
  decision lifecycle before dispatch; it grants no sign-off by itself. Nothing
  waits for the answer (Tom: "don't hold things up"): an unsigned request pins
  nothing, sets no thinking level and never leaves a role waiting, so the role
  runs on automatic selection within the level. When an approval arrives, Nucleus
  applies it through `route`: a live role run that was selected automatically
  while the request awaited sign-off is replaced on the approved profile, and a
  role with no live run (including a worker that has handed over to review) gets
  the route for its next run. Workspace and branch stay in place. The replacement
  ceiling and worker replacement guard still apply; if they refuse a live worker
  replacement, the approved route is saved for the next run and the activity
  records why the live run stayed. A decline leaves the run alone. Only an
  answer given on the board counts (Tom: "Board
  UI"); a relayed answer, a withdrawal or an answer that names no option
  declines, and the requester gets the answer as for any decision. The
  operator's own board `route` or `set_routing` is its own sign-off. An
  approval already given for a task and profile is not asked again: a
  re-recorded request for the same role and profile restores the recorded
  approval instead of opening a new decision, while a later ruling for the
  same role and profile wins. A recorded selection that predates a required
  approved route yields to it from that role's next run: the next worker run
  is replaced onto the approved profile and a stale reviewer or coordinator
  binding is dropped, without stopping a live run. A route
  that replaces the request withdraws the open question; a finished task
  withdraws its open ones; a level that later covers the profile withdraws it
  as moot. `route now` to an unsigned request-only profile is refused, since it
  would only restart the role on automatic selection. Requests on live tasks
  when this shipped were bound too, each opening its own question (Tom: "Bind
  them too"). A request within the level needs no sign-off. A worker already
  bound to its task keeps its own thread on its profile until the task ends
  (Tom, 2026-10-21: "Keep its thread"); a live run and a review continuation are
  never stopped by sign-off. Every new selection is bound: a fresh reviewer on
  the recorded reviewer profile, a new run on the bound coordinator, and new or
  replacement workers. The answer maps through the options as they were asked,
  and an unsigned worker route keeps its thinking level on the request. Submissions never
  carry a sign-off; Nucleus writes it. `routingPolicy` rows show each request's
  sign-off state. Automatic author capability upgrades are retired by Spec 058 cutover 3; a stronger worker model requires an owner route and the usual sign-off.
- **Planner grants** (Tom, 2026-11-06: when frontier is needed it is generally needed for a string of dispatches; agents ask and handle the routing, the operator only says yes). A planner requests a standing grant with `queue.routing-grant` action `request`, naming why and optionally which profiles and until when. Nucleus opens one operator decision on the existing board. A board yes activates the grant; a relayed answer does not. A repeat request while one is open joins it; a planner with an active grant is told so. Only the operator's board answer activates a grant: an agent cannot grant itself or another. While the grant stands, an explicit `profileRequests` or `route` on a task whose owner is that planner is treated as signed off, with the grant ID recorded on the request and in `routingPolicy`, and no per-task decision. Requests the grant does not cover — another planner's task, automatic selection, a profile outside a named set — keep today's route. The grant does not move automatic selection or demand. Coverage follows the current owner: a reparented task is covered only while its owner is the granted planner; reparenting away clears a grant-based sign-off, so the next fresh run falls back unless the new owner has a covering grant or a true operator per-task sign-off. The planner ends the grant with action `end`. The operator revokes from Settings → Limits at any time. An optional `until` expires it. An archived planner thread ends it. Revoking, ending, expiry and archive stop new sign-offs at once, are idempotent, and record the time. A covered request then remains on automatic selection without a new per-task decision; `routingPolicy` names the ended grant. A new grant or a fresh explicit request after the end enables frontier again. A task already running on the profile finishes that run; its next fresh run falls back. Open per-task decisions the new grant covers settle themselves; an explicit per-task decline stays declined, including if the planner resubmits or routes the same request while a grant stands. Without a covering grant, resubmitting a declined request is unsigned and opens a fresh per-task decision (today's route). Restart keeps stored grants. Settings → Limits lists active grants (planner, profiles, since when, run count) with a revoke control, never the board header (Tom, 2026-11-06); `next` says a request was covered by a grant. Run count increments for each fresh dispatch under the grant: the initial worker at `dispatch_intent`, and each new reviewer, worker-revision, or coordinator-route (recovery, verification, closeout) run on first `putRun`. Wake inventories live agents to archive a grant only when one is pending or live, bounded to 10s; a truncated or failed inventory leaves grants standing. Board projection reads live grants without persisting expiry; reconcile still writes expiry so covered sign-offs clear.
- **Expiry.** `until` returns the level to Normal when it passes. Settings shows
  which level is in force, and when a set level has expired. The board
  re-projects once when the level in force changes, so an open Settings screen
  never keeps showing an expired level.
- **Diagnostics.** When the level's permission rule, not the pool, leaves a
  role with no profile, the wait says so: it names the tier the level holds
  selection below, and says to raise the level or `route` the role. A catalogued
  profile the eligible set filtered out is reported as filtered, never as
  missing: excluded for this task, sharing the reviewer's model, or filtered
  from the eligible set; only a profile outside the catalog is absent. The wait stays a
  verb-free `route_unavailable` wait, since a coordinator cannot route past the
  level's permission either; `next` offers the owner `route`.
- **Effective policy on reads.** Tom chose this explanation as the Nucleus
  priority on 2026-10-19 (decision 83556116; papercut b6804a4b): an owner read
  a stored flag as absolute and rerouted a correct automatic Maximum pick.
  Reads show the policy in force, derived from the selector's own
  `requestOnly`; no gate or setting changes.
  - `task.next` and `queue.detail` carry `routingPolicy`: the dispatch-level policy, and
    one row per profile the task names (worker request, worker preference,
    recorded worker or reviewer run, reviewer and coordinator requests). Each
    row has `cost`, `capability`, `automatic` (`allowed`, `request_tier` when the
    level's permission rule holds the profile, or null outside the pool), its pool `gates` (disabled,
    group unavailable) and an `explanation`. A request stays
    explicit at every level; a preference alone does not satisfy a request
    requirement; a recorded run is history, not relabelled by today's level.
    Catalog availability is checked at dispatch, not here. Both reads compute
    it fresh, including over a cached detail payload, so expiry shows at once.
  - The board's Next section lists those rows; route and routing profile buttons
    tag the effective policy, and the chosen profile shows its full sentence.
    The route chooser offers every enabled profile (Spec 053 retired the role switches); a profile that fails a
    pool gate (disabled, the same check a route refuses on) reads
    "not eligible" with its cause, never "automatic". A profile whose
    subscription group is unavailable reads "group unavailable" in both
    choosers, with the reason and reset time once chosen. Long labels wrap.
    Settings → Profiles rows show a status only for a problem (unavailable, or
    a paused subscription group); the capability slider's (?) says the top two
    tiers need permission at Low and Normal and frontier at High.
- **Normal.** Normal starts high and very-high complexity one tier below and
  every lower complexity at its requested tier.
