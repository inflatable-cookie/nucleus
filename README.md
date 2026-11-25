# Nucleus

Nucleus is a local service that runs agent coding tasks end to end. Each task
gets one worker in its own worktree. A separate reviewer checks the PR at its
exact head, mechanical gates merge it, local `main` is synced, and closeout
follows. Tasks survive restarts. Side effects are reconciled from evidence,
never retried blindly. Nucleus carries out approved work; it doesn't plan it,
and nothing merges without review of the exact head (or the
operator's recorded acceptance of it).

Agent apps connect through a host interface. Paseo, T3Code and BB are supported
hosts, and T3Code is the current operating host. The board runs as a plugin
screen in a host's own sidebar where that host has one; a host without a plugin
UI uses the local web board. Nucleus is trusted local software, not a sandbox
between agents.

Subscription usage displays belong to each host app and its plugins. Nucleus
keeps the separate dispatch usage level in Settings → Dispatch limits because
that setting controls where runs start and which profiles need the operator's permission.

## Install

The first release is **0.1.0** for **macOS on Apple silicon**. These commands
become available when the public GitHub Release is published. With the
`nucleus` command already installed:

```sh
nucleus install inflatable-cookie/nucleus@v0.1.0
nucleus version
```

On a machine without `nucleus`, download the standalone package. It bundles
Node, so no npm install or source checkout is needed:

```sh
bootstrap_dir=$(mktemp -d)
curl --fail --location --proto '=https' --proto-redir '=https' \
  https://github.com/inflatable-cookie/nucleus/releases/download/v0.1.0/nucleus-0.1.0-darwin-arm64.tar.gz \
  -o "$bootstrap_dir/nucleus.tar.gz"
tar -xzf "$bootstrap_dir/nucleus.tar.gz" -C "$bootstrap_dir"
"$bootstrap_dir/runtime/node" "$bootstrap_dir/bin/nucleus.mjs" install inflatable-cookie/nucleus@v0.1.0
export PATH="$HOME/.local/bin:$PATH"
nucleus version
```

The installer checks the download against the release manifest's SHA-256 and
package inventory before activating it. Add `~/.local/bin` to your `PATH` for
future sessions. Nucleus keeps its data in `~/.nucleus` (`NUCLEUS_DATA_HOME`
overrides it; `nucleus data-home` prints the resolution). Release preparation,
proof and publishing follow the
[release contract](docs/knowledge/contracts/release.md).

## Getting started

1. **Connect a host.** Connect any supported host (no Paseo required):
   - **T3Code:** `nucleus integrate t3code` (or `nucleus t3 install`) registers the `nucleus` ACP provider; T3Code starts the daemon automatically on launch.
   - **Paseo:** `nucleus integrate paseo` registers the installed package; then reload the `nucleus` plugin and open **Nucleus** in the sidebar.
   On a host without a plugin UI, `nucleus ui` prints a localhost link that opens the same board in a browser, and `nucleus service-state` reads service state directly over the local socket.
2. **Configure.** New installations start paused with an empty worker pool. In
   Settings, add worker and reviewer profiles and set dispatch limits. Paused
   state survives restarts.
3. **Resume and submit.** Resume from the board header. Agents submit approved
   work through the queue and then steer it; the
   [Nucleus skill](skills/nucleus/SKILL.md) teaches planning, submission,
   owner verbs and review entry. Every task runs the responsible lifecycle on
   its own: worker, reviewer, merge gates and recovery.

Paseo and T3Code provide their own subscription usage display or host-specific
plugins for it. Nucleus does not add a subscription usage screen or sidebar
gauge; its Usage level setting controls dispatch routing only.

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
  records, briefs and leads, submission, owner verbs, review entry, and milestone QA history.
- [Operations](docs/knowledge/operations/restore.md) — restore a verified
  store snapshot. The data-home layout is in the release contract.
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

## Delete at TS retirement

- Remove the old Settings screen in `client/settings-screen.tsx`, its legacy
  panels, and its registrations in the Paseo and BB clients. The Rust board's
  Settings uses the shared controls.
- Remove the TypeScript web Settings RPC wiring in `client/web/app.tsx`,
  `client/web/transport.ts`, `service/web/web-board.ts` and
  `shared/web-surface.ts`. The Rust board pairs with Axum and edits settings
  through the engine API.

## License

Nucleus's source has no open-source license yet; all rights rest with the
authors until one is chosen. Bundled third-party marks are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
