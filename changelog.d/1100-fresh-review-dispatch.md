A task awaiting review now dispatches its reviewer past a finished recovery
run whose thread still shows a live turn: a run with a recorded completion is
finished work, so the participant lease no longer gates a dispatch on it, and
what remains uncertain about it keeps its own visible fences. When a dispatch
really is held by a busy participant, the wait names the run and agent that
still own work and the verbs that exit it — in `next` and in the accepting
restart or move-to-review reply — instead of reporting success while nothing
launches.
