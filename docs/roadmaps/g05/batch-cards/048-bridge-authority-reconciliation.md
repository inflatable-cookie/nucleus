# 048 Bridge Authority Reconciliation

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../016-optional-backend-bridge-alignment.md`
Depends on: card 047
Auto-start next card: yes

## Objective

Reconcile Longhorn bridge session identity and lifecycle with Nucleus control
envelopes without creating a second domain protocol.

## Acceptance

- [x] session, host, capability, authority, revision, and correlation mappings are exact
- [x] domain commands and DTOs remain Nucleus-owned
- [x] connection capability and write authority remain distinct
- [x] stale sessions and authority epochs fail closed

## Validation

- [x] mapping, compatibility, stale-session, and authority fixtures pass

## Evidence

- one local `nucleus.control` bridge domain carries existing typed control DTOs
- bridge and product request correlation must match exactly
- a new hello invalidates the previous caller session
- unsupported bridge-level replay and revision evidence fails before dispatch
- focused bridge fixtures pass

## Stop Conditions

- do not duplicate product payloads or treat connection as write admission
