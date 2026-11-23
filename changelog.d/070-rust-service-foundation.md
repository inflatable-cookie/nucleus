Version Rust task writes so a stale pass cannot apply an earlier decision.
T3 thread changes can wake a pass, and planner questions preserve their exact
queued delivery identity while the engine checks for a real turn start.
