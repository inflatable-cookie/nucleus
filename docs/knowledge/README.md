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
| Code-module quality ratings and the floor target | [quality/code/](quality/code/README.md) |
| Open questions | [questions.md](questions.md) |

Product documentation lives outside `docs/knowledge/`:

| Product docs | Location |
| --- | --- |
| Project front page: what Nucleus is, install, getting started | [README.md](../../README.md) |
| The Nucleus skill for planners and workers | [skills/nucleus/SKILL.md](../../skills/nucleus/SKILL.md) |

Nucleus reads pre-v5 control manifests (v1–v4) for consumer repositories whose
hook schemas predate brief mode; brief tasks refuse them. A Queue-held brief is
the only instruction route; committed handoffs are retired (nucleus#1368).
