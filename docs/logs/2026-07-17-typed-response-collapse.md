# Typed Response Collapse

Date: 2026-07-17
Lane: g04 admission vocabulary consolidation (card 210, milestone closeout)

## Outcome

- one serde-driven flattener (`query/typed_response.rs`, ~120 lines)
  replaces 38 hand-written response-lines modules (3,058 lines); output is
  `domain=<label>`, the body's `type` tag, dotted-prefix fields, and
  `_count` lines for arrays
- state-record queries keep their legacy concise output; everything else
  renders through the typed path
- the 44-arm `matches!` allowlist in `query.rs` is gone — a new response
  variant now renders generically instead of silently falling through to a
  runtime error
- 32 render-grep test files deleted; sanitization moved into the flattener
  itself (raw payload, stdout/stderr, secret, credential-material, and
  private-prefixed keys are dropped at render time) with a property-style
  test
- milestone 045 closed: shared vocabulary (208), no-effects sweeps and the
  AdmissionGate framework (209), renderer collapse and test pruning (210);
  nucleusd net -6k lines this card

## Evidence

- workspace tests green; real-query smoke: bootstrap + accepted-memory +
  tasks render correctly through the new path
- deferred and recorded: clap conversion, CLI parse-test table collapse,
  ~800 remaining variant no-effects literals

## Next

Milestone 046 (engine boundary migration) — needs two operator decisions:
adapter-crate fate and, for 048, the archive location.
