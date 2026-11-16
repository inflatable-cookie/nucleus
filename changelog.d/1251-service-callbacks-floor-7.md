The callback surface and the Effigy admission socket now each have one owner per
mechanism. The callback socket's seventeen routes are one table that is both its
allowlist and its dispatch, an oversized body keeps its 413 and a body it cannot
decode is a 400 the caller must fix, and the authentication refusal is a typed
error instead of a spelling the socket compared against — so a caller sees the
status its own refusal means. The agent helper is written from the shared
client's own bytes, with no import or re-export text surgery, so a rewording of
that shared module can no longer break the helper silently.

The admission socket is bound, probed and cleared through the host-run socket
owner's verified chain, so a symlinked, foreign or non-socket path refuses
instead of being bound through. Its hook liveness asks the start-identity owner
whether an identity can prove anything at all, rather than testing an `@unknown`
suffix, and every request line in one socket read is answered in order instead
of waiting for a read that may never come. A reconciliation tick that throws is
now recorded on the reservation it was observing, once per distinct reason,
instead of being swallowed every tick. No admission rule, protocol shape or
capacity decision changes.
