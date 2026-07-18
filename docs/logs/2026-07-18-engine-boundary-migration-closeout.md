# Engine Boundary Migration Closeout

Date: 2026-07-18
Lane: g04 engine boundary migration (milestone 046 closeout)

## Outcome

- milestone 046 closed: runtime effects and host identity in orchestration
  (211), task/goal/project dispatch engine-backed (212), goal-run god file
  decomposed with pure decisions in engine (213), Codex routed through the
  protocol adapter boundary with a live registry (214)
- `nucleus-contract-fixtures` wired per operator decision: nucleus-server
  consumes the command-policy fixtures in runner contract tests; the
  wiring immediately surfaced and documented an authority-boundary
  mismatch (fixture read-only request carries ScmAdapter authority the
  local runner does not admit)
- module-count ratchet live: nucleus-server fails its own suite above the
  322-module baseline; ceiling only goes down
- server facade deferred with reasoning on card 214: high churn, no
  behavior change until a second host form exists; the ratchet covers the
  growth risk

## Evidence

- fixture contract tests and ratchet green; workspace green

## Next

Milestone 047 (desktop contract integrity: Rust-to-TS drift guard, CSP,
control-layer collapse) is the last open milestone in the audit band.
