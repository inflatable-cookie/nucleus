# Orchestration Run Registry And Persistence

Date: 2026-08-13
Card: `docs/roadmaps/g05/batch-cards/098-orchestration-run-registry.md`
Branch: `thread/098-orchestration-run-registry`

## Outcome

Introduced the orchestration run aggregate on the contract-018 spine: the
durable run record, its lifecycle commands, spine events, contract-020
receipts, and the fleet projection the desktop will render. No UI, no
delegation tools, no orchestrator agent — those stay in 099-101.

- **Run aggregate (engine-owned, `nucleus-engine/src/run_commands/`)**:
  `EngineRunStorageRecord` carries the contract-033 Run Record Rule fields —
  run id, project, card-shaped objective (scope, acceptance, stop
  conditions), worktree identity, provider instance + model, nullable
  orchestrator designation, operation/conversation ids, lifecycle state,
  budget envelope (token/time), closeout slot, and an append-only transition
  log. `EngineRunCommandService` enforces the lifecycle
  (`proposed → dispatched → running → delivered → accepted | rejected`,
  with `failed`/`cancelled` terminal from any pre-delivery state), rejects
  invalid transitions and stale revisions, and requires a closeout before
  `delivered`. Mirrors the `task_commands` module shape (model/service/
  helpers/tests) per the existing engine conventions.
- **Spine**: `OrchestrationCommandFamily::Run` (additive enum variant; run
  commands require a target ref at admission). No envelope change was
  needed — the aggregate rides `command_admitted` events (family `Run`,
  target = run id) exactly like tasks do; the run record's transition log and
  the receipts carry the per-transition detail. Stop condition 1 does not
  trigger.
- **Persistence**: new `OrchestrationRuns` state domain end to end —
  `PersistenceDomain::OrchestrationRuns` / `PersistenceRecordKind::
  OrchestrationRun` in `nucleus-core`, SQLite table + kind codec + schema +
  domain boundary in `nucleus-local-store`, `ServerStateDomain::
  OrchestrationRuns` facade in `nucleus-server`.
- **Receipts**: every accepted transition writes a contract-020
  `EngineRuntimeReceiptRecord` (command-execution family, completed status,
  command ref, run transition effect ref, spine event evidence ref) into the
  runtime-effects domain. Audit trail = spine events + receipts + run record
  transition log, all readable.
- **Fleet projection**: `EngineRunFleetProjection` in `nucleus-engine`
  rebuilds deterministically from run records — per-project rows with state,
  provider, orchestrator designation, recency (updated_at desc, run id
  tie-break), closeout presence, plus status-board state counts. Served as
  `ServerQueryKind::OrchestrationRuns` → `ControlQueryDto::OrchestrationRuns`
  (action `fleet`) → `ControlResponseBodyDto::OrchestrationRuns`, with
  TS-exported DTO records (`ControlOrchestrationRunSummaryDto`,
  `ControlOrchestrationRunStateCountDto`) regenerated into
  `apps/desktop/src/lib/control/generated`.
- **CLI**: `nucleusd query orchestration-runs --project <project-id>`; effigy
  task `server:query:orchestration-runs` added.

## Placement Decision

The card says "in nucleus-server"; the repo ratchet and contract 018 say the
portable boundary:

- `nucleus-server/tests/module_ratchet.rs` pins the top-level module ceiling
  at 323 and the server already declares exactly 323 — any new top-level
  server module fails the suite. The ratchet text explicitly directs logic
  toward `nucleus-engine`/`nucleus-orchestration`.
- Contract 018 Implementation Boundary: orchestration implementation belongs
  in the portable Rust engine boundary; `nucleus-server` composes it, and the
  server request handler wires the engine service exactly like tasks
  (`request_handler/run_commands.rs` mirrors `task_commands.rs`).

No roadmap, milestone, card, or dispatch status files were touched; no
swallowtail, longhorn, or poodle sources were modified.

## Acceptance

- Run aggregate persists and round-trips; lifecycle transitions enforced —
  engine fixtures cover the full happy path, every invalid jump, terminal
  states, closeout precondition, duplicate propose, stale revision, and
  storage-domain/kind identity; handler fixture runs the full lifecycle
  through SQLite.
- Fleet projection query returns the contract-033 shape — engine projection
  fixtures (scoping, recency ordering, determinism, empty project) plus a
  server query fixture over persisted records.
- Receipts emitted for every transition; audit trail readable — handler
  fixture asserts 5 events (family `Run`, target `run:1`) and 5 receipts
  linked by command ref, plus a rejected invalid transition that mutates
  nothing.

## Commands And Exit States

1. `cargo test --workspace --exclude nucleus-desktop` — all green (engine
   112, orchestration 20, local-store 20, server 2042 incl. module ratchet,
   nucleusd 89, rest passing). `nucleus-desktop` excluded: its
   `tauri::generate_context!` requires `apps/desktop/dist` from the
   frontend build (pre-existing environment requirement, unrelated to this
   change).
2. `TS_RS_EXPORT_DIR=… cargo test -p nucleus-server export_bindings` — exit
   0; regenerated `ControlQueryDto.ts`, `ControlResponseBodyDto.ts`, new
   `ControlOrchestrationRun*Dto.ts`; CI's `git diff --exit-code` on the
   generated dir is clean after this run.
3. `effigy server:smoke` — exit 0.
4. `effigy server:query:orchestration-runs` — exit 0; renders
   `type=orchestration_runs`, `project_id=project:nucleus-local`,
   `runs_count=0` on bootstrap state.
5. `effigy qa:docs` — exit 0.
6. `git diff --check` — exit 0.
