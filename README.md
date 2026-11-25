# Nucleus

Nucleus is a local service that runs approved agent coding tasks end to end. A
worker uses its own worktree and an independent reviewer checks the PR at its
exact head. The engine applies the [exact-head merge and acceptance gates](docs/knowledge/contracts/orchestration.md#merge-gates)
and closes the task. Report-only tasks deliver a lane artifact for planner
acceptance. Tasks survive restarts, and the engine uses recorded evidence to
reconcile side effects.

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
2. **Configure.** Fresh profiles start with dispatch running and no worker or
   reviewer profiles. Add those profiles and set dispatch limits in Settings.
   Use **Pause** in the board’s queue controls if needed. The choice survives
   restarts.
3. **Submit.** Agents submit approved work through the queue and then steer it.
   The [Nucleus skill](skills/nucleus/SKILL.md) teaches planning, submission,
   task controls and review entry.

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
- [Open questions and historical rulings](docs/knowledge/questions.md).

## T3: one row per task

T3Code owns subscription usage display through its own features and plugins;
Nucleus adds no subscription usage gauge. Its usage level remains a Nucleus
dispatch setting, separate from monitoring provider subscription windows.

On T3Code a task is one thread on the Nucleus ACP provider. Its worker and
reviewer are native subagent children. T3 draws them inside the parent's card,
so each task has one row. The parent has no model. It shows the task's progress
and holds its turn while a role runs. Follow the [T3 setup guide](engine/README.md#set-up-t3)
to install the provider and check its status.

The parent row shows Working while a worker or reviewer runs. When the child
finishes, the row shows Waiting for two minutes so the next role can take over.
After that Nucleus snoozes it. An open question or decision brings the row
back. Manual snoozes take precedence. Finished tasks archive.
See [Spec 070, ruling 22](docs/knowledge/specs/070-small-engine.md#rulings).

## Development

From a checkout:

```sh
effigy setup        # install the locked browser and test dependencies
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
