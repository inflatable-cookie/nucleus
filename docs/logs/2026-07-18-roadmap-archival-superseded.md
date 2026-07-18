# Roadmap Archival Superseded

Date: 2026-07-18
Lane: g04 roadmap residue archival (milestone 048 closeout)

## Outcome

Operator decision: closed-generation batch cards stay where they are.
Milestone 048 and cards 218/219 are superseded without execution.

Reasoning:

- the cards are contained in closed `gNN/` directories and correctly
  indexed; nothing spills into the active planning surface
- they are validation evidence: batch cards hold the only record of what
  was manually verified per batch, and deferred-lanes return-refs point
  into them by doctrine ("keep old cards as evidence")
- the audit measured volume (2,019 files, 8.4MB), not harm — unlike the
  nucleus-server vocabulary sprawl, which sat in live code paths and
  multiplied every change, these files are inert
- docs QA does not crawl them, size is trivial, and git retains them
  regardless; the only real friction is repo-wide search noise, and the
  right fix for that is a search-tool exclude, not moving ~1,900 files

## Evidence

- audit finding re-examined against actual costs; no tooling or QA
  currently pays for the files' presence

## Next

Card 214 (adapter-trait routing and server facade) is the last open work
in the audit hardening band.
