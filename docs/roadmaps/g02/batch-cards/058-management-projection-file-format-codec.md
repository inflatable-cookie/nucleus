# 058 Management Projection File Format Codec

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../016-management-projection-file-io-and-sync.md`

## Purpose

Define the first committable management projection file envelope codec.

## Scope

- Choose the first file encoding for projection envelopes.
- Encode and decode project/task projection entries with schema metadata.
- Preserve unsupported records explicitly.
- Keep local-only/runtime/provider state excluded.

## Acceptance Criteria

- [x] Management projection envelopes can round trip through the selected file
  encoding.
- [x] Unsupported or future record kinds survive as explicit unsupported
  records.
- [x] Codec tests prove runtime streams, secrets, and local UI state are
  absent.

## Outcome

- Selected TOML as the first management projection file format.
- Added document-level encode/decode helpers around projection envelopes and
  payloads.
- Added explicit unsupported payload preservation.
- Kept local-only, runtime, provider auth, and client layout state out of file
  documents.

## Validation

- [x] `cargo test -p nucleus-engine management_projection`
- [x] `cargo check --workspace`
- [x] `effigy qa:docs`
- [x] `effigy qa:northstar`
- [x] `rg -n '^## Next Task' README.md AGENTS.md docs`
- [x] `git diff --check`

## Stop Conditions

- Stop if the selected encoding conflicts with the existing schema envelope
  contract.
