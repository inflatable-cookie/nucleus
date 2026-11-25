# Nucleus

Nucleus is a local service that runs agent coding tasks end to end. Each task
gets one worker in its own worktree. A separate reviewer checks the PR at its
exact head, mechanical gates merge it, local `main` is synced, and closeout
follows. Tasks survive restarts. Side effects are reconciled from evidence,
never retried blindly. Nucleus carries out approved work; it doesn't plan it,
and nothing merges without review of the exact head (or the
operator's recorded acceptance of it).

T3Code connects to the engine through its host interface, and the board runs in
a local browser. Nucleus is trusted local software with access to the agent's
work environment.

Subscription usage displays belong to each host app and its plugins. Nucleus
keeps the separate dispatch usage level in Settings → Dispatch limits because
that setting controls where runs start and which profiles need the operator's permission.

## Install

Follow the [engine staging instructions](engine/README.md#stage-an-engine-release)
for the current Rust executable and local web board. See the
[release contract](docs/knowledge/contracts/release.md) for release policy.
The [0.1.0 download](https://github.com/inflatable-cookie/nucleus/releases/tag/v0.1.0)
is the archived TypeScript release for macOS on Apple silicon.

## Getting started

1. **Connect T3Code.** Follow the [T3 setup](engine/README.md#set-up-t3) to register
   the `nucleus-rust` ACP provider. Open the [local web board](engine/README.md#board)
   with `nucleus ui`.
2. **Configure.** New installations start paused with an empty worker pool. In
   Settings, add worker and reviewer profiles and set dispatch limits. Paused
   state survives restarts.
3. **Resume and submit.** Resume from the board header. Agents submit approved
   work through the queue and then steer it; the
   [Nucleus skill](skills/nucleus/SKILL.md) teaches planning, submission,
   owner verbs and review entry. Every task runs the responsible lifecycle on
   its own: worker, reviewer, merge gates and recovery.

## Where to read more

- [docs/README.md](docs/README.md) — the entry point to the project's docs.
- [Knowledge index](docs/knowledge/README.md) — one owning file per topic:
  [vision](docs/knowledge/vision.md),
  [architecture](docs/knowledge/architecture.md),
  [contracts](docs/knowledge/contracts/README.md) (the durable rules,
  including [orchestration](docs/knowledge/contracts/orchestration.md),
  [repository hooks](docs/knowledge/contracts/repository-hooks.md) and the
  [release route](docs/knowledge/contracts/release.md)), and
  [specs](docs/knowledge/specs/README.md) (per-capability design with
  acceptance oracles).
- [The Nucleus skill](skills/nucleus/SKILL.md) — what agents read: planning
  records, briefs and leads, submission, owner verbs, review entry, and report-only milestone QA.
- [Operations](docs/knowledge/operations/restore.md) — restore a verified
  engine store snapshot.
- [Open questions](docs/knowledge/questions.md) — what is deliberately
  undecided.

## T3: one row per task

T3Code owns subscription usage display through its own features and plugins;
Nucleus adds no subscription usage gauge. Its usage level remains a Nucleus
dispatch setting, separate from monitoring provider subscription windows.

On T3Code a task is one thread on the Nucleus ACP provider. Its worker and
reviewer are native subagent children. T3 draws them inside the parent's card,
so each task has one row. The parent has no model. It shows the
task's lifecycle text and holds its turn while a role runs, so the row reads as
working exactly when the task is.

Set up the Rust ACP provider with `nucleus t3 install`. The engine registers
`nucleus-rust` and keeps its ACP launcher under the engine home. Check the
registration with `nucleus t3 status`. See the [T3 setup guide](engine/README.md#set-up-t3)
for connection and credential setup.

The task's row is snoozed while the task waits on nothing Nucleus is running and
needs no one — a hold with a release condition, a prerequisite wait, capacity —
and is shown again as soon as a role runs or a person must act. Nucleus never
settles a task thread, so its rows stay out of your settle list; a row you settle
by hand is left alone. A question or permission still belongs to the task's own
thread (open it from the row) or goes through Nucleus's own routes.

## Development

From a checkout:

```sh
npm install
effigy check        # typecheck and the publication gate
effigy qa:docs      # docs checks
effigy tasks        # task inventory
effigy test --plan  # the test shape
```

`effigy qa` is the full local QA, run as milestone QA on `main`. Validate only what you changed; see
`AGENTS.md` for the working rules and validation policy, and the
[orchestration contract](docs/knowledge/contracts/orchestration.md) before
changing state transitions or external effects. Release builds and rolling to
a live checkout follow the [release contract](docs/knowledge/contracts/release.md).

## License

Nucleus's source has no open-source license yet; all rights rest with the
authors until one is chosen. Bundled third-party marks are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
