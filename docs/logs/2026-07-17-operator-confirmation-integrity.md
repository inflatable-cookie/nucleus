# Operator Confirmation Integrity

Date: 2026-07-17
Lane: g04 execution safety honesty and enforcement

## Outcome

- added `CliFlagAsserted { operator_ref, flag, scope }` to
  `CodexAppServerTransportExecutorOperatorConfirmation`; flag-based
  confirmation is now typed distinctly from evidence-backed `Confirmed`
- `--confirm-real-write` / `--confirm-real-effect` paths record
  `assertion:cli-flag:*` references instead of fabricated `evidence:*`
  strings (codex turn-start smoke and durable live provider write smoke)
- authority and smoke-boundary decisions accept flag assertion for the
  real-write smoke scope while keeping honest refs in evidence records
- smoke output now labels its source: `source=fixture_replay` for
  fixture-computed runs, `boundary_source=fixture_records` for fixture-fed
  boundaries, `source=live_provider` for live provider execution

## Evidence

- new test pins that the confirm flag yields assertion refs and no
  `evidence:nucleusd-confirm*` strings
- `cargo test -p nucleus-server -p nucleusd` passes (1697 + 128)

## Next

Card 201 remains the lane's open decision: enforce sandbox claims at spawn
(seatbelt, env allowlist, process-group kill) or rename persisted evidence
to unsandboxed local exec.
