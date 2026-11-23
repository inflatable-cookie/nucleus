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
  values; create and update refuse anything else. A profile stores its thinking
  level once, in `thinkingOptionId`, and its mode once, in `modeId`
  (nucleus#1365, Tom 2026-11-19: "There should only ever be one field for this
  setting in the profile settings UI"): an option a host's table uses to carry
  either (a provider's `thinkingOption`, the host's `thinkingSelects` such as
  T3's `reasoningEffort`, a mode's option values) is never a feature field in
  the editor, which shows one Thinking and one Mode control in canonical values.
  A stored feature value on such an option makes the profile unavailable on that
  host with the reason named, and the migration below moves stored thinking
  carriers to the level. Each host adapter owns one
  table (`hosts/paseo/vocabulary.ts`, `hosts/t3code/vocabulary.ts`) that
  translates canonical values to its own: Paseo spells Claude's `full-access` as
  `bypassPermissions` and `supervised` as `default`, and carries Grok's
  `full-access` as its `auto_accept` option; T3Code names Claude `claudeAgent`
  and carries its thinking as the `effort` option (`ultra` is `ultrathink`) and
  Pi's as `thinking`. Provider options also have canonical keys (nucleus#1386,
  Tom 2026-11-19: the Astra profile's `service_tier` "is the same setting as
  'speed' in paseo"), stored in `featureValues`: `speed` (`default`, `priority`,
  `ultrafast`) is Paseo's codex `service_tier` and claude `fast_mode`, and T3's
  codex `serviceTier` and claude `fastMode`; `plan-mode` (Paseo codex
  `plan_mode`), `cyber-access` (T3 codex `cyberAccessProgram`) and `ultracode`
  (T3 claude `ultracode`) are single-host options kept for their defaults. Each
  table's `options` spell them; the editor shows one canonical control per option
  and none of the host spellings. A canonical option at its default is the
  provider's own default and is never sent, so it runs on every host; a
  non-default value a host's table can't spell (T3 has no ultrafast tier) or a
  model doesn't offer makes the profile unavailable there with the reason
  (`T3Code can't express speed Ultrafast for codex`), so selection excludes it
  and the pre-send check stays drift protection only. A value a host's table can't express makes the profile
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
  Pool saves (`queue.profile`, `queue.pool`) check identity against the stored
  profile records, never the routing snapshot, which is empty until a host
  catalog is read (nucleus#1492). A stored profile saves with or without a
  catalog read, and the catalog still alone decides whether it can launch on a
  host. A new or changed entry naming no stored profile is refused as `Unknown
  profile <id>`; an unchanged entry for a removed profile is kept as inert.
  Duplicate and reserved-group checks are unchanged.
  `profile.vocabulary` answers Settings' form: every registered host's catalog in
  canonical values, merged, so each dropdown offers what at least one host can
  run. Settings → Profiles edits canonical values only; a row shows one quiet
  warning icon when Nucleus serves more than one host and the profile can't run
  on one, with each host's reason in its popover. Stored profiles moved to the
  canonical vocabulary once on open (`profileVocabularyMigration` records what
  changed); a profile with a value the migration doesn't know is left as stored
  and reported. On every open the service then moves a thinking level held in a
  host carrier (`featureValues.thinking`, `effort`, `reasoningEffort`,
  `reasoning`) or a host spelling in `thinkingOptionId` (`ultrathink`, BB's
  `none`) to the canonical level, read back through every host table
  (`hosts/vocabularies.ts`); `profileThinkingMigration` records the first run and
  any run that changed a profile. The same way, host spellings of a canonical
  option (`service_tier`, `serviceTier`, `fast_mode`, `fastMode`, `plan_mode`,
  `cyberAccessProgram`, a boolean `ultracode`) move to the canonical key, keeping
  their meaning; `profileOptionMigration` records it. A value no table maps, or two values that
  disagree, stays as stored and reported, and shows on the profile as that host's
  reason. The task card reads a routing snapshot's level back through its host's
  table, so it shows the canonical level, not the host's spelling. The per-profile host setting (nucleus#1151) and the provider map
  (2026-11-08) are retired.
- The
  earlier migration copied Paseo's `config.agentProfiles` once with
  ids unchanged and records that it ran, so the pool, routing requests
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
buttons: the level, its end time, task slots and project overrides
save as they change, an invalid value is not sent, and each section shows
a brief Saved or the reason it was not saved (Tom, 2026-10-22; Saving… stays quiet, Tom 2026-11-08).

Profile capability is four brackets (Tom, 2026-11-19: "a simpler 4 point
bracketing system … essentially we're just combining medium and high to create
a pool of workers"). Task complexity keeps its own five-point scale.

| Bracket | Was |
| --- | --- |
| **Mechanical** | `low` |
| **Worker** | `medium` and `high`, one pool |
| **Heavyweight** | `very_high` ("extra high") |
| **Frontier** | `frontier` |

"The top two" are Heavyweight and Frontier. The store moved stored values once
(nucleus#1385); the migration is idempotent and lists any value it doesn't
know, leaving it as stored.

A task's **own bracket**: very-low and low complexity are Mechanical, medium
and high are Worker, very high is Heavyweight. The bracket it **may climb to**
is its own, one higher for high and very high: the medium/high difference is
the step-up (Tom, 2026-11-19: "a medium complexity task goes to a Worker
profile, a high complexity task starts on a Worker but can escalate to a
Heavyweight if it needs to").

**Explicit profile requests (Tom, 2026-11-22).** A planner can request a profile
for a role with a reason in the brief or through an owner route. The request
takes effect on that role's next run, and routing details show the reason.

| Level | Where a task's worker starts | Permission |
| --- | --- | --- |
| **Low** | One bracket below the one it may climb to. | The operator approves admission of high and very-high work. Frontier is request-only, as is Heavyweight unless the task starts or climbs there. |
| **Normal** (default) | On its own bracket: Mechanical, Worker or Heavyweight. | Frontier is request-only, as is Heavyweight unless the task starts or climbs there. |
| **High** | At the bracket it may climb to, up to Heavyweight. | Frontier is request-only. |
| **Extra high** | As at High. | None. |
| **Maximum** | Workers and reviewers run on Heavyweight or Frontier regardless of complexity. | None. |

- **Above the climb bracket.** A worker run above the bracket the task may
  climb to is an explicit planner or operator route, never automatic.
- **Step-up.** When an applied review requests changes on a task that started
  below the bracket it may climb to, the next worker run climbs one bracket,
  never past it: a medium task stays on Worker, a high task climbs once to
  Heavyweight, and very-low and low tasks stay on Mechanical. A very-high task
  steps up to at most Heavyweight at Low, Normal and High, and can step up to
  Frontier at Extra high and Maximum. The applied review outcome
  (`resolution.review.status === "changes_required"`) authorizes it, never the
  `changes_requested` phase alone (an owner move or recovery also takes that
  phase), and one climb is recorded per review run
  (`resolution.workerClimb`). A retained worker thread cannot change profile, so
  the climb is the one automatic worker replacement: the ordinary revision
  launch records the climb, retires the retained worker (for the archive sweep),
  and continues as its usual revision run on a fresh agent at the climbed
  profile; delivery binds that agent and run as the task's retained worker,
  keeps the selected subscription group on both the run and the task, and
  charges that fresh binding's assignment, so a later same-bracket revision
  continues it. A retained revision, re-review or coordinator turn keeps its
  thread and charges nothing: the rotation history counts fresh and explicitly
  selected bindings only. The climb is recorded before the launch
  so its bracket stays permitted, and the `changes_requested` phase alone never
  authorizes it. Availability and failover checks use the recorded climb when
  checking the earned bracket. A planner or owner can request a higher bracket
  explicitly.
- **Automatic selection stays at or below the climb bracket.** The run's
  bracket is its demand: it rotates inside that bracket, takes the nearest
  bracket above only when nothing carries it, and falls back to the most
  capable profile at or below the climb bracket on a shortfall. A profile above
  it is never automatic for a worker, and neither a worker preference nor a
  `preferredProfileId` reaches it; only an explicit request or owner route
  does. Maximum's own rule is Heavyweight and Frontier for workers and
  reviewers, an explicit worker request included, and an unrated retained
  reviewer is below it too.
- **The usage level sets the reviewer's bracket** (Tom, 2026-11-19: "the
  reviewer should be 1 bracket down from the worker on minimal, low and
  normal. Above that, it should be same bracket"). At Low and Normal the
  reviewer runs one bracket below the worker's actual profile (its start
  bracket before a worker ran): Heavyweight → Worker, Worker → Mechanical,
  Frontier → Heavyweight, and a Mechanical worker gets a Mechanical reviewer.
  At High, Extra high and Maximum it runs on the worker's bracket. Tom,
  2026-11-22: High moves to the one-bracket-below rule ("I want to use high to
  make use of Sol as worker, but still have lower bracket profiles do the
  review"), so the reviewer is on the worker's bracket only at Extra high and
  Maximum. Until nucleus#1559 lands, the code still uses the earlier rule. No reviewer
  floor parks review: when no independent profile carries the reviewer's
  bracket, the nearest permitted bracket above serves, and otherwise the most
  capable permitted profile. A critical task prefers a reviewer at least as
  capable as the worker when one is permitted, and falls back the same way
  (kept by Tom, 2026-11-19). At Maximum reviewers still use Heavyweight and
  Frontier.
- **Nothing waits for profile approval.** An explicit request applies on the
  role's next run. The Low submission gate still holds work that needs
  admission approval.
- **Other roles.** Reviewers keep the independence rule, and a retained
  reviewer below the bracket the level asks of it is replaced on the next
  round. Coordinator and recovery runs always use Mechanical when an eligible
  Mechanical profile is available, and otherwise the lowest permitted bracket
  that has one, at every level including Maximum (Tom, 2026-11-19: "Coordinator
  should always be mechanical if available, worker shouldn't have an offset at
  all"). There are no role-demand offsets: the Settings section is gone and the
  store drops a stored `demandRoleOffsets`, noting it in the migration record.
  Deciders run on the task's own bracket (nucleus#1362).
- **Eligibility.** Automatic selection uses enabled, available profiles within
  the effective usage and role bounds. A planner request with a reason can
  reach outside automatic selection, subject to profile availability, thinking
  support and role rules. Rotation weight affects selection among eligible
  profiles ([Spec 053](053-demand-based-selection.md)).
- **Frontier is a capability bracket, not a cost** (Tom, 2026-11-09: "Can we
  get rid of very low, and instead add `frontier` to the other end of the
  scale?… then Opus would move to `frontier` to distinguish it better from
  Sol"). The 2026-10-01/15 rule that very_high cost meant frontier is retired.
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
  still carries one reads without it.
- **Preference.** The level sets each run's start bracket, not a weight: since
  [Spec 053](053-demand-based-selection.md) (Tom, 2026-10-21; 2026-11-04) the
  set is every profile rated at or above the demand, with rotation and fair
  share inside it, weighted by the five-stop weight share (80% to 120% of Default, Tom, 2026-11-21), which never removes a profile. The
  2026-10-18 soft leans and tier orders are retired. An unavailable
  subscription group leaves the set; when nothing meets the demand, selection
  takes the most capable eligible profiles.
- **Roles.** The level applies to every automatic selection: worker, reviewer,
  coordinator and replacements. Review independence is unchanged; the reviewer
  still excludes every author model.
- **Request a profile for each role that needs it.** The task planner, project
  planner or operator can name a profile and reason in `profileRequests`. An
  owner can use `route` for the same change on an existing task. Workers and
  reviewers cannot request a profile for themselves. A legacy worker preference
  stays within automatic selection. An ordinary `route` applies from the next
  run, and `route now` uses the existing stop and replacement gates.
- **Upgrade.** The store withdraws open routing approval decisions and records
  the removal of standing grants. Existing explicit requests keep their
  profile and reason. Historical decisions remain in the record.
- **Expiry.** `until` returns the level to Normal when it passes. Settings shows
  which level is in force, and when a set level has expired. The board
  re-projects once when the level in force changes, so an open Settings screen
  never keeps showing an expired level.
- **Diagnostics.** When usage bounds leave a role without an automatic
  profile, `next` names the bracket and offers `route`. It also reports
  catalog, subscription, exclusion and reviewer-independence constraints.
- **Effective policy on reads.** Tom chose this explanation as the Nucleus
  priority on 2026-10-19 (decision 83556116; papercut b6804a4b): an owner read
  a stored flag as absolute and rerouted a correct automatic Maximum pick.
  Reads show the policy in force, derived from the selector's own
  `requestOnly`; no gate or setting changes.
  - `task.next` and `queue.detail` carry `routingPolicy` (a recorded row that still carries the retired `cost` reads without it, nucleus#1488): the dispatch-level policy, and
    one row per profile the task names (worker request, worker preference,
    recorded worker or reviewer run, reviewer and coordinator requests). Each
    row has `capability`, `automatic` (`allowed`, `request_tier` when the
    automatic selection excludes the profile, or null outside the pool), its pool `gates` (disabled,
    group unavailable), an `explanation` and the request reason when present. A request stays
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
    a paused subscription group); each row carries a control-height usage strip
    that fills relative to the busiest profile in the rendered list (nucleus#1501).
    Tied leaders fill; zero has a neutral, empty track. Hidden and removed profile
    history cannot set the maximum, and an all-zero sample has no fill. A cool-to-warm
    color cue supplements length, which carries the comparison independently of
    color. The accessible name and tooltip keep the exact count, the window's real
    sample size and the selected view; the Profiles help explains once that a full
    strip means busiest in the list.
    A selector above the list (All, Workers, Reviewers, Coordinators) picks the view
    (nucleus#1502). All reads the board's existing `recentAssignments` window, the
    most recent 50 charges across roles, sized by `recentAssignmentSample`. Each role
    reads its own most recent 50 charges from `assignment_role_history`, recorded with
    the routing purpose at the existing charge (`chargeAssignment`) and trimmed per
    role, so heavy worker traffic cannot evict coordinator or reviewer samples.
    Worker revisions are workers; proof executors and closeout keep their own
    purposes and count in All only. Untagged history counts in All and starts no role
    window. A view's maximum and denominator come from that view alone, and an empty
    view says it has no recorded assignments. Routing, the global 50-assignment
    selection window, assignment totals and group data do not change. The capability control shows the
    four brackets, and its (?) says where each complexity starts and which brackets
    require a profile request.
- **Normal.** Normal starts every task on its own bracket.
