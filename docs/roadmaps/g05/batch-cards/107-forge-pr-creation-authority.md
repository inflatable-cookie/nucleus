# 107 Run Delivery Forge PR-Creation Authority

Status: dispatched
Owner: Tom
Created: 2026-08-13
Milestone: none yet (agent orchestration lane, phase 2 unblocker)
Depends on: 106 (delivery commit/push authority, merged `0034ad9c`)
Auto-start next card: no

## Objective

Admit forge pull-request creation for a delivered run through an explicit
authority lane — the third and (expected) final authority gate on the run
loop. Card 103 stopped here (stop log
`docs/logs/2026-08-13-run-delivery-forge-pull-requests.md`, merged
`dfbac4c0`): PR/forge effects are hard-blocked
(`PullRequestCreationRequested`/`ForgeEffectRequested` blockers, preflight
hardcodes `pull_request_created: false`), and contract 027 reserves PR
creation for "a later explicit lane". This is that lane.

## Governing Refs

- The 103 stop log — full citations and this card's recommended shape
- `docs/contracts/027-*` — forge network execution authority; the lane must
  carry operator approval ref, preflight (credential readiness, network
  authority, idempotency, retry/recovery, sanitization), idempotency
  reconciliation against provider state, receipts, and sanitized evidence
  (per `027:534-561`)
- Contracts 007/011 realized exceptions and 033's authority rule as amended
  by 105/106 — extend; do not reshape
- The 2026-08-13 operator decisions: operator merges — merge, comment,
  label, reviewer, and review-sync authority stay OUT of this lane
- `provider_forge_pull_request_runner_authority/` — the stopped-by-default
  spine this card wires (mirror 105's treatment of the worktree chain)

## Scope (planned)

1. **Contract 027 amendment**: admit operator-confirmed per-delivery PR
   creation with the full admission/preflight/idempotency/receipt spine;
   explicitly not merge, comment, label, reviewer, or branch-mutation
   effects.
2. **007/011/033 amendments**: extend the realized exceptions so the
   per-delivery confirmation can carry PR-creation scope (forge provider,
   base/head refs, title/body sources) on top of the confirmed remote.
3. **Execution**: wire the `provider_forge_pull_request_runner_authority`
   spine to a real forge PR-open call behind the confirmed intent —
   preflight proves credential + network authority, idempotency reconciles
   against existing PRs for the branch, sanitized evidence + receipts; PR
   reference persisted on the run record; operator notification carries the
   link.
4. **Fallbacks**: no remote / no credential / PR API failure keeps the 101
   branch-only delivery with an explaining receipt. A forge test double for
   PR creation is part of the card (`ForgeScmNoEffects` is a no-effects
   marker today).
5. **Fixtures**: happy path (PR opened, reference stored, notification),
   each fallback, each blocker, idempotent re-delivery (no duplicate PR),
   preflight failures.
6. Batch log `docs/logs/2026-08-13-forge-pr-creation-authority.md`.

Out of scope: the 103 pipeline integration itself (re-dispatched after
this merges), merge/comment/review-sync, stacked runs, forge providers
beyond the admitted test double + one real route.

## Acceptance (planned)

- [ ] 027 admits the per-delivery PR-creation lane with the full spine;
  007/011/033 extended narrowly
- [ ] confirmed delivery intent + preflight + idempotency → PR opened,
  reference on the run, notification with link
- [ ] fallbacks keep branch-only delivery with explaining receipts
- [ ] no merge/comment/review-sync capability introduced
- [ ] fixtures + server suite + ratchet green; batch log

## Stop Conditions

- The forge runner spine's record shape cannot express the confirmed
  intent without weakening blockers → stop with citations
- Idempotency against provider state cannot be made safe for re-delivery →
  stop and report
- The real forge route needs credential material outside the admitted
  credential-reference mechanism → stop with citations
