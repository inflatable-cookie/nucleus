# 200 Command Policy Evaluation Function

Status: completed
Owner: Claude
Updated: 2026-07-17
Milestone: `../042-execution-safety-honesty-and-enforcement.md`
Auto-start next card: no

## Objective

Give `nucleus-command-policy` a real pure decision function
(request -> allow / require-approval / deny with reasons) and replace the
shell-basename denylist with it.

## Steps

- add `evaluate(invocation, policy) -> CommandPolicyDecision` as pure,
  exhaustively tested logic in `nucleus-command-policy`
- cover interpreter escapes (`python -c`, `node -e`, `perl -e`, `dash`,
  `busybox`, `env <shell>`) and direct destructive commands
- route `local_read_only_spawn` admission through the new function; delete
  the basename denylist in `invocation.rs`

## Acceptance

- [x] decision function exists in the policy crate, no IO
- [x] interpreter-escape cases denied or flagged for approval, with tests
- [x] server admission consumes the function; denylist removed

## Validation

- `cargo test -p nucleus-command-policy`
- `cargo test -p nucleus-server local_read_only_spawn`

## Stop Conditions

- stop if enforcement design requires evidence-schema changes beyond decision
  wiring; surface to milestone planning gap first
