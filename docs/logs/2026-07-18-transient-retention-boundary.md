# Transient Retention Boundary

Date: 2026-07-18
Lane: g04 transient chat and promotion (card 194)

## Outcome

- project creation now carries a retention choice: transient projects
  default their name to "New Chat" and persist `retention: transient`
- two new lifecycle actions in the engine service: `promote` flips a
  transient project durable in place (optional rename, identity and
  records untouched) and `expire_transient` deletes chat residue — both
  idempotency-fingerprinted like every lifecycle action
- expiry is admission-gated: any durable child (task, goal record in
  planning, accepted memory, attached resource) refuses expiry with an
  explicit retention-decision reason; conversations do not block since
  transient chat expires with its project; the scan port is now
  kind-aware
- the DTO chain (server command, control envelope, generated TS bindings)
  carries `transient` on create and the two new actions; the ts-rs drift
  guard caught the hand-side gaps during the change

## Evidence

- engine tests: transient default name, durable name requirement,
  promote-in-place identity, expiry blocked by child / allowed when clean
- workspace, desktop svelte-check, and bun tests green

## Next

Card 195: New Chat creates and focuses a transient project; in-place
promotion paths; transient work stays out of the named-project rail.
