# Changelog

## [Unreleased]

## [0.1.0] - 2026-11-10

Nucleus's first release brings durable local task dispatch, independent review,
merge gates and recovery to agent work. This release ships a standalone runtime
for macOS on Apple silicon, with a Paseo integration and a local web board.

### Install and distribution

- Install a pinned release with `nucleus install owner/repository@tag`, a release
  manifest URL or a local archive. Packages include Node and its non-system
  shared libraries, verify archive and file checksums, and record the exact
  source revision. No source checkout or dependency installation is needed.
- The `nucleus` command and bundled agent skill follow the active package.
  Installation, rollback and recovery converge those links; collisions with
  unrelated commands or skills refuse safely. Paseo registration is an explicit
  `nucleus integrate paseo` step.
- Release installs stay pinned. An opt-in local main channel builds and proves a
  replacement before handing over the service, retries incomplete activation,
  and keeps the working service available when a build fails. CLI calls recover
  recorded outcomes across rolls without blindly repeating mutations.
- `release:prepare` produces the macOS arm64 archive, checksum, GitHub manifest
  and release notes, and prints the publish command. A fresh-install proof checks
  those artifacts through a loopback HTTPS manifest and a private Paseo daemon.

### Board and UI

- Follow queued submissions and tasks through the Pipeline, inspect task details,
  filter by project and open a project board from its workspace. The local web
  board is available through `nucleus ui` with live updates.
- Manage plans, lanes, leads, papercuts and decisions in Nucleus. Pending questions
  stay visible, linked records follow their projects and lanes, and lists retain
  their last result while refreshing or reporting a failed read.
- Settings brings together Profiles, Subscriptions, Limits and Projects. Profile
  editors use the host's provider and model catalog. Projects can move repositories
  and their records, merge into another project, park or be removed after blockers
  are resolved.
- Consistent controls, accessible help popovers, focused dialogs and quieter
  settings reduce clutter. Telemetry separates active work from waiting and shows
  lifecycle timings, recovery causes and partial historical evidence.

### Task lifecycle and review

- One worker owns each task through implementation and revisions, one retained
  reviewer reviews the exact source head, the planner ladder handles planning
  rulings, and a retained recovery thread handles operational faults. Authenticated
  reports bind to their task, run, branch and PR; released credentials are revoked.
- Merge gates verify PR identity, exact-head review, required checks and the
  prospective merge candidate. Explicit operator source acceptance can stand in
  for source review at that exact head. External merges require matching evidence;
  another task's result never grants merge or closeout credit.
- Owner controls explain the next available action and support stop, route,
  restart, move, completion and retry of recorded effects. Cancel and supersede
  preserve task identity and owned work. Unknown external outcomes remain held
  for reconciliation rather than being retried blindly.
- Pause drains in-flight mechanical work while preventing new runs. Subscription
  availability, weighted model selection, usage levels and project/global limits
  govern admission. Only Settings changes dispatch limits; ordinary agent and CLI
  routes refuse those writes.
- Briefs and legacy handoffs retain their own intake contracts. Required proof
  cannot be waived by repository policy. External authors can use an explicitly
  activated proof execution, and merged commits can receive proof-only
  qualification without creating an implementation PR.

### QA and repository integration

- Run project validation against the exact prospective merge candidate, and
  milestone QA in isolated checkouts. Results retain setup, validation and teardown
  outcomes, failing test identities and bounded diagnostic excerpts.
- Effigy validations share host-wide admission, distinguish capacity waits from
  execution, and preserve uncertain process and cleanup evidence. Focused tests
  use bounded runners; wall-clock oracles run separately from the parallel lane.
- Repository hooks use pinned manifests, executable digests and durable occurrence
  identities. Closeout follows the selected repository authority and reconciles
  publication before completion. Worktree and sibling preparation preserve
  unrelated checkouts and shared Git state.

### CLI and agent tools

- Use `nucleus` for task controls, planning records, project QA, backups, telemetry
  and outcome search. Helper commands submit briefs, reparent tasks and admit
  existing external PRs to review. `version` reports the release and revision;
  `data-home` explains the selected store and its files.
- Agents report, ask questions and message other workers through `nucleus_report`,
  `nucleus_ask` and `nucleus_message`. Durable delegation preserves uncertain
  delivery and routes questions to the responsible reviewer or planner; releases
  and product changes stay with the operator.
- CLI QA output remains valid JSON, with progress notices on stderr. Bounded
  refusals explain invalid input, identity conflicts and unresolved effects.

### Data home and storage

- Nucleus uses `~/.nucleus`, or `NUCLEUS_DATA_HOME` when set, independently of
  Paseo's home. Old move journals and legacy data folders are ignored. The plugin
  and installed skill are named `nucleus`; the retired skill alias is removed
  only when its link belongs to this installation.
- Verified backups protect schema migrations. Bounded maintenance, explicit
  retention windows and shared text storage reduce database growth while keeping
  task history, planning content and callback idempotency intact.
- Repository rekeying preserves history through origin or checkout changes.
  Workspace cleanup checks ownership, clean published state and active tools
  before archiving or removing task resources.

### Performance

- Git and database work move off the service's main thread. Dispatch visits the
  runnable queue front, board publications coalesce, and planning lists refresh
  only when their own records change.
- Prepared statements, cached committed Git facts and bounded liveness observations
  reduce repeated work. Board cards and dialogs render independently, and focused
  test startup and fixture costs are lower.
- Service, core, shared and host-specific code now have explicit boundaries,
  preserving installed entrypoints while making the runtime easier to maintain.
