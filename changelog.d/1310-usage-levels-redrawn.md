# Usage levels are low, normal, high, extra high and maximum

Spec 052's usage level now says plainly where a task's worker starts, when it
climbs, and what needs the operator's permission (Tom, 2026-11-17).

- **The levels** are `low`, `normal` (default), `high`, `extra_high` and
  `maximum`. `minimal` is removed; a stored `minimal` reads as `low`, and
  `normal`, `high` and `maximum` are unchanged. The live `high` setting stays
  `high`.
- **Start tier** (`low` one tier below every complexity; `normal` one below high
  and very-high complexity only; `high` and `extra_high` at the requested tier;
  `maximum` on very-high or frontier models for workers and reviewers). When a
  review asks for changes, the next worker run climbs one tier, capped at the
  task's requested tier.
- **Permission** is about the capability tier, not cost: the top two tiers
  (very-high and frontier) need a board sign-off at `low` and `normal` except
  the recorded climb back to the task's own requested tier, frontier needs one at
  `high`, and `extra_high` and `maximum` need none. Submitting a high or
  very-high complexity task at `low` opens one board decision and holds the task
  until it is approved; the gate is decided at admission, so a later level change
  never holds work that was already accepted, and it never replaces an existing
  board hold.
- Coordinator and recovery offsets are unchanged under every level, including
  `maximum`; reviewers keep independence and at least the worker's actual
  profile tier, so a retained reviewer below a climbed worker is replaced, and
  no weaker reviewer stands in when none reaches that tier.
- Settings slider labels, `queue.usage`, `routingPolicy`, the board's profile
  tags and explanations, Spec 052, Spec 053 and the Nucleus skill describe the
  new rules; the profile editor no longer mentions a cost ceiling.
