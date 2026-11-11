# 004 - Trusted host hook runners

Status: retired (2026-11-08). Host tools remain available without an approval registry; see the repository-hooks contract.
Owner: operator and Chatterbox
Created: 2026-09-13
Governing refs: `docs/knowledge/contracts/orchestration.md`,
`docs/knowledge/contracts/repository-hooks.md`,
`docs/knowledge/specs/001-generic-repository-hooks.md`
Execution: g01.013 authorized by Tom on 2026-09-13

## Problem

The v1 control manifest can execute only a repository-relative executable blob.
A repository that needs a trusted host tool must commit a launcher or copy
runtime code. That prevents the host tool from being the declared executable
and spreads lifecycle plumbing into consumer repositories.

Nucleus needs a generic runner identity that a repository may select without
letting that repository choose an absolute path, search `PATH`, interpolate
event data, or authorize host software.

## Outcome

`paseo.queue.control.v2` adds a strict program union. A hook selects either a
committed repository executable or an operator-approved trusted host runner.
The host resolves runner identity to an immutable Nucleus-owned executable
artifact. Nucleus pins that artifact at event intent and executes it directly
with literal arguments and `shell: false`.

All existing hook event, result, delivery, isolation, publication, closeout,
timeout, output, retry, and reconciliation behavior remains unchanged. Nucleus
does not learn the document system or command carried by a runner's arguments.

## Manifest v2

A v2 hook replaces the v1 `executable` and `argv` pair with one `program`.

Repository program:

```json
{
  "program": {
    "kind": "repository",
    "executable": ".paseo/hooks/repository-lifecycle",
    "argv": []
  }
}
```

Trusted host program:

```json
{
  "program": {
    "kind": "trusted_runner",
    "runner": "project-tool",
    "argv": ["check", "--stdio", "passthrough"]
  }
}
```

Rules:

- `program` is a closed discriminated union. Fields from the two variants may
  not be mixed, and a v2 hook may not also declare top-level `executable` or
  `argv`.
- Repository executables retain the v1 normalized path, regular executable
  blob, commit, digest, symlink, reserved-path, and allowed-path rules.
- Runner IDs match `[a-z][a-z0-9-]{0,62}`. The manifest contains no runner path,
  digest, version, environment, host, or installation hint.
- Arguments retain the v1 limit of 32 literal NUL-free UTF-8 values of at most
  1 KiB each. Nucleus performs no variable, template, event, environment, shell,
  path, or command interpolation.
- All other hook fields and closed-schema validation remain v1-equivalent.

The v1 schema remains frozen and accepted. Nucleus normalizes its top-level
`executable` and `argv` into an internal repository program. A v2 manifest may
use either program kind. Manifest absence remains compatible.

## Trusted runner approval

Runner configuration is host-local operator state outside repositories and the
live task database. One approved revision contains:

```json
{
  "id": "project-tool",
  "enabled": true,
  "sourcePath": "/absolute/canonical/path/to/tool",
  "approvedDigest": "sha256:64-lowercase-hex",
  "versionLabel": "operator-visible label"
}
```

Registration and update require a trusted plugin operator action. Nucleus:

1. requires an absolute canonical path and rejects a missing path, directory,
   special file, symlink, non-executable file, unexpected real path, or digest
   mismatch;
2. opens and hashes the regular file rather than trusting its name or reported
   version;
3. copies the verified bytes from that same open descriptor into a Nucleus-owned
   private content-addressed executable store, atomically publishes the artifact,
   and re-hashes it;
4. records a new immutable approval revision with runner ID, host ID, digest,
   size, mode, OS, architecture, source path, version label, artifact identity,
   approval time, and enabled/revoked state; and
5. makes that revision active for new event intents only after the durable
   configuration write succeeds.

The private artifact directory is owner-only and outside repositories. A
repository cannot name it. A source-path replacement, `PATH` change, symlink
retarget, or later installation update cannot change the approved bytes.

The executable digest is authority. `versionLabel` is optional audit metadata;
it may be displayed and pinned with the record but never satisfies or overrides
a digest check. Nucleus does not invoke a generic version command.

## Event pin and runner updates

A trusted-runner hook record persists:

```text
program kind, runner ID, host ID, approval revision
executable digest, size, mode, OS and architecture
version label and content-addressed artifact identity
literal argv
```

Runner resolution completes before process intent. Unknown, disabled, absent,
revoked, corrupt, host-mismatched, or artifact-mismatched runners start no
process and produce no repository effect. The hook failure remains visible.
Required delivery holds; advisory delivery may advance only through the
existing proof that no effect occurred. An unavailable required integration-
write closeout runner does not change closeout authority or permit fallback.

An approved binary update creates a new revision for new occurrences. Pending
occurrences retry with their original content-addressed artifact and never
silently repin. Disabling the active revision prevents new occurrences while
existing pins remain executable. Explicit revocation of a runner or digest also
blocks pinned retries and raises attention before execution.

Nucleus pins the executable file at the same boundary as a repository-local hook
blob. Dynamic libraries, interpreters, files read by the program, and programs
resolved by a trusted runner remain that runner's responsibility.

## Execution and portability

Nucleus spawns the pinned private artifact by absolute path with `shell: false`,
the event checkout as `cwd`, the existing minimal environment, and the exact
literal argument vector. It writes the existing event JSON bytes to stdin and
closes stdin. Stdout and stderr remain separate bounded byte streams. The
runner must pass the hook result through stdout without an envelope or log
prefix; diagnostics belong on stderr.

Non-zero exit, signal, timeout, output overflow, malformed result, wrong event
ID, or repository mutation follows the existing hook failure and uncertainty
rules. Read-only snapshots and isolated integration-write publication are
identical across program kinds.

Manifests are portable because they name only a runner ID. Each host separately
approves its artifact. A missing mapping fails before execution. A persisted
occurrence remains bound to its original host and cannot move because another
host defines the same runner ID.

## Migration

- Keep v1 parsing and serialized fixtures unchanged.
- Add v2 beside v1; do not reinterpret unknown v1 fields.
- Migrate existing durable hook records to the internal repository-program
  form during the next schema migration after g01.012.
- Default trusted-runner configuration to empty and preserve tasks, hook
  occurrences, settings, pool, availability, limits, pause state, and notices.
- Do not rewrite an existing event ID, payload, attempt, executable pin, or
  closeout authority.

## Acceptance matrix

| Invariant | Counterexample | Required proof |
| --- | --- | --- |
| Repository cannot authorize host code | Manifest supplies an absolute path, digest, PATH name, or mixed program | Strict v2 schema negatives |
| Digest is authority | Matching version label accepts changed bytes | Changed-byte rejection with the same label |
| Spawn uses pinned bytes | Approved source or PATH changes after registration | Captured content-addressed spawn path and digest |
| Retry is stable | Binary update silently moves a pending event | Old occurrence uses old artifact; new event uses new revision |
| Revocation wins | Revoked digest runs from cache | Pre-spawn revocation refusal and visible attention |
| No interpolation | Event title or argv shell syntax changes the command | Hostile literal argv and environment fixtures |
| Host binding holds | Same runner ID on another host resumes an event | Host-ID mismatch refusal |
| Hook semantics match | Trusted runner bypasses lifecycle gates | Shared program-kind lifecycle matrix |
| Nucleus stays generic | Core embeds consumer vocabulary or commands | Synthetic runner fixture with opaque arguments |

Focused tests also cover v1 compatibility; v2 repository programs; absent,
unknown, disabled and corrupt artifacts; source and symlink replacement;
non-regular and non-executable files; approval-time copy verification; OS and
architecture diagnostics; raw stdin/stdout/stderr; exit, signal, timeout and
output limits; read-only and integration-write hooks; required and advisory
delivery; closeout authority; and restart at every durable hook state.

## Accepted Effigy interface

Effigy PR #104 is accepted on Effigy `main` at
`4f2b46613549341ced53449f80113da2bf763dea`, with implementation head
`26cf53506`. Without `--path`, `skill run` resolves a qualified selector from
the invocation project first and then a unique global skill install.
`--stdio passthrough` forwards raw stdin, stdout, stderr, and task exit status
without a presentation envelope and is incompatible with `--json`.

The first consumer selects trusted runner `effigy` with this exact opaque
literal argument vector:

```json
["skill", "run", "northstar/queue:hook", "--stdio", "passthrough"]
```

Nucleus neither interprets the selector nor supplies `--path` or `--json`. The
consumer repository owns the selector and lifecycle contract. Tom authorized
g01.013 implementation dispatch on 2026-09-13.

## Stop conditions

Stop if implementation needs repository-supplied host paths, PATH lookup,
shell execution, event interpolation, silent retry repinning, version labels as
authority, cross-host event migration, consumer-specific Nucleus vocabulary, or
weaker v1 delivery, isolation, publication, closeout, and reconciliation gates.
