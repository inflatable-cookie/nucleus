# 030 Harness Runtime Risk Comparison

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../009-harness-runtime-target-selection.md`

## Purpose

Compare bridged harnesses and the Nucleus-native harness against the
orchestration, timeline, receipt, checkpoint, and tool-policy requirements.

## Scope

- Compare Codex app-server/runtime, Claude SDK/CLI, Cursor ACP, OpenCode
  server/SDK/ACP, Kimi ACP/SDK, Pi RPC, and the Nucleus-native steward runtime.
- Score identity stability, event fidelity, cancellation, resume, permissions,
  process ownership, terminal fallback, and Rust integration complexity.
- Keep provider capability differences visible instead of forcing one uniform
  adapter shape.
- Identify what each option would prove for the broader adapter system.
- Promote durable implications into the harness adapter, registry, lifecycle,
  native harness, orchestration, or timeline contracts where needed.

## Acceptance Criteria

- A comparison note or updated source hub names the strongest first target and
  strongest comparison target candidates.
- Risks are tied to contract surfaces, not subjective preference.
- Native harness and bridged harness ownership differences remain explicit.
- No provider runtime implementation begins.

## Validation

- `effigy qa:docs`
- `effigy qa:northstar`
- `git diff --check`

## Stop Conditions

- Stop if the comparison reveals missing contract authority for event
  ingestion, runtime receipts, approvals, or tool policy.
- Stop if the first target depends on unavailable credentials, private docs, or
  an uninstalled local runtime.

## Outcome

Added `docs/research/translation-memos/harness-runtime-target-selection.md`.

The comparison selected Codex app-server/runtime as the strongest first target
and Pi RPC as the comparison target. Claude, Cursor, OpenCode, Kimi, and the
Nucleus-native steward remain important later lanes with different ownership
and transport tradeoffs.
