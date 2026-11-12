import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ActionButton, muted, row, type Colors } from "../controls";
import * as api from "../../shared/contracts";
import { isParkedTask, taskNumberLabel, type DecisionView, type Task, type TaskNext, type UiQueueState } from "../../shared/contracts";
import { formatSpan, taskElapsed } from "../../shared/task-detail-summary";
import { projectName, phaseLabel, attention } from "../board/text";
import { HoldChips, PullRequestBadge, Badge } from "../board/badges";
import { PendingQuestions, TaskDetailTabs, type BoardAct, type TaskDetailTab } from "./parts";
import type { output as ZodOutput } from "zod";
import { OverviewNext, OverviewSummary } from "./overview";
import { TechnicalTab } from "./technical";
import { RunsTab } from "./runs";
import { ActivityTab, MessagesTab } from "./activity";
import type { BoardNavigation } from "../shell/types";
import type { TaskDrafts } from "./drafts";
import { space, radius, type as typeScale, overlay } from "../design";

/** What `queue.detail` returns for the open task. */
export type TaskDetailRead = ZodOutput<typeof api.detail.output>;
/** The milestone QA run for the task's repository (#121). */
export type TaskQaRun = ZodOutput<typeof api.projectQaList.output>[number];

/**
 * The task detail dialog: its frame, header and tabs. Each tab owns its own form state,
 * so typing in one re-renders that tab, not the board. The board keeps the detail and
 * next reads, keyed on the selected task.
 */
export function TaskDialog({ task, detailQuery, nextQuery, state, decisions, qaRuns, spansRepositories: taskSpansRepositories, compact, busy, act, drafts, navigation, onClose, onSelectTask, c }: {
  task: TaskDetailRead["task"]; detailQuery: UseQueryResult<TaskDetailRead>; nextQuery: UseQueryResult<TaskNext>; state: UiQueueState | undefined;
  decisions: readonly DecisionView[] | undefined; qaRuns: readonly TaskQaRun[] | undefined; spansRepositories: boolean; compact: boolean; busy: boolean; act: BoardAct; drafts: TaskDrafts;
  navigation?: BoardNavigation; onClose: () => void; onSelectTask: (id: string) => void; c: Colors;
}) {
  const queryClient = useQueryClient();
  // Keep the selected task-detail tab local to the open dialog. Board refreshes
  // update its contents without resetting the operator's place.
  const [detailTab, setDetailTab] = useState<TaskDetailTab>("overview");
  useEffect(() => { setDetailTab("overview"); }, [task.id]);
  const taskParked = isParkedTask(task, detailQuery.data?.runs.some(run => !run.released) ?? false);
  // #121: the task detail shows the milestone QA run for the task's repository,
  // so its stages are visible from the task, not only from Planning.
  const taskQaRun = qaRuns ? qaRuns.find(run => run.repository.path === task.repoPath || run.key === task.repository || run.key === task.repoPath) : undefined;
  // Task 538: the summary's elapsed clock runs from the first dispatch.
  const taskElapsedMs = taskElapsed(detailQuery.data?.runs ?? []);
  const pendingOperation = (detailQuery.data?.operations ?? []).some(operation => operation.state === "pending" || operation.state === "running");
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => onClose()}
    >
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
        <View
          accessibilityViewIsModal
          accessibilityLabel="Task detail"
          style={{
            width: "100%",
            maxWidth: 980,
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
          }}
        >
          <View
            style={{
              ...row,
              flexWrap: "nowrap",
              justifyContent: "space-between",
              paddingHorizontal: compact ? space.md : space.lg,
              paddingVertical: space.md,
              borderBottomWidth: 1,
              borderBottomColor: c.border,
            }}
          >
            <View style={{ gap: space.xxs, flex: 1, minWidth: 0 }}>
              <Text
                accessibilityRole="header"
                style={{
                  color: c.foreground,
                  fontSize: typeScale.page.fontSize,
                  fontWeight: "600",
                }}
              >
                {task.number
                  ? `${taskNumberLabel(task, taskSpansRepositories)} · `
                  : ""}
                {task.title}
              </Text>
              <View style={row}>
                <View
                  style={{
                    paddingHorizontal: space.xs,
                    paddingVertical: space.xxs,
                    borderRadius: radius.panel,
                    backgroundColor: attention(task)
                      ? c.surface2
                      : c.accent,
                  }}
                >
                  <Text
                    style={{
                      color: attention(task)
                        ? c.statusWarning
                        : c.accentForeground,
                      fontSize: typeScale.metadata.fontSize,
                      fontWeight: "600",
                    }}
                  >
                    {phaseLabel(task)}
                  </Text>
                </View>
                <HoldChips task={task} c={c} decisionTitle={task.waitState?.decisionId
                  ? (decisions ?? []).find(decision => decision.id === task.waitState?.decisionId)?.headline
                    ?? (decisions ?? []).find(decision => decision.id === task.waitState?.decisionId)?.question
                  : null} />
                <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
                  {projectName(task)}
                </Text>
                {taskParked && (
                  <Badge
                    label="Parked (no slot held)"
                    tone="warning"
                    c={c}
                    a11y="Parked (no slot held)"
                  />
                )}
                {task.prUrl && (
                  <PullRequestBadge
                    task={task}
                    state={state?.prStates[task.id]}
                    c={c}
                  />
                )}
                {taskElapsedMs !== null && (
                  <Text accessibilityLabel={`Elapsed ${formatSpan(taskElapsedMs)}`} style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
                    Elapsed {formatSpan(taskElapsedMs)}
                  </Text>
                )}
              </View>
            </View>
            <ActionButton c={c} action="close" label="Close detail" onPress={() => onClose()} />
          </View>
          <TaskDetailTabs tab={detailTab} onSelect={setDetailTab} needsAttention={attention(task)} compact={compact} c={c} />
          <ScrollView
            style={{ flexGrow: 0 }}
            contentContainerStyle={{
              gap: space.sm,
              padding: compact ? space.sm : space.md,
            }}
          >
          <OverviewSummary task={task} detailTab={detailTab} nextQuery={nextQuery} detailQuery={detailQuery} qaRun={taskQaRun} c={c} />
          {task && (
            <PendingQuestions
              key={`questions-${task.id}`}
              agentId={task.agentId}
              hostId={task.hostId}
              runs={detailQuery.data?.runs ?? []}
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
          <OverviewNext task={task} detailTab={detailTab} nextQuery={nextQuery} state={state} busy={busy} pendingOperation={pendingOperation} c={c} />
          {detailTab === "technical" && <TechnicalTab key={task.id} task={task} detailQuery={detailQuery} nextQuery={nextQuery} state={state} qaRun={taskQaRun} pendingOperation={pendingOperation} compact={compact} busy={busy} act={act} drafts={drafts} navigation={navigation} onClose={onClose} c={c} />}
          {detailTab === "runs" && <RunsTab key={task.id} task={task} detailQuery={detailQuery} state={state} pendingOperation={pendingOperation} compact={compact} busy={busy} act={act} drafts={drafts} navigation={navigation} onSelectTask={onSelectTask} c={c} />}
          {detailTab === "messages" && <MessagesTab task={task} detailQuery={detailQuery} c={c} />}
          {detailTab === "activity" && <ActivityTab key={task.id} task={task} detailQuery={detailQuery} busy={busy} act={act} drafts={drafts} c={c} />}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
