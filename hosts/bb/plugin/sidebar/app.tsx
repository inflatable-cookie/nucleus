import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PreferencesSync } from "./app/preferences/PreferencesSync.js";
import { ProjectList } from "./app/list/ProjectList.js";
import { useSidebarThreadReveal } from "./app/list/useSidebarThreadReveal.js";
import { moveThreadAction } from "./app/rows/moveThreadAction.js";
import { ThreadSelectionProvider } from "./app/selection/threadSelection.js";

/**
 * The forked thread list (Spec 062, decision 5a seam 4). The fork defines the
 * list's component and exports it; Nucleus's own plugin entry registers it beside
 * the board and the rest of its slots.
 */
export function ThreadList({
  activeThreadId,
  isCompactViewport,
  onNavigate,
}: PluginThreadListProps) {
  useSidebarThreadReveal();
  return (
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      <TooltipProvider>
        <PreferencesSync />
        <ThreadSelectionProvider activeThreadId={activeThreadId}>
          <ProjectList
            activeThreadId={activeThreadId}
            onProjectSelect={onNavigate}
          />
        </ThreadSelectionProvider>
      </TooltipProvider>
    </CompactViewportOverrideProvider>
  );
}

/** The registration this fork hands its plugin entry, so one plugin owns one list. */
export const threadListRegistration = {
  id: "thread-list",
  title: "Thread list",
  description:
    "Pinned threads, custom sections, projects, machines, and nested threads, with a state line on each Nucleus task group.",
  component: ThreadList,
} as const;

export { moveThreadAction };
