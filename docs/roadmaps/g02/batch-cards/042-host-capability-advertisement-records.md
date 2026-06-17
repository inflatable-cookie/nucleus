# 042 Host Capability Advertisement Records

Status: completed
Owner: Tom
Updated: 2026-06-17
Milestone: `../010-client-protocol-and-host-transport-runway.md`

## Purpose

Expose host form, connection mode, capability, readiness, and authority-map
publication records through the client protocol layer.

## Scope

- Add compile-only Rust records for host capability advertisement.
- Distinguish embedded, sidecar, remote-authoritative, remote-worker, and
  managed host modes.
- Include authority-domain publication references without implementing the full
  `013` authority-map record lane.
- Include runtime readiness refs without making readiness a transport concern.
- Update docs and roadmap state.

## Acceptance Criteria

- Clients can inspect host form and advertised capability categories.
- Advertisement records can say whether authority-map publication is present,
  deferred, or unsupported.
- Records do not grant authority by themselves.
- No network listener, remote auth, or live host discovery is implemented.

## Validation

- `cargo test -p nucleus-server host_capability`
- `cargo check --workspace`
- `effigy qa:docs`
- `effigy qa:northstar`
- `rg -n '^## Next Task' README.md AGENTS.md docs`
- `git diff --check`

## Stop Conditions

- Stop if authority-map mutation rules are needed. That belongs to `013`.

## Outcome

Completed 2026-06-17.

Added compile-only `nucleus-server` host capability advertisement records under
the client protocol module. The records expose host form, connection mode,
protocol profile, capability categories, authority-map publication posture, and
runtime-readiness publication posture without granting authority or choosing a
transport.
