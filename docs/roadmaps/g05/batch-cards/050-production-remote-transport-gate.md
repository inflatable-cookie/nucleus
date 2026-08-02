# 050 Production Remote Transport Gate

Status: paused
Owner: Tom
Created: 2026-08-01
Milestone: `../016-optional-backend-bridge-alignment.md`
Depends on: card 049 and a promoted remote host pairing/session contract
Auto-start next card: no

## Objective

Select and prove production remote transport, discovery, security, pairing,
reconnection, and lifecycle only after Nucleus promotes the missing contract.

## Acceptance

- [ ] remote identity, pairing, authentication, revocation, and trust are contracted
- [ ] transport and discovery choices have explicit platform evidence
- [ ] authority epochs, stale sessions, reconnect, and uncertain writes fail safely
- [ ] native remote acceptance supports any production-readiness claim

## Validation

- [ ] deterministic protocol and separately gated native remote evidence pass

## Resume Condition

Nucleus promotes a remote host pairing/session contract and the operator
selects the production topology to prove.

## Stop Conditions

- loopback parity is not remote readiness
