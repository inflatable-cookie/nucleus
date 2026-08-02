# 012 Command Catalogue, Keymaps, And Palette

Status: completed
Owner: Tom
Created: 2026-08-01

## Purpose

Replace scattered global action discovery with Longhorn's command catalogue,
physical-key resolver, sparse keymaps, and one compact palette.

## Governing Refs

- `../../contracts/017-engine-host-authority-contract.md`
- `../../contracts/032-longhorn-desktop-systems-integration-contract.md`
- `../../../../longhorn/docs/contracts/006-command-action-and-input.md`

## Generation Runway Goal

Put advanced and infrequent actions behind search and shortcuts instead of
adding visible controls.

## Goals

- [x] register semantic Nucleus commands and current contexts
- [x] map each command to typed product or renderer-local execution
- [x] persist sparse keymap overrides with explicit conflicts
- [x] compose one palette and keybinding settings page

## Execution Plan

### Batch 12.1 — Catalogue And Fresh Admission

- [x] Execute card 036.
- [x] register shell, project, thread, panel, editor, Forge, and turn actions
- [x] rerun product admission at execution time

### Batch 12.2 — Keyboard And Keymaps

- [x] Execute card 037.
- [x] promote only global semantic shortcuts
- [x] retain component-local editing and accessibility keys locally

### Batch 12.3 — Palette And Acceptance

- [x] Execute card 038.
- [x] compose palette, menu projections, and settings integration
- [x] prove focus, text-input, IME, conflict, and stale-state behavior

## Acceptance Criteria

- [x] the palette finds and runs admitted commands without string dispatch
- [x] one command id does not become a Tauri invoke or server command id
- [x] unavailable commands explain why and cannot execute
- [x] shortcuts resolve consistently across supported platforms
- [x] no command bypasses Nucleus product authority

## Batch Cards

- `batch-cards/036-command-catalogue-and-admission.md`
- `batch-cards/037-keymap-persistence-and-resolution.md`
- `batch-cards/038-command-palette-and-acceptance.md`
