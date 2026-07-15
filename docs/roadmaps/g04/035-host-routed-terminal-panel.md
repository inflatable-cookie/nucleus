# 035 Host-Routed Terminal Panel

Status: completed
Updated: 2026-07-15
Owner: Tom
Updated: 2026-07-14

## Purpose

Replace the Terminal placeholder with a usable xterm panel backed by a
host-owned PTY without making terminal execution Tauri-local by design.

## Governing Refs

- `../../contracts/029-terminal-panel-runtime-contract.md`
- `../../contracts/017-engine-host-authority-contract.md`
- `../../contracts/006-workspace-layout-contract.md`
- `../../architecture/product-workflow-ui-architecture.md`

## Execution Plan

- [x] Promote terminal authority, protocol, lifecycle, and transport rules.
- [x] Add the transport-neutral client and local host PTY runtime.
- [x] Render xterm with input, output, fit, resize, attach, and close behavior.
- [x] Complete operator interaction validation after automated checks pass.

## Batch Cards

Completed:

- `batch-cards/177-terminal-host-runtime-boundary.md`
- `batch-cards/178-xterm-terminal-panel.md`
- `batch-cards/179-terminal-runtime-validation.md`
