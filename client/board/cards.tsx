import { useTaskQuestions } from "../native-questions";
import { formatAgentId } from "../../shared/agent-identity";
import {
  blockingHold,
  dispatchWaitFence,
  phaseStateLabel,
  taskStateLabel,
} from "../../shared/task-state";
import React, { useState, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../shell";
import { Button, Field, muted, row, type Colors } from "../controls";
import { Popover } from "../popover";
import {
  HOST_KIND_LABELS,
  hostKindOf,
  taskNumberLabel,
  type BoardQaRun,
  type DecisionView,
  type LaneView,
  type TaskSummary,
} from "../../shared/contracts";
import { phaseBadgeTone, recordBadgeTone } from "../../shared/badge-tones";
import { waitStateLabels } from "../../shared/wait-state";
import { recordedStopIsHeld, recordedStopIsWait } from "../../shared/task-stop";
import { hostDisplayLabel } from "../../shared/host-outage";
import { decisionAge, phaseNeedsAttention } from "../../shared/pipeline-board";
import {
  UNKNOWN_ASKER_LABEL,
  decisionProjectLabel,
  isGeneralDecision,
} from "../../shared/decision-project";
import { taskWaitCardLabel } from "../../shared/task-detail-summary";
import {
  isDarkSurface,
  projectBadgeWebStyle,
  type ProjectBadge,
} from "../../shared/t3/project-badge";
import {
  projectName,
  plainCardText,
  plainCardNode,
  phaseLabel,
  phaseIcon,
  attention,
  holdKindLabel,
  presentHoldKinds,
  stopBadgeLabel,
  prerequisiteLine,
  holdReasonPreview,
  budgetFields,
  interactiveBadgeLabel,
  elapsedRun,
  longShellCommandStart,
} from "./text";
import { useTick } from "../use-tick";
import {
  HoldBadge,
  HoldChips,
  PullRequestBadge,
  Badge,
  RecordChips,
  StopBadge,
  BudgetBadge,
  InteractiveBadge,
  LongShellCommandStatus,
  HeavyRunStatus,
} from "./badges";
import { overlay, space, radius, type as typeScale } from "../design";

/**
 * Spec 026 row 12a: the single card component for the Pipeline view. Task cards
 * render through TaskCard below; papercut and lead cards render through it
 * directly, with their own chips. Only the slot content differs, never the card
 * structure. Lane discovery is Planning's search, not a board surface (#866).
 * Spec 026 row 15a: cards carry no action buttons; clicking one opens the
 * record modal.
 */
/**
 * How a board card draws its frame. The inbox list (Tom, 2026-11-21) draws every
 * card as a flat row with a divider and an accent edge when selected; the content
 * and actions are the card's own either way.
 */
export type BoardCardVariant = "card" | "row";
export const BoardCardVariantContext =
  React.createContext<BoardCardVariant>("card");

export const BoardCard = React.memo(function BoardCard({
  label,
  onPress,
  selected,
  c,
  board = true,
  kind,
  eyebrow,
  accessory,
  title,
  chips,
  snippet,
  footer,
  actions,
}: {
  label: string;
  onPress: () => void;
  selected: boolean;
  c: Colors;
  board?: boolean;
  /** What the card is, drawn first in its eyebrow so a Needs you card says its kind (Tom, 2026-11-21). */
  kind?: string;
  eyebrow: React.ReactNode;
  accessory?: React.ReactNode;
  title: React.ReactNode;
  chips?: React.ReactNode;
  snippet?: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * The card's own controls, drawn inside the row's frame below its content
   * (nucleus#1511). They sit outside the row's press target, so a press on a
   * control never also opens the record; other cards keep no controls at all.
   */
  actions?: React.ReactNode;
}) {
  const variant = React.useContext(BoardCardVariantContext);
  const body = (
    <>
      <View
        style={{
          ...row,
          flexWrap: "nowrap",
          justifyContent: "space-between",
          zIndex: 2,
        }}
      >
        <View
          pointerEvents="none"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.xxs,
            minWidth: 0,
            flex: 1,
          }}
        >
          {kind && (
            <Text
              numberOfLines={1}
              style={{
                color: c.foreground,
                fontSize: typeScale.metadata.fontSize,
                fontWeight: "600",
                letterSpacing: 0.4,
                textTransform: "uppercase",
              }}
            >
              {kind}
            </Text>
          )}
          {plainCardNode(eyebrow)}
        </View>
        {plainCardNode(accessory)}
      </View>
      <View pointerEvents="none" style={{ gap: space.xs }}>
        {plainCardNode(title)}
        {plainCardNode(chips)}
        {plainCardNode(snippet)}
        {plainCardNode(footer)}
      </View>
    </>
  );
  // A row keeps its divider, padding and accent edge on the outer frame, so a
  // card's own controls land inside the row instead of under its divider.
  if (variant === "row")
    return (
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: c.border,
          borderLeftWidth: 2,
          borderLeftColor: selected ? c.accent : "transparent",
          backgroundColor: selected ? c.surface2 : c.surface0,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={plainCardText(label)}
          accessibilityState={{ selected }}
          onPress={onPress}
          style={{
            gap: space.xs,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
          }}
        >
          {body}
        </Pressable>
        {actions !== undefined && (
          <View
            style={{ paddingHorizontal: space.md, paddingBottom: space.sm }}
          >
            {actions}
          </View>
        )}
      </View>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={plainCardText(label)}
      onPress={onPress}
      style={{
        gap: space.xs,
        padding: board ? space.sm : space.md,
        paddingTop: board ? space.xs : space.sm,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: selected ? c.accent : c.border,
        backgroundColor: c.surface1,
      }}
    >
      {body}
      {plainCardNode(actions)}
    </Pressable>
  );
});
/** Milestone QA as a board card (Tom, 2026-11-01): a distinct accent edge, a QA icon and the selector as title. */
const qaStateLabels: Record<BoardQaRun["state"], string> = {
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  hold: "Held",
  timed_out: "Timed out",
  cancelled: "Cancelled",
  lost: "Lost",
};
export const QaRunCard = React.memo(function QaRunCard({
  run,
  busy,
  onOpen,
  onRerun,
  onCancel,
  onDismiss,
  c,
}: {
  run: BoardQaRun;
  busy: boolean;
  onOpen: () => void;
  onRerun: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  c: Colors;
}) {
  const live = run.state === "queued" || run.state === "running";
  useTick(live ? 30_000 : null);
  const project = run.repository.origin ?? run.repository.path;
  const lines = run.outputLines.slice(-4);
  return (
    <View
      accessibilityLabel={`Milestone QA ${run.selector}, ${qaStateLabels[run.state]}, ${project}`}
      style={{
        gap: space.xs,
        padding: space.sm,
        paddingTop: space.xs,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: c.border,
        borderLeftWidth: 3,
        borderLeftColor: c.accent,
        backgroundColor: c.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open milestone QA run ${run.selector}`}
        onPress={onOpen}
        style={{ gap: space.xs }}
      >
        <View
          style={{
            ...row,
            flexWrap: "nowrap",
            justifyContent: "space-between",
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.xxs,
              minWidth: 0,
              flex: 1,
            }}
          >
            <Icon name="FlaskConical" size={12} color={c.accent} />
            <Text
              numberOfLines={1}
              style={{
                ...muted(c),
                fontSize: typeScale.metadata.fontSize,
                flexShrink: 1,
              }}
            >
              Milestone QA · {project} · {run.baseBranch}
            </Text>
          </View>
          <Text
            style={{
              color: c.accent,
              fontSize: typeScale.metadata.fontSize,
              fontWeight: "700",
            }}
          >
            {qaStateLabels[run.state]}
          </Text>
        </View>
        <Text
          numberOfLines={2}
          style={{
            color: c.foreground,
            fontWeight: "600",
            fontSize: typeScale.body.fontSize,
            lineHeight: typeScale.body.lineHeight,
          }}
        >
          {run.selector}
        </Text>
        {run.state === "queued" && (
          <Text
            numberOfLines={1}
            style={{
              color: c.foregroundMuted,
              fontSize: typeScale.metadata.fontSize,
            }}
          >
            Waiting for QA capacity · position {run.queuePosition ?? "—"}
          </Text>
        )}
        {run.state === "running" && (
          <Text
            numberOfLines={1}
            style={{
              color: c.statusWarning,
              fontSize: typeScale.metadata.fontSize,
              fontWeight: "600",
            }}
          >
            Step {run.currentStep ?? "starting"} · {elapsedRun(run.startedAt)}
          </Text>
        )}
        {run.state === "passed" && (
          <Text
            numberOfLines={1}
            style={{
              color: c.foregroundMuted,
              fontSize: typeScale.metadata.fontSize,
            }}
          >
            Passed
            {run.finishedAt
              ? ` · ${new Date(run.finishedAt).toLocaleTimeString()}`
              : ""}
          </Text>
        )}
        {!live && run.state !== "passed" && (
          <View style={{ gap: space.xxs / 2 }}>
            <Text
              numberOfLines={1}
              style={{
                color: c.statusWarning,
                fontSize: typeScale.metadata.fontSize,
                fontWeight: "600",
              }}
            >
              {run.cancelReason
                ? `Cancelled: ${run.cancelReason}`
                : `Failed${run.failedStep ? ` at ${run.failedStep}` : ""}${run.exitCode !== null ? ` · exit ${run.exitCode}` : ""}`}
            </Text>
            {run.stale && (
              <Text
                accessibilityLabel={`Stale result: ${run.stale.commitsSince} commits since ${new Date(run.stale.runAt).toLocaleDateString()}`}
                numberOfLines={1}
                style={{
                  color: c.statusWarning,
                  fontSize: typeScale.metadata.fontSize,
                  fontWeight: "700",
                }}
              >
                Stale · {run.stale.commitsSince} commits since{" "}
                {new Date(run.stale.runAt).toLocaleDateString()}
              </Text>
            )}
            {lines.map((line, index) => (
              <Text
                key={index}
                numberOfLines={1}
                style={{
                  ...muted(c),
                  fontSize: typeScale.metadata.fontSize,
                  fontFamily: "monospace",
                }}
              >
                {line}
              </Text>
            ))}
          </View>
        )}
      </Pressable>
      <View style={{ ...row, gap: space.xs, justifyContent: "flex-end" }}>
        {live && (
          <Button
            small
            c={c}
            text="Cancel"
            label={`Cancel milestone QA run ${run.selector}`}
            disabled={busy}
            onPress={onCancel}
          />
        )}
        {!live && run.state !== "passed" && (
          <Button
            small
            c={c}
            text="Re-run"
            label={`Re-run milestone QA ${run.selector} for ${project}`}
            disabled={busy}
            onPress={onRerun}
          />
        )}
        {!live && run.state !== "passed" && (
          <Button
            small
            c={c}
            text="Dismiss"
            label={`Dismiss milestone QA run ${run.selector}`}
            disabled={busy}
            onPress={onDismiss}
          />
        )}
        <Button
          small
          c={c}
          text="Details"
          label={`Open details for milestone QA run ${run.selector}`}
          onPress={onOpen}
        />
      </View>
    </View>
  );
});
/**
 * Tom, 2026-11-07 (UI lane, step 2): a board task card says what is happening, what is
 * waiting and who or what moves it next. Long IDs, lanes, profiles and timestamps live in
 * the task view; the card keeps the holds, waits and attention a scan needs.
 */
/**
 * The generated T3 project badge on a card's project line (nucleus#1450). It is drawn in
 * the T3 renderer's colours for the surface's mode and is decorative: the project name
 * beside it is the label.
 */
export function ProjectBadgeMark({
  badge,
  c,
}: {
  badge: ProjectBadge;
  c: Colors;
}) {
  // A Text box in converted sRGB: react-native-web drops the pinned `oklch()` text
  // and the `color-mix()` tint through its normalizeColor, so the boundary converts
  // the assigned palette entry to rgb and the same entry at 14% alpha (nucleus#1487).
  const { color, backgroundColor } = projectBadgeWebStyle(
    badge,
    isDarkSurface(c.surface0),
  );
  return (
    <Text
      numberOfLines={1}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        color,
        backgroundColor,
        minWidth: 16,
        maxWidth: 32,
        height: 16,
        paddingHorizontal: 3,
        borderRadius: 4,
        overflow: "hidden",
        textAlign: "center",
        lineHeight: 16,
        fontFamily: "monospace",
        fontSize: 8,
        fontWeight: "700",
      }}
    >
      {badge.monogram}
    </Text>
  );
}

export const TaskCard = React.memo(function TaskCard({
  task,
  selected,
  onPress,
  prState,
  c,
  board = false,
  parked = false,
  decisions = false,
  decisionTitle,
  defaultHostId,
  projectBadge = null,
  kind,
}: {
  task: TaskSummary;
  selected: boolean;
  onPress: () => void;
  prState?: "OPEN" | "CLOSED" | "MERGED";
  c: Colors;
  board?: boolean;
  /** The kind label a Needs you card shows (Tom, 2026-11-21); other lists draw none. */
  kind?: string;
  parked?: boolean;
  decisions?: boolean;
  decisionTitle?: string | null;
  defaultHostId?: string;
  /** The generated T3 project badge for this task's repository, when its host is T3 and matched. */
  projectBadge?: ProjectBadge | null;
}) {
  const inRow = React.useContext(BoardCardVariantContext) === "row";
  const [statusTip, setStatusTip] = useState(false);
  const statusAnchor = useRef<View | null>(null);
  const hostId = task.hostId ?? defaultHostId;
  const hostKind = hostKindOf(hostId);
  const hostChip =
    !task.hostPending && (task.hostReason || hostKind !== "paseo")
      ? ` · ${HOST_KIND_LABELS[hostKind]}`
      : "";
  const questions = useTaskQuestions(
    task.questionAgentIds ?? [],
    hostId ? task.questionAgentIds?.map((id) => formatAgentId(hostId, id)) : [],
  );
  const archiveRetry = task.resolution.archiveRetry;
  const holdKinds = presentHoldKinds(task).filter(
    (kind) => !(task.waitState?.state === "merge_hold" && kind === "merge"),
  );
  const plainWait = taskWaitCardLabel(task.waitState, decisionTitle);
  const holdLabel = [
    task.waitState ? waitStateLabels[task.waitState.state] : null,
    ...holdKinds.map(holdKindLabel),
  ]
    .filter(Boolean)
    .map((label) => `, ${label}`)
    .join("");
  const stopLabel = stopBadgeLabel(task.stop);
  const stopRecord = task.stopRecord;
  const interactiveLabel = interactiveBadgeLabel(task);
  // The live dispatch hold is the wait; the stored reason may still name a cleared cause.
  const dispatchWait = dispatchWaitFence(task);
  // Whether a recorded stop is a wait or a hold is the stop owner's answer, not the card's.
  const stopWait = stopRecord ? recordedStopIsWait(stopRecord) : false;
  const stopHeld = stopRecord ? recordedStopIsHeld(stopRecord) : false;
  const attentionOwner =
    stopRecord?.reason === "operator_needed" ||
    stopRecord?.reason === "run_stalled"
      ? "you"
      : (task.stopDisplayOwner ?? "the task owner");
  const attentionNext =
    stopRecord?.reason === "operator_needed"
      ? "Your decision is next"
      : stopRecord?.reason === "run_stalled"
        ? "Your action is next"
        : `${attentionOwner} moves it next`;
  const stopDetail = stopRecord?.detail
    .replace(
      /^(Dispatch|Merge) held by [^:]+:/i,
      (_match, kind: string) =>
        `${kind} held by ${task.holdDisplayOwner ?? "a planner thread"}:`,
    )
    .replace(
      /Waiting with the planner or task owner\s+[0-9a-f-]{36}:\s*blocker escalation\s+[0-9a-f]{40,64}/i,
      `Waiting on ${task.stopDisplayOwner ?? "the task owner"} · blocker escalation`,
    );
  const cardAttention = attention(task) && !stopWait;
  const prerequisite = prerequisiteLine(task);
  const longCommandStartedAt = longShellCommandStart(task.reason);
  const budgetExhausted = Boolean(
    task.budget && budgetFields(task.budget).exhausted,
  );
  const attentionPriority = Boolean(
    cardAttention || archiveRetry || (stopRecord && !stopWait),
  );
  // nucleus#1198 review: the task's own host wait is shown beside any stop. An
  // owner-facing stop (budget, escalation, interactive) keeps its own line, so an
  // operator sees both why the task is stopped and that its host is away.
  const hostWait = task.hostWait;
  const hostWaitBlock = hostWait ? (
    <View style={{ gap: space.xxs / 2 }}>
      <Text
        accessibilityLabel={`Waiting on ${hostDisplayLabel(hostWait.hostId)}`}
        numberOfLines={2}
        ellipsizeMode="tail"
        style={{
          color: c.foregroundMuted,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
        }}
      >
        Waiting on {hostDisplayLabel(hostWait.hostId)}
      </Text>
      <Text
        numberOfLines={1}
        style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
      >
        Waiting on the host · {decisionAge(hostWait.since)}
      </Text>
      {stopRecord && stopRecord.reason !== "host_unavailable" && (
        <Text
          numberOfLines={2}
          ellipsizeMode="tail"
          style={{
            color: c.statusWarning,
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          {stopDetail}
        </Text>
      )}
    </View>
  ) : null;
  const next = hostWaitBlock ? (
    hostWaitBlock
  ) : plainWait ? (
    <Text
      numberOfLines={2}
      ellipsizeMode="tail"
      style={{
        color: c.foregroundMuted,
        fontSize: typeScale.metadata.fontSize,
        lineHeight: typeScale.metadata.lineHeight,
      }}
    >
      {plainWait}
    </Text>
  ) : task.heavyRun ? (
    <HeavyRunStatus run={task.heavyRun} c={c} />
  ) : questions.length ? (
    <View style={{ gap: space.xxs }}>
      {questions.flatMap((request) =>
        request.questions.map((q) => (
          <Text
            key={`${request.id}:${q.header}`}
            numberOfLines={2}
            style={{
              color: c.statusWarning,
              fontSize: typeScale.metadata.fontSize,
              lineHeight: typeScale.metadata.lineHeight,
            }}
          >
            Question · {q.question}
          </Text>
        )),
      )}
    </View>
  ) : archiveRetry ? (
    <Text
      numberOfLines={2}
      ellipsizeMode="tail"
      style={{
        color: c.statusWarning,
        fontSize: typeScale.metadata.fontSize,
        lineHeight: typeScale.metadata.lineHeight,
      }}
    >
      Workspace archive failed: {archiveRetry.error}
    </Text>
  ) : prerequisite ? (
    <Text
      numberOfLines={2}
      ellipsizeMode="tail"
      style={{
        color: c.foregroundMuted,
        fontSize: typeScale.metadata.fontSize,
        lineHeight: typeScale.metadata.lineHeight,
      }}
    >
      {prerequisite}
    </Text>
  ) : longCommandStartedAt ? (
    <LongShellCommandStatus startedAt={longCommandStartedAt} c={c} />
  ) : dispatchWait ? (
    <View style={{ gap: space.xxs / 2 }}>
      <Text
        accessibilityLabel={`Hold reason preview: ${holdReasonPreview(dispatchWait.reason)}`}
        numberOfLines={2}
        ellipsizeMode="tail"
        style={{
          color: c.foregroundMuted,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
        }}
      >
        Hold reason preview · {holdReasonPreview(dispatchWait.reason)}
      </Text>
      <Text
        numberOfLines={1}
        style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
      >
        Dispatch held by {task.holdDisplayOwner ?? "a planner thread"}
        {dispatchWait.since
          ? ` · ${decisionAge(dispatchWait.since)}`
          : " · age not recorded"}
      </Text>
      {(task.originError || task.originLookupError) && (
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={{
            color: c.statusWarning,
            fontSize: typeScale.metadata.fontSize,
          }}
        >
          Origin routing: {task.originError || task.originLookupError}
        </Text>
      )}
    </View>
  ) : stopRecord ? (
    <View style={{ gap: space.xxs / 2 }}>
      <Text
        numberOfLines={2}
        ellipsizeMode="tail"
        style={{
          color: stopWait || stopHeld ? c.foregroundMuted : c.statusWarning,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
        }}
      >
        {stopWait
          ? stopDetail!.replace(
              /^(?:lifecycle|prerequisite|capacity|validation):?\s*/i,
              "",
            )
          : stopHeld
            ? stopDetail
            : stopDetail}
      </Text>
      <Text
        numberOfLines={1}
        style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
      >
        {stopWait
          ? `Waiting · ${decisionAge(stopRecord.since)}`
          : stopHeld
            ? `Held · ${decisionAge(stopRecord.since)}`
            : `Needs attention · ${attentionNext} · ${decisionAge(stopRecord.since)}`}
      </Text>
    </View>
  ) : task.headline ? (
    <Text
      numberOfLines={2}
      ellipsizeMode="tail"
      style={{
        color: c.foregroundMuted,
        fontSize: typeScale.metadata.fontSize,
        lineHeight: typeScale.metadata.lineHeight,
      }}
    >
      {task.headline}
    </Text>
  ) : (
    <Text
      numberOfLines={2}
      ellipsizeMode="tail"
      style={{
        color: c.foregroundMuted,
        fontSize: typeScale.metadata.fontSize,
        lineHeight: typeScale.metadata.lineHeight,
      }}
    >
      {task.reason}
    </Text>
  );
  // The inbox list's row keeps one status line (nucleus#1511): the wait or stop
  // that moves the task next, else its phase. The host's name is dropped from it
  // (a row reads "Waiting on the host · 1m ago", never the host identity), and the
  // routing sentence behind the host choice stays in the task detail, which shows
  // the host selection and its reason.
  // An owner-facing stop keeps its detail beside the host wait (nucleus#1198), and
  // the row still draws it as the one line: why the task stopped, then that its host
  // is away. The host's own outage detail is the wait itself, so it is not repeated.
  const rowHostWait = hostWait
    ? `Waiting on the host · ${decisionAge(hostWait.since)}`
    : null;
  const rowStopDetail =
    stopRecord && stopRecord.reason !== "host_unavailable"
      ? (stopDetail ?? stopLabel)
      : null;
  const firstQuestion = questions[0]?.questions[0]?.question;
  const rowStatus = hostWait
    ? rowStopDetail
      ? `${rowStopDetail} · ${rowHostWait}`
      : rowHostWait
    : plainWait
      ? plainWait
      : task.heavyRun
        ? task.heavyRun.state === "queued"
          ? `Waiting for QA capacity · position ${task.heavyRun.position ?? "unknown"}`
          : `QA run ${task.heavyRun.state}`
        : firstQuestion
          ? `Question · ${firstQuestion}`
          : archiveRetry
            ? `Workspace archive failed: ${archiveRetry.error}`
            : prerequisite
              ? prerequisite
              : longCommandStartedAt
                ? `Long shell command · ${elapsedRun(longCommandStartedAt)}`
                : dispatchWait
                  ? `Dispatch held by ${task.holdDisplayOwner ?? "a planner thread"} · ${holdReasonPreview(dispatchWait.reason)}`
                  : stopRecord
                    ? `${stopDetail ?? stopLabel ?? ""} · ${
                        stopWait
                          ? `Waiting · ${decisionAge(stopRecord.since)}`
                          : stopHeld
                            ? `Held · ${decisionAge(stopRecord.since)}`
                            : `${attentionNext} · ${decisionAge(stopRecord.since)}`
                      }`
                    : task.headline
                      ? task.headline
                      : task.reason ||
                        (blockingHold(task)
                          ? taskStateLabel(task)
                          : phaseStateLabel(task));
  // The stop badge is suppressed where the phase line already says it, so it does not count toward the chips row.
  const showStopBadge =
    Boolean(stopLabel) &&
    !stopWait &&
    !stopHeld &&
    !(task.stop === "attention" && phaseNeedsAttention(task.phase));
  const hasChips = Boolean(
    parked ||
      decisions ||
      task.parked ||
      task.pausedStop ||
      interactiveLabel ||
      task.waitState ||
      holdKinds.length ||
      showStopBadge ||
      budgetExhausted,
  );
  const hasFooter =
    task.queuePriority > 0 || task.dependsOn.length > 0 || Boolean(task.prUrl);
  const stopA11y = stopRecord
    ? stopWait
      ? `Waiting: ${stopDetail}`
      : stopHeld
        ? `Held: ${stopDetail}`
        : `Needs attention: ${stopDetail}; next owner ${attentionOwner}`
    : "";
  const holdOwnerA11y =
    !dispatchWait && task.holds?.merge
      ? `, Merge held by ${task.holdDisplayOwner ?? "a planner thread"}`
      : dispatchWait
        ? `, Dispatch held by ${task.holdDisplayOwner ?? "a planner thread"}`
        : "";
  const accessibleWait = hostWait
    ? `, Waiting on ${hostDisplayLabel(hostWait.hostId)} since ${hostWait.since}`
    : plainWait
      ? `, ${plainWait}`
      : task.heavyRun
        ? `, ${task.heavyRun.state === "queued" ? `Waiting for QA capacity · position ${task.heavyRun.position ?? "unknown"}` : `QA run ${task.heavyRun.state}`}`
        : questions.length
          ? `, Question: ${questions.flatMap((request) => request.questions.map((question) => question.question)).join("; ")}`
          : archiveRetry
            ? `, Workspace archive failed: ${archiveRetry.error}`
            : prerequisite
              ? `, ${waitStateLabels.waiting_prerequisite}: ${prerequisite}`
              : longCommandStartedAt
                ? `, Long shell command · ${elapsedRun(longCommandStartedAt)}`
                : dispatchWait
                  ? `, Hold reason preview: ${holdReasonPreview(dispatchWait.reason)}`
                  : stopA11y
                    ? `, ${stopA11y}`
                    : task.headline
                      ? `, ${task.headline}`
                      : task.reason
                        ? `, ${task.reason}`
                        : "";
  const accessibleHold =
    plainWait || prerequisite
      ? holdKinds
          .map(holdKindLabel)
          .map((label) => `, ${label}`)
          .join("")
      : holdLabel;
  const fullHoldReasonA11y = dispatchWait
    ? `, Full hold reason: ${dispatchWait.reason}`
    : "";
  return (
    <BoardCard
      label={`${projectName(task)}${hostChip}, ${task.title}, ${phaseLabel(task)}${interactiveLabel ? `, ${interactiveLabel}` : ""}${accessibleHold}${holdOwnerA11y}${accessibleWait}${task.hostReason ? `, Host: ${task.hostReason}` : ""}${fullHoldReasonA11y}${stopLabel && !stopWait && !stopHeld ? `, ${stopLabel}` : ""}${!accessibleWait && stopA11y ? `, ${stopA11y}` : ""}, Action: open task details`}
      onPress={onPress}
      selected={selected}
      c={c}
      board={board}
      kind={kind}
      eyebrow={
        <>
          {projectBadge ? (
            <ProjectBadgeMark badge={projectBadge} c={c} />
          ) : (
            <Icon name="Folder" size={12} color={c.foregroundMuted} />
          )}
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              flexShrink: 1,
            }}
          >
            {projectName(task)}
            {hostChip}
          </Text>
        </>
      }
      accessory={
        <Pressable
          ref={statusAnchor}
          accessibilityRole="button"
          accessibilityLabel={`Open task details, status ${taskStateLabel(task)}`}
          onHoverIn={() => setStatusTip(true)}
          onHoverOut={() => setStatusTip(false)}
          onFocus={() => setStatusTip(true)}
          onBlur={() => setStatusTip(false)}
          onPress={(event) => {
            event.stopPropagation();
            onPress();
          }}
          style={{
            width: 24,
            height: 24,
            marginTop: -space.xxs / 2,
            marginRight: -space.xxs,
            borderRadius: radius.control,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.surface2,
            flexShrink: 0,
            position: "relative",
          }}
        >
          <Icon
            name={phaseIcon(task)}
            size={12}
            color={cardAttention ? c.statusWarning : c.foregroundMuted}
          />
          {statusTip && (
            <Popover
              anchor={statusAnchor}
              align="end"
              pointerEvents="none"
              inlineStyle={{ right: 0, top: 24 + space.xxs }}
            >
              <View
                pointerEvents="none"
                style={{
                  paddingHorizontal: space.xs,
                  paddingVertical: space.xxs,
                  borderRadius: radius.control,
                  borderWidth: 1,
                  borderColor: c.border,
                  backgroundColor: c.surface2,
                  shadowColor: overlay.shadow,
                  shadowOffset: { width: 0, height: 3 },
                  shadowOpacity: 0.3,
                  shadowRadius: 6,
                  elevation: 8,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: typeScale.metadata.fontSize,
                    fontWeight: "600",
                    color: cardAttention ? c.statusWarning : c.foreground,
                  }}
                >
                  {taskStateLabel(task)}
                </Text>
              </View>
            </Popover>
          )}
        </Pressable>
      }
      title={
        <Text
          numberOfLines={2}
          style={{
            color: c.foreground,
            fontWeight: "600",
            fontSize: board ? typeScale.body.fontSize : typeScale.body.fontSize,
            lineHeight: typeScale.body.lineHeight,
          }}
        >
          {[
            taskNumberLabel(task, false),
            task.entrypoint === "review" ? "Review entry" : "",
            task.title,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      }
      chips={
        hasChips ? (
          <View style={{ ...row, gap: space.xs, flexWrap: "wrap" }}>
            {parked && <RecordChips c={c} chips={["parked"]} />}
            <InteractiveBadge task={task} c={c} />
            {task.parked && (
              <Badge
                label="Parked (no slot held)"
                tone="warning"
                c={c}
                a11y="Parked (no slot held)"
              />
            )}
            {task.pausedStop && (
              <Badge
                label="Stopped while paused"
                tone="warning"
                c={c}
                a11y="Stopped while Nucleus was paused; Nucleus resumes it when the queue starts"
              />
            )}
            <HoldChips task={task} c={c} decisionTitle={decisionTitle} />
            {showStopBadge && <StopBadge task={task} c={c} />}
            {budgetExhausted && <BudgetBadge task={task} c={c} />}
            {decisions && (
              <Badge
                label="Decision"
                tone={recordBadgeTone("decision")}
                c={c}
                a11y="Open decisions linked"
              />
            )}
          </View>
        ) : undefined
      }
      snippet={
        <View style={{ gap: space.xxs }}>
          {/* A hold with a release condition is the task's wait, so a card names it
          instead of the phase; every other card keeps its phase line and its own
          wait line (nucleus#1366). The inbox row draws the one status line above
          (nucleus#1511). */}
          <Text
            numberOfLines={1}
            style={{
              color: attentionPriority ? c.statusWarning : c.foreground,
              fontSize: typeScale.metadata.fontSize,
              fontWeight: "600",
            }}
          >
            {inRow
              ? rowStatus
              : blockingHold(task)
                ? taskStateLabel(task)
                : phaseStateLabel(task)}
          </Text>
          {!inRow && next}
          {!inRow && task.hostReason && (
            <Text
              numberOfLines={2}
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              {task.hostReason}
            </Text>
          )}
        </View>
      }
      footer={
        hasFooter ? (
          <View style={{ ...row, gap: space.xs, flexWrap: "nowrap" }}>
            {task.queuePriority > 0 && (
              <View accessible accessibilityLabel="Promoted in project">
                <Icon
                  name="ArrowUpToLine"
                  size={12}
                  color={c.foregroundMuted}
                />
              </View>
            )}
            {task.dependsOn.length > 0 && (
              <View
                accessible
                accessibilityLabel={`${task.dependsOn.length} prerequisite${task.dependsOn.length === 1 ? "" : "s"}`}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space.xxs,
                  flexShrink: 0,
                }}
              >
                <Icon name="Link" size={12} color={c.foregroundMuted} />
                <Text
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  {task.dependsOn.length}
                </Text>
              </View>
            )}
            <View style={{ flex: 1 }} />
            {task.prUrl && (
              <PullRequestBadge task={task} state={prState} c={c} small />
            )}
          </View>
        ) : undefined
      }
    />
  );
});
/**
 * Spec 032: an agent's open decision in the Pipeline Decisions column. The card carries the
 * question, the asker, the age and the recommendation; answering and withdrawing
 * happen in the modal, never on the card. A stale decision stays visible.
 */
export function decisionChoicePresentation(decision: DecisionView) {
  const raw =
    decision.choices ??
    decision.options.slice(0, 3).map((label) => ({ label, consequence: "" }));
  const recommended =
    decision.recommended ?? decision.options[0] ?? raw[0]?.label;
  const first = raw.find((choice) => choice.label === recommended);
  return {
    choices: first ? [first, ...raw.filter((choice) => choice !== first)] : raw,
    recommended,
  };
}
export const DecisionCard = React.memo(function DecisionCard({
  decision,
  selected,
  onPress,
  c,
  board = true,
  kind,
  linkedTaskProjects = [],
  linkedTaskLabels = [],
}: {
  decision: DecisionView;
  selected: boolean;
  onPress: () => void;
  c: Colors;
  board?: boolean;
  kind?: string;
  linkedTaskProjects?: string[];
  linkedTaskLabels?: string[];
}) {
  const links =
    decision.links.tasks.length +
    decision.links.leads.length +
    decision.links.papercuts.length;
  const { choices, recommended } = decisionChoicePresentation(decision);
  const headline = decision.headline ?? decision.question;
  // Task 1183: the card names who asked — the task reference and role, or the
  // planner or agent name — never a bare agent or thread ID.
  const asker = decision.askerLabel ?? UNKNOWN_ASKER_LABEL;
  return (
    <BoardCard
      label={`Decision: ${headline}, asked by ${asker}`}
      onPress={onPress}
      selected={selected}
      c={c}
      board={board}
      kind={kind}
      eyebrow={
        <>
          <Icon name="Folder" size={12} color={c.foregroundMuted} />
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              flexShrink: 1,
            }}
          >
            {decisionProjectLabel(decision)}
          </Text>
        </>
      }
      title={
        <Text
          numberOfLines={2}
          style={{
            color: c.foreground,
            fontWeight: "600",
            fontSize: typeScale.body.fontSize,
            lineHeight: typeScale.body.lineHeight,
          }}
        >
          {headline}
        </Text>
      }
      chips={
        <RecordChips
          c={c}
          chips={[
            "Decision",
            ...(decision.stale ? ["Stale"] : []),
            ...((decision.overtakenBy?.length ?? 0) > 0
              ? ["Probably overtaken"]
              : []),
          ]}
        />
      }
      snippet={
        choices.length ||
        linkedTaskProjects.length ||
        decision.links.tasks.length ? (
          <View style={{ gap: space.xxs }}>
            {choices.map((choice) => (
              <Text
                key={choice.label}
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{
                  color: c.foregroundMuted,
                  fontSize: typeScale.metadata.fontSize,
                  lineHeight: typeScale.metadata.lineHeight,
                }}
              >
                {choice.label === recommended ? "★ Recommended · " : ""}
                {choice.label}
                {choice.consequence ? ` — ${choice.consequence}` : ""}
              </Text>
            ))}
            {linkedTaskLabels.length > 0 && (
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
              >
                Task · {linkedTaskLabels.join(", ")}
              </Text>
            )}
            {isGeneralDecision(decision) && linkedTaskProjects.length > 0 && (
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
              >
                linked: {linkedTaskProjects.join(", ")}
              </Text>
            )}
          </View>
        ) : undefined
      }
      footer={
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={{
            ...muted(c),
            fontSize: typeScale.metadata.fontSize,
            flex: 1,
            minWidth: 0,
          }}
        >
          Asked {asker} · {decisionAge(decision.createdAt)}
          {links ? ` · ${links} link${links === 1 ? "" : "s"}` : ""}
        </Text>
      }
    />
  );
});
/**
 * Spec 032: Queue's own escalation — a task in needs_attention or carrying an
 * escalated incident or recovery — read-only in the Pipeline Decisions column. The card
 * carries no answer box; pressing it opens the task's own detail.
 */
function RaisedCard({
  task,
  selected,
  onPress,
  c,
  board = true,
  kind,
  actions,
}: {
  task: TaskSummary;
  selected: boolean;
  onPress: () => void;
  c: Colors;
  board?: boolean;
  kind?: string;
  /** The operator's controls, drawn inside the row below the card's content. */
  actions?: React.ReactNode;
}) {
  const held = task.holdEscalated && task.hold;
  return (
    <BoardCard
      label={
        held
          ? `Ready to merge, held for ${task.hold!.reason}: ${task.title}`
          : `Nucleus-raised: ${task.title}, ${phaseLabel(task)}${task.holdKind ? `, ${holdKindLabel(task.holdKind)}` : ""}`
      }
      onPress={onPress}
      selected={selected}
      c={c}
      board={board}
      kind={kind}
      eyebrow={
        <>
          <Icon name="Folder" size={12} color={c.foregroundMuted} />
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              flexShrink: 1,
            }}
          >
            {projectName(task)}
          </Text>
        </>
      }
      title={
        <Text
          numberOfLines={2}
          style={{
            color: c.foreground,
            fontWeight: "600",
            fontSize: typeScale.body.fontSize,
            lineHeight: typeScale.body.lineHeight,
          }}
        >
          {task.title}
        </Text>
      }
      chips={
        <View style={{ ...row, gap: space.xs, flexWrap: "wrap" }}>
          <RecordChips c={c} chips={["Nucleus-raised"]} />
          <Badge
            label={phaseLabel(task)}
            tone={phaseBadgeTone(task)}
            c={c}
            bold
            a11y={`Phase ${phaseLabel(task)}`}
          />
          {presentHoldKinds(task).map((kind) => (
            <HoldBadge key={kind} kind={kind} c={c} />
          ))}
          <StopBadge task={task} c={c} />
        </View>
      }
      snippet={
        <Text
          numberOfLines={3}
          ellipsizeMode="tail"
          style={{
            color: c.foregroundMuted,
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          {held
            ? `Ready to merge, held for ${task.hold!.reason} since ${task.hold!.since ? new Date(task.hold!.since).toLocaleString() : "an unrecorded time"} · owner ${task.hold!.owner}`
            : task.reason}
        </Text>
      }
      actions={actions}
    />
  );
}
/**
 * Spec 040: an escalated merge hold carries operator authority, so it is the one Nucleus-raised
 * item with actions: Release continues the merge; Keep renews the hold and asks for a reason.
 */
export const HoldPromptCard = React.memo(function HoldPromptCard({
  task,
  selected,
  onPress,
  c,
  board = true,
  kind,
  busy,
  onRelease,
  onKeep,
}: {
  task: TaskSummary;
  selected: boolean;
  onPress: () => void;
  c: Colors;
  board?: boolean;
  kind?: string;
  busy: boolean;
  onRelease: () => void;
  onKeep: (reason: string) => void;
}) {
  const [keeping, setKeeping] = useState(false),
    [reason, setReason] = useState("");
  return (
    <View
      accessibilityLabel={plainCardText(`Held merge: ${task.title}`)}
      style={{ gap: space.xs }}
    >
      <RaisedCard
        task={task}
        selected={selected}
        onPress={onPress}
        c={c}
        board={board}
        kind={kind}
        actions={
          <View style={{ gap: space.xs }}>
            <View style={{ ...row, gap: space.xs }}>
              <Button
                small
                c={c}
                disabled={busy}
                text="Release"
                onPress={onRelease}
              />
              <Button
                small
                c={c}
                disabled={busy}
                text="Keep"
                selected={keeping}
                onPress={() => setKeeping(!keeping)}
              />
            </View>
            {keeping && (
              <View style={{ gap: space.xs }}>
                <Field
                  c={c}
                  label="Why keep the hold (required)"
                  value={reason}
                  onChange={setReason}
                />
                <Button
                  small
                  c={c}
                  disabled={busy || !reason.trim()}
                  text="Keep hold"
                  onPress={() => {
                    onKeep(reason.trim());
                    setKeeping(false);
                    setReason("");
                  }}
                />
              </View>
            )}
          </View>
        }
      />
    </View>
  );
});
/**
 * Spec 041: a drained lane that outlived its escalation timer is the operator's to answer.
 * Close finishes the step (lane.status done); Keep records a reason and ends the episode.
 */
export const LaneDrainCard = React.memo(function LaneDrainCard({
  lane,
  selected,
  onPress,
  c,
  board = true,
  kind,
  busy,
  onClose,
  onKeep,
}: {
  lane: LaneView;
  selected: boolean;
  onPress: () => void;
  c: Colors;
  board?: boolean;
  kind?: string;
  busy: boolean;
  onClose: () => void;
  onKeep: (reason: string) => void;
}) {
  const [keeping, setKeeping] = useState(false),
    [reason, setReason] = useState("");
  return (
    <BoardCard
      label={`Drained lane: ${lane.title}`}
      onPress={onPress}
      selected={selected}
      c={c}
      board={board}
      kind={kind}
      eyebrow={
        <>
          <Icon name="Folder" size={12} color={c.foregroundMuted} />
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              flexShrink: 1,
            }}
          >
            {lane.key}
          </Text>
        </>
      }
      title={
        <Text
          numberOfLines={2}
          style={{
            color: c.foreground,
            fontWeight: "600",
            fontSize: typeScale.body.fontSize,
            lineHeight: typeScale.body.lineHeight,
          }}
        >
          {lane.title} has drained
        </Text>
      }
      chips={<RecordChips c={c} chips={["Nucleus-raised"]} />}
      snippet={
        <Text
          numberOfLines={3}
          ellipsizeMode="tail"
          style={{
            color: c.foregroundMuted,
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          {lane.aim}
          {lane.drain?.escalatedAt
            ? ` · escalated ${decisionAge(lane.drain.escalatedAt)}`
            : ""}
        </Text>
      }
      footer={
        <Text
          numberOfLines={1}
          style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
        >
          The plan owner has not answered the close-out prompt
        </Text>
      }
      actions={
        <View style={{ gap: space.xs }}>
          <View style={{ ...row, gap: space.xs }}>
            <Button
              small
              c={c}
              disabled={busy}
              text="Close"
              label={plainCardText(`Close drained lane ${lane.key}`)}
              onPress={onClose}
            />
            <Button
              small
              c={c}
              disabled={busy}
              text="Keep"
              selected={keeping}
              label={plainCardText(`Keep drained lane ${lane.key}`)}
              onPress={() => setKeeping(!keeping)}
            />
          </View>
          {keeping && (
            <View style={{ gap: space.xs }}>
              <Field
                c={c}
                label={`Why keep ${lane.title} (required)`}
                value={reason}
                onChange={setReason}
              />
              <Button
                small
                c={c}
                disabled={busy || !reason.trim()}
                text="Keep lane"
                label={plainCardText(
                  `Confirm keep for drained lane ${lane.key}`,
                )}
                onPress={() => {
                  onKeep(reason.trim());
                  setKeeping(false);
                  setReason("");
                }}
              />
            </View>
          )}
        </View>
      }
    />
  );
});
