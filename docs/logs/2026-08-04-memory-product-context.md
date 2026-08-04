# Memory Product Context

Date: 2026-08-04
Roadmap: `../roadmaps/g05/023-memory-provider-and-advanced-control-cohesion.md`
Cards: 071-072

## Result

Memory now presents useful project context without widening its authority or
leaking sensitive content.

- public-project and internal-project records expose bounded stored title and
  summary fields
- user-private, secret-adjacent, and restricted records omit content and carry
  explicit redaction
- detail, review notes, raw sources, and provider material remain outside the
  list projection
- accepted and proposed records remain separate and read-only
- the panel leads with readable context; ids, actor refs, retention, counts,
  and supersession stay behind Details
- the tab title remains the sole Memory title

## Evidence

- focused accepted-memory, proposal, response DTO, and binding fixtures pass
- 288 TypeScript binding exports pass
- 49 Bun tests and 19 mounted Vitest tests pass
- 11 native panel guards pass
- Svelte check and desktop build pass
- Rust workspace check passes

The existing ProjectRail accessibility warning and Doctor structural findings
are unchanged.
Scoped Nucleus formatting and diff hygiene pass. Workspace-wide formatting is
blocked by three pre-existing Longhorn path-dependency test-file diffs; this
lane did not edit Longhorn.

## Provider Checkpoint

Nucleus still has one local Codex provider summary. Swallowtail provides exact
prepared facades and model/session catalogues but deliberately no portable
configured provider-instance catalogue or provider router. Card 073 is paused
instead of inventing route identity, readiness, or credential state in Nucleus.
