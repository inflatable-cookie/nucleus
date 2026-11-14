Worker report intake and run result application are now separate owners, and the
rules they shared have one home each: report shape, the report-only gate, and
proof-execution settlement. Review entry reads one canonical pull request and
names its own refusal codes, and PR adoption picks its route from the task's
typed state. A checkout or PR-identity refusal is a typed error, so returning a
ready report to its worker no longer depends on matching its message text. No
product behaviour, contract or CLI change.
