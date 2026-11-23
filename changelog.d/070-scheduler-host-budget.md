The Rust engine now admits queued work locally during host outages. Running
tasks share T3 wake hints and use a slower exact-read backstop, and the
scheduler limits concurrent host calls and backs off on transport failures.
