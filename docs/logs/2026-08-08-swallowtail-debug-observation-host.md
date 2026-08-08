# Swallowtail Debug Observation Host

Date: 2026-08-08

## Outcome

Nucleus Codex host can opt into Swallowtail Contract 053 debug observation.

- `NUCLEUS_SWALLOWTAIL_DEBUG=1` registers `SwallowtailDebugObserver` on
  `HostServices`
- stderr sink prints restricted `DebugObservation` detail plus safe diagnostics
- ordinary runs leave the observer unregistered
- local development uses `effigy deps link cargo ../swallowtail` until Nucleus
  bumps past Swallowtail `v0.3.0` to a release that includes the seam

## Validation

Focused `nucleus-agent-adapters` package validation.
