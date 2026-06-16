# 007 Pi Adapter Readiness Research

Status: done
Owner: Tom
Updated: 2026-06-15

## Goal

Promote Pi from first-pass runtime dossier to adapter implementation readiness.

## Scope

- Re-check Pi RPC behavior.
- Compare SDK session operations against RPC gaps.
- Record session file, event stream, tree/fork, queue, retry, compaction, bash,
  and sandbox evidence.

## Out Of Scope

- Implementing Pi support.
- Treating session tree navigation as generic rollback.
- Assuming sandboxing exists without nucleus-managed wrapping.

## Evidence Questions

- Which RPC commands are required for first adapter support?
- How should nucleus synthesize event ids for streamed RPC events?
- How do session files, session ids, tree entries, and fork/import operations
  relate?
- Which SDK capabilities are not available through raw RPC?
- What must be exposed as extension or command surface metadata?

## Stop Conditions

- Synthetic event id rules cannot be made deterministic.
- Session tree operations are confused with rollback.
- Sandbox status cannot be reported honestly.

## Promotion Targets

- `docs/research/specimen-dossiers/pi-runtime-boundary.md`
- `docs/contracts/002-harness-adapter-contract.md`
- `docs/contracts/009-adapter-registry-contract.md`
- `docs/contracts/010-agent-session-lifecycle-contract.md`

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```

## Next Task

Draft projection storage Rust surface boundaries.
