# 024 Shell Accessibility Responsive And Failure Cohesion

Status: completed
Owner: Tom
Created: 2026-08-04

## Purpose

Make the consolidated shell keyboard-sound, panel-responsive, and honest about
loading, empty, failed, and recoverable state without adding permanent chrome.

## Governing Refs

- `../../contracts/006-workspace-layout-contract.md`
- `../../contracts/010-agent-session-lifecycle-contract.md`
- `../../contracts/028-browser-panel-runtime-contract.md`
- `../../contracts/029-terminal-panel-runtime-contract.md`
- `../../contracts/032-longhorn-desktop-systems-integration-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`

## Generation Runway Goal

Close the first shell-inward consolidation pass with a usable minimum layout,
semantic interaction, and bounded recovery while keeping normal state quiet.

## Goals

- [x] remove remaining shell interaction semantics warnings and pointer-only routes
- [x] make panel adaptation depend on panel width rather than native-window width
- [x] preserve every primary action at the narrow supported panel size
- [x] converge loading, empty, failed, and retry presentation around Poodle primitives
- [x] prove keyboard, focus, narrow-layout, announcement, and exact-retry behavior

## Execution Plan

### Batch 24.1 — Semantic Shell Interaction

- [x] execute cards 076 and 077
- [x] inventory current shell interaction and state-presentation gaps
- [x] replace event-bearing static controls with semantic controls
- [x] retain keyboard routes for selection, rename, tabs, menus, and dialogs

### Batch 24.2 — Container-Relative Composition

- [x] execute card 078
- [x] establish container ownership at panel roots
- [x] replace panel viewport media queries with container-relative rules
- [x] keep primary controls visible and content overflow bounded

### Batch 24.3 — Failure And Recovery Composition

- [x] execute cards 079 and 080
- [x] converge shell and sidebar loading, empty, failed, and retry states
- [x] keep failures local and announce only actionable transitions
- [x] prove exact retry without fallback routing or duplicate panels

### Batch 24.4 — Acceptance

- [x] execute card 081
- [x] run mounted keyboard and state fixtures, responsive policy fixtures, and narrow native acceptance
- [x] close with Svelte, desktop, docs, and isolated native evidence

## Acceptance Criteria

- [x] Svelte accessibility checks report no Nucleus-owned interaction warning
- [x] project and thread selection, rename, tabs, menus, and dialogs have keyboard routes
- [x] narrow panels adapt when the window remains wide
- [x] normal chrome never requires horizontal scrolling
- [x] empty and loading state stays quiet while actionable failure is announced once
- [x] retry retains exact project, panel, resource, and operation identity
- [x] healthy panels add no global status chrome

## Planning Checkpoint

After card 078, inspect the actual narrow shell before applying one presentation
pattern across specialist panels. Stop if a panel needs product-specific rules
rather than forcing generic error or empty-state composition.

## Batch Cards

- `batch-cards/076-shell-quality-contract-and-audit.md`
- `batch-cards/077-semantic-shell-interaction.md`
- `batch-cards/078-container-relative-panel-composition.md`
- `batch-cards/079-shell-state-presentation.md`
- `batch-cards/080-specialist-panel-recovery-convergence.md`
- `batch-cards/081-shell-quality-acceptance.md`
