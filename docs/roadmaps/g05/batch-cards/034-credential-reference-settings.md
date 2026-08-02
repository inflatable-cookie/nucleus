# 034 Credential Reference Settings

Status: completed
Owner: Tom
Created: 2026-08-01
Milestone: `../011-provider-and-product-settings.md`
Depends on: card 033
Auto-start next card: yes

## Objective

Expose credential setup, repair, and revocation through opaque host-owned
references and sanitized status only.

## Acceptance

- [x] OAuth, API-key, subscription, and future provider flows stay distinguishable
- [x] renderer state contains references and posture, never secret values
- [x] setup, repair, revoke, and unavailable outcomes are explicit
- [x] logs, backups, snapshots, and Longhorn documents remain secret-free

## Validation

- [x] redaction, IPC, persistence, restart, and revoke fixtures pass

## Stop Conditions

- stop on any path that exposes credential material to the renderer

## Evidence

- Local Codex projects interactive OAuth, subscription metering,
  provider-managed ownership, caller-asserted readiness, and no credential ref.
- Typed setup, repair, and revoke requests reject unknown fields and return
  coded sanitized no-effect receipts while provider lifecycle remains external.
- Rust fixtures prove secret-shaped IPC rejection, ref mismatch rejection, and
  provider-managed revoke without state change.
- Desktop persistence fixtures prove the unavailable revoke leaves Agent
  defaults intact across restart and writes no credential-shaped fields.
- Mounted Settings checks prove the credential posture and revoke receipt are
  visible without exposing material.
- No authenticated provider or credential effect ran.
