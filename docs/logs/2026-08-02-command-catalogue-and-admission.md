# Command Catalogue And Admission

Date: 2026-08-02
Roadmap: `g05/012-command-catalogue-keymaps-and-palette.md`
Card: `g05/batch-cards/036-command-catalogue-and-admission.md`

## Outcome

Nucleus now has one sealed Longhorn command registry generation containing 26
semantic shell, project, thread, panel, editor, Forge, and Agent Chat actions.
The catalogue uses a rooted context tree, explicit capabilities, coded product
availability, and opaque product routes distinct from command and transport
identity.

Each availability projection or execution loads one fresh Nucleus-owned state
snapshot. Execution reruns Longhorn admission, then maps the admitted route to
one typed Nucleus executor call. Stale registry generations, unknown commands,
invalid arguments, missing capabilities, and changed product state fail before
product execution.

The renderer host is deliberately deferred to the keymap and palette batches.
No generic command-to-Tauri bridge was added. Component-local editing, IME,
accessibility, and data-bound row actions retain local ownership.

## Evidence

- four focused desktop command fixtures pass
- `effigy check:rust` passes
- docs and Northstar checks pass
- Doctor retains the existing repository structural error set; the new command
  modules add no Doctor findings after the catalogue and availability split
- the Longhorn consumer replay is blocked by unrelated dirty
  `packages/settings/src/poodle/SettingsShell.svelte` and
  `packages/settings/tests-svelte/shell.test.ts` files in the Longhorn worktree
- no authenticated provider work ran

## Next

Execute card 037. Add sparse keymap persistence, platform-aware physical-key
resolution, explicit conflicts, and reset without copying the default map.
