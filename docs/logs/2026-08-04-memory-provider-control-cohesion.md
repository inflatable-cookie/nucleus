# Memory Provider Control Cohesion

Date: 2026-08-04
Roadmap: `../roadmaps/g05/023-memory-provider-and-advanced-control-cohesion.md`
Cards: 073-075

## Result

Nucleus now owns one truthful provider-selection path without inventing a
second provider vocabulary.

- the runtime registry assembles Swallowtail's configured-provider-instance
  catalogue and retains the matching Nucleus runtime binding
- the server projects safe instance identity, readiness, credential posture,
  and bound model data; credentials and native payloads do not cross the boundary
- defaults and live sessions carry exact instance, revision, facade, optional
  provider, model, reasoning, harness, and resource identity
- changing immutable route identity opens a fresh session and preserves the
  existing conversation transcript
- model and reasoning options stay scoped to the selected provider instance
- one ready provider remains quiet; two or more ready providers expose the
  same explicit selector in Settings and Agent Chat
- not-ready instances remain visible but cannot be selected
- provider technical evidence is disclosed on demand; credential, destructive,
  diagnostic, and low-frequency controls keep their deliberate product owners

## Evidence

- configured-catalogue and immutable-route Rust fixtures pass
- settings default persistence and reset pass
- accepted Memory survives a backend close and reopen without projection drift
- provider selection Bun fixtures pass
- mounted Settings and Memory project-switch fixtures pass
- Svelte check, desktop build, and Rust workspace check pass
- docs QA, Northstar QA, Rust formatting, and diff hygiene pass

The existing ProjectRail accessibility warning, unrelated Rust test-import
warnings, and Doctor oversized-file findings are unchanged. No authenticated
provider or credential effect ran.

## Remaining Boundary

The current runtime registry has one ready Codex instance. Multi-provider UI
behavior is deterministic fixture evidence until more Swallowtail-backed
runtimes are registered. Authenticated provider and credential acceptance keeps
its separate operator gate.
