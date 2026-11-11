# Open questions

## Who may write host-wide settings?

Answered for `queue.capacity`: only the operator, from Settings. The rule and its
code are recorded in [contracts/service-boundary.md](contracts/service-boundary.md),
"Settings-only capacity writes (Tom, 2026-10-25)".

Short version: every caller of the catalogue — the Settings screen, the CLI and
any task session's shell — is the same uid as the service, so no caller identity,
hidden command or same-user credential separates them. Tom chose accident
prevention rather than an authority boundary (2026-10-25): Settings writes the
limits again, and the CLI and every ordinary agent route refuse with a plain
message. The service reads provenance from the transport — the Paseo plugin bridge
marks its forwarded frames, and `queue.capacity` is allowed only from that surface
— and records every applied change durably with its time, surface and the values
before and after. A same-uid process that deliberately writes the bridge frame is
not stopped; that limit is stated rather than claimed away. No install, no admin
rights and no host document are involved.

### Ruling: Settings-only capacity writes (Tom, 2026-10-25)

Tom chose "Settings-only, no admin (Recommended)": "Limits change only from the
Settings screen. The CLI and agent route refuses with a clear message, and every
change is logged. Stops accidents, needs no install, and Settings works again
right away. The admin-rights installer stays unused." This supersedes both the
design-only limit and the root-owned authority implementation below for
enforcement, and it is delivered: the #426 root-owned installer and document path
stay reviewed but unused and historical, and nothing on this host needs them.

The change log stays: every applied change is recorded and read through
`queue.capacity-state` by the CLI and agents. Settings has no view of it (Tom,
2026-11-08: "Drop the UI, keep the log").

### Ruling: build the root-owned authority design (Tom, 2026-10-25, superseded)

Tom answered decision `65843408-f4a1-4385-97c4-34816dabcb04` version 2 on
operator board: "A: Build the root-owned authority design; accept explicit
operator authorization for each capacity change".

That selected implementation of the #426 design: the root-owned host authority
document and writer, and the replacement of capacity autosave with explicit
operator authorization. The reviewed change delivered it — the verifier and
derive rule, the dispatch refusal, `queue.capacity-state`, the read-only Settings
section and the reviewed writer and installer artifacts — without installing
anything. Its consequence was that Tom could not change a limit from Settings
without a privileged host installation, which is what the Settings-only ruling
above replaced. The residual software-integrity limits and unused artifacts are in the
[Settings-only capacity writes](contracts/service-boundary.md#settings-only-capacity-writes-tom-2026-10-25) section of the service boundary.

### Ruling: design the enforced boundary first (Tom, 2026-10-25, superseded)

Tom answered decision `2b697ab7-b984-4ee9-9ab0-f38433a7aec5` version 2:
"A: Design an enforceable operator-only capacity boundary first (Recommended)".
That selected design work for `queue.capacity`, identifying a real operator trust
root unavailable to task shells, its transport and compatibility changes, and the
tests needed to enforce it. The design work happened (#426); the Settings-only
ruling above replaced its conclusion.

Other host-wide settings — the usage level, demand offsets, project dispatch
overrides, pool, profiles, availability, pause and budgets — are named as
residual scope and are not changed by any of this.

## May a Nucleus-launched agent shell carry the Effigy v2 admission opt-in?

Owner: operator. Source facts:
[specs/035-host-run-scheduler.md](specs/035-host-run-scheduler.md), "Reviewed
Effigy v2 custody protocol"; Effigy contract 049 "Reported custody protocol
(v2)" at `21aec07ce0`.

Nucleus's hook reports a workload's custody to Nucleus under the reviewed v2
protocol only when the heavy invocation sets `EFFIGY_ADMISSION_PROTOCOL=2`, and
Effigy refuses v2 for any durable run (`--run-id`, or a run inside a durable
parent tree) before the hook starts. The environment Nucleus merges into every
agent launch it creates is one object for all effigy calls in that shell, so
setting the variable there makes v2 the default for worker and reviewer work and
also refuses the durable route from those shells. Today's design injects
nothing, so v2 evidence exists only for invocations an owner opts in by hand —
which means no worker run gains foreground custody evidence without that
practice.

The choice: (A) set `EFFIGY_ADMISSION_PROTOCOL=2` in
`queueOwnedAdmissionEnvironment` for the launches Nucleus creates, accepting that a
durable `--run-id` invocation in those shells refuses before the hook, a nested
heavy run under the shell's own live host run refuses too, and each must clear
the variable for itself; (B) keep injecting nothing, so v2 evidence stays opt-in
per invocation and Nucleus's own launches never report custody; or (C) ask the
producer for a protocol selection that carries both classes in one environment,
which is Effigy's contract to change. Any of the three leaves the admission
reservation, capacity and accounting rules as they are; only A gives the
foreground terminal record and the accepted-risk release the coverage they need
for ordinary worker runs.

Answered questions are recorded in their owning knowledge files.


## How does a renamed repository keep its Nucleus history?

Answered for Nucleus by [Spec 056](specs/056-repository-namespace-rekey.md):
one operator-invoked, atomic, idempotent re-key moves a repository's *current*
records (settings, numbering, tasks, outcomes, leads, lanes, decision targets,
project membership, QA) to its new `owner/name`, while operation
payloads, hook events, host-run rows, retained shadow-journal history, receipts
and an outcome's proof keep the identity they were written under. Nothing is merged with
a repository that later claims the old name, and no old-origin redirect survives.

### Ruling: Full swap after Nucleus fix (Tom, 2026-10-20)

Tom chose "Full swap after Queue fix": archive the desktop repository now, and
perform the full name swap only after Nucleus re-keying ships, so each repository's
history moves with it. The desktop `inflatable-cookie/project-d` (already archived
on GitHub) becomes `inflatable-cookie/project-d-desktop`, and the CLI
`inflatable-cookie/project-d-cli` then becomes `inflatable-cookie/project-d`. CLI
#015 was still in flight when the ruling was made. The ruling settled the sequence
and the naming, not a live migration: the re-key capability, its review and its
delivery are ordinary Nucleus work, and the live GitHub and Nucleus steps are a later,
separately coordinated operation once the CLI work is quiet. The exact operator
order and quiescence gates are in Spec 056.

## Should Nucleus prepare declared bundles in task checkouts?

A Nucleus-created checkout has no `.effigy` state, so a repository whose composed
manifest declares a remote `[bundle]` refuses every selector until a worker runs
`effigy bundle sync` under a brief that authorises it. An opt-in Nucleus
preparation pass was designed and deferred (Tom, 2026-10-24: Effigy primitive
first; keep explicit per-brief manual preparation meanwhile). The design is in
Git history of the [orchestration contract](contracts/orchestration.md),
section "Proposed: opt-in declared bundle preparation (not implemented)"
(removed 2026-10-31). Open: whether to admit it once the primitive below
exists, and by which authorisation carrier.

## What must an Effigy prepare-if-needed operation provide?

The deferred bundle preparation waits for an Effigy operation that is a
network-free no-op on a current checkout, reports a settled outcome, and
recovers an unsettled attempt itself. No producer task exists. The required
surface and the integration readiness criteria are in Git history of the
[orchestration contract](contracts/orchestration.md), section "Producer
requirement: an Effigy prepare-if-needed operation" (removed 2026-10-31). Open:
whether Effigy takes it on, and in which contract.

## Paseo split step 4: two decisions (answered, 2026-11-08)

Tom took both recommendations ("Go with your recommendations"): a 10-minute
and daemon shutdown grace. The rulings
live in [vision.md](vision.md), "Split details". Restarts that touch only the
Nucleus service are the planner's to schedule.
