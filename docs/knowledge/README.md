# Knowledge index

Every topic has exactly one owning file. Link to it; don't restate it.

| Topic | Owner |
| --- | --- |
| Vision and non-goals | [vision.md](vision.md) |
| System shape: modules, trust boundaries, runtime | [architecture.md](architecture.md) |
| Durable rules | [contracts/](contracts/README.md) |
| Detailed design per capability, with acceptance oracles | [specs/](specs/README.md) |
| How the plugin is rolled onto the live checkout | [contracts/release.md](contracts/release.md) |
| Restore a verified store snapshot | [operations/restore.md](operations/restore.md) |
| Compact the store: the one-shot conversion and bounded freed-page maintenance | [operations/store-compaction.md](operations/store-compaction.md) |
| Unexpected child termination: retained evidence and the attribution gap | [operations/unexpected-child-termination.md](operations/unexpected-child-termination.md) |
| Retired concepts | [retired.toml](retired.toml) |
| Open questions | [questions.md](questions.md) |

Product documentation lives outside `docs/knowledge/`:

| Product docs | Location |
| --- | --- |
| Operator and API guide, CLI methods, retention | [README.md](../../README.md) |
| The Nucleus skill for planners and workers | [skills/nucleus/SKILL.md](../../skills/nucleus/SKILL.md) |

Nucleus implements the legacy Northstar handoff protocol (committed handoffs,
v1–v4 manifests, lifecycle hooks) for consumer repositories that still use it.
Those paths and terms are product in this repository's code, specs and skill, not
process records.
