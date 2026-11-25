# Release

## Changelog fragments

Pull requests add a Markdown fragment under `changelog.d/`; they do not edit
`CHANGELOG.md`'s `[Unreleased]` section. When cutting a release, collect and
review the fragments, curate their entries into a dated version section in
`CHANGELOG.md`, leave an empty `[Unreleased]`, and remove the folded fragment
files in the same release change. The folded changelog is that change’s release
record; it needs no additional fragment. This keeps parallel pull requests from
contending on the shared changelog.

Owner: Nucleus maintainers

Nucleus runs from the standalone package under `~/.local/share/nucleus/current`.
Paseo loads plugin `nucleus` there; the bridge starts the service with
that package’s `runtime/node` ([service boundary](service-boundary.md)).
The local main channel is opt-in; release installs stay pinned. Linked-checkout
rolling and `nucleus link` are retired (Tom, 2026-11-09).

## Rolling the main channel

The roll owner (`service/roll/owner.ts`) checks the configured main channel every
30 seconds and on an own-repository sync hint. It is a separate detached process,
started by the legacy Paseo bridge. One owner per data home holds
the `queue-roll-owner.json` heartbeat; a second starter reports it running and
starts nothing, so there is one fetch, build and activation loop. The owner builds
the observed main revision while waiting 60 seconds after the latest change.
Consecutive changes coalesce; an attached heavy follower defers replacement for up
to 15 minutes unless the operator forces the roll. Paseo, its daemon and T3Code are
never restarted by a roll.

The owner rolls only while a service answers or a roll is unfinished. With no
service and nothing pending it exits after two minutes, and it never holds a host
connection, so the service's ten-minute host grace is unchanged. A pending record
or activation survives an owner's exit or crash: the next T3 launch or Paseo bridge
starts an owner that resumes it. After a roll activates a newer version, the owner
hands over to that version's owner and exits, so no older owner keeps rolling.

A failed build or standby startup keeps the running service and records why;
the failed revision stays suppressed until main changes. A stalled live standby
uses the bounded drain fallback. Once replacement begins, incomplete replacement
and activation stay `retrying`: every check retries them. The record becomes
`rolled` only when the selected build answers and activation of `current`
and the installer entrypoints succeeds. Activation is retried independently of
connection readiness. A fresh owner can settle an interrupted record naming its
answering build; records naming other sources remain untouched.

Roll state lives in `queue-service-roll.json` and `queue.service-state`.
Direct CLI calls compare protocol and per-method contract digests, so compatible
calls continue during a roll. Changed contracts wait for a compatible replacement;
failed rolls and timeouts explain the failure. A draining service keeps its
identity while alive, so retries start a standby rather than a second writer.
Project-validation supervisors retain durable results across service rolls;
uncertain processes stay held until reconciled.

Child startup diagnostics are redacted and capped at 2,000 bytes in owner-only
`queue-service-startup-failure.json`; they clear once a compatible service
answers. Captured output is drained after readiness. EPIPE closes the diagnostic
channel without stopping the detached service. After a landed roll the Paseo bridge
reloads only the plugin once, so its bridge and UI load the new contracts. A stale
UI shows the reload notice.

Main-channel builds use the active install's standalone `runtime/node`, or a
host executable verified to be Node without Electron. Before drain, staged
packages must pass `runtime/node --version` and start their real service entry
against an isolated scratch store; failure is a failed build.

## Swapping a shared tool

The release owner coordinates any live task validation, Effigy runs or
report-only milestone work using the tool being replaced through their owners.
For an install with managed QA history, the
[milestone QA handoff](milestone-qa.md#legacy-history-and-upgrades) describes how
the existing roll defers until the compatibility build settles custody.

## Rules

- Keep the registered checkout clean: never leave uncommitted work there; use a
  separate worktree.
- Never edit the live database; preserve profiles, subscriptions, limits and
  pause state across reloads.
- UI changes are checked in the installed bundle in the operator's dark theme,
  never light mode on the operator's display. A task worker cannot do this
  before merge, because the installed bundle only changes on a plugin reload,
  which workers never do. So before merge, a worker proves UI changes with a
  rendered-bundle test (the built client bundle in dark theme at the stated
  viewport sizes) and says in the PR that the operator checks the installed look
  after merge. Reviewers accept that; the installed-bundle look is the operator's
  post-merge check, and a problem found there becomes a new task (2026-09-27).
- The client also runs in the Paseo mobile app, where Hermes evaluates the
  esbuild-compiled bundle from source without Metro's transforms. Client code
  uses no class syntax (`test/client-bundle.test.ts`), and a sticky ScrollView
  header keeps its layout on an inner View, because native sticky headers move
  the child's style onto their wrapper (Tom, 2026-09-29).
- Publishing releases and editing CI or release workflows require operator
  authorization.

## First GitHub Release

Tom, 2026-11-10, after the audit, god-file splits and layout restructure landed (milestone QA
f4af259c green at 8f7bd7ff): the first release is **0.1.0**, ships **macOS arm64 only** (built on
the local machine; no CI), and the repository **goes public** so `nucleus install
owner/repository@tag` downloads release assets anonymously. Order: audit the full git history for
secrets and personal data, fix what it finds, then Tom switches the repository to public; publishing
the release follows (both outward steps stay Tom's). Other platforms wait for a build host or CI,
which needs his authorization.

Task-specific evidence and scratch artifacts stay outside the shipped tree. Older receipts
referenced by documentation remain in Git history; removing them from the current tree does
not remove them from historical commits, branches, tags or GitHub content. A history rewrite
and credential rotation remain separate operator decisions.

## Prepare and publish

Prepare the Rust binary and matching browser assets from the intended committed
revision using the [engine staging command](../../../engine/README.md#stage-an-engine-release).
Milestone QA pins its checks to the final published main commit
([milestone QA](milestone-qa.md)). Keep validation evidence and release files in scratch.

Publishing remains a separate operator action. The legacy TypeScript
`v0.1.0` archive and manifest remain attached to their original tag.
Never reuse a published tag for a changed package.

Publication route (Tom, 2026-11-10, after the history audit found no secrets but thousands of private
project names, personal paths, evidence screenshots and 1,370 PR bodies): start clean rather than
publish or rewrite this history ("copy the source to a fresh repo without the history and go clean -
there's not that much of value in history, but a lot of churn"). First the tree passes a publication
gate (synthetic fixtures and examples, no private project names or personal paths, no committed
evidence). Then Tom renames this repository to `inflatable-cookie/nucleus-archive` (kept private,
full history and PRs intact), creates a new `inflatable-cookie/nucleus`, and one initial commit of
the clean tree is pushed there. The registered checkout is re-cloned; Nucleus records keep the same
repository name; old commit SHAs and PR links in records stay historical, readable in the archive.
The new repository goes public at the 0.1.0 release. Renaming, creating, pushing and switching
visibility are his steps.

## Compiled runtime package

From a clean committed checkout, `effigy build:runtime -- /absolute/new/package-directory`
produces a standalone package for the build host's platform and architecture. It
includes that host's Node executable in `runtime/node`, bundled service and CLI
entries, workers and detached helpers. The build inspects Node’s shared-library
dependencies with `otool` (macOS) or `ldd` (Linux), copies non-system libraries
recursively into `runtime/`, and rewrites their load paths to use that directory.
Unresolved libraries fail the build by name; Linux rewriting requires `patchelf`.
System libraries remain external. All copied libraries are covered by the package
manifest. Run `runtime/node bin/queue-cli.mjs` from
the package; no source, tsx or dependency installation is needed. This build does
not install, publish, register or activate anything.
The generated plugin entry wrappers load their bundles from `server/` and `client/`,
as required by Paseo’s directory compiler.

`build.json` records the exact source revision, input digest, build ID, platform,
Node version, bundled and external system libraries, size and build time. Builds refuse dirty checkouts or a checkout
changed during compilation. Compiled service and clients embed the checkout's
per-method contract digests because bundling changes function source text used
by the digest algorithm. Socket authentication and protocol are unchanged.

`shared/data-home.mjs` is the one data-home resolver. The data home is
`~/.nucleus`, or `NUCLEUS_DATA_HOME` when set. Tom, 2026-11-09: retire the move
machinery. The resolver reads no journal, knows no legacy leaf, and ignores
`PASEO_HOME`. A leftover `~/.nucleus-stage-journal.json` and a sealed
`~/.paseo/northstar-queue` are ignored. Resolution for `process.env` is computed
once per process. An existing non-empty `~/.nucleus` without Nucleus store
markers is refused; a missing or empty folder is the creation default; any other
filesystem error is a refusal. Every consumer uses the resolver: the service, bridge, CLI, helpers,
workers, backups and the host-run live comparison. `nucleus data-home` prints
the resolution and the path inventory. The bridge pins the data directory it
resolved for the service it spawns (`--data-dir`), so the child serves the store
the bridge resolved. Checkout CLI runs retain the source
snapshot fence; compiled runs use their embedded identity. The relocated-package
proof is `effigy test unit -- test/compiled-runtime.test.ts`; it starts a private
fixture service, both worker types and a detached validation helper.

## Scratch installation and command

The installed `nucleus` skill is the only skill the package ships, and its link
follows `current`. The installer links only `nucleus`; on install or roll it
removes a `northstar-queue` link that points inside the Nucleus install (a
leftover from a package that shipped the retired alias) and leaves an unrelated
entry of that name exactly as it is (nucleus#1049). Plugin-ID discovery knows only `nucleus` (nucleus#971, after
the 2026-11-08/09 cutover below): the CLI's Paseo transport and the installed
source path resolve only the `nucleus` registration, and a Paseo config that
still names the retired `northstar-queue` ID is ignored, not migrated. The
bridge claims service presence through `service.nucleus-bridge-presence` alone
— the one standby arbiter; a refused claim is retried on the retained
connection until it is granted. The cutover window's host-inventory gate and the
legacy `service.host-presence` RPC are gone. The bridge pins the data directory
it resolved for the service it spawns (`--data-dir`), as the main channel does.
The retired skill alias is deleted from the package; the name survives only in
stored records, which keep their bytes.
The capacity authority's privileged paths are the Nucleus ones
(`/usr/local/libexec/nucleus`, `/Library/Application Support/Nucleus`,
`/etc/nucleus`); none is installed on this machine, so the rename needed no
migration of an installed helper.

Plugin-ID cutover is Tom's operation, not part of a merge or a normal roll. Done 2026-11-08 at 20:48 UTC on Tom's "Let's do it": verified backup taken, `northstar-queue` disabled (kept registered for rollback), `nucleus` installed from `~/.local/share/nucleus/current` (build 430daead); one service, same data home, and the new bridge serving plugin RPCs. Tom removed the disabled `northstar-queue` registration on 2026-11-09, after the `~/.nucleus` data move. The steps, kept for reference and rollback:

1. Drain work and callbacks, record the active package and data home, and take
   a verified backup. Disable `northstar-queue` and verify it is disabled and
   its bridge has disconnected; preserve the store and all settings.
2. Install the same verified package with
   `paseo plugin install --id nucleus <current>`. Never enable both IDs at once.
   The new bridge waits for a fresh host inventory and the absence of legacy
   service presence. Tom handles any Paseo or daemon restart.
3. Verify one running `nucleus` plugin and one service against the original data
   home, then check CLI, retained sessions and hook/admission consumers. The
   planner runs milestone QA on main before advancing the migration.

For rollback, drain and disable or remove the `nucleus` registration, verify
it is inactive, and install the recorded package under `nucleus` (current code
no longer discovers the old ID, so a rollback reinstalls the same package under
the one ID). Tom handles
any required Paseo restart. Verify a single bridge and service using the same data
home and check the same consumers. Do not restore an older data copy over newer
writes; the later data migration has its own recovery rules.

`nucleus install <tarball>` verifies the package's complete SHA-256 inventory,
platform and archive paths before staging it under `~/.local/share/nucleus/versions`.
Create archives with `tar --format=ustar -czf nucleus.tar.gz -C <package-directory> .`.
`--sha256 <digest>` also verifies the archive itself. A release manifest URL
contains `{ "url": "<tarball URL>", "sha256": "<archive digest>" }`;
`owner/repository@tag` finds `nucleus-<platform>-<arch>.json` in a GitHub Release.
HTTPS is required except for loopback test servers. Publishing stays separate.

Activation (`activateVersion`) is the one step that both points `current` at a
verified version and converges the CLI launcher and owned skill links, with the
same restore-on-failure as install. Install, roll, rollback and recover-previous
all end in that state. The command in `~/.local/bin` and owned skill links
follow `current`; unowned commands and skills cause a collision error. Shared
`.agents/skills` is always installed; existing `.codex` and `.claude` apps
receive skills, as do folders in the path-delimited `NUCLEUS_SKILL_DIRS`.
A failed activation leaves the prior pointer and prior links active. Fresh
agent contexts discover updated skills; retained threads need an explicit
refresh.

`nucleus <method>` delegates the existing CLI catalogue, stdin and output contract.
`nucleus helper submit`, `nucleus helper reparent` and `nucleus helper review-entry`
run packaged helpers with the bundled Node runtime, preserving their arguments,
working directory, stdin and exit status. Packaged skill references use these
commands from any directory; no checkout or separate Node installation is needed.
`nucleus version` reports package version, source revision, channel and the existing
data home.
The compiled runtime package omits the retired BB plugin under
[Spec 070 ruling 5](../specs/070-small-engine.md#rulings). The package's standalone
board assets are built without the BB CLI.
`nucleus integrate paseo` is the separate host-registration step: it preserves
unrelated config and refuses to replace a different existing registration. It
never reloads Paseo. This scratch-tested installer does not change the live
data home, plugin registration or release policy above.

## Opt-in local main channel

The installer and channel helpers live under `service/install/` (installed aliases stay under `server/service/`); shared modules
loaded by the plugin must stay free of Node imports.

An installed version can select `nucleus channel main <repository> [scratch-directory]` explicitly.
The default scratch root is `<workRoot>/scratch`; `NUCLEUS_SCRATCH_ROOT` optionally
overrides it when set. A selected build directory must be an existing real directory
under that root, which the service creates from `workRoot` when needed. The selected
build directory is retained in install configuration. Developer bench, proof and
release-preparation scripts may continue to require `NUCLEUS_SCRATCH_ROOT`; set it
to an existing real directory before running them.
Reload the plugin after changing the channel. Absent that configuration, installs
stay pinned. This does not migrate registrations. Main builds never publish to
GitHub or create releases (Tom, 2026-11-04).

The bridge reads main from the configured repository, fetches `origin/main` into
its own clean scratch clone, and builds the exact observed commit with the
compiled runtime builder. Before activation it bundles the installed plugin entry in the host's CommonJS format and loads it in a separate process; a failure is recorded on the roll. Build and dependency installation run at nice level 10
alongside the 60-second settle window; one bridge builds serially and coalesces
new observations onto the latest main. Failed commits are suppressed until main
changes, with a plain reason on the existing roll notice. An incomplete initial
clone is never reused; the next main revision gets a fresh clone. Unreadable
checkout digests leave the existing roll record alone and retry on the next check. A verified staged
version enters the existing heavy-follower, standby, drain and lease handoff.
Activation of `current` and the installer entrypoints is a roll step, retried
on each check, and does not wait for that service to answer. A failed
activation is recorded as `retrying` with the error in detail. The plugin
reloads once the replacement lands, including that activation. Current, prior and one additional installed version are
retained. `nucleus rollback` queues the prior version through that same path and
holds it until main advances; `nucleus channel release` stops main builds.

If the plugin cannot load and cannot own a normal roll, the operator can run
`nucleus recover-previous`. It verifies the current and previous installed
packages, refuses a pending activation, atomically restores the previous package,
and suppresses the failed current revision on the main channel. Then reload the
connected host's plugin (`paseo plugin reload nucleus`, or
`bb plugin reload nucleus`). This emergency route does not restart
Paseo or its daemon; normal rolls remain owned by the bridge.

A machine switch is an authorized maintenance step: back up and
inventory retained callbacks/helpers and admission paths, preserve the data home
and all settings, pause new dispatch while changing plugin registration to the
installed `current` path, then roll and reload only the plugin. Verify live-task,
callback and host-run continuity before restoring the prior pause state. Keep
old helper paths until retained threads release them. Data moves and repository
rekeys need their own drained migration. Scratch service/lease proofs cannot
establish native Paseo registration or retained provider-session continuity.
