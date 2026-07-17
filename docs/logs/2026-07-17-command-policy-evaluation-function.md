# Command Policy Evaluation Function

Date: 2026-07-17
Lane: g04 execution safety honesty and enforcement

## Outcome

- added pure read-only policy evaluation to `nucleus-command-policy`
  (`evaluation.rs`): allow / requires-approval / deny with typed blockers
- classifier covers shell passthrough (including `dash`, `ksh`, `busybox`),
  interpreter inline-code escapes (`python -c`, `node -e`, `perl -e`,
  `ruby -e`, `osascript -e`, more), opaque interpreter scripts
  (approval-required), destructive executables (`rm`, `dd`, `mv`, `chmod`,
  `mkfs*`, ...), indirect execution (`xargs`, `find -exec/-delete`), and
  in-place mutation flags (`sed -i`)
- environment wrappers (`env`, `nohup`, `nice`, `timeout`, `stdbuf`) are
  unwrapped so the wrapped command is what gets classified
- removed the shell-basename denylist from `CommandInvocation`; the read-only
  command runner now maps classifier blockers into its rejection evidence
- classification remains a policy hedge, not a sandbox guarantee; enforcement
  or evidence renaming is the next card

## Evidence

- new pure evaluation tests cover shells, inline-code escapes, wrapper
  unwrapping, destructive and indirect execution, and read-only tool
  allowance
- `cargo test --workspace` passes

## Next

Operator decision on card 201: enforce sandbox claims at spawn (seatbelt,
env allowlist, process-group kill) or rename persisted evidence to
unsandboxed local exec.
