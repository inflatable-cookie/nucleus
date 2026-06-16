# 066 Draft Command Artifact Store And Output Retention Boundary

Status: done
Owner: Tom
Updated: 2026-06-16

## Goal

Draft the command artifact store and output retention boundary.

## Scope

- Define where command output artifacts live relative to command evidence,
  runtime effect storage, task history, and UI logs.
- Name retention postures for summaries, symbolic refs, full output artifacts,
  expiry, compaction, and repair after missing artifacts.
- Define secret scanning, redaction, approval, and audit expectations before
  full command output can be retained.
- Batch with compile-only artifact-store vocabulary if stable enough.

## Out Of Scope

- Artifact store implementation.
- File format, database, object store, or blob backend selection.
- Secret scanner implementation.
- Command execution implementation.
- Runtime scheduler implementation.
- UI rendering of artifact payloads.

## Evidence Questions

- Which artifacts can be referenced by command evidence without becoming
  command evidence themselves?
- Which output retention modes need explicit approval?
- Which artifact refs must survive replay and compaction?
- How should missing, expired, redacted, and unsupported artifacts be surfaced?
- Which redaction and secret-scan states are needed before implementation?

## Stop Conditions

- The draft stores raw output.
- The draft chooses a storage backend.
- The draft treats artifact refs as proof that raw payloads are still
  resolvable.
- The draft allows full output retention without redaction and approval policy.

## Promotion Targets

- `docs/contracts/007-server-boundary-contract.md`
- `docs/contracts/008-storage-state-persistence-contract.md`
- `docs/architecture/system-inventory.md`
- `crates/nucleus-command-policy`
- `crates/nucleus-server`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
cargo check --workspace
cargo test --workspace
```

## Closeout

- Added compile-only command artifact metadata vocabulary.
- Added server command artifact envelope types.
- Promoted artifact retention, resolution, secret-scan, redaction, and
  full-output approval rules into server and storage contracts.
- Updated system inventory and roadmap 005 acceptance state.
