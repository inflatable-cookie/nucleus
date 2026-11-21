Removed the retired managed milestone QA launch and schedule controls from the runs surface, QA cards, and Settings:

- Removed the **Run QA** button, project picker modal, and `QaRunCard` **Re-run** launch control while presenting the shared run list as **Runs** and keeping non-QA host runs, legacy managed QA history, and legacy `Cancel QA`, `Dismiss`, `Retry teardown`, and `Release capacity` controls accessible.
- Removed the milestone QA schedule (`Schedule`, `After N merges`) and milestone `Timeout` controls from **Settings → Projects** while keeping ordinary task **Merge check** validation, the `QA` worktree-validation command setting (`qa.argv` / `qa.stages`), and the `repository.set` `{"qa":{"schedule":null}}` compatibility path for clearing a stored legacy schedule.
- Updated Planning's empty-QA copy and the milestone QA / UI contracts and skill guidance to point to the ordinary report-only task recipe instead of launching from the board.
