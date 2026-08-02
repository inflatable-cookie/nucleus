# 011 Provider And Product Settings

Status: completed
Owner: Tom
Created: 2026-08-01

## Purpose

Populate the Settings shell with provider, model, appearance, workspace, and
advanced product controls while keeping credential material host-owned.

## Governing Refs

- `../../contracts/004-model-routing-contract.md`
- `../../contracts/010-agent-session-lifecycle-contract.md`
- `../../contracts/027-provider-auth-forge-execution-contract.md`
- `../../contracts/030-swallowtail-agent-runtime-integration-contract.md`
- `../../contracts/032-longhorn-desktop-systems-integration-contract.md`

## Generation Runway Goal

Move provider and advanced configuration behind one coherent product surface.

## Goals

- [x] expose configured provider instances and sanitized auth posture
- [x] configure default model, reasoning, and session mode inputs
- [x] admit appearance, workspace, Browser, Terminal, and Forge pages only where
  durable policy exists
- [x] keep all secrets behind opaque refs and host workflows

## Execution Plan

### Batch 11.1 — Provider And Model Projection

- [x] Execute card 033.
- [x] map current model discovery and provider readiness into settings
- [x] retain immutable prepared-session behavior

### Batch 11.2 — Credential Workflows

- [x] Execute card 034.
- [x] expose setup, repair, and revoke actions without credential values
- [x] preserve OpenAI OAuth, API-key, and future provider distinctions

### Batch 11.3 — Product Pages And Acceptance

- [x] Execute card 035.
- [x] add only contract-backed product pages
- [x] validate persistence, restart, and narrow layout behavior

## Acceptance Criteria

- [x] the configured provider instance and its available configuration are visible in Settings
- [x] secret values never enter Longhorn documents, logs, or renderer snapshots
- [x] active sessions are replaced rather than silently mutated
- [x] unsupported provider features remain explicit
- [x] normal Agent Chat chrome stays minimal

## Batch Cards

- `batch-cards/033-provider-and-model-settings.md`
- `batch-cards/034-credential-reference-settings.md`
- `batch-cards/035-product-settings-and-acceptance.md`
