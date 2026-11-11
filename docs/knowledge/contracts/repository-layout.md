# Repository layout

Owner: Nucleus maintainers

## Purpose

Folders show the process, host and domain that own the code (Tom, 2026-11-10).
The standalone service owns state and lifecycle work; a host integration supplies
an adapter, and its plugin only forwards requests. The [service boundary](service-boundary.md)
owns those runtime contracts. This map is the target; relocation happens in
separate reviewed changes recorded in the Nucleus `nucleus-general` lane document.

`core/hooks/` owns repository hook execution, discovery, replay, isolation, retention
and build-output records. Hook publication uses the synchronous repository-sync
roll callback registered by the service.

Forge and Git now live in `core/forge/` and `core/git/`. The service registers
the synchronous repository-sync roll callback; login-session fault notification
lives in shared code so Git does not load the service.

## Target runtime layout

`core/` is host-neutral code running in the service process. `service/` is the
standalone process's composition and transport layer. `hosts/` owns each app's
integration, with separate entries for service, plugin backend and browser code.
There is no mixed-process barrel: each public index exports only its process's
surface. The old `server/` and `host/` source roots disappear after migration.

| Folder (including second level) | Process and ownership | Host |
| --- | --- | --- |
| `shared/` | Contracts, pure helpers and method catalogue, usable by every process. | Neutral |
| `shared/schema/` | Input, output and persisted-value schemas. | Neutral |
| `shared/rpc/` | Method contracts grouped by domain. | Neutral |
| `shared/service/` | Shared-safe socket protocol, clients and discovery primitives; no process owner. | Neutral |
| `core/` | Engine and resolution construction shells and domain composition. | Neutral |
| `core/host/` | Adapter interface, registration interface, host facade, registry and host admission. | Neutral |
| `core/store/` | Store, schema, projections, persistence seams, compaction and backups. | Neutral |
| `core/dispatch/` | Queue ordering, capacity, routing, worker launch and run-launch stages. | Neutral |
| `core/intake/` | Authenticated reports, result application, callback policy and run settlement. | Neutral |
| `core/review/` | Review source, retained reviewer, verdict, publication and revision orchestration. | Neutral |
| `core/merge/` | Merge/check gates, intent reconciliation and integration-turn ownership. | Neutral |
| `core/closeout/` | Sync, closeout authority, hooks and terminal completion orchestration. | Neutral |
| `core/recovery/` | Observation, recovery handoff, incidents, retry and transient-provider recovery. | Neutral |
| `core/workspaces/` | Allocation, worktree ownership, continuation, retirement and cleanup. | Neutral |
| `core/hooks/` | Repository hook execution, manifest, replay, retention and isolation. | Neutral |
| `core/host-runs/` | Host-run admission/scheduling, accounting, custody, files and protocol policy. | Neutral |
| `core/qa/` | Project QA, validation, proof execution, fence and evidence policy. | Neutral |
| `core/forge/` | Forge interface and GitHub transport, checks, review publication and merge implementation. | Neutral across agent hosts |
| `core/git/` | Git commands, identity, fetch, snapshots, authentication and transient retries. | Neutral |
| `core/planning/` | Plans, lanes, leads, decisions, briefs, handoffs and durable operations. | Neutral |
| `core/questions/` | Native questions, agent asks/messages, delegation, ladder and origin notices. | Neutral |
| `core/verbs/` | Owner controls, disposition and control fences. | Neutral |
| `core/runtime/` | Board, planning, question, settings and repository handlers with restricted contexts. | Neutral |
| `core/scheduling/` | Lane scheduler, task wakes and bounded reconciliation sweep. | Neutral |
| `core/telemetry/` | Task/board projections, usage, presence and runtime measurements. | Neutral |
| `core/machine/` | Process identity, execution, tool custody, file facts and supervision primitives. | Neutral |
| `service/` | Entrypoint and runtime owner: construct core and select host through its public service index. | Composes configured hosts |
| `service/transport/` | Authenticated service socket, catalogue dispatch and local clients. | Neutral |
| `service/callbacks/` | Callback socket/client and Effigy admission socket endpoints. | Neutral |
| `service/web/` | HTTP board, formal-review HTTP and publication budget. Serves the browser bundle. | Web transport |
| `service/install/` | Build identity, installation, rolling, standby and handoff. | Neutral |
| `service/executor/` | Executor worker, host-run front/worker, supervision and private fixture servers. | Neutral |
| `hosts/` | App integration containers; no cross-host imports. | Per child folder |
| `hosts/paseo/` | Public service index; adapter implementation stays behind it. | Paseo |
| `hosts/paseo/adapter/` | SDK adapter, asks, messages, questions, workspace and workspace-id mapping. | Paseo, service process |
| `hosts/paseo/plugin/` | Public plugin-backend index, registration, bridge and manifest source. | Paseo plugin process |
| `hosts/paseo/client/` | Public client index, contribution registration and shell implementation. | Paseo browser/native UI |
| `client/` | Host-neutral board UI, controls, settings and planning surfaces. | Neutral, browser/native UI |
| `client/board/` | Board cards, pipeline, header and data subscriptions. | Neutral |
| `client/task/` | Task detail and activity. | Neutral |
| `client/records/` | Lead, decision and papercut dialogs. | Neutral |
| `client/shell/` | Shell interface and neutral injection point; no concrete host export. | Neutral |
| `client/web/` | Web entry, shell and HTTP transport, implementing the same shell interface. | Browser |
| `bin/` | Stable CLI/helper front doors; service-owned helper implementations may live behind these entries. | Neutral |

The web shell stays in `client/web/`: a browser transport does not implement an
agent-host adapter. A future agent app gets its own `hosts/<app>/` subtree;
adding it must not make core or board code depend on its SDK.

The proposed T3Code adapter belongs behind `hosts/t3code/index.ts`, with its
minimal private-protocol client and adapter modules inside that host subtree.
It has no plugin-backend or client contribution entry. Service composition
reaches only the public index; no T3 protocol type enters core or shared.
The [adapter design](../specs/t3code-host-adapter.md) is a checkpoint, not an
implemented second host.

## Supporting layout

| Folder (including second level) | Ownership |
| --- | --- |
| `test/`, `test/support/`, `test/fixtures/` | Unit/local integration tests, reusable harnesses and inert fixtures; no production imports from tests. |
| `scripts/` | Build, import gates, formatting, validation and bounded proof tools; development process only. |
| `scripts/acceptance/` | Explicit opt-in external acceptance scenarios, when present. |
| `skills/`, `skills/nucleus/` | Shipped agent instructions and their references. |
| `docs/`, `docs/knowledge/` | Documentation front doors and current knowledge with one owner per fact. |
| `changelog.d/` | User-facing changes awaiting release preparation. |

Examples and fixtures use synthetic projects, paths and task histories. Real consumer
records are never fixture sources. Task evidence and scratch artifacts live outside
the checkout under the local `NUCLEUS_SCRATCH_ROOT`; link shareable evidence from
PRs without naming local paths or private projects in the public PR body.

`effigy check` runs the package-native publication gate over tracked filenames and
working-tree bytes. It rejects private vocabulary, absolute home or volume paths,
and evidence artifacts (binary files, images outside `docs/assets/` or `assets/`,
logs and HTML diffs). Exact synthetic fixture exceptions live in the gate; they
never exempt private vocabulary. The ignored `.publication-denylist` supplies
local private names, one literal name per line, case-insensitively. Copy
`.publication-denylist.example` and replace its synthetic sample, or set
`NUCLEUS_PUBLICATION_DENYLIST` in `.agents.local.env` or the environment to another
local file. With no default file the list is empty; path and artifact checks still
run. A configured nonempty filename must exist. Diagnostics name rules and file
locations without echoing private content.

For `.json` data, the gate also decodes one JSON string layer in keys and values
before checking names and paths. Source-code escapes remain unchanged so a regex
describing a path is not treated as a recorded machine path.

The machine scratch value belongs in the ignored `.agents.local.env`; the committed
`.agents.local.env.example` holds only variable names. Managed runs retain their
recorded scratch roots. `NUCLEUS_TEST_PINNED_EFFIGY` and
`NUCLEUS_TEST_QUALIFIED_EFFIGY` identify local executables for compatibility proofs.
Unset, they skip with a stated reason. A present path is hashed against the
expected artifact.

Task evidence and scratch artifacts live outside the checkout. The former
`evidence/` tree is retained only in Git history. Use `git log --all -- <path>`
to find a receipt’s history, then `git show <revision>:<path>` to read it.

Generated package-only folders are `runtime/` (the packaged Node executable)
and `web/dist/` (browser assets). Dependencies in `node_modules/` and Git metadata
are tooling state, not source architecture. Configuration such as `.github/`
retains its existing owner and is outside relocation scope.

## Import rules

- Shared imports only shared and neutral dependencies. Core imports only core,
  shared and neutral dependencies; it never imports service, a concrete host,
  board UI or CLI. Neutral dependencies include Node, schemas and forge tools.
- A host's service adapter imports shared, its own files and SDK, and core's
  host interface. Service composition reaches a host only through its public
  service index. Only that host subtree imports its SDK or plugin package.
- Plugin-backend code imports shared, its own forwarding helpers and SDK
  registration types. Its transport client/protocol must be shared-safe: no
  core, service runtime, database, Git, hook or lifecycle import, even transitively.
- The board imports shared, board modules and the shell interface. Concrete host
  client entries may compose the board and implement that interface. The neutral
  shell entry cannot re-export a concrete implementation.
- CLI code uses the shared catalogue and service client. Cross-process modules
  communicate through contracts; they cannot import another process's owner.

The `test/folder-imports.test.ts` gate scans runtime and type imports, re-exports,
literal dynamic imports and `require` calls. It retains current violating edges
in `test/fixtures/folder-import-violations.json`; the separate bridge gate also
checks transitive runtime reachability. New edges fail immediately; a move removes the matching
known edges in the same PR. Never refresh the list wholesale. Once it is empty,
all boundaries remain enforced without exceptions. Process entries and neutral
transport helpers must be classified explicitly while their old paths remain.

## Root and installed compatibility

The source root keeps package/configuration files (`package.json`, lockfile,
TypeScript and Effigy configuration, `.gitignore`, `paseo-plugin.json`) and
human front doors (`AGENTS.md`, `CLAUDE.md`, `README.md`, `CHANGELOG.md`). It keeps
exactly three executable source front doors: `index.server.ts`,
`index.client.tsx` and `mcp-report.mjs`. The two Paseo entries become thin
re-exports of the corresponding process index under `hosts/paseo/`; the MCP
entry continues forwarding to `bin/mcp-report.mjs` for retained absolute paths.

Paseo loads the root entries independently. The build already generates root
entry shims for installed bundles; it can also copy the manifest from its host
source, while keeping root `paseo-plugin.json` for source-checkout loading.
The manifest ID is `nucleus`: Paseo uses it as the default installation ID,
matching bridge reload and discovery. Entry or manifest changes require the
private installed-daemon proof and plugin-load test. No installed-loader proof uses the operator's live daemon.

Source relocation does not relocate installed package contracts. Preserve
`build.json`, `manifest.json`, `runtime/node`, `bin/nucleus.mjs`,
`bin/queue-cli.mjs`, `skills/nucleus/SKILL.md`, root manifest and plugin entries,
`server/index.server.mjs`, `client/index.client.js`, `web/dist/`, and the existing
`server/` worker/helper bundle paths emitted by `scripts/build-runtime.mjs`.
The currently running installer validates a replacement with its own code.
Keep these output aliases during every move; if a later task must retire one,
first ship a roll accepting both paths, then change writers in a subsequent roll.
Do not move the source and installed reader/writer contract in one roll.

`core/store/` now owns store persistence, schema, projections, sibling storage and
backup sources. Installed backup worker and CLI entries remain under `server/`.

`core/planning/` owns planning records, operations, briefs and handoffs;
`core/questions/` owns asks, messages, questions and their delegation policies.
The review-entry CLI prepares its lead source through the local
`service/transport/index.mjs` seam. Workspace preparation goes through service
admission and core review-entry identity on the selected host.
The runtime owner supplies operations with the synchronous build-identity getter.

## Migration invariants

Preserve byte-identical strings, method names/shapes, task identity, callback
authentication, persisted intent, state transitions and UI behavior. Update
imports, build asset anchors, Effigy selectors, docs and skill commands together.
Preserve all live data, settings, subscriptions, limits and pause state; reload
only the plugin after typechecking, never Paseo or its daemon.

Mechanical relocation and lifecycle extraction are separate PRs. Phase owners
receive narrow contexts; engine and resolution shells keep construction and
late-bound adapter lookups. The lane move plan records both, including the
engine/resolution orchestration still present after the decision-block split.

`core/verbs/` owns owner controls, their fences and refusal text, and disposition
handling. Disposition's effect, evidence, workspace and request modules stay
together under `core/verbs/disposition/`.

## Transport location

The framed protocol, socket client, local client, roll recovery, discovery reads
and build identity live in `shared/service/`. Service identity writes and process
launch/install actions stay outside shared. The installed local-client entry
remains `server/service/local-client.mjs`. Pure review text lives in
`shared/review-text.ts`.

The plugin registration entry (`hosts/paseo/plugin/index.ts`) binds the shared structural
bridge action port through `service/install/bridge-process-actions.ts`. That is
its only service-process composition import; the bridge itself reaches only
shared modules, with process effects supplied synchronously through the port.
The folder gate permits this registration edge alone, and the layout gate checks
the bridge's transitive graph independently of registration.

The Paseo adapter, plugin backend and client now live under `hosts/paseo/`,
with a separate index for each process. The root plugin entries only re-export
their process index, and the root manifest matches the host manifest source.
The neutral board shell is bound synchronously by the host client entry.

The standalone runtime owner lives in `service/runtime-owner.ts`. Socket listeners
live in `service/callbacks/`, with service RPC in `service/transport/`, installation
and roll helpers in `service/install/`, and executor workers in `service/executor/`.
Formal-review HTTP is a forge client in `core/forge/`, not a service listener.
Installed service worker and helper aliases remain under `server/service/`.

`core/workspaces/` owns workspace allocation, continuation, retirement, checkout
mounts and cleanup, including the directory-normalization helper. Installed
checkout and normalization helpers retain their `server/` output paths. The
cached default data-directory accessor lives in `shared/service/`.

`core/host-runs/` owns host-run scheduling, accounting, wire types, paths, file
custody and output policy. Socket serving stays in `service/callbacks/`; front
workers and the detached supervisor run from `service/executor/`. Installed
host-run front and worker paths remain under `server/`.

Runtime handlers now live in `core/runtime/`. Host admission, registration,
facade and registry live in `core/host/`; its public `index.ts` retains the
adapter contract and adapter-facing value types extracted before relocation.

The stable CLI entries use direct service transport by default. The retained
`--via-paseo` compatibility transport lives behind `hosts/paseo/cli/index.mjs`;
only `bin/queue-client.mjs` imports that public CLI entry. Migrate callers by
omitting `--via-paseo`, with the Nucleus service running. Retirement is recommended
after the planner warns callers; this migration retains the flag and route.

`core/qa/` owns project QA, validation, proof and Effigy admission policy, including
supervision files and failure-log collection. Detached QA and validation entrypoints
live in `service/executor/`; their `bin/` commands and installed aliases stay stable.

`core/dispatch/` owns launch sequencing, run-launch stages, worker dispatch,
capacity, routing, participant leases, retained work and prompts. The construction
shells retain compatibility delegates and supply live adapter accessors. Installed
package paths remain unchanged.

`core/intake/` owns authenticated report intake, callback reminders, result
application, run settlement and worker checkpoint continuations. CLI callback
transport and pure binding helpers live in `shared/service/`; intake retains
compatibility re-exports. Installed callback helpers keep their `server/` paths.

`core/review/` now owns review source, continuation, publication, retained-review
history, PR adoption, proof-receipt acceptance and review/revision lifecycle methods. Resolution supplies
narrow live contexts and keeps compatibility delegates for existing callers and
test overrides.

`core/closeout/` owns synchronization, closeout authority, queue and hook completion,
closeout workspace recovery and renewal, and ordered completion follow-ups. Phase
contexts retain live adapter and method lookups; workspace retirement proofs and
archive implementation stay in `core/workspaces/`. Installed package paths remain
unchanged.

`core/recovery/` owns recovery handoff, observations, provider and delivery
faults, stalls and worker replacement. Recovery lifecycle gates use named live
ports; planner-grant cleanup lives in `core/questions/`, and accepted-PR
workspace reconciliation lives in workspace continuation. Installed recovery
module aliases remain under `server/`.

`core/merge/` owns exact-head merge gates, required-check waits, integration turns,
external merge acceptance and prospective candidates. Its phase owner restores
recorded merge intents and sequences exact automatic hook replay through narrow
contexts; resolution retains synchronous delegates and live adapter access.

`core/machine/` owns process execution and identity, host-process reaping,
supervision, file facts, tool custody and output retention. `core/telemetry/`
owns task and board projections, run usage, live presence and runtime measurements.
Their source moves preserve installed helper paths, including `server/owned-file.mjs`.

Agent policy lives in dispatch; archive intent, delivery and thread archive live in
workspaces; cohort and repository contention live in scheduling. Enclosing operations
belong to planning, fence settlement and task/wait reasons to recovery, runtime
retirement to runtime, and data-home retention to store. Stage definitions and
task decision rules live at the core root.

`core/scheduling/` now owns task quanta, ordered resolution advancement, prerequisite
release batches, lane scheduling, task wakes and the reconciliation sweep. Engine
and resolution live at the core root as construction and compatibility shells;
phase calls use named live ports so adapter replacements and method overrides
still apply. Terminal archive orchestration lives in `core/closeout/workspace-lifecycle.ts`,
host policy wiring in `core/host/`, and the request ledger in `core/runtime/`.
The pure bounded retry helper lives in `shared/backoff.ts`. The legacy `server/`
source root and folder-import exception list are empty; layout and import gates
keep them empty while installed package aliases stay unchanged.
