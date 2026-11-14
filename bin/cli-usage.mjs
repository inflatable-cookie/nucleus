// The CLI's usage text: one owner for what each method and flag does.
//
// It is data, not logic, and it is the only place the method list, the snapshot
// paging rule, the retired-adoption note and the board-link explanation live.
// queue-cli prints it verbatim for --help/-h.

export const usageText = `Usage: node bin/queue-cli.mjs [--via-paseo] <method> [- | payload.json] [--wait]

Calls one Nucleus service method with a JSON payload. Pass - to read it from stdin
(the default route: no shared temporary files), a path to read a file, or nothing
for {}. A heredoc avoids shell quoting:
  node bin/queue-cli.mjs plan.get - <<'JSON'
  {"repository":"owner/name"}
  JSON
Methods without a dot are tried as queue.<method> first, for example:
  snapshot, detail, telemetry, outcome, outcome-search, task, next, operation-start,
  operation-status, capacity-state, lanes, lane.upsert, lane.status, projects, project.upsert,
  project.get, project.settings, project.park, project.unpark, project.remove, project.removal-blockers, project.qa.run, project.qa.cancel, project.qa.dismiss, project.qa.retry-teardown, project.qa.get, project.qa.list, repositories, repository.set, repository.get, repository.rekey-preview, repository.rekey, repository.rekey-receipt, papercut.add, papercut.list, papercut.get, papercut.edit, papercut.promote, papercut.promote-task,
  papercut.close, papercut.set-lanes, lead.add, lead.edit, lead.get, lead.version,
  lead.list, lead.set-lanes, lead.set-tags, lead.drop, lead.reopen, lead.promote, lead.check, lead.approve, lead.promote-task, lead.submit, lead.import,
  decision.add, decision.get, decision.list, decision.answer, decision.withdraw, decision.link, decision.supersede, queue.routing-grant, lane.document.get,
  lane.document.edit, plan.get, plans, plan.set, backup.now, backup.list, usage.state
snapshot accepts optional repository, project, limit (default 100, max 250) and
cursor; page while hasMore is true. An oversized snapshot is refused with those
filters named instead of a closed socket.
project.qa.run --wait returns the settled run, exitCode, failureIndexes and failuresLogPath.
lead.submit submits an authorized brief through check, approval and promotion in one call.
next (task.next) takes a taskId or a reference such as owner/name#12 and reads
what steers the task: phase, active run, PR head, the current stop or wait,
holds, and every owner verb with prefilled arguments and its refusal. Run next
first, then call task with the listed args plus the reason or instruction it
asks you to fill.
Task IDs also accept references such as nucleus#1070. Task owner verbs may omit
version, optionally fence an observed phase, and return the changed field names.
Queued next offers set_dependencies; its dependsOn list accepts references too.
capacity is not a CLI route: only the operator changes dispatch limits, in
Settings, and a CLI call refuses without changing anything. capacity-state reads
the values in force and the recorded changes; do not retry a refused write.
ui prints a link to the local board (127.0.0.1 only; the token rides in the link's
fragment and expires after 8 hours). ui opens it in the browser (use --no-open to print only), and
ui --revoke revokes every outstanding link. A link is the operator's board access,
so do not paste it into a shared log or prompt.
--via-paseo routes through the Paseo bridge (needed for bridge-only methods such as service-state).
See README.md "CLI methods" and the nucleus skill for payload shapes. Only the
"nucleus" skill is installed; the retired "northstar-queue" name survives in
submitted handoffs, which may still carry it in queue_dispatch.`;
