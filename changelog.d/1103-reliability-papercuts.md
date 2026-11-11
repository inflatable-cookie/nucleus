A reviewer verdict refused for a malformed `reviewedInputs` entry no longer turns
into a planner escalation. The refusal names the exact entry, field and expected
shape, so the reviewer corrects that field and resends the same verdict in the
same turn; the reviewer prompt and the `nucleus_report` tool say the same thing.
Harmless duplicate entries (the same reading recorded twice) are de-duplicated
instead of refused, while two entries that claim different digests for one path
still refuse and name both.

An escalation whose delivery is unknown is still never resent, but once it
outlives the stall threshold the task surfaces as visible attention instead of
waiting invisibly with owner "queue": `next` and the board name the owner, the
question and the exits (answer by `question.answer`, an ordinary owner verb, or a
fresh question ID after the operator or planner confirms it was not seen), and
the project planner receives exactly one agent-channel message about it.

Extending a budget — through `extend_budget` or the board's budget answer — now
supersedes every recorded budget question for the task and dismisses the ones
still pending on the worker thread through the host. A superseded Nucleus
question no longer holds a turn, so launches no longer decline with "retained
worker still owns its turn: pending question" until someone answers by hand.
