# Provider And Model Settings

Date: 2026-08-02
Status: complete
Roadmap: g05.011
Card: 033

## Outcome

The Settings shell now has one lazy Agent & models page. A typed Nucleus
projection reports the configured local Codex provider instance, adapter and
harness identity, provider-managed authentication posture, model-discovery
availability, and the portable model catalogue. Discovery failure stays a
sanitized unavailable state; no raw provider payload or credential value
enters the renderer.

The shared desktop-preferences domain now stores staged default model,
reasoning effort, and normal/plan harness mode values. These values seed only
an Agent Chat conversation without stored or explicit route state. Reopened
conversations retain their selected and effective route. Composer changes and
later default changes therefore keep the existing fresh-session replacement
rule instead of mutating a prepared Swallowtail plan.

Configured models missing from current discovery remain visible as unavailable
and are not silently replaced by the first discovered model.

## Evidence

- eight focused Rust Settings tests pass, including persistence and reset
- the mounted Settings corpus passes provider projection and staged Plan apply
- desktop check, the 39 Bun tests, five mounted tests, and production build pass
- the native packaged app discovered seven models, applied Plan to an empty
  composer, and reset to Normal; no provider turn ran
- final persisted defaults are `gpt-5.4-mini`, `low`, and `normal`
- the Longhorn consumer check passes at commit
  `efe3483d499b5416cd6f1690d1c4598fd75cdfa4`, selected-tree SHA-256
  `193c7d24353f97f8275b8fa5724f1ffe7e37094890a3ae80680cb8b80e323896`

## Next

Execute card 034. Add setup, repair, revoke, and unavailable credential
workflows using opaque host-owned references and sanitized receipts only.
