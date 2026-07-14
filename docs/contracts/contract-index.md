# Contract Index

Status: active
Owner: Tom
Updated: 2026-07-14

## Active Contracts

| Contract | Status | Purpose |
| --- | --- | --- |
| `001-working-rules.md` | active | Repo working rules before v1.0. |
| `002-harness-adapter-contract.md` | draft-promoted-first-pass | Provider adapter boundary with first Rust protocol types. |
| `003-project-identity-contract.md` | draft | Planned durable project identity model. |
| `004-model-routing-contract.md` | draft-promoted-first-pass | Model/provider routing layer with first Rust protocol types. |
| `005-task-contract.md` | draft-promoted-first-pass | Durable task model with first Rust domain types. |
| `006-workspace-layout-contract.md` | draft-promoted-first-pass | Persisted project workspace layout with first Rust domain types. |
| `007-server-boundary-contract.md` | draft-promoted-first-pass | Server/host API, control-plane access, DTO, transport, and runtime wrapper boundary. |
| `008-storage-state-persistence-contract.md` | draft-promoted-first-pass | Persistence domains, record identity, revisions, and journal vocabulary. |
| `009-adapter-registry-contract.md` | draft-promoted-first-pass | Configured harness adapter registry with first Rust types. |
| `010-agent-session-lifecycle-contract.md` | draft-promoted-first-pass | Server-owned agent session and turn lifecycle with first Rust types. |
| `011-scm-forge-sync-contract.md` | draft-promoted-convergence-backend | Git, SCM, forge, and project-management sync boundary. |
| `012-native-harness-runtime-contract.md` | draft | Nucleus-owned harness runtime and steward persona boundary. |
| `013-shared-memory-contract.md` | draft | Server-owned shared memory records for project, task, session, and repo context. |
| `014-structured-project-planning-contract.md` | draft | Server-owned guided planning sessions, artifacts, and task seeds. |
| `015-deep-research-contract.md` | draft | Server-owned deep research runs, questions, source records, observations, and synthesis. |
| `016-effigy-project-integration-contract.md` | draft | Optional project-level Effigy integration for workflow routing, validation, and native steward tooling. |
| `017-engine-host-authority-contract.md` | draft-promoted-first-pass | Engine-first host forms, project authority maps, and multi-host authority rules. |
| `018-orchestration-contract.md` | draft | Event-sourced command, event, projection, and replay spine. |
| `019-conversation-timeline-contract.md` | draft | Canonical task, work item, session, thread, turn, message, activity, and provider-id mapping model. |
| `020-runtime-receipt-contract.md` | draft | Durable receipts and progress events for runtime side effects. |
| `021-checkpoint-diff-contract.md` | draft | Checkpoint and diff ownership across SCM, tasks, turns, and review workflows. |
| `022-engine-orchestration-boundary-contract.md` | draft | Portable engine, orchestration, and host/server crate ownership boundary. |
| `023-task-backed-agent-workflow-contract.md` | draft | Task-owned agent work-item lifecycle, Codex binding, wait states, review, and implementation gaps. |
| `024-harness-mediation-tool-projection-contract.md` | draft | Nucleus-owned tool projection and conversation steering across bridged harnesses. |
| `025-goal-loop-next-task-contract.md` | draft | Goal, loop, pathway, and next-task selection rules. |
| `026-open-ended-planning-conversation-contract.md` | draft | Open-ended ideation and exploration sessions before finite plans or tasks. |
| `027-provider-auth-forge-execution-contract.md` | draft | Provider credential authority, network-write admission, idempotency, recovery, and sanitized forge execution evidence. |
| `028-browser-panel-runtime-contract.md` | draft-promoted-first-pass | Desktop native child-webview trust, navigation, and panel lifecycle boundary. |
| `029-terminal-panel-runtime-contract.md` | draft-promoted-first-pass | Host-routed terminal authority, protocol, PTY lifecycle, transport, and client rendering boundary. |

## Needed Contracts

The 2026-06-17 stocktake found gaps that should become contracts before more
runtime implementation depends on them:

- remote host pairing/session contract
- browser/preview automation and remote-control contract beyond the local panel runtime
- observability and diagnostics contract

## Authority Ownership Notes

`007-server-boundary-contract.md` is a host/API boundary, not the system core.
When it overlaps focused contracts, the focused contract owns the durable rule:

- `017` owns engine host authority and project authority maps.
- `018` owns orchestration commands, events, projections, replay, and effect
  routing.
- `019` owns conversation and provider timeline identity.
- `020` owns runtime receipts and side-effect progress evidence.
- `021` owns checkpoints, diffs, and review snapshots.
- `022` owns engine, orchestration, and host/server crate boundaries.
- `023` owns task-backed work-item lifecycle, runtime binding, wait, recovery,
  and review sequencing.
- `024` owns harness mediation, portal tools, tool projection, and steering.
- `025` owns goals, loops, pathway records, and next-task selection.
- `026` owns open-ended exploration conversations and promotion gates from
  ideation into planning, research, memories, goals, and task seeds.
- `027` owns provider-auth and forge network execution authority before any
  real forge provider writes.
- `028` owns the local desktop browser-panel trust and child-webview lifecycle
  boundary.
- `029` owns terminal host routing, session protocol, PTY lifecycle, and client
  attachment semantics.
- `011`, `008`, and `002` own SCM/forge, storage, and harness-adapter rules.

Source refs:

- `docs/architecture/architecture-gap-index.md`
- `docs/architecture/t3-code-comparison.md`
- `docs/roadmaps/reassessment-decision-queue.md`
