# Runtime Effects To Orchestration

Date: 2026-07-17
Lane: g04 engine boundary migration (card 211)

## Outcome

- all six `runtime_effect_*` modules (events, replay, retention, storage,
  subscriptions, transport — 788 lines) relocated from nucleus-server to
  nucleus-orchestration per contract 022's standing list
- client identity vocabulary (`ClientId`, `ClientIdentity`, `ClientKind`,
  `ServerEventId`) moved to `nucleus-orchestration::host_identity`; the
  host-side `ClientConnection` record stays in the server
- server keeps thin re-export shims at the old paths, so no consumer churn
- orchestration's one-line placeholder modules (`replay.rs`, `streams.rs`,
  `receipts.rs`) deleted — the crate no longer advertises empty API
- orchestration now depends on nucleus-command-policy and nucleus-scm-forge
  for effect event payloads (no cycles)
- contract 022 disposition list annotated with move dates

## Evidence

- `cargo test --workspace` green

## Next

Card 212 (request-handler dispatch to engine) is the next mechanical move;
card 214 still holds the two operator decisions (adapter crate fate,
server facade guard).
