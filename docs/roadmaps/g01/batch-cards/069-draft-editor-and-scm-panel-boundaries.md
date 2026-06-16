# 069 Draft Editor And SCM Panel Boundaries

Status: proposed
Owner: Tom
Updated: 2026-06-16

## Goal

Draft text/code editor and SCM diff/commit panel boundaries.

## Scope

- Define editor surfaces, file identity, dirty state, save/apply authority,
  language-server lifecycle, theme import, and plugin host split.
- Define SCM changes, diff, staging/selection, commit/capture, push/publish,
  review-request, conflict repair, and AI proposal workflows.
- Decide whether the first implementation runway must include any editor or
  SCM panel preparation.
- Keep implementation out of scope.

## Out Of Scope

- Building the editor UI.
- Selecting Monaco, CodeMirror, or another editor substrate.
- Implementing language servers.
- Implementing a plugin system.
- Implementing Git actions.
- Implementing AI commit-message or conflict-resolution generation.

## Evidence Questions

- Which editor state is server-owned and which is client-local rendering state?
- What is the Rust/TypeScript split for plugins?
- How early should VS Code-compatible theme import be supported?
- Which SCM controls are Git-specific UI labels versus provider-neutral
  adapter actions?
- Which AI proposals require approval and audit before apply?

## Stop Conditions

- Client plugins can bypass server file, command, SCM, or credential policy.
- Git commit terminology leaks into provider-neutral SCM contracts.
- Editor planning turns into full IDE implementation planning.
- SCM controls mutate state directly from client state.

## Promotion Targets

- `docs/contracts/006-workspace-layout-contract.md`
- `docs/contracts/011-scm-forge-sync-contract.md`
- `docs/architecture/system-architecture.md`
- `docs/roadmaps/g01/005-server-runtime-boundaries.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```
