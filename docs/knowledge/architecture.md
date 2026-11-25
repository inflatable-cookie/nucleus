# System architecture

Nucleus runs one Rust service for each configured engine home. T3 hosts the
native task threads. The browser board and the installed CLI are clients of
the same service.

## Modules

| Responsibility | Owner |
| --- | --- |
| Task state, commands, transitions and pure decisions | [nucleus-core](../../engine/crates/nucleus-core/) |
| SQLite transactions, delivery records and saved settings | [nucleus-store](../../engine/crates/nucleus-store/) |
| Scheduling, report authentication, HTTP and the event stream | [nucleus-service](../../engine/crates/nucleus-service/) |
| Worktree allocation, custody and retirement | [nucleus-work](../../engine/crates/nucleus-work/) |
| Exact-head GitHub checks and merge | [nucleus-forge](../../engine/crates/nucleus-forge/) |
| Native T3 operations and observations | [nucleus-hosts](../../engine/crates/nucleus-hosts/) |
| The task’s model-free ACP session | [nucleus-acp](../../engine/crates/nucleus-acp/) |
| Local service, CLI and T3 provider setup | [nucleus-cli](../../engine/crates/nucleus-cli/) |

## Service boundary

A worker and a retained reviewer run under the task’s native parent thread.
Their reports carry run-scoped credentials. The service commits decisions
against the task version and reconciles uncertain sends against their native
receipts. See the [orchestration rules](contracts/orchestration.md) and the
[service boundary](contracts/service-boundary.md).

The TypeScript board starts at [engine-index.tsx](../../client/web/engine-index.tsx).
Axum serves its assets, authenticates paired browsers and streams invalidations.
The board refreshes its views from the engine. Host observations and native
writes belong to the Rust adapters.

## Deployment and data

The [engine guide](../../engine/README.md) covers staging, storage and T3 setup.
The [repository layout](contracts/repository-layout.md) locates source and
tests. [Spec 070](specs/070-small-engine.md) records the governing decisions
and migration history. The prior TypeScript runtime and store ownership are recorded
in the [historical architecture](https://github.com/inflatable-cookie/nucleus/blob/737246d22/docs/knowledge/architecture.md).
