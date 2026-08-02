# Notification Ledger And Attention

Date: 2026-08-02
Cards: g05.042-g05.044

## Result

Nucleus now owns one durable, finite Longhorn notification ledger. Failed
cross-panel operations publish a redacted error record. Routine success and
progress remain quiet. Seen and dismissed state survives restart; corrupt
ledger files are quarantined and cannot become authority.

The titlebar affordance exists only while retained records exist and shows the
authoritative unseen count. Warning and error records may also produce
transient Poodle toasts. Toast expiry does not mark seen or dismiss the ledger
record.

Forge failure records expose one semantic `Open Forge` action. Invocation
reruns the command catalogue's current project admission. Unknown sources and
action references fail closed.

## Evidence

- publication, redaction, renderer-authority, seen, dismissal, and restart Rust
  fixtures: passed
- compact popover, severity selection, and semantic action fixtures: passed
- Svelte check: zero errors; one pre-existing ProjectRail accessibility warning
- desktop Rust compilation: passed
