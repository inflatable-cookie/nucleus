# 023 Memory Provider And Advanced Control Cohesion

Status: completed
Owner: Tom
Created: 2026-08-04

## Purpose

Make Memory useful as project context, keep provider selection truthful, and
place advanced controls outside the normal working path.

## Governing Refs

- `../../contracts/004-model-routing-contract.md`
- `../../contracts/008-storage-state-persistence-contract.md`
- `../../contracts/010-agent-session-lifecycle-contract.md`
- `../../contracts/013-shared-memory-contract.md`
- `../../contracts/030-swallowtail-agent-runtime-integration-contract.md`
- `../../contracts/032-longhorn-desktop-systems-integration-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`
- `../../architecture/repository-authority-map.md`

## Generation Runway Goal

Restore useful project context and provider choice without adding permanent
diagnostic chrome or pretending unavailable providers are configured.

## Goals

- [x] expose bounded, sensitivity-safe Memory display content
- [x] replace raw-id-first Memory presentation with a compact project context list
- [x] keep provider, model, reasoning, and harness selection in one truthful path
- [x] move specialist diagnostics and destructive controls behind deliberate entry points
- [x] close with deterministic and isolated native evidence

## Execution Plan

### Product Memory Projection

- [x] execute cards 071 and 072
- [x] promote bounded Memory display rules into Contract 013
- [x] carry sanitized title and summary through the existing read model
- [x] simplify the Memory panel around readable content and quiet metadata

### Provider Selection Placement

- [x] execute card 073
- [x] reconcile provider identity, route selection, model discovery, and new-session defaults
- [x] show a provider selector only when more than one admitted provider instance is selectable
- [x] preserve fresh-session replacement for provider, model, reasoning, or harness-mode changes

### Advanced Controls And Acceptance

- [x] execute cards 074 and 075
- [x] audit normal panel chrome against Settings, menu, popover, and disclosure placement
- [x] retain destructive, credential, diagnostic, and low-frequency controls behind deliberate entry points
- [x] prove narrow, restart, project-switch, and unavailable-provider behavior

## Acceptance Criteria

- [x] Memory leads with truthful titles and bounded summaries, not internal ids
- [x] restricted or secret-adjacent Memory content remains redacted
- [x] proposals remain distinct from accepted Memory and grant no mutation authority
- [x] a single configured provider does not create a redundant selector
- [x] route-dependent model and reasoning options never cross provider instances
- [x] normal panel chrome remains sparse and attention is reserved for actionable state
- [x] unsupported provider and credential behavior stays explicit

## Planning Checkpoint

After card 072, reassess the admitted Swallowtail provider catalogue. Card 073
must pause rather than invent a multi-provider projection if Nucleus still has
only one exact provider summary.

Checkpoint result: the stop condition is active. Swallowtail has exact
provider facades and model/session catalogues but deliberately no portable
configured provider-instance catalogue or router. Cards 073-075 remain held
until that boundary exists or the operator defers provider selection and
recompiles the remaining advanced-control work.

2026-08-04 recovery: Swallowtail Contract 047 and its runtime implementation
now provide the missing consumer-assembled configured-provider-instance
catalogue without adding a router. Card 073 is re-admitted against Contracts
004, 010, and 030. The original pause remains historical checkpoint evidence,
not an active stop.

## Delivered Through

Batch cards collapsed by the flattened-task migration (2026-09-09). Each card below is complete; dispatch and merge evidence lives in `../dispatch.md`, with per-card implementation logs under `../../logs/`.


- `071-memory-product-display-projection.md` — completed (collapsed into this task)
- `072-memory-panel-product-composition.md` — completed (collapsed into this task)
- `073-provider-selection-and-session-defaults.md` — completed (collapsed into this task)
- `074-advanced-control-placement.md` — completed (collapsed into this task)
- `075-memory-provider-control-acceptance.md` — completed (collapsed into this task)
