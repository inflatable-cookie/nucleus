# Local Control Bridge Alignment

Date: 2026-08-02
Cards: g05.048-g05.050

## Result

Nucleus now exposes one local Longhorn bridge domain, `nucleus.control`, over
the existing typed control envelopes and the exact desktop control adapter.
The bridge adds session, capability, and authority semantics without adding a
second product protocol.

Query and command routes require exact bridge-to-product request correlation.
They reject the wrong envelope kind before dispatch. A new hello invalidates
the previous caller session. Connection capability, read authority, and write
authority remain separate. Bridge-level revision and idempotency evidence is
rejected because no uniform exact mapping exists across current Nucleus command
DTOs. Rejected product outcomes stay rejected, and writes are not retried.

## Evidence

- direct and serialized-loopback product-envelope parity: passed
- stale-session and capability-versus-write-authority fixture: passed
- bridge-level replay/revision rejection fixture: passed
- production Tauri command registration and desktop Rust compilation: passed
- consumer-side Tauri invocation with Nucleus's generated context: passed

The consumer fixture invokes `longhorn_bridge_hello` and
`longhorn_bridge_query` from the `main` webview and matches the direct receipt
and reply. It uses Nucleus's generated Tauri context; the empty mock context has
no capability authority and is not evidence of the shipped app. No broad app
command ACL was introduced for the test.

## Gates

Production remote transport remains paused until Nucleus promotes remote host
identity, pairing, authentication, revocation, discovery, and lifecycle rules
and the operator selects a topology.
