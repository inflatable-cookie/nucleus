/**
 * Nucleus's BB plugin frontend (Spec 062, decision 5a).
 *
 * Composition, not a second fork: the vendored list registers its component here
 * beside this plugin's own slots, and the one wrapper this file adds supplies the
 * batched Nucleus task-group read the fork's header consumes. The plugin gets the
 * scrolling list only — the New-thread button, the navigation rail and the footer
 * stay host-rendered in every sidebar.
 */
import {
  definePluginApp,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
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
});

export type { sidebarGroupsContract };
