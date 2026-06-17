# 060 Management Projection Import Staging

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../016-management-projection-file-io-and-sync.md`

## Purpose

Parse and stage management projection files from another clone without silently
mutating authoritative state.

## Scope

- Read projection files from a configured repo path.
- Decode envelopes and validate schema/semantic shape.
- Build an import staging report.
- Keep import application out of scope.

## Acceptance Criteria

- [x] A fresh clone can parse project/task projection files.
- [x] Invalid and unsupported records are reported separately.
- [x] Import staging does not mutate task or project records.
- [x] Staged records retain enough refs for later conflict resolution.

## Outcome

- Added server-owned import staging request/report records.
- Read configured projection file refs from a repo root.
- Decoded and validated projection file documents without mutating
  authoritative state.
- Reported invalid decode/validation and unsupported schema records
  separately.

## Validation

- [x] `cargo test -p nucleus-engine management_projection`
- [x] `cargo test -p nucleus-server management_projection`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if import application semantics are needed before staging can be tested.
