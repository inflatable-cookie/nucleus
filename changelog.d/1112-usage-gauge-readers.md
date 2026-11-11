New `usage.state` reads every subscription's provider usage: Codex through the
app-server (rollout files as fallback), Claude through its cached utilization,
Grok through `grok usage --json`. Readings are paced per subscription with
backoff, stored as bounded samples, and projected into a pressure dial — on
track, spare, or will run out before the window's reset — naming the binding
window. An unreadable provider never reads as 0.
