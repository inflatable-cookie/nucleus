The callback surface and the Effigy admission socket each give one mechanism one
owner, with no change to what a caller or a hook observes. The callback socket's
seventeen routes are one table that is both its allowlist and its dispatch, and
the status of a refusal is chosen from the refusal itself: the authentication
refusal is the store's typed error rather than a message the socket compared
against, while the oversized body keeps its 413 and everything else keeps the 409
it already answered. The agent helper is written from the shared client's own
bytes, with no import or re-export text surgery, so a rewording of that shared
module can no longer break the helper silently.

The admission socket shares the host-run socket's one liveness probe instead of
carrying its own copy, asks the start-identity owner whether a hook's recorded
identity can prove anything at all instead of testing an `@unknown` suffix, and
records a reconciliation tick that throws on the reservation it was observing,
once per distinct reason, instead of swallowing it every tick. The request bound,
the framing, the bind and the teardown keep the behaviour they had. No admission
rule, protocol shape or capacity decision changes.
