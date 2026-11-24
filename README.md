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

## BB host

Nucleus also runs tasks in [BB](https://getbb.app) (bb 0.49 or newer). The
Nucleus package ships the built BB plugin; one command installs it into your
BB, and nothing else in your BB is read or written.

1. **Install the plugin.** Once, after installing the Nucleus package:

   ```sh
   nucleus bb install
   nucleus bb status
   ```

   `nucleus bb install` copies the plugin to your Nucleus data home before BB
   installs it, so BB builds cannot change the installed Nucleus version. It
   points the plugin at that data home and reloads it; `nucleus bb uninstall`
   removes the plugin and its managed copy.
   `nucleus bb status` reports the installed plugin's version and build against
   the running Nucleus service (`match`, or `behind` with the command to fix it),
   and says when the plugin is not configured to connect.
   A BB update needs no Nucleus action: BB rebuilds the plugin's frontend itself
   in that managed copy, and what is checked is the Nucleus build identity it
   was installed from, never that bundle.
   A later service roll keeps the plugin current by itself: when your BB has the
   plugin installed from another build, the roll runs the same install route,
   and a roll that could not update it says so in the roll state, in
   `nucleus bb status` and in service health. A machine without the plugin is
   never touched.
2. **Point one test repository at BB.** Set the repository's host kind to `bb`
   (`repository.set` with `hostKind: "bb"`). Paseo stays the default; a live
   task never changes host.
3. **Expect.** The board names the BB host online with its BB and plugin SDK
   versions, a dispatched task's worker thread appears under its planner in BB,
   and the sidebar's Nucleus task groups carry the task's state, PR and wait.
   The plugin is pinned to the Nucleus build it shipped with: a plugin from
   another build is refused with a message naming both builds, and the board
   shows the BB host unavailable with that reason until the matching plugin is
   installed — which a service roll does for you when the plugin is already
   installed. Nucleus writes nothing into your BB unless you ran
   `nucleus bb install` at least once.
   If Paseo detects a changed installed file, its bridge stays available, the
   board reports the failed roll, and the notice recommends reinstalling that
   version or rolling to a fresh build.
4. **Remove it.** `nucleus bb uninstall` removes the plugin with ID `nucleus`.
   No other plugin, project or thread is touched; a plugin with ID `nucleus`
   that is not a Nucleus build is refused by name rather than overwritten or
   removed.

Usage Pace is an optional BB plugin the operator installs separately; Nucleus
never installs, updates or removes it. The operator notes
and the design are in [Spec 062](docs/knowledge/specs/062-bb-host-adapter.md).

## Getting started

1. **Connect a host.** Connect any supported host (no Paseo required):
   - **T3Code:** `nucleus integrate t3code` (or `nucleus t3 install`) registers the `nucleus` ACP provider; T3Code starts the daemon automatically on launch.
   - **BB:** `nucleus integrate bb` (or `nucleus bb install`) installs and configures the BB plugin; BB starts the daemon automatically when the plugin loads.
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

On T3Code a task is one thread on the Nucleus ACP provider, and its worker,
reviewer, recovery, coordinator and executor threads are that thread's native
subagent children: T3 draws them inside the parent's card, so one row per task is
what you see with no setting to turn on. The parent has no model. It shows the
task's lifecycle text and holds its turn while a role runs, so the row reads as
working exactly when the task is.

That needs the Nucleus ACP provider registered in T3 once, and one command does
it:

```sh
nucleus t3 install   # find the running T3Code, connect, register the provider
nucleus t3 status    # what the server, bearer, provider and projects report
nucleus t3 uninstall # remove the provider and this environment's sessions
```

`install` mints a scoped bearer for the service and registers the installed
`nucleus-acp` command as an ACP provider named `nucleus` through T3's own
settings route, only touching that one instance. Nucleus checks for it at connect
and before every launch and reports the answer as `service.health`'s
`t3code.nativeParenting` line. Without it, a role cannot be created as a child:
the task waits visibly with that reason and the `nucleus t3 install` fix, and no
top-level thread is launched in its place.

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
