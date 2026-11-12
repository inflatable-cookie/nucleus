# Nucleus

A trusted local Paseo plugin and standalone service that own durable task
dispatch, review, merge, closeout and recovery. Every task runs the responsible
lifecycle: one worker owns it end to end, one retained reviewer reviews it, the
planner ladder takes rulings, and one retained recovery thread handles faults
code cannot settle. Nucleus must never become a place that invents planning decisions,
grants execution authority from documents, or bypasses exact-head review
(only an explicit, recorded operator source acceptance of the exact head may
stand in for it; Tom, 2026-10-20).

## Where things live

- Current state: `docs/README.md`
- Knowledge (one owner per fact): `docs/knowledge/README.md`
- Retired concepts, which must not come back: `docs/knowledge/retired.toml`
- Open questions: `docs/knowledge/questions.md`
- Writing style for docs, PRs and reports: `docs/knowledge/contracts/writing-style.md`

The plan (lanes, their documents and their order), leads, papercuts, brief
drafts, tasks and status live in Nucleus, never in this repository. Read what's
next with `plan.get` (see the Nucleus skill, `nucleus`).

## Commands

- `effigy tasks` — task inventory; `effigy test --plan` shows the test shape.
- `effigy check` — typecheck and publication gate.
- `effigy qa:docs` — docs checks.
- `effigy test:affected [base] [--run]` — the test files the change can affect
  (import graph against `origin/main` by default; `--run` runs them).
- `effigy qa` — the full local board: typecheck, docs checks, the parallel
  suite and the serial wall-clock lane (`test:timing`), fast checks first.
- Parallel unit runs allow each physical test file 120 seconds in total
  (`--test-timeout` bounds the whole file, not each test); six files run at once
  and each force-exits after its tests finish. Real hook and Git fixture
  families split across shards to stay inside that budget (see
  [orchestration contract](docs/knowledge/contracts/orchestration.md)). The
  wall-clock timing lane gets 10 minutes per test.

Existing npm scripts stay package-native; do not add wrappers around Effigy.

## Changelog

Each pull request adds a Markdown fragment under `changelog.d/`, named
`<task-number>-<short-slug>.md`. Put the user-facing change in the fragment;
do not edit `CHANGELOG.md`'s `[Unreleased]` section. Release preparation folds
all fragments into the changelog and removes the folded files.

## Product rules

- Preserve task identity, callback authentication, exact-head review and merge
  gates, provider independence and durable side-effect intent. Unknown delivery
  is not permission to retry blindly.
- Keep Northstar independent of Paseo: the Nucleus skill belongs here, not in
  Northstar core.
- Tasks needing attention stay owned until resolved or explicitly disposed of.
  The worker owns its blockers with the retained reviewer as its second opinion,
  the planner ladder takes planning rulings, and one retained recovery thread
  handles operational faults.
- Nucleus implements the legacy handoff protocol for consumer repositories; in
  this repository's code, tests, specs and skill those paths are product.

## Guardrails

- Preserve the live database, profiles, subscriptions, limits and pause state.
  Never edit the live database or silently reset exhausted groups.
- Reload only the plugin (`paseo plugin reload nucleus`) after
  typechecking. Never restart Paseo or its daemon. Never test light mode on the
  operator's display.
- Never leave uncommitted work in the registered checkout; it fences every
  agent's Nucleus CLI. Work in a separate worktree.
- Load `NUCLEUS_SCRATCH_ROOT` from the ignored `.agents.local.env` for new
  scratch, including test temporary directories and command output. Managed runs
  use their recorded root. Set `TMPDIR`, `TMP` and `TEMP` there before tests;
  if the configured volume is absent, stop without an internal-drive fallback.
  Service and bridge scratch derives from `workRoot/scratch`; the environment
  variable is an optional override there. Developer scripts may require it.
- Examples and fixtures are synthetic. Keep evidence in scratch and link it
  from PRs; never commit it. PR bodies must contain no local paths or private
  project names because they will be public.
- Never run `git stash`: `refs.stash` is shared by every worktree. Commit work
  in progress on the task branch. See the [orchestration contract](docs/knowledge/contracts/orchestration.md).
- Never edit a submitted handoff; clarify in the owning spec, or resubmit and
  supersede.
- No release mutations, CI workflow edits or live acceptance runs that create
  GitHub or native application resources without operator authorization.
- Frontier and above-ceiling profiles need an explicit per-role request, a reason
  and the operator's board sign-off, unless the operator's usage level (Spec
  052) puts them in automatic selection. An unsigned request runs on automatic
  selection.
- When a change alters what is true, update the owning knowledge file in the
  same PR. An operator ruling given in conversation goes into its owning file
  before the thread ends.

## Papercuts

File small, recurring friction in Nucleus with `papercut.add` (see the
Nucleus skill, `nucleus`). There is no `PAPERCUTS.md`.

No Nucleus task may fix a single stuck state (Tom, 2026-10-14). A papercut
describes the stuck shape, not a fix mechanism. Clear it with an existing Spec
050 owner verb (`next`, `route`, `restart`, `move`, `retry_effect`), make one
of those verbs more general, or leave it for the phase 2 reconciler. A new
guard, proof tuple or exception-specific control is never the fix.

## Validate

Run `effigy check` once. Then, at the committed head, run the affected test files
once with `effigy test:affected --run` (Tom, 2026-11-12). It selects every
`test/**/*.test.ts` that transitively imports a changed file, plus any test that
names a changed file's path, or reads its directory, as a string literal, and
runs them through the unit runner. Run `effigy test:affected` without `--run` to
see the list and each file's reason. Run `effigy qa:docs` if docs changed.
Wall-clock oracles in the selection skip in the parallel lane and run in milestone
QA's timing lane. Node test options ride after the files for a single file,
e.g. `effigy test unit -- test/<file>.test.ts --test-skip-pattern=<pattern>`;
the unit runner moves them ahead of the files. No full suites,
no `effigy qa`, no Cargo builds (Tom, 2026-10-04). Those run in milestone QA on
`main` via `project.qa.run`. A missing or failing affected-test run is a review
finding; anything wider than the affected set never is.
Rerun a failing test file alone before believing it; UI changes are checked in
the installed bundle in dark theme by the planner after the roll. The installed plugin
runs from `main`, so a worker can't check its own PR's UI, and that check never blocks
a worker or a review.
