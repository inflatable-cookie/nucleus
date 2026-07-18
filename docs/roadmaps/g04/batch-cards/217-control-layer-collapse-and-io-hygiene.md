# 217 Control Layer Collapse And IO Hygiene

Status: completed
Owner: Claude
Updated: 2026-07-18
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

- [x] control-layer duplication removed: shared `QueryFallback` +
  `parseSingleRecordResponse` replace eleven local fallback declarations
  and ten cloned switch ladders
- [x] no SQLite or directory-walk IO on the main thread:
  `submit_control_envelope`, editor list/read/save, diff overview/patch,
  review decisions, and `terminal_open_or_attach` are async +
  `spawn_blocking`
- [x] file open/save no longer O(repo): text probe reads an 8KB prefix
  instead of whole files, and a short-TTL discovery cache stops every
  open/save re-walking and re-probing the project
- [x] AgentChatPanel module caches bounded to 32 conversations (LRU-ish
  eviction)

## Validation

- `effigy qa`
- desktop manual smoke: editor open/save latency, chat during query load

## Stop Conditions

- stop before store-level query filtering changes; in-memory filtering stays
  for now
