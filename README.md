# Nucleus

Nucleus is a local service that runs agent coding tasks end to end. Each task
gets one worker in its own worktree. A separate reviewer checks the PR at its
exact head, mechanical gates merge it, local `main` is synced, and closeout
follows. Tasks survive restarts. Side effects are reconciled from evidence,
never retried blindly. Nucleus carries out approved work; it doesn't plan it,
and nothing merges without review of the exact head (or the
operator's recorded acceptance of it).

Agent apps connect through a host interface. Paseo is the first host: the
board runs as a plugin screen in its sidebar. More hosts, such as T3Code, are
planned; a host without a plugin UI uses the local web board. Nucleus is
trusted local software, not a sandbox between agents.

Subscription usage displays belong to each host app and its plugins. Nucleus
keeps the separate dispatch usage level in Settings → Dispatch limits because
that setting controls routing demand and cost ceilings.

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

1. **Install the plugin.** After installing or rolling the Nucleus package:

   ```sh
   nucleus bb install
   nucleus bb status
   ```

   `nucleus bb install` runs BB's own install for the plugin with ID `nucleus`,
   points the plugin at your Nucleus data home so it connects, and reloads it.
   `nucleus bb status` reports the installed plugin's version and build against
   the running Nucleus service (`match`, or `behind` with the command to fix it),
   and says when the plugin is not configured to connect.
2. **Point one test repository at BB.** Set the repository's host kind to `bb`
   (`repository.set` with `hostKind: "bb"`). Paseo stays the default; a live
   task never changes host.
3. **Expect.** The board names the BB host online with its BB and plugin SDK
   versions, a dispatched task's worker thread appears under its planner in BB,
   and the sidebar's Nucleus task groups carry the task's state, PR and wait.
   The plugin is pinned to the Nucleus build it shipped with: after a service
   roll, `nucleus bb status` says the plugin is behind, the plugin's connection
   is refused with a message naming both builds, and the board shows the BB host
   unavailable with that reason. Reinstall with `nucleus bb install`; Nucleus
   never writes into your BB on its own.
4. **Remove it.** `nucleus bb uninstall` removes the plugin with ID `nucleus`.
   No other plugin, project or thread is touched; a plugin with ID `nucleus`
   that is not a Nucleus build is refused by name rather than overwritten or
   removed.

Usage Pace is an optional BB plugin the operator installs separately; Nucleus
never installs, updates or removes it. The operator notes
and the design are in [Spec 062](docs/knowledge/specs/062-bb-host-adapter.md).

## Getting started

1. **Connect a host.** For Paseo: `nucleus integrate paseo` registers the
   installed package; then reload the `nucleus` plugin and open **Nucleus** in
   the sidebar. On a host without a plugin UI, `nucleus ui` prints a localhost
   link that opens the same board in a browser.
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

- [docs/README.md](docs/README.md) — the project's current state and front door.
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
  records, briefs and leads, submission, owner verbs, review entry, project QA.
- [Operations](docs/knowledge/operations/restore.md) — restore a verified
  store snapshot. The data-home layout is in the release contract.
- [Open questions](docs/knowledge/questions.md) — what is deliberately
  undecided.

## T3: one row per task

T3Code owns subscription usage display through its own features and plugins;
Nucleus adds no subscription usage gauge. Its usage level remains a Nucleus
dispatch setting, separate from monitoring provider subscription windows.

On T3Code, a task starts one thread per agent: the worker, its reviewer, recovery,
coordinator and executor threads. Nucleus tags those support threads
`nucleus-support` and links each one from the worker's conversation as a card, so
the worker thread is the task's one row and its title names the step. The support
threads still appear in the sidebar as their own rows until you turn T3's own hide
setting on. That setting is optional: with it off, everything above works the same
and the support threads simply stay visible.

The hide switch lives in T3's server settings and has no settings screen:
`hideTaggedThreads: true` plus `nucleus-support` in `hiddenThreadTags`. A client
hides a tagged top-level thread only while both are true. Nucleus reads the switch
at connect and never writes it; `service.health`'s `t3code.supportThreads` line says
whether support threads are hidden.

To turn it on, paste this into an agent on the machine that runs T3:

> Find T3Code's server settings file (the `settings.json` in T3's data directory),
> or use T3's own `server.updateSettings` route from a client. Set
> `hideTaggedThreads` to `true` and add `nucleus-support` to `hiddenThreadTags`,
> keeping every other setting and any other tag exactly as it is. Show me the
> diff of the file (or the patch you sent) before saving. To revert, set
> `hideTaggedThreads` back to `false`; leave the tag list as it is or remove the
> `nucleus-support` entry.

Answering a reviewer's or recovery thread's question still happens in that
support thread, opened from its card, or through Nucleus's own routes.

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
