# 006 — Terminal closeout projection convergence

Status: implemented
Owner: Nucleus and repository lifecycle adapter maintainers
Updated: 2026-09-25
Governing refs: `docs/knowledge/contracts/repository-hooks.md`,
`docs/knowledge/specs/001-generic-repository-hooks.md`

## Problem

A successful `task.closeout` can publish a terminal lifecycle record and its
generated indexes while retaining an older task-local lifecycle marker. The
repository then has two status authorities. A later currentness audit reports
the duplicate even though main is clean and closeout itself succeeded.

The first accepted fixture is Market g05.064 and g05.065 after the g05.067
currentness repair. Closeout commits `2d436bb9a4084260150ceea45a6c6fd90b831f9c`
and `30f64ee34957c7b103e258359998037d1190cd9c` published terminal lifecycle state
but retained the task files' existing `Status: Ready` and
`Status: Ready after g05.064` markers. The installed currentness audit reports
exactly those two `duplicate-status-header` findings.

## Ownership boundary

Nucleus owns the durable closeout occurrence, isolated integration-write
checkout, exact changed-path publication, retry reconciliation and terminal
task transition. The selected repository hook owns the meaning and rendering
of its document system. Nucleus must not parse Markdown, recognize Northstar
status headers or infer task-file paths from titles.

A required integration-write `task.closeout` result is therefore one complete
repository projection transaction. The hook must replace every older
task-local lifecycle authority that its terminal projection supersedes in the
same result. It must declare every non-ignored changed path. Nucleus publishes
those exact paths or holds closeout.

## Required behaviour

- The repository adapter identifies the canonical task path from its pinned
  instruction and planning evidence before changing bytes.
- Terminal closeout removes or replaces only the adapter-defined superseded
  lifecycle marker. Human outcome, decisions, evidence and unrelated status
  prose remain byte-stable.
- The task file participates in the same atomic adapter operation as the
  terminal record, generated projection targets and handoff consumption.
- The operation is idempotent. Replaying an accepted occurrence produces the
  same bytes and no second marker, block or changed path.
- A missing, ambiguous, symlinked, changed or out-of-allowlist task path fails
  closed before publication. A status-looking line whose ownership is
  ambiguous is not removed.
- Required currentness validation runs against the complete prospective
  projection before the hook returns `ok`. A red result blocks closeout with
  bounded diagnostics.
- Nucleus retains its existing exact-path, allowed-path, staged-file, ignored
  artifact, commit, push and restart gates. No special document syntax enters
  Nucleus schemas or server code.

## Compatibility and recovery

This spec applies only to repositories that choose hook closeout. Nucleus closeout
never enters it: there is no closeout occurrence, isolated checkout or published
projection for Spec 006 to converge.

Repositories without a required integration-write closeout hook are
unchanged. Adapters without the convergence capability continue under their
pinned contract until their repository opts into the accepted adapter
revision; Nucleus does not silently reinterpret an old occurrence.

A consumer already left red by this defect needs a separate bounded repair of
the exact audit findings. The Nucleus change prevents later closeouts from
reintroducing them. It does not rewrite consumer history or broaden a repair
task's authority.

## Acceptance oracle

- A synthetic repository starts with one human task body and one
  adapter-owned pre-terminal marker. Closeout publishes one terminal record,
  all declared projections and the task-file replacement in one commit.
- The repository currentness oracle is clean immediately after closeout.
- Replaying the same closeout event is a byte-stable no-op.
- Two sequential closeouts after a currentness repair remain clean.
- An ambiguous status-like line, undeclared task path, changed planning blob,
  symlink, special file or unreported task-file mutation blocks publication.
- Nucleus's generic hook suites prove no document-system identifiers or parsing
  entered the core and all existing retry/reconciliation behaviour remains.

## Dependency

Execution needs an accepted Northstar lifecycle adapter revision that performs
the task-local replacement and prospective currentness check. The Nucleus lane
then pins that accepted interface, adds the generic integration fixture and
proves the configured trusted-runner path end to end. Until that revision is
available, g01.019 is approved planning but is not worker-dispatch ready.

Resolution (2026-09-25): the adapter revision landed as Northstar g03.021 and has
been installed since 2026-09-21. Tom closed g01.019 without a Nucleus lane, because
the fix lives in the adapter and Northstar Spec 042 retires hook closeout for
migrating repositories.

### Interface Nucleus requires from that adapter

Written so the dependency has a settled target rather than two parties guessing at
it. Nucleus requires the adapter, on `task.closeout`, to:

- **Replace, not append.** The task's own status marker is rewritten in place as
  part of publishing the terminal projection, so the task ends with exactly one
  lifecycle authority. A second authority beside the old one is the defect.
- **Publish atomically with the other declared paths.** The replacement and the
  adapter's other declared paths land in one commit; a partial publication is not
  an acceptable outcome.
- **Be byte-stable on replay.** Re-delivering the same event leaves the same bytes
  and adds no marker, so a retry after an operational hold cannot duplicate
  authority.
- **Refuse before any commit intent when it cannot tell an adapter-owned marker
  from human prose**, and on an invalid or ambiguous task path. Refusal is a
  finding for the task's coordinator, not a partial write.
- **Own the syntax.** The marker's shape, the matching rule and any escaping stay
  the adapter's business. Nucleus pins the adapter and its instruction artifact and
  never parses task Markdown, which is what keeps Nucleus document-system agnostic.

What Nucleus provides on its side, unchanged: occurrence identity, isolation in a
Nucleus-owned checkout, exact changed-path publication, durable intent before every
effect, and recovery for uncertain process, commit or push outcomes.

**What Nucleus pins.** For each new occurrence: the adapter commit, the exact
installed interface identity it was resolved from, the executable and instruction
artifact digests, the event and the clean base. Existing occurrence retries keep
whatever they were originally pinned to, so an adapter upgrade never reinterprets
an in-flight occurrence.

## Exclusions

Consumer-specific cleanup, Consumer-b product work, generation rollover,
general Markdown normalization, create-agent schema repair and heartbeat
control-plane work are outside this spec. The latter two remain separate
portfolio candidates.
