import { useTaskQuestions } from "../native-questions";
import { formatAgentId } from "../../shared/agent-identity";
import {
  blockingHold,
  dispatchWaitFence,
  phaseStateLabel,
  taskStateLabel,
} from "../../shared/task-state";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../shell";
import { Button, Field, muted, row, type Colors } from "../controls";
import {
  HOST_KIND_LABELS,
  hostKindOf,
  type DecisionView,
  taskNumberLabel,
  type HoldKind,
  type LaneView,
  type Task,
  type TaskSummary,
} from "../../shared/contracts";
import { waitStateLabels } from "../../shared/wait-state";
import { recordedStopIsHeld, recordedStopIsWait } from "../../shared/task-stop";
import { decisionAge, phaseNeedsAttention } from "../../shared/pipeline-board";
import {
  UNKNOWN_ASKER_LABEL,
  decisionProjectLabel,
} from "../../shared/decision-project";
import {
  taskWaitCardLabel,
  waitOwnerLabel,
} from "../../shared/task-detail-summary";
import {
  isDarkSurface,
  projectBadgeWebStyle,
  type ProjectBadge,
} from "../../shared/t3/project-badge";
import {
  projectName,
  plainCardText,
  phaseLabel,
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
  PullRequestBadge,
  Badge,
  RecordChips,
  BudgetBadge,
  InteractiveBadge,
} from "./badges";
import {
  cardRow,
  hoverSurface,
  roles,
  space,
  radius,
  toneSurface,
  type as typeScale,
} from "../design";
import { useFocusVisible } from "../focus-modality";

/**
 * Spec 026 row 12a: the single card component for the inbox board. Every card is
 * the same three-line row (Tom, 2026-11-21, nucleus#1515): a kind tile, a meta
 * line (reference or kind, project, age), the title in up to two lines, and one
 * status line — a coloured dot, the state in plain words and the single most
 * useful detail. Flags appear only for exceptions; buttons only where the card is
 * the action (hold and drained-lane prompts). Routing, host identity, profiles
 * and attempt counts live in the detail pane.
 */
/**
 * How a board card draws its frame. The inbox list (Tom, 2026-11-22) draws every
 * card as a sidebar-style row: no dividers or borders at rest, a dimmed hover
 * (and keyboard-focus) background, and the selected surface when open; the
 * content and actions are the card's own either way.
 */
export type BoardCardVariant = "card" | "row";
export const BoardCardVariantContext =
  React.createContext<BoardCardVariant>("card");

/** What a card is. Each kind has one fixed tile icon and colour; phase never changes it. */
export type CardKind =
  | "task"
  | "decision"
  | "hold"
  | "lane"
  | "lead"
  | "papercut";
/** A status or tile tone, read from the theme's colour roles. */
export type CardTone = "accent" | "success" | "warning" | "danger" | "muted";

const KIND_TILES: Record<CardKind, { icon: string; tone: CardTone }> = {
  task: { icon: "ListChecks", tone: "accent" },
  decision: { icon: "CircleHelp", tone: "warning" },
  hold: { icon: "CirclePause", tone: "warning" },
  lane: { icon: "Layers", tone: "accent" },
  // Papercut red, Lead green: the badge-colour rule's kind distinction (Spec 026).
  lead: { icon: "Lightbulb", tone: "success" },
  papercut: { icon: "Scissors", tone: "danger" },
};

/** The status line of a row: a dot in `tone`, the state in words and one detail. */
export type CardStatus = {
  tone: CardTone;
  state: string;
  detail?: string | null;
  /** The status line's own accessible name, when it carries more than it shows (a wait's owner and next action). */
  a11y?: string;
  /** The holds this status stands for, set by the branch that chose it; those are not repeated as flags. */
  holds?: readonly HoldKind[];
};

function toneColor(tone: CardTone, c: Colors): string {
  const r = roles(c);
  if (tone === "muted") return r.muted;
  return (
    (tone === "accent"
      ? r.accent
      : tone === "success"
        ? r.success
        : tone === "warning"
          ? r.warning
          : r.danger) ?? r.accent
  );
}

/** The kind tile: one icon per kind on its tone at low alpha. Decorative; the row's label names the kind. */
export function KindTile({ kind, c }: { kind: CardKind; c: Colors }) {
  const tile = KIND_TILES[kind];
  const color = toneColor(tile.tone, c);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: cardRow.tile,
        height: cardRow.tile,
        borderRadius: radius.control,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: toneSurface(color, c.surface2),
        flexShrink: 0,
      }}
    >
      <Icon name={tile.icon} size={cardRow.tileIcon} color={color} />
    </View>
  );
}

/** The project on a row's meta line: the T3 project badge when matched, otherwise the folder icon. */
export function CardProject({
  name,
  badge = null,
  c,
}: {
  name: string;
  badge?: ProjectBadge | null;
  c: Colors;
}) {
  return (
    <>
      {badge ? (
        <ProjectBadgeMark badge={badge} c={c} />
      ) : (
        <Icon name="Folder" size={12} color={c.foregroundMuted} />
      )}
      <Text
        numberOfLines={1}
        ellipsizeMode="tail"
        style={{
          ...muted(c),
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
          flexShrink: 1,
        }}
      >
        {plainCardText(name)}
      </Text>
    </>
  );
}

/** The row's status line, one line: dot, state, then ` · detail`. */
export function StatusLine({ status, c }: { status: CardStatus; c: Colors }) {
  const color = toneColor(status.tone, c);
  return (
    <View
      accessible={Boolean(status.a11y)}
      accessibilityLabel={status.a11y ? plainCardText(status.a11y) : undefined}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.xs,
        minWidth: 0,
      }}
    >
      <View
        style={{
          width: cardRow.dot,
          height: cardRow.dot,
          borderRadius: radius.full,
          backgroundColor: color,
          flexShrink: 0,
        }}
      />
      <Text
        numberOfLines={1}
        ellipsizeMode="tail"
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
          color: c.foregroundMuted,
        }}
      >
        <Text
          style={{
            color,
            fontWeight: "400",
          }}
        >
          {plainCardText(status.state)}
        </Text>
        {status.detail ? ` · ${plainCardText(status.detail)}` : ""}
      </Text>
    </View>
  );
}

/** The status as a row's accessible label reads it: `Status: <state> · <detail>`, identifiers sanitized. */
export function statusLabel(status: CardStatus): string {
  return plainCardText(
    `Status: ${status.state}${status.detail ? ` · ${status.detail}` : ""}`,
  );
}

export const BoardCard = React.memo(function BoardCard({
  label,
  onPress,
  selected,
  c,
  board = true,
  kind,
  meta,
  project,
  age,
  title,
  status,
  flags,
  actions,
}: {
  /**
   * The row's accessible name, used as given: the caller keeps the record's own title
   * and sanitizes only operational wording (`plainCardText`), so a title is announced
   * exactly as written.
   */
  label: string;
  onPress: () => void;
  selected: boolean;
  c: Colors;
  board?: boolean;
  /** The kind tile; a list's own "…and N more" row has none. */
  kind?: CardKind;
  /** Line 1's lead: the task reference, otherwise the kind in words. */
  meta?: string | null;
  /** Line 1's project: badge or folder, then the name (`CardProject`). */
  project?: React.ReactNode;
  /** Line 1's age, right-aligned, when the record carries a time. */
  age?: string | null;
  /** The record's own title, drawn as written (the caller sanitizes operational titles). */
  title: string;
  status?: CardStatus | null;
  /** Exceptions only (holds, parked, interactive, budget, the PR); a normal task has none. */
  flags?: React.ReactNode;
  /**
   * The card's own controls, drawn inside the row's frame below its content
   * (nucleus#1511). They sit outside the row's press target, so a press on a
   * control never also opens the record; other cards keep no controls at all.
   */
  actions?: React.ReactNode;
}) {
  const variant = React.useContext(BoardCardVariantContext);
  const hasMeta = Boolean(meta || project || age);
  const content = (
    <View
      pointerEvents="box-none"
      style={{ flex: 1, minWidth: 0, gap: space.xxs }}
    >
      {hasMeta && (
        <View
          pointerEvents="none"
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.xxs,
            minWidth: 0,
          }}
        >
          {meta ? (
            <Text
              numberOfLines={1}
              style={{
                color: c.foregroundMuted,
                fontSize: typeScale.metadata.fontSize,
                lineHeight: typeScale.metadata.lineHeight,
                fontWeight: "400",
                flexShrink: 0,
                marginRight: space.xxs,
              }}
            >
              {plainCardText(meta)}
            </Text>
          ) : null}
          {project ? (
            // The project group shrinks and clips as one unit, so the age keeps its place.
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.xxs,
                flexShrink: 1,
                minWidth: 0,
                overflow: "hidden",
              }}
            >
              {project}
            </View>
          ) : null}
          <View style={{ flex: 1 }} />
          {age ? (
            <Text
              numberOfLines={1}
              style={{
                ...muted(c),
                fontSize: typeScale.metadata.fontSize,
                lineHeight: typeScale.metadata.lineHeight,
                flexShrink: 0,
              }}
            >
              {age}
            </Text>
          ) : null}
        </View>
      )}
      <Text
        pointerEvents="none"
        numberOfLines={2}
        style={{
          color: c.foreground,
          fontWeight: "600",
          fontSize: typeScale.body.fontSize,
          lineHeight: typeScale.body.lineHeight,
        }}
      >
        {title}
      </Text>
      {status ? (
        <View pointerEvents="none">
          <StatusLine status={status} c={c} />
        </View>
      ) : null}
    </View>
  );
  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: space.sm,
      }}
    >
      {kind ? <KindTile kind={kind} c={c} /> : null}
      {content}
    </View>
  );
  // Sidebar-style hover and keyboard focus (nucleus#1528): a dimmed background
  // while hovered or keyboard-focused, the selected surface when the record is
  // open. Hover over a selected row keeps the selected background.
  const [hovered, setHovered] = useState(false);
  const focus = useFocusVisible();
  const highlighted = hovered || focus.visible;
  // Flags and buttons line up under the content, past the tile.
  const actionInset = kind ? cardRow.tile + space.sm : 0;
  // The flags sit outside the row's press target, like its buttons, so the PR link is
  // never nested inside the task's button: each is its own focusable control.
  const flagsRow = flags ? (
    <View
      style={{
        ...row,
        gap: space.xxs,
        flexWrap: "wrap",
      }}
    >
      {flags}
    </View>
  ) : null;
  const below = Boolean(flags) || actions !== undefined;
  // A row keeps its highlight inset from the list edges, so the hover and
  // selected backgrounds read with padding around the content; spacing alone
  // separates rows. A card's own flags and controls land inside the row.
  if (variant === "row")
    return (
      <View
        style={{
          marginHorizontal: space.xs,
          borderRadius: radius.control,
          backgroundColor: selected
            ? c.surface2
            : highlighted
              ? hoverSurface(c)
              : "transparent",
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ selected }}
          onPress={onPress}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          onFocus={focus.onFocus}
          onBlur={focus.onBlur}
          style={{
            paddingHorizontal: space.md,
            paddingTop: space.sm,
            paddingBottom: below ? space.xxs : space.sm,
          }}
        >
          {body}
        </Pressable>
        {below && (
          <View
            style={{
              gap: space.xs,
              paddingLeft: space.md + actionInset,
              paddingRight: space.md,
              paddingBottom: space.sm,
            }}
          >
            {flagsRow}
            {actions}
          </View>
        )}
      </View>
    );
  return (
    <View
      style={{
        gap: space.xs,
        padding: board ? space.sm : space.md,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: selected ? c.accent : c.border,
        backgroundColor: c.surface1,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
      >
        {body}
      </Pressable>
      {below && (
        <View style={{ gap: space.xs, paddingLeft: actionInset }}>
          {flagsRow}
          {actions}
        </View>
      )}
    </View>
  );
});
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
        minWidth: cardRow.projectMark.height,
        maxWidth: cardRow.projectMark.maxWidth,
        height: cardRow.projectMark.height,
        paddingHorizontal: cardRow.projectMark.paddingX,
        borderRadius: cardRow.projectMark.radius,
        overflow: "hidden",
        textAlign: "center",
        lineHeight: cardRow.projectMark.height,
        fontFamily: "monospace",
        fontSize: cardRow.projectMark.fontSize,
        fontWeight: "700",
      }}
    >
      {badge.monogram}
    </Text>
  );
}

/** The phase in a row's plain words (the shared short labels serve tight chips and titles). */
const ROW_PHASE_WORDS: Record<Task["phase"], string> = {
  queued: "Queued",
  dispatching: "Dispatching",
  working: "Working",
  awaiting_review: "Awaiting review",
  report_ready: "Report ready",
  blocked: "Blocked",
  error: "Error",
  needs_attention: "Needs attention",
  cancelled: "Cancelled",
  reviewing: "In review",
  changes_requested: "Changes requested",
  verifying: "Checking",
  merging: "Merging",
  syncing: "Syncing",
  closing: "Closing",
  done: "Done",
};
export function rowPhaseWords(
  task: Pick<TaskSummary, "phase" | "disposition">,
) {
  if (task.disposition && task.disposition.status !== "complete")
    return "Cancelling";
  if (task.phase === "cancelled" && task.disposition?.kind === "supersede")
    return "Superseded";
  return ROW_PHASE_WORDS[task.phase];
}
export function phaseTone(task: Pick<TaskSummary, "phase">): CardTone {
  if (task.phase === "done") return "success";
  if (task.phase === "error") return "danger";
  if (phaseNeedsAttention(task.phase)) return "warning";
  if (task.phase === "cancelled" || task.phase === "queued") return "muted";
  return "accent";
}

/**
 * A task's status when no wait, stop or run names it: the hold or wait it stands in,
 * else its phase, with the latest report (or the stored reason) as the detail.
 */
/** The fences a task is blocked on now, as hold kinds. */
function blockingHoldKinds(task: TaskSummary): HoldKind[] {
  const blocking = blockingHold(task);
  if (blocking === "both") return ["dispatch", "merge"];
  if (blocking === "dispatch" || blocking === "merge") return [blocking];
  return blocking === "held" ? presentHoldKinds(task) : [];
}
function taskFallbackStatus(
  task: TaskSummary,
  cardAttention: boolean,
): CardStatus {
  // A declared wait (Spec 043 (a)) names its state, with its next action as the detail;
  // its owner rides the accessible label.
  if (task.waitState)
    return {
      tone: cardAttention ? "warning" : "muted",
      state: waitStateLabels[task.waitState.state],
      detail: task.waitState.nextAction || null,
      holds: task.waitState.state === "merge_hold" ? ["merge"] : [],
    };
  const words = rowPhaseWords(task);
  const full = taskStateLabel(task);
  const named = Boolean(blockingHold(task));
  const state = named ? full : words;
  const detail = task.headline || task.reason || null;
  return {
    tone: cardAttention ? "warning" : named ? "muted" : phaseTone(task),
    state,
    detail: detail && detail !== state ? detail : null,
    // "Held by planner" or "Waiting on Tom" names who holds it, not which fence, so the
    // kind stays visible as its flag.
    holds: [],
  };
}
/**
 * Tom, 2026-11-07 (UI lane, step 2), restated as the three-line row (nucleus#1515):
 * a task row says what is happening and the one detail that moves it next. Long IDs,
 * lanes, profiles, routing, host waits and timestamps live in the task view.
 */
export const TaskCard = React.memo(function TaskCard({
  task,
  selected,
  onPress,
  prState,
  c,
  board = false,
  decisionTitle,
  defaultHostId,
  projectBadge = null,
  projectLabel,
}: {
  task: TaskSummary;
  selected: boolean;
  onPress: () => void;
  prState?: "OPEN" | "CLOSED" | "MERGED";
  c: Colors;
  board?: boolean;
  decisionTitle?: string | null;
  defaultHostId?: string;
  /** The generated T3 project badge for this task's repository, when its host is T3 and matched. */
  projectBadge?: ProjectBadge | null;
  /** The project's display name from the board's project lookup; the checkout name otherwise. */
  projectLabel?: string;
}) {
  const project = projectLabel ?? projectName(task);
  const hostId = task.hostId ?? defaultHostId;
  const hostKind = hostKindOf(hostId);
  // The host kind rides the accessible label only; the row's badge already marks a T3 project.
  const hostChip =
    !task.hostPending && (task.hostReason || hostKind !== "paseo")
      ? ` · ${HOST_KIND_LABELS[hostKind]}`
      : "";
  const questions = useTaskQuestions(
    task.questionAgentIds ?? [],
    hostId ? task.questionAgentIds?.map((id) => formatAgentId(hostId, id)) : [],
  );
  const archiveRetry = task.resolution.archiveRetry;
  const blocking = blockingHold(task);
  const allHoldKinds = presentHoldKinds(task);
  const a11yHoldKinds = allHoldKinds.filter(
    (kind) => !(task.waitState?.state === "merge_hold" && kind === "merge"),
  );
  const plainWait = taskWaitCardLabel(task.waitState, decisionTitle);
  const holdLabel = [
    task.waitState ? waitStateLabels[task.waitState.state] : null,
    ...a11yHoldKinds.map(holdKindLabel),
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
  const hostWait = task.hostWait;
  const holdOwner = task.holdDisplayOwner ?? "a planner thread";
  const firstQuestion = questions[0]?.questions[0]?.question;
  // A held stop stands for the fence it reports: the blocking fences, else the kind its
  // recorded fence wording names.
  const heldStopKinds: HoldKind[] = blockingHoldKinds(task).length
    ? blockingHoldKinds(task)
    : /^Dispatch held/i.test(stopRecord?.detail ?? "")
      ? ["dispatch"]
      : /^Merge held/i.test(stopRecord?.detail ?? "")
        ? ["merge"]
        : [];
  const words = rowPhaseWords(task);
  const ownStop =
    stopRecord && stopRecord.reason !== "host_unavailable"
      ? (stopDetail ?? stopLabel)
      : null;
  // The one status line (nucleus#1515): the wait or stop that moves the task next,
  // else its phase and latest report. The host's name and the routing sentence behind
  // the host choice stay in the task detail.
  const status: CardStatus = hostWait
    ? ownStop && !stopWait && !stopHeld
      ? {
          tone: "warning",
          state: "Needs attention",
          detail: `${ownStop} · waiting on the host`,
        }
      : {
          tone: "muted",
          state: "Waiting",
          detail: ownStop ? `${ownStop} · waiting on the host` : "on the host",
        }
    : plainWait
      ? {
          tone: "warning",
          state: "Waiting on you",
          detail: plainWait.replace(/^Waiting on you · /, ""),
        }
      : task.heavyRun
        ? task.heavyRun.state === "queued"
          ? {
              tone: "muted",
              state: "Waiting",
              detail: `for QA capacity · position ${task.heavyRun.position ?? "unknown"}`,
            }
          : {
              tone: "accent",
              state: words,
              detail: `Testing: ${task.heavyRun.selector} · ${elapsedRun(task.heavyRun.launchedAt ?? task.heavyRun.submittedAt)}`,
            }
        : firstQuestion
          ? { tone: "warning", state: "Question", detail: firstQuestion }
          : archiveRetry
            ? {
                tone: "warning",
                state: "Needs attention",
                detail: `Workspace archive failed: ${archiveRetry.error}`,
              }
            : prerequisite
              ? {
                  tone: "muted",
                  state: waitStateLabels.waiting_prerequisite,
                  detail: prerequisite,
                }
              : longCommandStartedAt
                ? {
                    tone: "accent",
                    state: words,
                    detail: `Long shell command · ${elapsedRun(longCommandStartedAt)}`,
                  }
                : dispatchWait
                  ? {
                      tone: "muted",
                      state: "Dispatch held",
                      detail: `by ${holdOwner}: ${holdReasonPreview(dispatchWait.reason)}`,
                      holds: ["dispatch"],
                    }
                  : stopRecord
                    ? stopWait
                      ? {
                          tone: "muted",
                          state: "Waiting",
                          detail: stopDetail?.replace(
                            /^(?:lifecycle|prerequisite|capacity|validation):?\s*/i,
                            "",
                          ),
                        }
                      : stopHeld
                        ? {
                            tone: "muted",
                            state: "Held",
                            detail: stopDetail,
                            holds: heldStopKinds,
                          }
                        : {
                            tone: "warning",
                            state: "Needs attention",
                            detail: stopDetail ?? stopLabel,
                          }
                    : taskFallbackStatus(task, cardAttention);
  const since =
    stopRecord?.since ??
    hostWait?.since ??
    dispatchWait?.since ??
    task.hold?.blockingSince ??
    task.hold?.since ??
    task.updatedAt ??
    null;
  // Ages and elapsed times read the clock; a row without one does not tick.
  useTick(since || longCommandStartedAt || task.heavyRun ? 30_000 : null);
  // Spec 043 (a): a declared wait's status names its owner and next action accessibly.
  const waitWording = task.waitState
    ? (plainWait ??
      `Wait state: ${waitStateLabels[task.waitState.state]}; owner ${waitOwnerLabel(task.waitState.owner)}; next ${task.waitState.nextAction}`)
    : undefined;
  const rowStatus: CardStatus = waitWording
    ? { ...status, a11y: waitWording }
    : status;
  // A hold flag is dropped only when the branch that chose the status stands for that
  // hold; any other status (a host wait, a question, a report) keeps it as a flag.
  const flagHoldKinds = allHoldKinds.filter(
    (kind) => !status.holds?.includes(kind),
  );
  // The approved exception set (nucleus#1515): holds, parked, interactive, budget and
  // the PR. Stop categories, a paused stop and linked decisions are in the task detail.
  const hasFlags = Boolean(
    task.parked ||
      interactiveLabel ||
      flagHoldKinds.length ||
      budgetExhausted ||
      task.prUrl,
  );
  const stopA11y = stopRecord
    ? stopWait
      ? `Waiting: ${stopDetail}`
      : stopHeld
        ? `Held: ${stopDetail}`
        : `Needs attention: ${stopDetail}; next owner ${attentionOwner}`
    : "";
  const holdOwnerA11y =
    !dispatchWait && task.holds?.merge
      ? `, Merge held by ${holdOwner}`
      : dispatchWait
        ? `, Dispatch held by ${holdOwner}`
        : "";
  const accessibleWait = hostWait
    ? // The outage host and its start time are task detail (nucleus#1515); the row
      // names the wait and its age, as its status line does.
      `, Waiting on the host · ${decisionAge(hostWait.since)}`
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
      ? a11yHoldKinds
          .map(holdKindLabel)
          .map((label) => `, ${label}`)
          .join("")
      : holdLabel;
  const fullHoldReasonA11y = dispatchWait
    ? `, Full hold reason: ${dispatchWait.reason}`
    : "";
  const reference = taskNumberLabel(task, false) || null;
  return (
    <BoardCard
      label={`${project}${hostChip}, ${task.title}, ${plainCardText(`${phaseLabel(task)}${interactiveLabel ? `, ${interactiveLabel}` : ""}${accessibleHold}${holdOwnerA11y}${accessibleWait}${fullHoldReasonA11y}${stopLabel && !stopWait && !stopHeld ? `, ${stopLabel}` : ""}${!accessibleWait && stopA11y ? `, ${stopA11y}` : ""}, ${statusLabel(status)}`)}, Action: open task details`}
      onPress={onPress}
      selected={selected}
      c={c}
      board={board}
      kind="task"
      meta={
        [reference, task.entrypoint === "review" ? "Review entry" : null]
          .filter(Boolean)
          .join(" · ") || "Task"
      }
      project={<CardProject name={project} badge={projectBadge} c={c} />}
      age={since ? decisionAge(since) : null}
      title={task.title}
      status={rowStatus}
      flags={
        hasFlags ? (
          <>
            {flagHoldKinds.map((kind) => (
              <HoldBadge key={kind} kind={kind} c={c} />
            ))}
            {task.parked && (
              <Badge
                label="Parked (no slot held)"
                tone="warning"
                c={c}
                a11y="Parked (no slot held)"
              />
            )}
            <InteractiveBadge task={task} c={c} />
            {budgetExhausted && <BudgetBadge task={task} c={c} />}
            {task.prUrl && (
              <PullRequestBadge task={task} state={prState} c={c} small flag />
            )}
          </>
        ) : undefined
      }
    />
  );
});
/**
 * A decision's choices with the recommended one first, for the decision detail and
 * its native question surfaces.
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
/**
 * Spec 032: an agent's open decision. The row carries the question, the project,
 * the age and who asked; the choices, the recommendation and the links are in the
 * decision's detail, where it is answered or withdrawn.
 */
export const DecisionCard = React.memo(function DecisionCard({
  decision,
  selected,
  onPress,
  c,
  board = true,
  projectBadge = null,
  projectLabel,
}: {
  decision: DecisionView;
  selected: boolean;
  onPress: () => void;
  c: Colors;
  board?: boolean;
  /** The asking repository's T3 project badge, when matched. */
  projectBadge?: ProjectBadge | null;
  /** The asking project's display name from the board's project lookup. */
  projectLabel?: string;
}) {
  useTick(30_000);
  const headline = decision.headline ?? decision.question;
  // Task 1183: the row names who asked — the task reference and role, or the
  // planner or agent name — never a bare agent or thread ID.
  const asker = decision.askerLabel ?? UNKNOWN_ASKER_LABEL;
  const overtaken = (decision.overtakenBy?.length ?? 0) > 0;
  const status: CardStatus = overtaken
    ? {
        tone: "muted",
        state: "Probably overtaken",
        detail: `asked by ${asker}`,
      }
    : decision.stale
      ? { tone: "warning", state: "Stale", detail: `asked by ${asker}` }
      : { tone: "warning", state: "Your answer", detail: `asked by ${asker}` };
  return (
    <BoardCard
      // An agent-written question is operational text: identifiers are sanitized in it.
      label={plainCardText(`Decision: ${headline}, ${statusLabel(status)}`)}
      onPress={onPress}
      selected={selected}
      c={c}
      board={board}
      kind="decision"
      meta="Decision"
      project={
        <CardProject
          name={projectLabel ?? decisionProjectLabel(decision)}
          badge={projectBadge}
          c={c}
        />
      }
      age={decisionAge(decision.createdAt)}
      title={plainCardText(headline)}
      status={status}
    />
  );
});
/**
 * Spec 040: an escalated hold carries operator authority, so it is the one
 * Nucleus-raised row with actions: Release continues the merge or dispatch; Keep
 * renews the hold and asks for a reason.
 */
export const HoldPromptCard = React.memo(function HoldPromptCard({
  task,
  selected,
  onPress,
  c,
  board = true,
  busy,
  onRelease,
  onKeep,
  projectBadge = null,
  projectLabel,
}: {
  task: TaskSummary;
  selected: boolean;
  onPress: () => void;
  c: Colors;
  board?: boolean;
  busy: boolean;
  onRelease: () => void;
  onKeep: (reason: string) => void;
  projectBadge?: ProjectBadge | null;
  /** The project's display name from the board's project lookup; the checkout name otherwise. */
  projectLabel?: string;
}) {
  useTick(30_000);
  const project = projectLabel ?? projectName(task);
  const [keeping, setKeeping] = useState(false),
    [reason, setReason] = useState("");
  const blocking = blockingHold(task);
  const kind =
    blocking === "dispatch" || (!blocking && task.holdKind === "dispatch")
      ? "dispatch"
      : "merge";
  const hold = task.hold;
  const ready = kind === "dispatch" ? "Ready to dispatch" : "Ready to merge";
  const reference = taskNumberLabel(task, false) || null;
  const since = hold?.blockingSince ?? hold?.since ?? null;
  const kindWord = kind === "dispatch" ? "Dispatch hold" : "Merge hold";
  const status: CardStatus = {
    tone: "warning",
    state: hold ? ready : rowPhaseWords(task),
    detail: hold ? `held for ${hold.reason}` : task.reason || null,
  };
  return (
    <View accessibilityLabel={`Held ${kind}: ${task.title}`}>
      <BoardCard
        label={`${kindWord}: ${task.title}, ${project}, ${statusLabel(status)}${hold ? plainCardText(`, owner ${hold.owner}`) : ""}`}
        onPress={onPress}
        selected={selected}
        c={c}
        board={board}
        kind="hold"
        meta={[kindWord, reference].filter(Boolean).join(" · ")}
        project={<CardProject name={project} badge={projectBadge} c={c} />}
        age={since ? decisionAge(since) : null}
        title={task.title}
        status={status}
        flags={
          task.prUrl ? (
            <PullRequestBadge task={task} c={c} small flag />
          ) : undefined
        }
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
 * The lane's aim is in the plan view the row opens.
 */
export const LaneDrainCard = React.memo(function LaneDrainCard({
  lane,
  selected,
  onPress,
  c,
  board = true,
  busy,
  onClose,
  onKeep,
  project,
}: {
  lane: LaneView;
  selected: boolean;
  onPress: () => void;
  c: Colors;
  board?: boolean;
  busy: boolean;
  onClose: () => void;
  onKeep: (reason: string) => void;
  /** Line 1's project: the lane's projects with their badges; the lane key when it has none. */
  project?: React.ReactNode;
}) {
  useTick(lane.drain?.escalatedAt ? 30_000 : null);
  const laneStatus: CardStatus = {
    tone: "success",
    state: "Drained",
    detail: "plan owner has not answered",
  };
  const [keeping, setKeeping] = useState(false),
    [reason, setReason] = useState("");
  return (
    <BoardCard
      label={`Drained lane: ${lane.title}, ${statusLabel(laneStatus)}`}
      onPress={onPress}
      selected={selected}
      c={c}
      board={board}
      kind="lane"
      meta="Lane drained"
      project={project ?? <CardProject name={lane.key} c={c} />}
      age={lane.drain?.escalatedAt ? decisionAge(lane.drain.escalatedAt) : null}
      title={`${lane.title} has drained`}
      status={laneStatus}
      actions={
        <View style={{ gap: space.xs }}>
          <View style={{ ...row, gap: space.xs }}>
            <Button
              small
              c={c}
              disabled={busy}
              text="Close lane"
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
