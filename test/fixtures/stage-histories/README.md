# Synthetic declared-stage histories

These fixtures are generated entirely from the neutral scenarios in `generate.mjs`.
They contain no consumer task records, captured identities, project paths or original
hashes. Regenerate them by running that script with Node.

`1001.json` describes a closed five-stage chain with three earlier review attempts,
a 36-required/30-permitted canonical gate and a digest invalidation. `1002.json`
describes a blocked publisher, a later accepted publication, a stale worker report
and a distinct observed head with a head-change invalidation. The fixed date,
identities, digests, verdict evidence lengths and events are generated values.
They cannot authenticate callbacks or authorize work.

`1002-git-shape.json` describes a synthetic two-parent append topology. All document
sizes exceed 64 KiB; the incoming object lacks a terminal LF and the candidate
adds exactly one LF to the 76,001-byte union. Its twelve delta entries have fourteen
path endpoints to represent renames. It records a test shape, not Git object proof.

The identity tests cover associations, independent stages, immutable verdicts,
invalidation and the difference between callback and observed heads. These records
do not prove runtime authentication, consumer recovery, Git composition or installed
UI behavior. Stage execution remains retired under Spec 043.
