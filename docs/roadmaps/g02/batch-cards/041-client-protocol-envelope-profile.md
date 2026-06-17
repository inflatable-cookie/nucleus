# 041 Client Protocol Envelope Profile

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../010-client-protocol-and-host-transport-runway.md`

## Purpose

Define the first client protocol envelope profile before adding more host
capability, auth, or transport behavior.

## Scope

- Add compile-only Rust protocol profile types.
- Name request, response, and event envelope message kinds.
- Keep DTOs and transport envelopes boundary-only.
- Keep live network listeners, pairing, subscriptions, and remote auth out of
  scope.
- Update the server boundary contract and active roadmap.

## Acceptance Criteria

- Protocol profile includes request, response, and event message shapes.
- Protocol versioning is explicit and v1 exact-match only.
- Event envelopes are named without implementing a live subscription channel.
- Protocol authority is separate from durable server/engine authority.

## Validation

- `cargo test -p nucleus-server client_protocol`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if the profile requires a transport choice, auth mechanism, or
  authority-map record shape that belongs to a later batch.

## Outcome

Completed 2026-06-17.

Added compile-only `nucleus-server` client protocol profile records. The first
profile names v1 request, response, and event envelope shapes, keeps DTOs at
the boundary, and treats event delivery as protocol shape only.
