# Nucleus — current state

Nucleus is implemented and in live use: a trusted local Paseo plugin and a
standalone service that own durable task dispatch, exact-head review, merge,
closeout and recovery for the operator's repositories. Every task runs the
responsible lifecycle — one worker, one retained reviewer, the planner ladder
and one retained recovery thread; the old coordinator lifecycle is deleted
(Spec 058 rollout step 4). It holds tagged leads (including papercuts), lanes,
projects and permanent outcomes, and is piloting Nucleus's
planning records.

## By topic

- Vision: [knowledge/vision.md](knowledge/vision.md)
- Architecture: [knowledge/architecture.md](knowledge/architecture.md)
- Contracts: [knowledge/contracts/](knowledge/contracts/README.md)
- Specs: [knowledge/specs/](knowledge/specs/README.md)
- Release: [knowledge/contracts/release.md](knowledge/contracts/release.md)
- Operator and API guide: [README.md](../README.md)

## What's next

The project's plan is in Nucleus: its lanes, their documents and their order. Read it
with `plan.get` (see the Nucleus skill, `nucleus`).
