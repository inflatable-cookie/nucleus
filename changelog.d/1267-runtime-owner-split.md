# Runtime health names what it does not know

The service runtime's bootstrap, refresh and health now live in their own
modules, and `service.health` reports two facts it used to hide:

- `prStateRead` says whether the board's PR-state map was read, and why not:
  a failed read keeps the last known map and names its cause instead of
  publishing an empty one.
- `hostRunEndpoint.retentionFailures` is now a typed record:
  `clear`, `unresolved` with the exact durable total and its bounded sample, or
  `unknown` with the reason the set could not be read. An unreadable set is
  never reported as clear (a client reading `null` for "nothing outstanding"
  now reads `state: "clear"`).
- `hostIdentityConflict` carries a conflict between the configured daemon and
  the recorded host as a typed fact; a host's `conflict` state no longer comes
  from matching error text.
