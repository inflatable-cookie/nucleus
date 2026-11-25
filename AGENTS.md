# Nucleus

The Rust service owns durable task dispatch, review, merge and closeout. T3
hosts the task's ACP thread and its worker and reviewer. The engine reconciles
mechanical faults from evidence. Questions about the work go to the task's
planner. A planning document cannot authorize execution.
Merging through Nucleus requires exact-head review, qualified owner acceptance
or recorded operator source acceptance. The operator-source rule came through
a 2026-10-20 agent relay. A responsible planner or the operator board may
explicitly accept an observed external merge for closeout (Tom, 2026-11-23).
See [Spec 067](docs/knowledge/specs/067-explicit-resolution.md#external-merge-source-acceptance).

## Where things live

- Docs entry point: `docs/README.md`
- Knowledge (one owner per fact): `docs/knowledge/README.md`
- Open questions: `docs/knowledge/questions.md`
- Writing style for docs, PRs and reports: `docs/knowledge/contracts/writing-style.md`

The plan (lanes, their documents and their order), leads, papercuts, brief
drafts, tasks and status live in Nucleus, never in this repository. Read what's
next with `plan.get` (see the Nucleus skill, `nucleus`).

## Commands

- `effigy engine:fmt`, `effigy engine:check`, `effigy engine:clippy` and
  `effigy engine:nextest` — the Rust engine's format, check, lint and test selectors.
- Agents use the installed `nucleus` command from any directory (Tom, 2026-11-16); repository CLI files are internal.
- `effigy tasks` — task inventory; `effigy test --plan` shows the test shape.
- `effigy check` — TypeScript typecheck and publication gate.
- `effigy qa:docs` — docs checks.
- `effigy test:affected [base] [--run]` — active TypeScript tests near the change
  (against `origin/main` by default, at most 60; `--run` runs them).
- `effigy qa` — the full milestone board, including the Rust workspace,
  typecheck, docs and active TypeScript tests.

The browser board and its shared TypeScript code have active tests and a
typecheck. The Rust service serves the board and its API. See
[Spec 070](docs/knowledge/specs/070-small-engine.md#rulings).

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
  Read the current wait, question and available commands with `nucleus next <id>`.
  A planner ruling is required for decisions about the work.

## Guardrails

- Preserve the live database, profiles, subscriptions, limits and pause state.
  Never edit the live database or silently reset exhausted groups.
- Never restart T3 or its daemon. Check UI changes against the built board
  before merge. The planner checks the installed board in dark theme after a roll.
  Never test light mode on the operator's display.
- Never leave uncommitted work in the registered checkout; it fences every
  agent's Nucleus CLI. Work in a separate worktree.
- Load `NUCLEUS_SCRATCH_ROOT` from the ignored `.agents.local.env` for new
  scratch, including test temporary directories and command output. Managed runs
  use their recorded root. Set `TMPDIR`, `TMP` and `TEMP` there before tests;
  if the configured volume is absent, stop without an internal-drive fallback.
  Service scratch follows the configured storage placement. Developer scripts may require it.
- Examples and fixtures are synthetic. Keep evidence in scratch and link it
  from PRs; never commit it. PR bodies must contain no local paths or private
  project names because they will be public.
- Never run `git stash`: `refs.stash` is shared by every worktree. Commit work
  in progress on the task branch. See the [orchestration contract](docs/knowledge/contracts/orchestration.md).
- Never edit a submitted brief; clarify in the owning spec, or resubmit and
  supersede.
- No release mutations, CI workflow edits or live acceptance runs that create
  GitHub or native application resources without operator authorization.
- Frontier runs only on an explicit per-role planner request with a reason at the
  Low, Normal and High usage levels (Spec 052). The request applies directly, with
  no operator sign-off (Tom, 2026-11-22). Automatic selection never picks Frontier
  at those levels.
- When a change alters what is true, update the owning knowledge file in the
  same PR. An operator ruling given in conversation goes into its owning file
  before the thread ends.

## Papercuts

File small, recurring friction in Nucleus with `papercut.add` (see the
Nucleus skill, `nucleus`). There is no `PAPERCUTS.md`.

No Nucleus task may fix a single stuck state (Tom, 2026-10-14). A papercut
describes the stuck shape. Use the same engine decision for every task with that shape.
Check the current commands with `nucleus next <id>` and preserve exact delivery evidence
when the outcome of a send is uncertain. See [Spec 070](docs/knowledge/specs/070-small-engine.md#rulings).

## Validate

For Rust changes, run `effigy engine:fmt` and scope `effigy engine:check`,
`effigy engine:clippy` and `effigy engine:nextest` with `-p <crate>` for each
affected crate. Run the selectors serially. Full workspace validation and
`effigy qa` belong to [milestone QA](docs/knowledge/contracts/milestone-qa.md),
an ordinary report-only task pinned to one published `main` commit.

Run `effigy check` once and `effigy qa:docs` when docs change. At the committed
head, run `effigy test:affected --run` once. It selects active TypeScript tests
through imports, test helpers and literal paths. The closest 60 files run and
the rest are deferred to milestone QA. Run it without `--run` to see the
selection and reasons. A missing or failing affected run is a review finding.

Use the printed failure summary to find failing files, then rerun each alone.
Use `effigy test:baseline <file>` for the `origin/main` comparison. The planner
checks UI changes in the installed bundle in dark theme after the roll.
