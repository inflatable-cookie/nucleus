# 003 Native Harness And Steward

Status: complete-first-pass
Owner: Tom
Updated: 2026-06-16

## Goal

Define Nucleus-owned harness personas and the project steward authority model
without choosing a final native runtime implementation.

## Scope

- Native harness and steward runtime research.
- Nucleus-owned persona/session/event/tool/model-backend/audit surfaces.
- Steward sync authority and approval policy.
- Distinction between bridged harnesses and native personas.

## Out Of Scope

- Native harness implementation.
- Model backend implementation.
- Steward execution.
- UI controls for approvals.

## Execution Plan

- [x] Research native harness and steward runtime options.
- [x] Add type-only native harness Rust surfaces.
- [x] Promote steward authority and management sync rules.

## Acceptance Criteria

- [x] Steward authority cannot mutate source code under management-sync policy.
- [x] Model backend choice does not increase persona authority.
- [x] Native runtime surfaces keep audit identity explicit.
- [x] Pure Rust runtime versus sidecar remains an explicit research gap.

## Cards

- `docs/roadmaps/g01/batch-cards/019-native-harness-and-steward-runtime-research.md`
- `docs/roadmaps/g01/batch-cards/020-native-harness-rust-surface-boundaries.md`
- `docs/roadmaps/g01/batch-cards/021-steward-persona-policy-and-sync-authority.md`

## Planning Gaps

- Pure Rust runtime versus sidecar runtime.
- Rig, Candle, llama.cpp, Ollama, and mistral.rs backend tradeoffs.
- Local model packaging and deployment policy.
