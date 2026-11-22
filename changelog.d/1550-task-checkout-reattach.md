A follow-up review round no longer leaves the shared task checkout detached:
it reads its exact head in the task checkout on its own branch, so the worker's
branch and checkout stay usable whatever happens to the round. One reattach step
returns a checkout an earlier round already left detached to its task branch
before any launch, in `run.start` and in `run.release`, and only when no
unreleased round owns it, the tree is clean and HEAD already equals the branch
tip, so no commit ever moves. A dirty, moved or still-owned detached checkout is
left alone and the command names why, with `run.release` then `run.start` as the
exit.
