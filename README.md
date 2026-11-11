# Nucleus

Nucleus is a local service that runs agent software tasks end to end. Each task
gets one worker in an isolated worktree; an independent reviewer checks the
resulting PR at its exact head; mechanical gates merge it; local `main` is
synchronized; closeout and recovery follow. Tasks are durable and survive
restarts, and side effects are reconciled from evidence, never blindly retried.
Nucleus never invents planning decisions, grants execution authority from
documents, or bypasses exact-head review.

Host applications connect through a host interface. Paseo is the first: the
board runs as a plugin screen in its sidebar. Other hosts follow the same
interface, and a host without a plugin UI uses the local web board. Nucleus is
trusted local software, not a sandbox between agents.

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

## Development

From a checkout:

```sh
npm install
effigy check        # typecheck and the publication gate
effigy qa:docs      # docs checks
effigy tasks        # task inventory
effigy test --plan  # the test shape
```

`effigy qa` runs the full local board. Validate only what you changed; see
`AGENTS.md` for the working rules and validation policy, and the
[orchestration contract](docs/knowledge/contracts/orchestration.md) before
changing state transitions or external effects. Release builds and rolling to
a live checkout follow the [release contract](docs/knowledge/contracts/release.md).

## License

Nucleus's source has no open-source license yet; all rights rest with the
authors until one is chosen. Bundled third-party marks are credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
