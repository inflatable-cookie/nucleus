# 009 Harness Runtime Target Selection

Status: completed
Owner: Tom
Updated: 2026-06-17

## Purpose

Choose the first real harness runtime target and compile the implementation
runway from evidence, not preference.

This milestone should compare bridged harnesses and a Nucleus-native harness
shape against the orchestration, timeline, receipt, checkpoint, and tool broker
requirements.

## Governing Refs

- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`
- `docs/contracts/012-native-harness-runtime-contract.md`
- `docs/contracts/018-orchestration-contract.md`
- `docs/contracts/019-conversation-timeline-contract.md`
- `docs/research/source-hubs/harness-communications.md`

## Goals

- [x] Refresh evidence for Codex, Claude Code, Cursor CLI/SDK, OpenCode/ACP,
  Pi, Kimi, GLM, MiniMax, DeepSeek, OpenRouter, and OpenCode Zen where current
  docs are available.
- [x] Compare bridged harness vs Nucleus-native harness risks.
- [x] Pick one first runtime target and one comparison target.
- [x] Define provider event ingestion, cancellation, permissions, resume, and
  message identity requirements before implementation.
- [x] Keep UI panels and SCM mutation out of scope.

## Execution Plan

- [x] Evidence batch: update the harness communication source hub.
- [x] Adapter-risk batch: compare identity, resume, cancellation, permission,
  and transport behavior.
- [x] Target-decision batch: pick the first runtime target and comparison
  target.
- [x] Roadmap batch: compile the harness implementation milestone.

## Ready Cards

- `batch-cards/029-harness-evidence-refresh.md`
- `batch-cards/030-harness-runtime-risk-comparison.md`
- `batch-cards/031-first-harness-target-decision.md`
- `batch-cards/032-harness-implementation-runway.md` - completed

## Acceptance Criteria

- [x] The first harness target is selected with evidence.
- [x] Provider differences are exposed as capabilities, not hidden behind a
  false uniform interface.
- [x] The implementation milestone has clear stop conditions for provider
  limitations.

## Gate

Do not start implementation until runtime receipts, timeline projection, and
checkpoint rules can absorb provider events.

## Outcome

Selected Codex app-server/runtime as the first bridged harness target and Pi
RPC as the comparison target.

Compiled `011-codex-app-server-runtime-runway.md` as the next implementation
runway. It starts with schema/probe evidence and metadata fixtures, not live
provider session execution.
