# Provider And Product Settings Closeout

Date: 2026-08-02
Roadmap: `g05/011-provider-and-product-settings.md`
Card: `g05/batch-cards/035-product-settings-and-acceptance.md`

## Outcome

The product-settings audit found three durable user-preference domains:
General, Appearance, and Agent & models. The registry remains limited to those
pages. Project layouts stay in project-scoped documents. Browser, Terminal,
Forge, Workspace, and Advanced do not get empty global pages.

The Agent & models page exposes the configured Local Codex instance, discovered
models, new-session defaults, and provider-managed interactive OAuth posture.
Credential lifecycle requests are typed and secret-free. Current setup, repair,
and revoke actions return explicit no-effect receipts because Codex owns that
login lifecycle.

## Evidence

- focused server credential and desktop restart fixtures pass
- mounted Settings acceptance passes all three cases
- Rust, desktop, docs, and Northstar checks pass; the final Longhorn consumer
  replay is blocked by unrelated dirty `inventory.rs` and transition-test files
  in the Longhorn worktree after the previously clean consumer check
- native release acceptance proves the sparse registry, sanitized revoke
  receipt, narrow-window usability, restart-safe geometry, and current defaults
- no authenticated provider or credential effect ran

## Next

Execute card 036. Inventory semantic Nucleus commands and admit invocation
through fresh product state without turning command ids into transport ids.
