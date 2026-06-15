# 001 Foundation And Research

Status: active
Owner: Tom
Updated: 2026-06-15

## Goal

Install the repo spine, establish Rust workspace boundaries, gather harness
communication evidence, and promote stable findings into architecture and
contracts before app behavior begins.

## Scope

- Strict Northstar docs setup.
- Native Effigy task routing.
- Minimal Rust workspace.
- T3 Code reference source.
- Harness communication research lane.
- Initial project identity and adapter contracts.

## Out Of Scope

- Runnable Tauri app.
- Server API implementation.
- Provider adapter implementation.
- Storage engine selection.
- UI design.

## Milestone Acceptance

- Repo has a passing Northstar validation path.
- Rust workspace checks.
- T3 Code integration points are mapped. First pass complete in
  `docs/research/specimen-dossiers/t3-code-provider-integrations.md`.
- Harness adapter contract has provider-specific findings. First pass promoted
  in `docs/contracts/002-harness-adapter-contract.md`.
- Kimi, Pi, and provider-routing surfaces are separated from core harness
  adapters before Rust traits are drafted. First pass complete in
  `docs/research/specimen-dossiers/kimi-runtime-boundary.md`,
  `docs/research/specimen-dossiers/pi-runtime-boundary.md`, and
  `docs/contracts/004-model-routing-contract.md`.
- `nucleus-agent-protocol` has first draft adapter identity, capability, event
  identity, model-route, and agent session lifecycle types.
- `nucleus-projects` and `nucleus-tasks` have first draft type-only domain
  surfaces.
- `nucleus-workspaces` has first draft modular workspace layout, panel, and
  surface types.
- `nucleus-server` has first draft modular server authority, deployment,
  client, command, and event boundary types.
- `nucleus-core` has first draft persistence domains, record identity,
  revision, snapshot, and journal vocabulary.
- `nucleus-agent-adapters` has first draft adapter registry, instance
  configuration, readiness, lifecycle, and health types.
- Project, task, workspace, server, persistence, adapter registry, and session
  lifecycle contracts have enough shape to support provider readiness planning.
- Provider implementation readiness spec and first adapter research cards exist.
- Codex adapter readiness research is promoted first-pass.
- Cursor CLI adapter readiness research is promoted first-pass.
- OpenCode adapter readiness research is promoted first-pass.
- Claude adapter readiness research is promoted first-pass.
- Kimi adapter readiness research is promoted first-pass.
- Pi adapter readiness research is promoted implementation-ready.
- Adapter trait requirements batch card exists.
- Runtime event payload schema batch card exists.
- Adapter runtime ownership and stream semantics batch card exists.
- Adapter registry selection and persistence batch card exists.
- Adapter registry health and readiness batch card exists.
- Adapter secret reference and credential boundary batch card exists.
- Project and session model-route override batch card exists.
- Task agent assignment and model preference batch card exists.

## Batch Queue

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

## Next Task

Draft task-level agent assignment and model preference semantics.
