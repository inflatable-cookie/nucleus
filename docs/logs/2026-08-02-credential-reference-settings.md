# Credential Reference Settings

Date: 2026-08-02
Roadmap: `g05/011-provider-and-product-settings.md`
Card: `g05/batch-cards/034-credential-reference-settings.md`

## Outcome

Agent & models Settings now show credential mechanism, entitlement, ownership,
status evidence, and lifecycle posture through a renderer-safe projection.
Local Codex remains provider-managed interactive OAuth backed by subscription
allowance. Its Swallowtail access profile carries no credential reference, so
Nucleus projects none.

Setup, repair, and revoke use one typed Tauri route. The request accepts only a
bounded request id, exact provider identity, optional opaque credential ref,
and action. Unknown fields fail deserialization. Current Codex actions return a
sanitized `provider_managed_lifecycle` no-effect receipt; they do not claim to
change the saved login.

## Evidence

- four focused server credential tests pass
- desktop restart/revoke persistence fixture passes
- mounted Settings fixture passes all three cases
- desktop type checking passes with one pre-existing ProjectRail ARIA warning
- no authenticated provider or credential effect ran

## Boundary

Credential material remains outside Longhorn config, Settings values, IPC
responses, logs, snapshots, and backup inputs. A future provider may supply a
real opaque credential ref and host-owned lifecycle workflow without changing
the renderer contract.

## Next

Execute card 035. Add only product settings with existing schemas and authority,
then close deterministic and native Settings acceptance.
