# 2026-06-20 Health Rebaseline

Status: accepted
Owner: Tom
Updated: 2026-06-20

## Purpose

Record the first 124 health/runway rebaseline pass.

## Changes

- Split request-handler diagnostics query tests into parent, completion, and
  SCM modules.
- Split control-envelope diagnostics response tests into parent, completion,
  and SCM modules.
- Moved diagnostics query routing from `request_handler/queries.rs` into a
  nested diagnostics module.
- Moved embedded SCM review/prep unit tests out of the largest SCM production
  modules into sibling test modules.

## First Result

The pass reduced error-sized doctor findings from 37 to 33. It did not clear
the doctor gate. Total findings are now 152: 119 warnings and 33 errors.

The increase in warning findings is expected from splitting error-sized files
into smaller files that still cross warning thresholds. The next useful target
is the request-handler SCM diagnostics test submodule, followed by
control-envelope request DTO tests.

## Second Result

The second pass split the request-handler SCM diagnostics tests,
control-envelope request DTO tests, and the embedded tests from the top three
durable/provider error files.

Doctor now reports 152 findings: 124 warnings and 28 errors.

The remaining errors are broader durable dispatch, Codex supervision, provider
persistence, and DTO front-door debt. Roadmap 123 is resumed because the
active-lane request-handler/control DTO/SCM review pressure has been reduced
and the remaining debt is tracked in the implementation gap index.

## Validation

- `cargo test -p nucleus-server request_handler -- --nocapture`
- `cargo test -p nucleus-server control_envelope_dto -- --nocapture`
- `cargo test -p nucleus-server provider_scm -- --nocapture`
- `cargo check --workspace`
- `cargo test --workspace`
- `git diff --check`

`effigy doctor` remains red on `scan.god-files`.
