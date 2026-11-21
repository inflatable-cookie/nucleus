Repository hooks now have a neutral documented path: a manifest at
`.nucleus/queue.json` with `nucleus.queue.*` schema names, hook executables under
`.nucleus/hooks/`, and `NUCLEUS_QUEUE_EVENT_ID` and `NUCLEUS_QUEUE_EVENT_SCHEMA`
for the event a hook receives. Committed `.paseo/queue.json` manifests keep working
unchanged, with their `paseo.queue.*` names and `PASEO_QUEUE_EVENT_*` variables.
A repository that commits both manifest locations is refused until it keeps one,
and each manifest's schema must be spelled in its own location's family. Pending
hook occurrences keep the spelling they were delivered in.
