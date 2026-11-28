# Nucleus engine

The Rust engine runs approved tasks on T3 and serves the local web board.
[Spec 070](../docs/knowledge/specs/070-small-engine.md) owns its model and
authority rules. See [staging](#stage-an-engine-release), [T3 setup](#set-up-t3)
and [board pairing](#board) to operate an installation.

### Stage an engine release

From a clean checkout of the intended revision with the web dependencies
installed, run `effigy engine:stage -- /absolute/builds-root`. Pass the active
builds root shown in Storage. This is the Barge builds class when placement is
enabled and no explicit override is set. The builds root must already exist.
The selector creates its `releases` child if needed. It builds `nucleus` with
`oxide build --profile release` and publishes the executable, `board-assets/`
and `skills/nucleus/SKILL.md` together under `<builds-root>/releases/<git-sha>/`.
Staging requires Git to see all tracked inputs. Index entries marked
assume-unchanged or skip-worktree prevent publication. It also refuses an
existing release or a destination that changes during staging.

On macOS, staging uses the installed `Nucleus Local Signing` identity by default.
Set `NUCLEUS_CODESIGN_IDENTITY` to use another installed identity by name.
Staging signs the copied executable with the fixed identifier
`com.inflatable-cookie.nucleus` and verifies it before publishing. Reuse the
same certificate across releases so Keychain can recognize the engine.

At activation, point the CLI runtime link and the service and ACP launchers
at the staged `nucleus`. The new release then
[refreshes the ACP command lines](#set-up-t3). The
[registry launcher](#registry-serve-launcher) uses its matching board assets.
The managed skill link at `<engine-home>/skills/nucleus` points to that release's skill
directory. Configure each provider to discover the stable link once. On later
rolls, update the stable target with the runtime and keep the provider's skill
path. The engine embeds its run protocol when a provider has yet to discover
the matching sections.

Keep the matching release files for recovery. The engine upgrades a schema 14
or later database and refuses an older one by name. Schema upgrades follow the
[forward-only recovery policy](../docs/knowledge/specs/070-small-engine.md#parent-delivery-storage-and-upgrade).
Staging leaves running processes and launcher definitions untouched.

### Move an existing engine home

Keep the current `--home` until the move is ready. Copy the profile offline,
after stopping the service and quiescing ACP sessions. A profile that still
stores a `workVolume` pin is refused by name; move it with an earlier release.
Keep a restorable source and copy the durable state together, including SQLite
sidecars if present, all configuration domains, backups, and private key files.
Preserve the original permissions. If the old profile used separate platform
directories, collect each domain into the corresponding directory in the new
home. Avoid moving roots that still hold active checkouts, sessions or report
tickets. Keep their overrides through the move until those users settle.

On the copied profile, run `nucleus configure --home /absolute/copied-home --enable`,
with `--placement barge` if desired. Use `--reset-roots`
to remove old overrides and pass any overrides to keep in the same command.
Refresh the owner-only serve and ACP launchers for the new absolute paths and
scratch root. Verify the database and settings under the new home, then verify
the exact provider launcher and the pinned Inbox before reopening dispatch.
Keep the original profile and launcher available for rollback.

The native T3 Inbox verifies its existing project against the absolute
`<databaseRoot>/acp-inbox` path. Moving the database requires a separately
authorized rebind of that T3 project, with its fixed project and thread IDs
intact. The ACP session ID also changes with the path. `t3 install --adopt`
can update the provider launcher and still refuses an Inbox whose project
points to the old root. Verify the Inbox session on the new binding as part of
the cutover.

### Set up T3

`nucleus t3 install` registers the Rust provider `nucleus-rust` in
the local T3 environment. First enable the engine with `configure --enable`.
Use the default engine home or pass the same `--home` to configure, serve and
T3 setup. Set the T3 origin with `--t3` or the profile's Hosts setting. The
provider's launcher is `bin/nucleus-rust-acp` under the engine home. The startup
lock lives beside `bin`.

### Registry serve launcher

Point the owner-only serve launcher at the staged release and the enabled
profile. Substitute the engine and T3 loopback addresses for this installation.
Keep the four input files owner-readable only. The controller and caller keys
each contain 64 hex digits and must be distinct. Give the installed CLI the same
caller key and give T3 setup the same controller key and engine endpoint.

```sh
#!/bin/sh
set -eu
engine_home=/absolute/engine-home
release=/absolute/builds-root/releases/COMMIT
keys=/absolute/private-credentials
NUCLEUS_ENGINE_CONTROL_KEY=$(cat "$keys/operator.key")
NUCLEUS_ENGINE_T3_CALLER_KEY=$(cat "$keys/t3-caller.key")
NUCLEUS_ENGINE_T3_BEARER=$(cat "$keys/t3-runtime-bearer")
NUCLEUS_ENGINE_GITHUB_TOKEN=$(cat "$keys/github-token")
export NUCLEUS_ENGINE_CONTROL_KEY NUCLEUS_ENGINE_T3_CALLER_KEY
export NUCLEUS_ENGINE_T3_BEARER NUCLEUS_ENGINE_GITHUB_TOKEN
export NUCLEUS_RUST_NATIVE_INBOX=1
exec "$release/nucleus" serve --home "$engine_home" --actor operator \
  --endpoint 127.0.0.1:4319 --t3 http://127.0.0.1:3773 \
  --acp-provider nucleus-rust --board-assets "$release/board-assets"
```

Use `t3 auth session issue` to mint a short-lived session with
`--scope providers:manage --scope orchestration:read` and supply its bearer as
`NUCLEUS_ENGINE_T3_INSTALL_BEARER` for install or uninstall. T3 requires
`providers:manage` for a provider mutation with an empty settings patch.
Give the separate Rust runtime bearer `orchestration:read` and
`orchestration:operate`, plus `preview:operate` to open the board from the
Inbox. Supply it in `NUCLEUS_ENGINE_T3_BEARER` (explicit `--t3`) or the
credential environment variable named by Hosts. Use Rust-specific
sessions. The generated launcher does not store the management bearer.
[T3 RPC scopes](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/apps/server/src/auth/RpcAuthorization.ts#L268-L283)

```sh
nucleus t3 install --t3 http://127.0.0.1:3773 \
  --control-key-file /absolute/path/controller.key \
  --serve-launcher /absolute/path/serve-engine
nucleus t3 status --t3 http://127.0.0.1:3773 \
  --control-key-file /absolute/path/controller.key
```

Use `install --adopt` to take over an existing local `nucleus-rust`
registration. It verifies the owner-only launcher, then updates that
instance's command path if it differs. A matching registration stays in
place. Other provider IDs and running sessions are left alone.

The launcher ensures the engine on `127.0.0.1` and execs Rust ACP over
stdio with the profile's binding directory and `loadSession: true`.
When `ensure` or `serve` starts, it rewrites a marked ACP launcher that differs
from this release's output and logs the change. It keeps the launcher's control
key and serve launcher paths. It leaves unmarked launchers, and launchers for
another endpoint, unchanged. The engine does not generate the serve launcher
and never rewrites it. Clients get new command lines on their next launch.
Install waits for the exact T3 registration, the `nucleus` model probe and the
engine's observation of the pinned Rust Inbox.

Install publishes the bundled `nucleus-icon.svg` in the engine home and sets
the fixed Rust Inbox project's `faviconPath` to that file.

Status uses the runtime bearer for T3 readback and the control key for
authenticated engine health. It reports configured Storage roots, the CLI
version, the exact Rust provider and launcher, and native Inbox presence, pin,
favicon path and session health. Missing credentials or unavailable reads leave the
corresponding status unknown.

#### Remove the T3 provider

Run this command to retire the Rust Inbox and remove its provider.

```sh
nucleus t3 uninstall --t3 http://127.0.0.1:3773
```

Uninstall verifies the Rust registration and its local launcher, unpins and
archives the verified Rust Inbox, clears its project favicon, and removes `nucleus-rust`. It keeps
the launcher, engine data and decisions. T3's remove operation takes only an
instance ID, so keep the provider unchanged in T3 Settings during uninstall.
The command checks the exact registration immediately before removal and
reads it back afterward.
[T3 provider mutation contract](https://github.com/pingdotgg/t3code/blob/3b08d975ab58ed19ff7c61b077f69c4bd818989f/packages/contracts/src/providerInstance.ts#L85-L101)
For offline setup flag details, run
`nucleus t3 --help`.

Configure the provider's `NUCLEUS_ACP_BINDINGS` to the service's binding
directory. The scheduler supplies a read-only binding when no session has been
minted. Keep an existing writable binding so the planner can use task commands.

## Board

The JSON model comes from the engine. A task list returns identity, phase and
current wait or question. Detail adds the brief, current run, PR, verdict,
hold and paged event history. A `next` read returns the current phase, wait,
question and available commands. A typed command endpoint handles `move`,
`answer`, `cancel`, `amend` and `hold`/`release` for the CLI and board.
`/v1/settings` reads the isolated engine's configuration domains. `/v1/health`
reports cached T3 status, scheduled queue depth and the oldest current waits.
Neither read contacts an adapter.
`/v1/events` emits the task ID and version on a change. A reconnect or missed
interval invalidates the list and visible task views. Task commands use the configured control
credential. Each run has its own callback credential, including its task and
role checks. The API exposes the run's progress without its ticket or wire.
Task detail includes a run's current activity label and optional start time
in Unix milliseconds. T3 derives it from running items belonging to the
launch's exact native run. Command labels omit arguments and shell input.
Activity is in memory, scoped to the row revision and run instance. A change
can invalidate a task at the same version, so clients refetch on each notice.
History pages include display records for run starts and ends, PR links,
verdicts, questions, confirmed merges and finish. Replays of the same launch
reuse its instance. The audit sequence and record order are enough to rebuild
the feed on attach. Decisions never read these display records.
Review rounds count applied reviewer verdicts in history. Replays and
unsuccessful launches stay in the same round.

Axum serves the bundled TypeScript board and its same-origin API. Pair a browser
with `nucleus ui`. A planner's session is scoped to its project. Only an
operator session can edit Settings. See the [board pairing contract](../docs/knowledge/contracts/service-boundary.md#local-web-board).

A paired browser can reopen the plain loopback URL after a service restart.
Sessions expire after 30 idle days and renew at most once per day. The private
`web-sessions.json` beside the engine database holds token digests and expiry
times. An operator can revoke all browser sessions and pending links with
`nucleus ui --revoke`.

### Task references

The engine assigns a task number per repository at admission. Loopback task
views show the public reference separately from the internal identity used by
runs and callbacks.

The CLI's `admit`, `task`, `next`, `history` and task commands use the loopback
API. Every route requires the configured loopback Host and a same-origin Origin
when supplied. `report` reads the role's owner-only ticket and the report from stdin.

## Settings

| Group | Profile file (schema version 2; Dispatch 4) | Settings |
| --- | --- | --- |
| Profiles | `config/profiles.json` | Profile names, enabled flags, selections (stable ID, capability, weight, provider, model and effort), subscription groups, operator pauses and host-specific profile choices. |
| Dispatch | `config/dispatch.json` | Usage and optional end, Heavy and Total slots, project defaults and overrides, thread retention and dispatch mode. |
| GitHub accounts | `config/github-accounts.json` | Verified account identities and account bindings for workers and reviewers. |
| Projects | `state/projects.json` | Names, archival, repository routes, planner bindings and removal receipts. |
| Hosts | `state/hosts.json` | T3 loopback endpoint and the environment key referring to its credential. |
| Storage | `state/engine.json` | Enabled flag, placement, root overrides and retention. |

Startup refuses a version 1 file by name and leaves it untouched. It upgrades a
version 2 Dispatch file in place after Longhorn verifies a pre-migration archive
in the profile backup directory. Validation failures name the file and field.
Restarting with current files leaves them untouched.

Use `GET /v1/settings/{domain}` to read one domain. `PUT` takes its current
`revision` and replacement `value`. The operator can save only one domain
per request. An edit whose revision changed returns HTTP 409. A Projects edit
preserves the discovered repository routes and planner bindings. Project saves
publish the local settings change and wake the scheduler.
Capacity changes wake local waiters. GitHub's branch rules and the exact-head
approval govern the merge.

The explicit `--t3` endpoint overrides the saved T3 connection for that run.
Apply saved connection and storage changes on the next start.
Storage reports the running process's active paths and the verified archive
inventory separately from saved intent.

The [allowance scheduler](crates/nucleus-service/src/allowance.rs) charges
active work and extends an exhausted allowance automatically once. If the
allowance is exhausted again, the planner can approve a further extension
before the next launch.

The [profile selector](crates/nucleus-core/src/profiles.rs) chooses the worker's
starting bracket and the reviewer's bracket under [Spec 052](../docs/knowledge/specs/052-usage-level.md).
[Spec 053](../docs/knowledge/specs/053-demand-based-selection.md) governs
selection within a bracket. The [Rust profile tests](crates/nucleus-core/tests/profiles.rs)
cover both matrices and the step-up after a changes-required review.

Profile rotation uses the engine's `SQLite` database. Freezing a profiled launch
records one assignment for its role, profile and subscription group in the same
transaction. The store keeps the last 50 assignments per role and lifetime
counts. The group tie-break uses the most recent 50 assignments across roles.
An empty or unreadable history leaves selection to the configured weights. A
failed usage write rolls back the charge while leaving the launch available.
Configured profiles use one T3 catalog read per pass for due launch decisions.
A profile's optional `group` names its subscription. Unset groups use the
resolved T3 provider instance ID. The scheduler freezes the group, profile
and native request together, using the retained worker's model to require an
independent reviewer. An unavailable profile leaves the task waiting.
Provider usage pauses follow [Spec 070](../docs/knowledge/specs/070-small-engine.md#rulings).
The T3 adapter reads the exact run's structured
[`error.failure` item](https://github.com/pingdotgg/t3code/blob/1368854828e259fe6e9539239b36dbf71b50301c/packages/contracts/src/orchestrationV2.ts).

## Routing repositories to T3

Start one Rust service with `serve --acp-provider <provider-id>`. Give the
service and installed CLI the same machine-local
`NUCLEUS_ENGINE_T3_CALLER_KEY`, a 32-byte hex key distinct from the operator
key. The CLI takes the caller from T3's environment. The planner runs
`nucleus task.add` or `nucleus item.promote <id>` from its T3 thread.

On first contact, a T3 request starts or joins one verification and waits up
to three seconds. A slower check continues in the background and the caller
can retry. The scheduler verifies the exact active top-level thread. In a
Git checkout it checks the registered T3 root, both GitHub remotes and the
local default branch via `refs/remotes/origin/HEAD` before saving its project
and planner binding. In a scratch folder a verified thread needs no binding.

Verified threads may plan, dispatch and send messages across projects. Name the
project or task reference when working outside the thread's own project. A task
completion notice first goes to its dispatching thread, then falls back to a
verified planner in the project only after positive evidence rules out the
origin; an unresolved origin keeps delivery pending. Project messages go to the
claimed planner, or fall back to the most recently active thread working in the
project when the claim is unavailable; they are never dropped. Replies use the
exact sender thread, falling back to that project's planner if the sender is
archived or gone. See [Spec 070 rulings 23, 40 and
41](../docs/knowledge/specs/070-small-engine.md#rulings).
A healthy T3 shell stream keeps the proof across run activity. A closure or
loss of host observation revokes the cached proof. The next request verifies
the thread again.

New project IDs are `repo-` followed by the lowercase hex SHA-256 of the
canonical lowercase GitHub slug. Enrollment keeps an existing Projects ID for
an exact matching route.

Edit the project name, archive state and repository checks in Projects. In
Limits, set Heavy and Total slots, the per-project default or an individual
project’s override. Limits saves the changed fields against the Dispatch
revision it read. A project’s slots cover all its routed repositories. New and amended briefs reject the retired
`queue.preferredProfileId` key. Use `queue.profileRequests.worker` with a
profile ID, reason and `required: true` for a required worker profile. Every
launch uses the Profiles domain.

Until the Profiles domain is configured, dispatch waits.

The native write gate compares the prepared destination with the current
repository binding, verifies both origin remotes and confirms that the exact
T3 project is active at the registered checkout. Projects settings edits and
native writes are ordered so an edited binding cannot authorize an earlier
destination. Role threads use the task's ACP parent.

## Pinned Inbox

Set `NUCLEUS_RUST_NATIVE_INBOX=1` and install the Inbox pin with
`nucleus t3 install`. The native Inbox uses the Rust planning decision store.
The scheduler verifies each answer against the task version and exact merge head
before applying it. A decline sends one planner notice and waits for a move or
cancellation.

The Rust Inbox records native form answers as
`operator via T3 Inbox (unattested)`. T3 currently returns the same response
for a desktop submission and an MCP submission.

The board opens in the pinned T3 Inbox thread's browser panel once per host
connection. Type `ui` in the Inbox to open it again. The scheduler verifies
the message came directly from the operator's UI and records the attempt before
issuing a one-use link. The ACP reply uses the plain board URL.

### Agent notes

Agents must not answer Inbox requests or operator decisions. If Tom answers a
decision in chat, its asking planner may record his exact words with
`decision.answer ... --relayed` under [Spec 070 ruling 67](../docs/knowledge/specs/070-small-engine.md#rulings).
Tom answers Inbox requests directly.
