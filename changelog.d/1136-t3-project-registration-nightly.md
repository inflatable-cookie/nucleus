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

Host delivery diagnostics now keep the bounded why behind a remote failure:
only demonstrably safe shapes survive — a whitelisted error tag (alone or
beside the handlers' fixed wire messages), a decoder defect in the nightly's
own post-value-dropping shape, or the ticket exchange's HTTP status. Arbitrary
remote text, including any unquoted secret it carries, retains nothing; the
configured bearer is stripped first and delivery classification is unchanged.
Nucleus-authored remediation rides a separate bounded guidance field, so a
long repository path can never cut off the manual setup steps.
