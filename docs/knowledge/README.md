# Knowledge index

Every topic has exactly one owning file. Link to it; don't restate it.

| Topic | Owner |
| --- | --- |
| Vision and non-goals | [vision.md](vision.md) |
| System shape: modules, trust boundaries, runtime | [architecture.md](architecture.md) |
| Durable rules | [contracts/](contracts/README.md) |
| Detailed design per capability, with acceptance oracles | [specs/](specs/README.md) |
| Local staging, release and recovery authority | [contracts/release.md](contracts/release.md) |
| Report-only milestone QA and its delivery record | [contracts/milestone-qa.md](contracts/milestone-qa.md) |
| Restore a verified store snapshot | [operations/restore.md](operations/restore.md) |
| Historical TypeScript store compaction | [operations/store-compaction.md](operations/store-compaction.md) |
| Unexpected child termination: retained evidence and the attribution gap | [operations/unexpected-child-termination.md](operations/unexpected-child-termination.md) |
| Historical TypeScript module quality ratings and their rubric | [quality/code/](quality/code/README.md) |
| Open questions | [questions.md](questions.md) |

Product documentation lives outside `docs/knowledge/`:

| Product docs | Location |
| --- | --- |
| Project front page: what Nucleus is, install, getting started | [README.md](../../README.md) |
| Rust installation, board pairing and T3 setup | [engine/README.md](../../engine/README.md) |
| The Nucleus skill for planners and workers | [skills/nucleus/SKILL.md](../../skills/nucleus/SKILL.md) |

For approval and task admission, see the [held brief and instruction contract](contracts/orchestration.md#submission-and-instruction-source).
[Spec 070](specs/070-small-engine.md) governs the Rust engine. Use older specs
as design and migration evidence for their original implementations.
