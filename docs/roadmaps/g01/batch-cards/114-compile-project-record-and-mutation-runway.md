# 114 Compile Project Record And Mutation Runway

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Turn the project switcher blocker into a bounded implementation runway.

## Scope

- Check project identity contract coverage.
- Decide whether first display records use a control DTO, projection fixture,
  or storage codec.
- Decide whether local project data should enter through seed data or create
  command execution first.
- Produce the next few implementation cards.

## Out Of Scope

- Implementing project storage codecs.
- Implementing project creation.
- Implementing desktop project switcher UI.

## Promotion Targets

- `docs/roadmaps/g01/013-project-state-records-and-switcher-readiness.md`
- `docs/roadmaps/g01/batch-cards/README.md`
- `apps/desktop/README.md`

## Acceptance Criteria

- [x] First project display-data path is chosen.
- [x] First project record write path is chosen.
- [x] Next implementation card is narrow and executable.
- [x] TypeScript project authority remains out of scope.

## Decision

First project display-data path:

- add a Rust-owned JSON storage codec for the first project record shape in
  `nucleus-projects`
- keep storage payloads opaque at `nucleus-local-store`
- expose display-ready project fields through a server control DTO/projection,
  not by asking TypeScript to decode raw storage bytes

First write path:

- use server-owned local seed data before full project-create command DTOs
- seed data is for local/bootstrap readiness only
- full project creation UI and command DTOs remain deferred until the switcher
  can render real records

## Next Implementation Card

`115-add-project-record-storage-codec-or-fixture.md` should implement the codec
and display projection first. It should not add desktop project UI or project
creation commands.

## Validation

```sh
effigy qa:docs
effigy qa:northstar
```
