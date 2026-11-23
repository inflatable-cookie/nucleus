import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { Colors } from "../controls";
import * as api from "../../shared/contracts";
import type {
  DecisionView,
  TaskNext,
  UiQueueState,
} from "../../shared/contracts";
import {
  buildActivityTimeline,
  taskHappeningView,
} from "../../shared/task-detail-view";
import { PendingQuestions } from "./summary";
import { PopoverHost } from "../popover";
import { TaskDetailTabs, type BoardAct, type TaskDetailTab } from "./parts";
import type { output as ZodOutput } from "zod";
import { TaskDetailHeader } from "./task-header";
import {
  TaskActionsPopover,
  TaskMenuActionPanel,
  type TaskMenuAction,
} from "./task-menu";
import { OverviewTab } from "./overview";
import { ActivityTab } from "./activity";
import { DetailsTab } from "./details";
import type { BoardNavigation } from "../shell/types";
import type { TaskDrafts } from "./drafts";
import { overlay, radius, space, taskDetail } from "../design";

/** What `queue.detail` returns for the open task. */
export type TaskDetailRead = ZodOutput<typeof api.detail.output>;

/**
 * The task detail dialog (nucleus#1537): header with Open thread and ⋯ menu,
 * three tabs (Overview, Activity, Details), and responsive layout for wide
 * detail pane, medium modal and narrow viewports.
 */
export function TaskDialog({
  task,
  detailQuery,
  nextQuery,
  state,
  decisions,
  spansRepositories: taskSpansRepositories,
  compact,
  busy,
  act,
  drafts,
  navigation,
  onClose,
  onSelectTask,
  c,
  inline = false,
}: {
  task: TaskDetailRead["task"];
  detailQuery: UseQueryResult<TaskDetailRead>;
  nextQuery: UseQueryResult<TaskNext>;
  state: UiQueueState | undefined;
  decisions: readonly DecisionView[] | undefined;
  spansRepositories: boolean;
  compact: boolean;
  busy: boolean;
  act: BoardAct;
  drafts: TaskDrafts;
  navigation?: BoardNavigation;
  onClose: () => void;
  onSelectTask: (id: string) => void;
  c: Colors;
  /** Render the detail in place, filling its container, for a host panel tab (Spec 062, decision 5d); no modal, scrim or close. */
  inline?: boolean;
}) {
  const queryClient = useQueryClient();
  // Keep the selected task-detail tab local to the open dialog. Board refreshes
  // update its contents without resetting the operator's place.
  const [detailTab, setDetailTab] = useState<TaskDetailTab>("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPanel, setMenuPanel] = useState<TaskMenuAction | null>(null);
  const menuAnchor = useRef<View | null>(null);

  useEffect(() => {
    setDetailTab("overview");
    setMenuOpen(false);
    setMenuPanel(null);
  }, [task.id]);

  const runs = detailQuery.data?.runs ?? [];
  const pendingOperation = (detailQuery.data?.operations ?? []).some(
    (operation) =>
      operation.state === "pending" || operation.state === "running",
  );
  const happening = taskHappeningView({
    task,
    next: nextQuery.data ?? null,
    runs,
    state,
    decisions,
  });
  const activityTimeline = buildActivityTimeline({
    events: detailQuery.data?.events ?? [],
    messages: detailQuery.data?.messages ?? [],
    taskId: task.id,
  });

  const card = (
    <View
      accessibilityViewIsModal={!inline}
      accessibilityLabel="Task detail"
      style={
        inline
          ? { flex: 1, minHeight: 0, backgroundColor: c.surface0 }
          : {
              width: "100%",
              maxWidth: taskDetail.maxWidth,
              maxHeight: "92%",
              alignSelf: "center",
              backgroundColor: c.surface0,
              borderColor: c.border,
              borderWidth: 1,
              borderRadius: radius.panel,
              overflow: "hidden",
              shadowColor: overlay.shadow,
              shadowOffset: { width: 0, height: 14 },
              shadowOpacity: 0.45,
              shadowRadius: 24,
              elevation: 20,
            }
      }
    >
      <TaskDetailHeader
        task={task}
        next={nextQuery.data ?? null}
        runs={runs}
        state={state}
        decisions={decisions}
        happening={happening}
        spansRepositories={taskSpansRepositories}
        compact={compact}
        inline={inline}
        navigation={navigation}
        onClose={onClose}
        menuAnchor={menuAnchor}
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen((open) => !open)}
        c={c}
      />
      <TaskActionsPopover
        open={menuOpen}
        anchor={menuAnchor}
        onClose={() => setMenuOpen(false)}
        onOpenPanel={(panel) => setMenuPanel(panel)}
        task={task}
        busy={busy}
        pendingOperation={pendingOperation}
        act={act}
        navigation={navigation}
        onCloseDialog={onClose}
        next={nextQuery.data ?? null}
        c={c}
      />
      <TaskDetailTabs
        tab={detailTab}
        onSelect={setDetailTab}
        activityCount={activityTimeline.items.length}
        compact={compact}
        c={c}
      />
      <ScrollView
        style={inline ? { flex: 1, minHeight: 0 } : { flexGrow: 0 }}
        contentContainerStyle={{
          gap: space.md,
          paddingHorizontal: compact ? space.md : space.lg,
          paddingVertical: space.md,
          maxWidth: taskDetail.maxWidth,
          width: "100%",
        }}
      >
        <TaskMenuActionPanel
          panel={menuPanel}
          onClose={() => setMenuPanel(null)}
          task={task}
          state={state}
          drafts={drafts}
          busy={busy}
          pendingOperation={pendingOperation}
          act={act}
          next={nextQuery.data ?? null}
          c={c}
        />
        {task && (
          <PendingQuestions
            key={`questions-${task.id}`}
            agentId={task.agentId}
            hostId={task.hostId}
            runs={runs}
            c={c}
            onAnswered={async () => {
              await queryClient.refetchQueries({
                queryKey: ["nucleus", "state"],
                exact: true,
              });
              await queryClient.invalidateQueries({
                queryKey: ["nucleus", "detail", task.id],
                exact: true,
              });
              await queryClient.invalidateQueries({
                queryKey: ["nucleus", "next", task.id],
                exact: true,
              });
            }}
          />
        )}
        <View style={{ display: detailTab === "overview" ? "flex" : "none" }}>
          <OverviewTab
            task={task}
            happening={happening}
            detailQuery={detailQuery}
            nextQuery={nextQuery}
            state={state}
            compact={compact}
            busy={busy}
            pendingOperation={pendingOperation}
            c={c}
          />
        </View>
        {detailTab === "activity" && (
          <ActivityTab
            key={task.id}
            task={task}
            detailQuery={detailQuery}
            busy={busy}
            act={act}
            drafts={drafts}
            c={c}
          />
        )}
        {detailTab === "details" && (
          <DetailsTab
            key={task.id}
            task={task}
            detailQuery={detailQuery}
            nextQuery={nextQuery}
            state={state}
            compact={compact}
            navigation={navigation}
            onSelectTask={onSelectTask}
            c={c}
          />
        )}
      </ScrollView>
    </View>
  );
  if (inline) return card;
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => onClose()}
    >
      {/* The ⋯ menu's popover layer lives inside the modal, above its backdrop. */}
      <PopoverHost>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            padding: compact ? space.sm : space.xl,
            backgroundColor: overlay.scrim,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close task detail"
            onPress={() => onClose()}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
            }}
          />
          {card}
        </View>
      </PopoverHost>
    </Modal>
  );
}
