# Spawn Boundary Sandbox Enforcement

Date: 2026-07-17
Lane: g04 execution safety honesty and enforcement (closeout)

## Outcome

Operator decision: enforce, not rename.

- read-only spawns now run under macOS seatbelt via `sandbox-exec`:
  `NoFilesystemWrite` denies all writes (except `/dev/null`),
  `ProjectRestricted` allows writes only under the canonicalized working
  directory; unmapped profiles and non-macOS platforms fail closed with
  `SandboxUnavailable` instead of running unsandboxed under a sandboxed label
- environment policy is enforced at spawn: `env_clear()` always, then a
  minimal safe allowlist (`PATH`, `HOME`, `TMPDIR`, locale, `TERM`, user
  identity, `TZ`) for `MinimalInheritedSafe`, explicit keys for
  `AllowlistedKeys`, nothing for `Empty`; `Custom` is rejected at admission
- children spawn in their own process group; timeout kill signals the group,
  so grandchildren (including the sandbox-exec wrapper's child) die with it
- milestone 042 closed: policy evaluation (card 200), enforcement (201),
  confirmation integrity (202) all landed

## Evidence

- seatbelt tests: `touch` outside project root fails and creates nothing
  under `NoFilesystemWrite`; succeeds inside project root under
  `ProjectRestricted`
- environment test: unlisted parent variable does not reach the child;
  `PATH` does
- end-to-end: `nucleusd command-runner read-only -- rm -rf <scratch>` blocked
  before spawn (`DestructiveExecutable`), target directory intact
- `cargo test -p nucleus-server -p nucleusd`: 1700 + 128 pass

## Next

Milestone 043 (CI and validation runway) is unblocked: CI workflow, desktop
`bun test` wiring, first direct `nucleus-local-store` coverage.
