# 079 Draft Effigy Project Integration Boundary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Add first-pass authority surfaces for optional Effigy integration inside
Nucleus-managed projects.

## Scope

- Define Effigy as an optional project-level integration.
- Define how agents may access Effigy through extensions, skills, server tool
  bridges, or native personas.
- Bind Effigy invocation to server command authority.
- Add native steward expectations for Effigy-aware task routing and validation.
- Add storage and task refs for selector summaries, health, validation plans,
  and sanitized evidence.

## Out Of Scope

- Effigy manifest editing UI.
- Effigy plugin implementation.
- Harness-specific Effigy extensions.
- Automatic manifest rewrites.
- Command execution runtime.
- Release execution.

## Promotion Targets

- `docs/contracts/016-effigy-project-integration-contract.md`
- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/contracts/005-task-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/system-architecture.md`

## Closeout

Effigy is now documented as an optional but first-class project workflow
integration.

The active storage runway can include Effigy integration records without
building the tool bridge, harness skill injection, command execution, or UI
yet.
