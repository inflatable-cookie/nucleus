Milestone QA is now an ordinary report-only Nucleus task pinned to one commit,
and the managed launch is retired: `project.qa.run` (including `--wait`) refuses
with the recipe named, and `repository.set` refuses enabling or replacing
`qa.schedule` while still accepting `{"qa":{"schedule":null}}`. A repository that
still has a schedule records one durable notice pointing at the recipe instead of
admitting a run. Runs admitted before the cutover keep settling and stay readable
through `project.qa.get`, `project.qa.list`, `project.qa.cancel`,
`project.qa.dismiss` and `project.qa.retry-teardown`; nothing is orphaned,
replayed or rewritten. The new [milestone QA contract](docs/knowledge/contracts/milestone-qa.md)
holds the report-only recipe, the consumer inventory and the order for removing
the supervisor, QA-only scheduling and storage.
