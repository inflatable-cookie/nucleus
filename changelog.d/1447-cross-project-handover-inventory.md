A retiring planner can now read every unfinished task it still owns before it
hands its work on. `nucleus helper reparent --inventory AGENT_ID [--project PROJECT]`
lists those tasks grouped by project, with the named project's work separated from
the responsibilities outside it and a `remaining` count of what a project-scoped
handover leaves with the old thread, so work in another project is visible instead
of silently owned by a thread that has gone. The read uses the same verified caller
and thread identity as an owner change, writes nothing, sends no handover notice and
leaves independent holds alone; a missing or ambiguous identity and an unknown
project are refused, while an archived or gone old owner stays inspectable by the
operator.
