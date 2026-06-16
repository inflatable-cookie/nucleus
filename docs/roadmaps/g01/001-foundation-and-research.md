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
- Task history and agent attempt audit batch card exists.
- Validation evidence and artifact reference batch card exists.
- Git-backed project management state batch card exists.
- Native harness and steward runtime research batch card exists.
- Native harness Rust surface boundaries batch card exists.
- Steward persona policy and sync authority batch card exists.
- Management projection file model batch card exists.
- Projection storage Rust surface boundaries batch card exists.
- Projection schema validation and migration policy batch card exists.
- SCM and forge adapter surface boundaries batch card exists.
- SCM/forge sync observation and task-link policy batch card exists.
- SCM/forge implementation readiness research batch card exists.
- SCM/forge credential and webhook verification boundary batch card exists.
- Branch/worktree session management policy batch card exists.
- SCM/forge conflict and review workflow policy batch card exists.
- SCM/forge adapter implementation readiness plan batch card exists.
- Command execution authority and sandbox policy batch card exists.
- Provider-neutral fake adapter and fixture plan batch card exists.
- Dev-only fixture crate boundary and contract-test plan batch card exists.
- Dev-only contract fixture crate scaffold batch card exists.
- First provider-neutral contract tests batch card exists.
- Provider-neutral fake adapter skeleton batch card exists.
- Fake adapter scenario script tests batch card exists.
- Production adapter trait boundary draft batch card exists.
- Production adapter trait skeleton batch card exists.
- Production adapter trait compile tests batch card exists.
- Adapter runtime effect boundary draft batch card exists.
- Adapter runtime effect type skeleton batch card exists.
- Adapter runtime effect type compile tests batch card exists.

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
- `docs/roadmaps/g01/batch-cards/016-task-history-and-agent-attempt-audit.md`
- `docs/roadmaps/g01/batch-cards/017-validation-evidence-and-artifact-references.md`
- `docs/roadmaps/g01/batch-cards/018-git-backed-project-management-state.md`
- `docs/roadmaps/g01/batch-cards/019-native-harness-and-steward-runtime-research.md`
- `docs/roadmaps/g01/batch-cards/020-native-harness-rust-surface-boundaries.md`
- `docs/roadmaps/g01/batch-cards/021-steward-persona-policy-and-sync-authority.md`
- `docs/roadmaps/g01/batch-cards/022-management-projection-file-model.md`
- `docs/roadmaps/g01/batch-cards/023-projection-storage-rust-surface-boundaries.md`
- `docs/roadmaps/g01/batch-cards/024-projection-schema-validation-and-migration-policy.md`
- `docs/roadmaps/g01/batch-cards/025-scm-and-forge-adapter-surface-boundaries.md`
- `docs/roadmaps/g01/batch-cards/026-scm-forge-sync-observation-and-task-link-policy.md`
- `docs/roadmaps/g01/batch-cards/027-scm-forge-implementation-readiness-research.md`
- `docs/roadmaps/g01/batch-cards/028-scm-forge-credential-and-webhook-verification-boundary.md`
- `docs/roadmaps/g01/batch-cards/029-branch-worktree-session-management-policy.md`
- `docs/roadmaps/g01/batch-cards/030-scm-forge-conflict-and-review-workflow-policy.md`
- `docs/roadmaps/g01/batch-cards/031-scm-forge-adapter-implementation-readiness-plan.md`
- `docs/roadmaps/g01/batch-cards/032-command-execution-authority-and-sandbox-policy.md`
- `docs/roadmaps/g01/batch-cards/033-provider-neutral-fake-adapter-and-fixture-plan.md`
- `docs/roadmaps/g01/batch-cards/034-dev-only-fixture-crate-boundary-and-contract-test-plan.md`
- `docs/roadmaps/g01/batch-cards/035-scaffold-dev-only-contract-fixture-crate.md`
- `docs/roadmaps/g01/batch-cards/036-add-first-provider-neutral-contract-tests.md`
- `docs/roadmaps/g01/batch-cards/037-add-provider-neutral-fake-adapter-skeleton.md`
- `docs/roadmaps/g01/batch-cards/038-add-fake-adapter-scenario-script-tests.md`
- `docs/roadmaps/g01/batch-cards/039-draft-production-adapter-trait-boundary.md`
- `docs/roadmaps/g01/batch-cards/040-add-production-adapter-trait-skeleton.md`
- `docs/roadmaps/g01/batch-cards/041-add-production-adapter-trait-compile-tests.md`
- `docs/roadmaps/g01/batch-cards/042-draft-adapter-runtime-effect-boundary.md`
- `docs/roadmaps/g01/batch-cards/043-add-adapter-runtime-effect-type-skeleton.md`
- `docs/roadmaps/g01/batch-cards/044-add-adapter-runtime-effect-type-compile-tests.md`
- `docs/roadmaps/g01/batch-cards/045-draft-runtime-effect-trait-boundary.md`

## Next Task

Draft runtime effect trait boundary.
