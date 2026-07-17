# 217 Control Layer Collapse And IO Hygiene

Status: planned
Owner: Codex
Updated: 2026-07-17
Milestone: `../047-desktop-contract-integrity.md`
Auto-start next card: no

## Objective

Deduplicate the per-query TS control modules and fix blocking IO on the main
thread.

## Steps

- one generic `parseSingleRecordResponse<T>` and shared query builders;
  delete the 11 duplicate `QueryFallback` declarations and cloned switches
- make sync Tauri commands (`submit_control_envelope`, editor file ops,
  diff reads, terminal open) async + `spawn_blocking`
- cache editor file discovery per resource revision; probe text-ness from a
  bounded prefix instead of full-file reads
- bound the module-level retained caches in `AgentChatPanel`

## Acceptance

- [ ] control-layer duplication removed (~400 lines)
- [ ] no SQLite or directory-walk IO on the main thread
- [ ] file open/save no longer O(repo)

## Validation

- `effigy qa`
- desktop manual smoke: editor open/save latency, chat during query load

## Stop Conditions

- stop before store-level query filtering changes; in-memory filtering stays
  for now
