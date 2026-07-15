# Project Resource Mutations

Date: 2026-07-15
Lane: g04 multi-resource attachment and targeting

## Outcome

- closed the validated name-only project and lifecycle-control lane
- replaced the deferred repair-only command with one typed resource family
- added attach, update, locator repair, and membership removal actions
- detected plain folders and Git worktrees on the authoritative host
- assigned the first attached working resource as the quiet default
- retained stable resource ids, locator history, and repair notes across moves
- kept detach free of filesystem deletion or movement
- serialized the command family without exposing locators in project reads
- split persistence orchestration from resource mutation mechanics

## Evidence

- focused admission, control-envelope, persistence, detection, repair, and
  detach tests pass
- `cargo check -p nucleus-server` passes

## Next

Resolve filesystem panels and agent execution through explicit resource targets
or a truthful project default before exposing resource controls in the rail.
