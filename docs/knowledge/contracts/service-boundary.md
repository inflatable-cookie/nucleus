# Standalone Nucleus service boundary

Status: approved

[Spec 070](../specs/070-small-engine.md) governs the Rust engine. This contract
owns the boundary between the local service, callers, browser and host. Task
transitions and side effects follow the [orchestration contract](orchestration.md).

## Boundary

One local Rust service owns the task store, planning and settings, scheduling,
run authentication, and task and host observations. The installed `nucleus`
binary provides `serve`, `ensure`, the ACP agent and the CLI. The browser board
uses the shared TypeScript client over the Rust API. T3 hosts the ACP rows and
runs. The core ACP task session owns the task protocol, while the host adapter
owns native thread creation, parenting, notices and presentation. See the
[Rust service](../../../engine/crates/nucleus-service/src/lib.rs),
[CLI](../../../engine/crates/nucleus-cli/src/main.rs) and
[ACP implementation](../../../engine/crates/nucleus-acp/src/lib.rs).

The service is the writer. Clients submit scoped commands and render the
service's recorded facts. A projection, possession of a task reference or a
source file opens no write authority. Repository hooks and validation follow
[their own contract](repository-hooks.md).

## Transport and identity

The Rust API listens on loopback. Controller calls authenticate with a local
credential. A planner call from T3 uses a separate caller credential and names
its native thread. When its binding is cold, the scheduler verifies the thread and checkout against the
held host view and repository identity. The service asks the caller to retry.
A verified planner's task and planning access stays within the recorded project
scope. Commands that use operator authority have an explicit operator check.
See the [controller boundary](../../../engine/crates/nucleus-service/src/web.rs)
and [project enrollment](../../../engine/crates/nucleus-service/src/enrollment.rs).

A report ticket belongs to one task and run. The endpoint authenticates the
bound instance before applying a report. A revoked or replaced run cannot report
as current. A report ticket can read or write the bound lane of a report-only
run within its allowed operations. These credentials grant no controller access.
See [run tickets](../../../engine/crates/nucleus-service/src/ticket.rs),
[report-only delivery](../../../engine/crates/nucleus-service/src/report_only.rs)
and [callback custody](orchestration.md#runs-and-callbacks).

### Host identity registry

T3 is the integrated host. The store binds a verified planner thread and
checkout to a project and repository. First dispatch can register a verified
repository. An explicit repository must already be verified in the same
project. Several responsible planners can work in one project. The engine
preserves each task's original binding and follows its current authorized
planner association. Unknown and incomplete host observations grant no new
identity or authority. The [project registry](../../../engine/crates/nucleus-service/src/project.rs)
and [Spec 070 rulings](../specs/070-small-engine.md#rulings) own verification and
the first-use admission rule.

### Settings-only capacity writes (Tom, 2026-10-25)

Capacity and usage level change through the operator's Settings. Domain
writes require operator authority and carry versions. Preserve unrelated
values when sending the next domain value. A planner's project scope can
qualify its planning edits and task controls. It confers no Settings authority. Provisioning and offline profile changes follow the
[release contract](release.md). The mode that gates all dispatch is a Dispatch setting. A task hold is a
separate recorded action. The engine reads Settings from the local snapshot.
See the [Settings handlers](../../../engine/crates/nucleus-service/src/web/settings.rs)
and [validated domains](../../../engine/crates/nucleus-store/src/settings_domains.rs).

### Local web board

The engine serves the board and Settings on its own loopback listener. Use
`nucleus ui` to issue a short-lived, single-use pairing grant for the current
authority and project scope. The browser removes the link fragment, exchanges
the grant and uses an HttpOnly, SameSite=Strict cookie. The engine stores
only a session digest and its authority and expiry in the owner-only profile.
Active sessions survive an engine restart. Revocation clears grants and
sessions and ends their event streams. The listener checks the loopback Host
and any supplied Origin. The board's request header and session are required
for its paired API. Controller credentials stay outside the browser. See
[pairing and request checks](../../../engine/crates/nucleus-service/src/web/board.rs)
and [session persistence](../../../engine/crates/nucleus-service/src/web/board/sessions.rs).

The paired API mounts the same planning handlers as the controller API and
checks session scope. The browser subscribes to scoped engine invalidations and
re-reads affected data. Open planning records use periodic reads while the
stream is disconnected. Reconnection resynchronizes open views and stops
those periodic reads. A browser view, Settings read or ordinary planning read
consumes the store and cached host facts.
Opening a view does not refresh native threads. The typed browser adapter keeps
shared views behind the Rust boundary. See the [paired planning handlers](../../../engine/crates/nucleus-service/src/web/planning.rs),
[board adapter](../../../client/web/rust-adapter.ts) and
[live board transport](../../../client/web/rust-board.ts). See the
[engine board guide](../../../engine/README.md#board) and
[shipped board Settings and reconnect proof](../../../test/rust-task-board.test.ts).

GitHub Accounts is an operator-only settings domain. It stores GitHub host,
user ID, login and the role selections. Each saved account's grant stays in
the local keychain for that engine profile. An unset role uses installed
`gh`. A selected reviewer with an inaccessible or expired grant needs
attention before a review can publish. The existing operator forge credential
still owns PR reads and merges.

Sign-in uses the public GitHub App registration `inflatable-cookie-nucleus`
with client ID `Iv23liRsqJ59EsNDdtiu`. Device-issued grants refresh with that
public ID. Repository access is limited to the permissions shared by the
app installation and the signed-in user. Phase 1 applies account selection to
formal reviews. The worker account stays inactive until the per-role
credential handoff is verified. See [Spec 070](../specs/070-small-engine.md#rulings)
and [GitHub's device-flow and access rules](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token).

## Process and data ownership

One process owns each Rust profile and opens its store before publishing the
listener. `ensure` verifies an existing process or starts the configured
release. T3's ACP presence keeps the service alive. When the last connection
remains absent through the grace period, the service reaches a durable safe
point and releases its profile lock. A reconnect during that period cancels
shutdown. Startup resumes from recorded state and current observations. See
[engine startup](../../../engine/crates/nucleus-cli/src/ensure.rs) and
[ACP lifecycle](../../../engine/crates/nucleus-service/src/acp.rs).

The engine owns its durable database, settings, backups and credentials.
Storage defaults to the internal drive. Worktrees, scratch and builds may use
operator-configured roots or Barge resource classes. A missing required volume
blocks use of that placement. It does not move an active profile or route work
to internal storage. Keep the registered project checkout and its Git common
directory in project custody. The [release contract](release.md) owns roll and
rollback. [Spec 070 ruling 19](../specs/070-small-engine.md#rulings) and
[storage configuration](../../../engine/crates/nucleus-store/src/settings.rs)
own root selection.

The historical TypeScript database remains an offline read-only backup. The
Rust profile is the active data authority. Existing decisions and past outcomes
remain evidence. See the [migration decisions](../specs/070-small-engine.md#migration)
and the [pre-cutover service contract](https://github.com/inflatable-cookie/nucleus/blob/737246d22bcb7590e5819da41449d28131ed1b3d/docs/knowledge/contracts/service-boundary.md).

## Responsiveness

The scheduler advances its active and archive scan cursors only after reading
both pages. A failed read leaves both pages eligible for the next pass.

Read and render from local state. The scheduler owns bounded calls to T3 and
GitHub. Per host, it shares a held shell and cached observations across tasks,
reads a precise thread only for a due decision or safety fence, and keeps an
unavailable host on its next due time. A request that times out or returns
incomplete evidence remains unknown. Rechecking it respects the same host
budget. A native title, visibility change or notice needs a recorded reason to
write. Use typed state and push invalidations for the board. See the
[scheduler pass](../../../engine/crates/nucleus-service/src/pass.rs),
[T3 observations](../../../engine/crates/nucleus-hosts/src/thread_snapshots.rs)
and [Spec 070 ruling 11](../specs/070-small-engine.md#rulings).
