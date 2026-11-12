Project registration on T3 Code Nightly now works, and a refused remote
command keeps its reason.

The T3Code adapter registers a missing repository project through the
`projects.mutate` RPC with a `project.create` mutation — the route the shipped
nightly actually implements — instead of a `project.create` command inside
`orchestration.dispatchCommand`, which the nightly's command union rejects
before any handler runs. Registration keeps its deterministic project and
command IDs, adopts a project that appeared after an unknown delivery, and
resends at most once with the recorded IDs so T3's command receipt answers
idempotently; an unknown intent recorded on the retired dispatch route resends
once on the new route. When the build's remote text names no known registration
method, the create stays unknown delivery carrying the repository path and the
manual setup steps as guidance; it is never marked refused on remote text.

Host delivery diagnostics now keep the bounded why behind a remote failure as
value-free facts only, with no remote text: the known remote error tag, a fixed
failure-shape name the adapter defines (`unknown_request_tag`,
`schema_missing_key`, `schema_expected`, `encoder_rejected`, `remote_failure`,
`project_mutation_failed`, `project_not_empty`, `scope_missing`), the ticket
exchange's HTTP status, and method and command names from the adapter's own
constants. A secret in any position of any remote failure retains nothing.
The manual-fix guidance is Nucleus-authored and names the repository path in
full, untruncated; only remote-derived fields are bounded.
