# Contract Index

Status: active
Owner: Tom
Updated: 2026-06-17

## Active Contracts

| Contract | Status | Purpose |
| --- | --- | --- |
| `001-working-rules.md` | active | Repo working rules before v1.0. |
| `002-harness-adapter-contract.md` | draft-promoted-first-pass | Provider adapter boundary with first Rust protocol types. |
| `003-project-identity-contract.md` | draft | Planned durable project identity model. |
| `004-model-routing-contract.md` | draft-promoted-first-pass | Model/provider routing layer with first Rust protocol types. |
| `005-task-contract.md` | draft-promoted-first-pass | Durable task model with first Rust domain types. |
| `006-workspace-layout-contract.md` | draft-promoted-first-pass | Persisted project workspace layout with first Rust domain types. |
| `007-server-boundary-contract.md` | draft-promoted-first-pass | Server/host API and control-plane boundary with first Rust types. |
| `008-storage-state-persistence-contract.md` | draft-promoted-first-pass | Persistence domains, record identity, revisions, and journal vocabulary. |
| `009-adapter-registry-contract.md` | draft-promoted-first-pass | Configured harness adapter registry with first Rust types. |
| `010-agent-session-lifecycle-contract.md` | draft-promoted-first-pass | Server-owned agent session and turn lifecycle with first Rust types. |
| `011-scm-forge-sync-contract.md` | draft | Git, SCM, forge, and project-management sync boundary. |
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

## Needed Contracts

The 2026-06-17 stocktake found gaps that should become contracts before more
runtime implementation depends on them:

- remote host pairing/session contract
- tool broker, preview, and MCP contract
- observability and diagnostics contract

Source refs:

- `docs/architecture/architecture-gap-index.md`
- `docs/architecture/t3-code-comparison.md`
- `docs/roadmaps/reassessment-decision-queue.md`
