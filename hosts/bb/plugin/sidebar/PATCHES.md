The BB plugin and its validation selectors are retired under [Spec 070 ruling 5](../../../../docs/knowledge/specs/070-small-engine.md#rulings). The commands below record how the fork was checked while it shipped.

# The vendored thread list

Nucleus owns BB's sidebar by forking BB's own list (Spec 062, decision 5a: the
operator's option A). This directory is that fork: upstream's `app.tsx`, `app/`,
`shared/`, `server.ts`, its two app-level tests, `PLUGIN_OVERVIEW.md` and upstream's
`LICENSE`, kept as a thin patch set over a pinned release.

- Repository: <https://github.com/get-bb/bb>
- Tag: `desktop-v0.49.0`, commit `7b26cae79ec978fafd0a5db0e8517e94f12eb8f4`
- Upstream path: `plugins/thread-list`
- SDK floor: the list's own `engines.bbPluginSdk` (recorded in `UPSTREAM.json`)
- Registry items written into the plugin package: `components/ui/**`, `lib/**`,
  `hooks/**` (recorded in `UPSTREAM.json`)

`UPSTREAM.json` is the record every check reads: the pin, the release's SDK, a
SHA-256 per file exactly as the pin ships it, the patch set's touched files, the
files the patch set adds, the registry items, and upstream's forkable-list record.

## Licence

Upstream BB is MIT (root `LICENSE`, copyright 2026 Michael Yong); the plugin
directory carries no separate licence of its own, so `LICENSE` here is upstream's
root notice verbatim. `THIRD_PARTY_NOTICES.md` at the repository root names the
repository, the pinned commit, both vendored trees, that the files are unmodified
except where this file says otherwise, and that Nucleus's modifications are under
Nucleus's own terms. A rebase updates that section's commit and file list.

## The patch set: four seams, and nothing else

Each patch is one file under `patches/`, applied in name order onto the pin's
copy. A vendored file that needs a fifth change is a signal that the seam is
wrong: either the patch set grows deliberately with its reason recorded here, or
the change belongs upstream (Spec 062, decision 5f's exit path).

1. **`0001-task-group-header.patch` — `app/list/ProjectRow.tsx`.** The worktree
   group header. For a group whose environment the sidebar's batched read names,
   the name block renders the task's `#<number> <title>` and its state line; the
   group's collapse state comes from the fork's own `expandedTaskGroups`
   preference and its toggle writes that list. Every other group, and every group
   while inline rename is open, takes upstream's markup and upstream's
   `collapsedEnvironments` path unchanged. Reason: Spec 062 decision 5b — the
   header has to say what the task is doing, and a collapsed group is where the
   operator reads it. Phase 6 adds one line to each of the project row's two
   action menus (dropdown and context): the fork's `NucleusProjectBoardMenuItem`,
   which renders a "Board" link to the Nucleus project's board when the batched
   read names the row's BB project, and nothing otherwise (Spec 062, decision 5d).
   nucleus#1313 adds three things here. Where this row would render upstream's "No threads" and the
   project's own threads are all nested under another project's planner, it renders the fork's
   `NucleusNestedTaskPointers` instead — "1 task under <planner title>" on the planner's own route;
   a project with no threads anywhere keeps upstream's empty state. A Nucleus container has no
   action controls and reserves no slot for them (nucleus#1323), so its title and state line take the
   row's width; detach is BB drag and drop or the `detach` owner control. Upstream's are gone too: no "New thread in environment" (it would add a participant Nucleus
   does not know about), no Edit (it renames an environment the header no longer shows) and no
   Archive (it would archive live role threads behind Nucleus's back). Every ordinary worktree group
   keeps upstream's actions untouched.
   nucleus#1336: a collapsed container draws its roll-up (upstream's `experimental_resolveThreadStatus`
   over the hidden threads, drawn with `experimental_ThreadStatusGlyph`) in the leading icon slot in
   place of the folder, labelled with the status for assistive technology, and renders no trailing
   slot at all; its chevron reveals on hover or focus whether collapsed or expanded, and a click
   anywhere on the row toggles it. Upstream draws that roll-up absolutely positioned in the trailing
   slot, where it overlapped the chevron. A task the projection marks `attention` draws BB's
   needs-you glyph there even while its threads are idle, collapsed or expanded, since no thread row
   shows it; an unread failure keeps BB's precedence. The choice lives in the fork's
   `taskGroupLeadingStatus` (patch 3). An idle container keeps the folder. Ordinary groups keep
   upstream's markup.
2. **`0002-expanded-task-groups-preference.patch` — `shared/preferences.ts`,
   `app/preferences/atoms.ts`.** One preference key, `expandedTaskGroups`
   (environment ids). Reason: a task group is collapsed by default and its expand
   persists, while `collapsedEnvironments` keeps governing every other group, so
   each group class reads exactly one list and the two can never disagree.
3. **`0003-nucleus-task-groups.patch` — `app/list/nucleusTaskGroups.tsx` (new)
   and `app/list/nucleusTaskGroups.test.tsx` (new).** The batched read (`sidebarGroups`, one call for every group), its
   join by `environment.id`, the collapsed/expanded decision derived from (1) and
   (2), the state-line component, (phase 6) the project-row board link,
   resolved from the same read's `projects` by BB project id, and (nucleus#1313) the nested-elsewhere
   pointer with its counting rule, the repository-led state line (folder icon plus the repository
   label), the PR chip (the shared `shared/pull-request-badge.ts` mapping as an icon plus `#39` in the
   state colour, with the state in the aria-label) and the task container's own action menu items,
   and (nucleus#1336) the container's leading status.
   Reason: the fork's own logic belongs in one file of the fork rather than smeared over upstream's
   components.
4. **`0004-export-thread-list.patch` — `app.tsx`, `app.test.tsx`,
   `sidebarRowRenders.test.tsx`.** `app.tsx` exports the list's component and its
   registration instead of defining a plugin, because Nucleus's own plugin entry
   registers the list beside the rest of its slots (one plugin, one connection, one
   catalogue). The two app-level tests load that entry instead of `./app`; their
   assertions are otherwise unchanged, and the one that counted RPC calls still
   requires exactly one preferences read now that the plugin's own task-group read
   rides beside it.

The seams deliberately do not touch the paths behind them: the thread row's drag
bindings, split props, action menus, inline rename, section drag and drop and the
keyboard shortcuts are upstream's code, and `test/bb-sidebar-vendored.test.ts`
fails if a patch hunk ever removes or adds a line naming `dragBindings`.

## The rebase routine

One sequence, so any worker can do it:

1. Clone BB at the new release tag and check out its commit
   (`git clone --branch desktop-vX.Y.Z https://github.com/get-bb/bb`).
2. Run `node scripts/bb/vendor-sidebar.mjs --upstream <checkout>`. It copies the
   tree through upstream's own fork routine (`scripts/lib/plugin-fork.mjs`), writes
   the registry items, the fork tsconfig and the test runner, applies
   `patches/*.patch` in order, and rewrites `UPSTREAM.json`. A patch that no longer
   applies stops the run with the rejects named — resolve it by updating the patch,
   never by editing a vendored file in place.
3. Run the fork's own tests (`effigy bb:sidebar-tests`) and the plugin typecheck
   (`effigy check:plugin-types`); then the vendored-manifest test
   (`effigy test unit -- test/bb-sidebar-vendored.test.ts`).
4. Run `effigy bb:sidebar-drift` to report what changed upstream since the new pin
   and whether the plugin is still on upstream's forkable list.
5. Update the `THIRD_PARTY_NOTICES.md` section's commit and file list, and this
   file's pin line.
6. Run the phase acceptance (`effigy check`, `effigy qa:docs`,
   `effigy test:affected --run`) and the isolated install proof
   (`effigy proof:bb:sidebar`).

## Building and testing in this repository

The plugin package declares the dependencies the fork needs (its runtime packages
in `dependencies`, the host-shimmed type packages and the test runner in
`devDependencies`). In this repository they are installed at the repository root,
so `effigy setup` is the only install step and Node's own resolution finds them
from `hosts/bb/plugin`: `effigy bb:sidebar-tests` runs the fork's own vitest suite,
`effigy check:plugin-types` typechecks the package with this tsconfig, and
`bb plugin build hosts/bb/plugin` writes `dist/` (ignored). A published copy needs
its own `npm install` first, which is what upstream's fork routine provides.

The vendored `server.ts` is upstream's, unchanged, and is not dead code: the
plugin's own `server.ts` calls its default export (`threadListPlugin(bb)`) beside
the adapter's RPC catalogue and the presence socket, so the fork's preference RPC
and its `prefs` CLI register in the plugin BB actually loads. `test/bb-plugin-backend.test.ts`
proves that composition against the production factory.

`test-setup.ts` in the package root supplies the in-memory `localStorage` the
preferences mirror reads: the repository's jsdom reaches a test window without one,
and the host's browser has it. Nothing else about the environment is faked.

## What the fork does not do

It adds no host operation, no workspace fact, no reporting route and no thread
presentation of its own: it reads the projection the service already publishes
(`bb.sidebar-groups`) and draws it. It never writes a lifecycle owner, never
archives or deletes a thread or a BB project, and never calls a forge, Git or a
thread timeline from the sidebar. Spec 062 decision 5f's exit path — an upstream
group-row metadata slot plus a per-group collapse hint — would replace this fork
and delete the patch set.
