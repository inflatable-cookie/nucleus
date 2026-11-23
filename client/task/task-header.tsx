import React, { useRef } from "react";
import { Text, View } from "react-native";
import { ActionButton, Button, row, type Colors } from "../controls";
import {
  isParkedTask,
  taskNumberLabel,
  type DecisionView,
  type Run,
  type TaskDetail,
  type TaskNext,
  type UiQueueState,
} from "../../shared/contracts";
import { decisionAge } from "../../shared/pipeline-board";
import { formatSpan, taskElapsed } from "../../shared/task-detail-summary";
import type { DetailTone, TaskHappening } from "../../shared/task-detail-view";
import { attention, phaseLabel, projectName } from "../board/text";
import { Badge, HoldChips, PullRequestBadge, StopBadge } from "../board/badges";
import { CardProject } from "../board/cards";
import type { BoardNavigation } from "../shell/types";
import { radius, roles, space, taskDetail, type as typeScale } from "../design";

export function detailToneColor(tone: DetailTone, c: Colors): string {
  const r = roles(c);
  switch (tone) {
    case "danger":
      return r.danger;
    case "warning":
      return r.warning;
    case "success":
      return r.success;
    case "accent":
      return r.accent;
    case "muted":
      return r.muted;
  }
}

/**
 * The redesigned task detail header (nucleus#1537):
 * - Line 1: task reference, project badge and name, and age
 * - Line 2: title
 * - Line 3: status dot + state in words, one-line detail, PR link when present,
 *   short chips (elapsed time, exception flags)
 * - Right: Open thread button, ⋯ menu trigger, and Close button (modal only).
 */
export function TaskDetailHeader({
  task,
  next,
  runs,
  state,
  decisions,
  happening,
  spansRepositories,
  compact,
  inline,
  navigation,
  onClose,
  menuAnchor,
  menuOpen,
  onToggleMenu,
  c,
}: {
  task: TaskDetail;
  next: TaskNext | null;
  runs: readonly Run[];
  state: UiQueueState | undefined;
  decisions: readonly DecisionView[] | undefined;
  happening: TaskHappening;
  spansRepositories: boolean;
  compact: boolean;
  inline: boolean;
  navigation?: BoardNavigation;
  onClose: () => void;
  menuAnchor: React.RefObject<View | null>;
  menuOpen: boolean;
  onToggleMenu: () => void;
  c: Colors;
}) {
  const r = roles(c);
  const boardSummary = state?.tasks.find((item) => item.id === task.id);
  const projectBadge =
    task.hostId && state?.projectBadges?.[task.hostId]?.[task.repoPath]
      ? state.projectBadges[task.hostId]![task.repoPath]!
      : null;
  const linkedDecisions = (decisions ?? []).filter((decision) =>
    decision.links.tasks.includes(task.id),
  ).length;
  const taskParked = isParkedTask(
    task,
    runs.some((run) => !run.released),
  );
  const taskElapsedMs = taskElapsed(runs);
  const isAttn = attention(task);
  const stateTone: DetailTone = isAttn
    ? "danger"
    : task.phase === "done"
      ? "success"
      : task.phase === "queued" || task.phase === "cancelled"
        ? "muted"
        : task.phase === "changes_requested"
          ? "warning"
          : "accent";
  const stateColor = detailToneColor(stateTone, c);
  const stateWords = isAttn ? "Needs attention" : phaseLabel(task);

  // One-line detail beside the state words: PR round/head when reviewing, else happening headline
  const oneLineDetail =
    task.phase === "reviewing" && next
      ? `Round ${Math.min(next.outcome.revision.runs + 1, next.outcome.revision.budget)}${task.prHead ? ` at ${task.prHead.slice(0, 7)}` : ""}`
      : happening.headline;

  // Thread to open: live active run's agent, else the worker agent on the task row
  const activeAgentId =
    runs.find((run) => !run.released && run.agentId)?.agentId ??
    task.agentId ??
    null;

  const refLabel = task.number ? taskNumberLabel(task, spansRepositories) : "";
  const ageLabel = task.createdAt ? decisionAge(task.createdAt) : "";

  return (
    <View
      style={{
        paddingHorizontal: compact ? space.md : space.lg,
        paddingTop: space.md,
        paddingBottom: space.sm,
        gap: space.xs,
      }}
    >
      {/* Line 1: task reference, project badge + name, age */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: space.xs,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            flex: 1,
            minWidth: 0,
            flexWrap: "wrap",
          }}
        >
          {Boolean(refLabel) && (
            <Text
              style={{
                color: r.muted,
                fontSize: typeScale.metadata.fontSize,
                lineHeight: typeScale.metadata.lineHeight,
              }}
            >
              {refLabel}
            </Text>
          )}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.xxs,
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            <CardProject name={projectName(task)} badge={projectBadge} c={c} />
          </View>
          {Boolean(ageLabel) && (
            <>
              <Text
                style={{
                  color: r.muted,
                  fontSize: typeScale.metadata.fontSize,
                }}
              >
                ·
              </Text>
              <Text
                style={{
                  color: r.muted,
                  fontSize: typeScale.metadata.fontSize,
                  lineHeight: typeScale.metadata.lineHeight,
                }}
              >
                {ageLabel}
              </Text>
            </>
          )}
        </View>
        {!inline && (
          <ActionButton
            c={c}
            action="close"
            label="Close detail"
            onPress={() => onClose()}
          />
        )}
      </View>

      {/* Line 2: Title */}
      <Text
        accessibilityRole="header"
        style={{
          color: r.foreground,
          fontSize: typeScale.page.fontSize,
          lineHeight: typeScale.page.lineHeight,
          fontWeight: "600",
        }}
      >
        {task.title}
      </Text>

      {/* Line 3: Status line + PR flag + chips + right-side Open thread & ⋯ menu */}
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          gap: space.xs,
          marginTop: space.xxs / 2,
        }}
      >
        <View
          style={{
            ...row,
            gap: space.xs,
            flex: 1,
            minWidth: 0,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
            }}
          >
            <View
              style={{
                width: taskDetail.statusDot,
                height: taskDetail.statusDot,
                borderRadius: radius.full,
                backgroundColor: stateColor,
                flexShrink: 0,
              }}
            />
            <Text
              style={{
                color: stateColor,
                fontSize: typeScale.body.fontSize,
                lineHeight: typeScale.body.lineHeight,
                fontWeight: "500",
              }}
            >
              {stateWords}
            </Text>
          </View>
          {Boolean(oneLineDetail) && (
            <>
              <Text
                style={{ color: r.muted, fontSize: typeScale.body.fontSize }}
              >
                ·
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  color: r.muted,
                  fontSize: typeScale.body.fontSize,
                  lineHeight: typeScale.body.lineHeight,
                  flexShrink: 1,
                }}
              >
                {oneLineDetail}
              </Text>
            </>
          )}
          {task.prUrl && (
            <PullRequestBadge
              task={task}
              state={state?.prStates[task.id]}
              c={c}
            />
          )}
          {taskElapsedMs !== null && (
            <View
              accessibilityLabel={`Elapsed ${formatSpan(taskElapsedMs)}`}
              style={{
                paddingHorizontal: space.xs,
                paddingVertical: space.xxs / 2,
                borderRadius: radius.control,
                backgroundColor: r.raised,
              }}
            >
              <Text
                style={{
                  color: r.muted,
                  fontSize: typeScale.metadata.fontSize,
                  lineHeight: typeScale.metadata.lineHeight,
                }}
              >
                Elapsed {formatSpan(taskElapsedMs)}
              </Text>
            </View>
          )}
          <HoldChips
            task={task}
            c={c}
            decisionTitle={
              task.waitState?.decisionId
                ? ((decisions ?? []).find(
                    (decision) => decision.id === task.waitState?.decisionId,
                  )?.headline ??
                  (decisions ?? []).find(
                    (decision) => decision.id === task.waitState?.decisionId,
                  )?.question)
                : null
            }
          />
          {boardSummary?.holdEscalated && (
            <Badge
              label="Nucleus-raised"
              tone="warning"
              c={c}
              a11y="Nucleus-raised: the hold is escalated to you"
            />
          )}
          {boardSummary && <StopBadge task={boardSummary} c={c} />}
          {boardSummary?.pausedStop && (
            <Badge
              label="Stopped while paused"
              tone="warning"
              c={c}
              a11y="Stopped while Nucleus was paused; Nucleus resumes it when the queue starts"
            />
          )}
          {linkedDecisions > 0 && (
            <Badge
              label={
                linkedDecisions === 1
                  ? "Decision"
                  : `${linkedDecisions} decisions`
              }
              tone="accent"
              c={c}
              a11y={`${linkedDecisions} open decision${linkedDecisions === 1 ? "" : "s"} linked`}
            />
          )}
          {taskParked && (
            <Badge
              label="Parked (no slot held)"
              tone="warning"
              c={c}
              a11y="Parked (no slot held)"
            />
          )}
        </View>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            flexShrink: 0,
          }}
        >
          {activeAgentId && navigation?.openAgent && (
            <Button
              small
              c={c}
              text="Open thread"
              label="Open thread"
              onPress={() => navigation.openAgent({ agentId: activeAgentId })}
            />
          )}
          <View ref={menuAnchor} collapsable={false}>
            <Button
              small
              c={c}
              text="⋯"
              label="Task actions menu"
              selected={menuOpen}
              onPress={onToggleMenu}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
