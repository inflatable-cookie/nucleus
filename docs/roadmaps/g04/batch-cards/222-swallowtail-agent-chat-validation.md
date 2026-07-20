# 222 Swallowtail Agent Chat Validation

Status: completed
Owner: Tom
Updated: 2026-07-20
Milestone: `../049-swallowtail-agent-chat-adoption.md`
Auto-start next card: no

## Objective

Prove the Swallowtail-backed Agent Chat route in automated and native product
use, then close the first Nucleus consumer slice.

## Acceptance

- [x] full Effigy QA passes
- [x] authenticated model catalogue passes through Swallowtail
- [x] one normal multi-turn chat stays on one live provider session
- [x] one task or Goal portal callback preserves its Nucleus receipt
- [x] changing model or reasoning opens a safe fresh session
- [x] stored history opens fresh with transcript context after restart
- [x] panel switching remains responsive during an active turn
- [x] direct transport audit is recorded

## Automated Evidence

- full `effigy qa` passed on 2026-07-20
- Swallowtail Codex app-server integration: 14 passed
- Nucleus Swallowtail adapter: 8 passed
- Nucleus server: 1,981 passed, 11 ignored
- desktop Svelte diagnostics: 0 errors, 0 warnings
- desktop TypeScript tests: 14 passed
- authenticated Agent Chat acceptance: native task/Goal inspection completed
  through both dynamic portals without mutating the selected records
- authenticated focused acceptance: 4 passed for same-session follow-up,
  route-change isolation, restart context, and durable task receipts
- the retained module-level pending state and async Tauri boundary preserve the
  previously accepted non-blocking panel-switch behavior
- direct Agent Chat wire transport is absent from `nucleus-agent-adapters`
- `local_codex_chat/task_execution.rs` remains a separate direct Codex path;
  it is outside this slice and is the first item in the post-acceptance audit

## Stop Condition

Reopen the lane with exact failed checks if model discovery, callbacks, turn
completion, cleanup, or UI behavior regresses.
