# 122 Control Envelope Protocol Helper Split

Status: completed
Owner: Tom
Updated: 2026-06-21
Milestone: `../036-control-envelope-request-boundary-split.md`

## Purpose

Move diagnostics-domain mapping, runtime metadata action mapping, request-kind
decoding, and protocol validation helpers into focused modules.

## Acceptance Criteria

- [x] Protocol validation remains unchanged.
- [x] Diagnostics domain string mapping remains unchanged.
- [x] Runtime metadata action mapping remains unchanged.
- [x] No provider, SCM, UI, remote transport, or task behavior is added.

## Validation

- `cargo test -p nucleus-server control_envelope_dto -- --nocapture`
- `CARGO_INCREMENTAL=0 cargo check -p nucleus-server`
- `git diff --check`
