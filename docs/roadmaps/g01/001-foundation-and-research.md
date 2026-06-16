# 001 Foundation And Harness Research

Status: complete-first-pass
Owner: Tom
Updated: 2026-06-16

## Goal

Install the repo spine, establish Rust workspace boundaries, gather first-pass
harness communication evidence, and promote stable findings into architecture
and contracts before app behavior begins.

## Scope

- Strict Northstar docs setup.
- Native Effigy task routing.
- Minimal Rust workspace.
- T3 Code reference source.
- Harness communication research lane.
- Initial project identity, task, workspace, server, persistence, adapter
  registry, and session lifecycle contracts.
- First-pass model routing and task assignment boundaries.

## Out Of Scope

- Runnable Tauri app.
- Server API implementation.
- Provider adapter implementation.
- Storage engine selection.
- UI design.

## Execution Plan

- [x] Install strict Northstar docs spine and Effigy routing.
- [x] Add minimal Rust workspace and placeholder app surfaces.
- [x] Clone and map T3 Code as ignored research evidence.
- [x] Research Codex, Cursor CLI, OpenCode, Claude, Kimi, and Pi readiness.
- [x] Promote first-pass harness, model-route, adapter registry, task,
  workspace, server, persistence, and session lifecycle contracts.
- [x] Add type-only Rust surfaces for adapter identity, model routes, project,
  task, workspace, server, persistence, adapter registry, and session records.

## Acceptance Criteria

- [x] Repo has a passing Northstar validation path.
- [x] Rust workspace checks.
- [x] T3 Code integration points are mapped in
  `docs/research/specimen-dossiers/t3-code-provider-integrations.md`.
- [x] Harness adapter contract has provider-specific findings in
  `docs/contracts/002-harness-adapter-contract.md`.
- [x] Kimi, Pi, and provider-routing surfaces are separated from core harness
  adapters in `docs/contracts/004-model-routing-contract.md`.
- [x] `nucleus-agent-protocol`, `nucleus-agent-adapters`,
  `nucleus-projects`, `nucleus-tasks`, `nucleus-workspaces`,
  `nucleus-server`, and `nucleus-core` have first-pass type-only surfaces.

## Cards

- `docs/roadmaps/g01/batch-cards/001-bootstrap-repo-spine.md`
- `docs/roadmaps/g01/batch-cards/002-codex-adapter-readiness-research.md`
- `docs/roadmaps/g01/batch-cards/003-cursor-cli-adapter-readiness-research.md`
- `docs/roadmaps/g01/batch-cards/004-opencode-adapter-readiness-research.md`
- `docs/roadmaps/g01/batch-cards/005-claude-adapter-readiness-research.md`
- `docs/roadmaps/g01/batch-cards/006-kimi-adapter-readiness-research.md`
- `docs/roadmaps/g01/batch-cards/007-pi-adapter-readiness-research.md`
- `docs/roadmaps/g01/batch-cards/008-adapter-trait-requirements.md`
- `docs/roadmaps/g01/batch-cards/009-runtime-event-payload-schema.md`
- `docs/roadmaps/g01/batch-cards/010-adapter-runtime-ownership-and-streams.md`
- `docs/roadmaps/g01/batch-cards/011-adapter-registry-selection-and-persistence.md`
- `docs/roadmaps/g01/batch-cards/012-adapter-registry-health-and-readiness.md`
- `docs/roadmaps/g01/batch-cards/013-adapter-secret-reference-and-credential-boundary.md`
- `docs/roadmaps/g01/batch-cards/014-model-route-override-semantics.md`
- `docs/roadmaps/g01/batch-cards/015-task-agent-assignment-and-model-preferences.md`
- `docs/roadmaps/g01/batch-cards/016-task-history-and-agent-attempt-audit.md`

## Follow-On Roadmaps

- `002-management-state-and-scm-forge.md`
- `003-native-harness-and-steward.md`
- `004-adapter-contracts-fixtures-and-effects.md`
- `005-server-runtime-boundaries.md`
