# 115 Add Project Record Storage Codec Or Fixture

Status: done
Owner: Tom
Updated: 2026-06-17

## Goal

Make server-owned project records display-ready without involving desktop
authority.

## Scope

- Add a Rust-owned JSON codec for the first project record shape.
- Add a server-owned display projection/DTO for project list records.
- Preserve stable project identity fields.
- Keep storage payloads server-owned.

## Out Of Scope

- Desktop project switcher.
- Project creation UI.
- Repo membership editing.

## Promotion Targets

- `crates/nucleus-projects`
- `crates/nucleus-server`
- `docs/architecture/system-inventory.md`

## Acceptance Criteria

- [x] Server can expose display-ready project fields for stored project
  records.
- [x] Tests prove ids, display names, status, and importance are preserved.
- [x] No TypeScript project authority is introduced.

## Notes

- Added a Rust-owned JSON project storage codec in `nucleus-projects`.
- Added `ProjectRecords` response DTO shape in `nucleus-server`.
- `nucleus-local-store` still stores opaque bytes.
- Desktop TypeScript only names the response DTO shape; it does not decode raw
  project storage payloads.

## Validation

```sh
cargo test -p nucleus-projects -p nucleus-server
```
