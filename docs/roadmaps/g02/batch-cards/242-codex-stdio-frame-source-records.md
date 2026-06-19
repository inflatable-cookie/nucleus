# 242 Codex Stdio Frame Source Records

Status: completed
Owner: Tom
Updated: 2026-06-19
Milestone: `../055-codex-process-and-transport-acceptance.md`

## Purpose

Define stdio frame source and decode outcome records for Codex app-server
transport.

## Scope

- Record frame source id, runtime instance id, stream direction, frame
  sequence, decoded method, decode status, and evidence refs.
- Represent malformed, unsupported, and recovery-required frames.
- Do not open stdio or parse live bytes yet unless the runtime instance gate
  proves that is safe.

## Acceptance Criteria

- Decode outcome records can feed the existing 054 acceptance path.
- Malformed frames do not retain raw payloads by default.
- Recovery-required decode states stay visible.

## Result

`nucleus-server` now has Codex stdio frame source records under
`codex_supervision/stdio_frames.rs`.

The records describe runtime instance id, stream direction, sequence, decode
status, payload-retention posture, and evidence refs without opening stdio,
retaining raw frames, or parsing live bytes.

## Validation

- targeted server tests
- `cargo check --workspace`
- `git diff --check`

## Stop Conditions

- Stop if decode records need unbounded raw stream retention.
