### Changed

- A host going down or coming back now writes one outage record, not a record on every task (Spec 069 §3). The board card, `next`, task detail and the wall-time budget work each task's host wait out from that record when they are read, and the budget keeps a closed outage off the task's wall time.
- A task's stop is kept until its own writer clears it. A write that changes only the task's reason no longer erases it, so two writers can no longer rewrite the same task in turn.
- Settings and diagnostics that have not changed are no longer rewritten on every pass.
- The web board's live channel sends at most one board every half second; a burst of task changes reaches each open board as a few updates ending on the latest.
