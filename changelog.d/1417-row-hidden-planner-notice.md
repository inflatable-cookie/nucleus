A Nucleus task that stays hidden on T3 now tells its planner. A continuous
Nucleus-owned row snooze gets one notice after 30 minutes naming the task, its
age, its wait, its last transition and one supported action, and it says whether
the task is genuinely waiting or the row should already be visible. A task parked
behind an explicit hold gets one informational nudge after three hours of the same
hold generation, reusing a hold reminder that already reached that planner. The
notice is deduplicated per episode across sweeps, rolls, horizon renewals and owner
changes, an unreadable row is reported as unknown rather than clear, and nothing
here settles, releases, restarts or changes a hold.
