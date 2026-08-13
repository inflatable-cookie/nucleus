# Operator-Dispatched Runs Implementation

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/099-operator-dispatched-runs.md`
Branch: `thread/099-operator-dispatched-runs`

## Outcome

Implemented the phase-1 managed-worktree dispatch path from the desktop project
surface through the run registry and worktree authority chain.

- **Run lifecycle**: run propose/dispatch commands now carry the run record
  fields through the control DTOs and envelope codecs. The engine binds the
  deterministic conversation id and realized worktree on `dispatched`; the
  operation id binds only from the first observed provider activity.
- **Authority chain**: dispatch builds a run-scoped admitted handoff lane,
  writes the durable confirmed operator-effect intent, then calls
  `run_git_branch_worktree_runner`. The gated runner is the only path that
  spawns `git --no-optional-locks worktree add`; dispatch requests isolated
  worktree authority only, with no commit/push authority.
- **Project resource**: the created sibling worktree (`<repo>-wt/<run-slug>`)
  is registered as a `GitRepository` project resource before the run is
  dispatched.
- **Worker conversation**: the desktop Tauri command seeds a playbook-shaped
  brief into `conversation:run:<run_id>` against the registered worktree.
  Turn-start activity marks the run running and binds the provider operation;
  turn failure records a failed run with the observed failure reason.
- **Desktop**: added an explicit project-bound dispatch affordance and dialog
  for slug, objective/scope, acceptance, stop conditions, provider instance,
  model, and optional budgets. The confirm action is the operator confirmation
  for the authority chain and opens the resulting worker conversation.
- **Fixtures**: server fixtures cover real worktree creation, resource
  registration, conversation binding, intent and execution receipts, missing
  location, repeat dispatch, and operation-truth transitions.

The module ratchet remains unchanged: no new top-level `nucleus-server` module.

## Validation

- `cargo test -p nucleus-engine -p nucleus-server` — passed.
- `cargo test -p nucleus-server --test module_ratchet` — passed.
- `effigy desktop:check` — passed (1328 files, 0 errors, 0 warnings).
- `effigy desktop:test` — 71 Bun tests passed; Vitest has one unrelated
  failure in `src/lib/settings/settingsDialog.vitest.ts`: the `General` tab
  did not expose the expected `tabindex="-1"`.
- `effigy qa:docs` — passed (links, vision index, roadmap next-action, and
  forbidden-path checks).
- `git diff --check` — passed.

No roadmap, milestone, card, or dispatch status files were modified. No
swallowtail, longhorn, or poodle sources were modified.
