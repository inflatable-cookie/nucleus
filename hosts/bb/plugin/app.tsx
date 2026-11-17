/**
 * Nucleus's BB plugin frontend (Spec 062, decision 5a).
 *
 * Composition, not a second fork: the vendored list registers its component here
 * beside this plugin's own slots, and the one wrapper this file adds supplies the
 * batched Nucleus task-group read the fork's header consumes. The plugin gets the
 * scrolling list only — the New-thread button, the navigation rail and the footer
 * stay host-rendered in every sidebar.
 *
 * Phase 6 registers the board's surfaces from the generated board bundle
 * (`board/nucleus-board.js`, built by `scripts/bb/build-board.mjs` from
 * `hosts/bb/board/`): the rail board with its badge, the per-project and task
 * tabs, Settings, the composer pills, the pending-question renderer and the
 * planner rows' "Project board" action. The SDK module is handed to it, so the
 * bundle carries no copy of BB's runtime.
 */
import * as bbApp from "@get-bb/plugin-sdk/app";
import {
  definePluginApp,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { registerNucleusBoard } from "./board/nucleus-board.js";
import { ThreadList, moveThreadAction } from "./sidebar/app.js";
import { NucleusSidebarGroupsProvider } from "./sidebar/app/list/nucleusTaskGroups.js";
import { sidebarGroupsContract } from "./sidebar-groups.js";

/** The vendored list, with the one read its task groups draw from. */
function NucleusThreadList(props: PluginThreadListProps) {
  return (
    <NucleusSidebarGroupsProvider>
      <ThreadList {...props} />
    </NucleusSidebarGroupsProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "thread-list",
    title: "Thread list",
    description:
      "Pinned threads, custom sections, projects, machines, and nested threads, with a state line on each Nucleus task group.",
    component: NucleusThreadList,
  });
  app.slots.experimental_threadAction(moveThreadAction);
  registerNucleusBoard(app, bbApp);
});

export type { sidebarGroupsContract };
