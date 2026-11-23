import { Linking, Platform, Pressable, Text, View } from "react-native";
import { Icon } from "../shell";
import React, { useState } from "react";
import {
  FocusRing,
  StateWash,
  muted,
  noOutline,
  row,
  type Colors,
} from "../controls";
import { useFocusVisible } from "../focus-modality";
import type {
  HeavyRunView,
  HoldKind,
  TaskSummary,
} from "../../shared/contracts";
import {
  holdBadgeTone,
  recordBadgeTone,
  stopBadgeTone,
  type BadgeTone,
} from "../../shared/badge-tones";
import { waitStateLabels } from "../../shared/wait-state";
import {
  taskWaitCardLabel,
  waitOwnerLabel,
} from "../../shared/task-detail-summary";
import {
  plainCardText,
  type DisplayTask,
  attention,
  holdKindLabel,
  presentHoldKinds,
  stopBadgeLabel,
  budgetFields,
  budgetSummary,
  interactiveBadgeLabel,
  elapsedRun,
} from "./text";
import {
  pullRequestBadge,
  pullRequestBadgeLabel,
  pullRequestNumberLabel,
} from "../../shared/pull-request-badge";
import { useTick } from "../use-tick";
import {
  cardRow,
  roles,
  space,
  toneSurface,
  touchSlop,
  type as typeScale,
  radius,
} from "../design";

export function HoldBadge({ kind, c }: { kind: HoldKind; c: Colors }) {
  const label = holdKindLabel(kind);
  return (
    <Badge label={label} tone={holdBadgeTone(kind)} c={c} bold a11y={label} />
  );
}
export function HoldChips({
  task,
  c,
  decisionTitle,
}: {
  task: DisplayTask;
  c: Colors;
  decisionTitle?: string | null;
}) {
  const wait = task.waitState;
  const kinds = presentHoldKinds(task).filter(
    (kind) => !(wait?.state === "merge_hold" && kind === "merge"),
  );
  return (
    <>
      {wait ? (
        <WaitBadge wait={wait} c={c} decisionTitle={decisionTitle} />
      ) : null}
      {kinds.map((kind) => (
        <HoldBadge key={kind} kind={kind} c={c} />
      ))}
    </>
  );
}
/**
 * Spec 043 (a): the explicit wait badge. The visible label names the state; the
 * accessibility label carries the owner and next action, so the Pipeline shows
 * who acts and what clears it. A merge hold renders here instead of the Spec 040
 * `Merge held` badge: both state the same fact, and the wait state owns it once.
 */
function WaitBadge({
  wait,
  c,
  decisionTitle,
}: {
  wait: NonNullable<TaskSummary["waitState"]>;
  c: Colors;
  decisionTitle?: string | null;
}) {
  const plainWait = taskWaitCardLabel(wait, decisionTitle);
  const label = plainWait ? "Waiting on you" : waitStateLabels[wait.state];
  const tone: BadgeTone =
    wait.state === "needs_operator_input" ||
    wait.state === "needs_source_rights"
      ? "warning"
      : wait.state === "merge_hold"
        ? "accent"
        : "neutral";
  return (
    <Badge
      label={label}
      tone={tone}
      c={c}
      bold
      a11y={
        plainWait ??
        `Wait state: ${label}; owner ${waitOwnerLabel(wait.owner)}; next ${wait.nextAction}`
      }
    />
  );
}
/**
 * nucleus#1313 (Tom, 2026-11-17): the PR is the standard icon plus `#39` in the
 * state colour, with no visible text label; the state rides the accessible label.
 * The mapping is `shared/pull-request-badge.ts`, shared with the BB sidebar's
 * task-group chip so the two surfaces cannot drift.
 */
export function PullRequestBadge({
  task,
  state,
  c,
  small = false,
  flag = false,
}: {
  task: DisplayTask;
  state?: "OPEN" | "CLOSED" | "MERGED";
  c: Colors;
  small?: boolean;
  flag?: boolean;
}) {
  if (!task.prUrl) return null;
  const status = task.resolution.mergedCommit ? "MERGED" : state;
  // Terminal PR state takes precedence over task attention.
  const badge = pullRequestBadge({
    state: status ?? null,
    blocked: attention(task),
  });
  // Merged, closed, blocked and open read as the matching theme role: the board
  // carries no GitHub palette of its own.
  const r = roles(c);
  const color =
    badge.tone === "accent"
      ? r.accent
      : badge.tone === "danger"
        ? r.danger
        : badge.tone === "warning"
          ? r.warning
          : badge.tone === "success"
            ? (r.success ?? r.accent)
            : c.foregroundMuted;
  const completionNumber =
    "completionPrNumber" in task
      ? task.completionPrNumber
      : "completion" in task
        ? (task.completion?.prNumber ?? undefined)
        : undefined;
  const number =
    task.resumePrNumber ??
    completionNumber ??
    task.prUrl.match(/\/pull\/(\d+)/)?.[1];
  const label = pullRequestBadgeLabel(number, badge);
  const content = (
    <>
      <Icon name={badge.icon} size={small ? 12 : 14} color={color} />
      <Text
        style={{
          fontSize: small
            ? typeScale.metadata.fontSize
            : typeScale.body.fontSize,
          color,
        }}
      >
        {pullRequestNumberLabel(number)}
      </Text>
    </>
  );
  const prUrl = task.prUrl;
  // The row's PR flag is a link (nucleus#1515): it opens the pull request and leaves
  // the row's own press, which opens the task detail, untouched. On the web it renders
  // as a real anchor (react-native-web turns `href` into `<a href>`), so Enter
  // activates it natively; react-native-web leaves a link role's keyboard activation
  // to that native click. Native hosts open it through Linking.
  const web = Platform.OS === "web";
  const anchor = {
    href: prUrl,
    hrefAttrs: { target: "_blank", rel: "noopener noreferrer" },
  };
  if (flag)
    return (
      <LinkChip
        label={`${label}, open on GitHub`}
        anchor={anchor}
        onPress={() => {
          if (!web) void Linking.openURL(prUrl);
        }}
        c={c}
      >
        {content}
      </LinkChip>
    );
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", gap: space.xxs }}
    >
      {content}
    </View>
  );
}
/**
 * A borderless link chip (nucleus#1540): the raised surface at rest, the hover wash
 * under the pointer. Its press never reaches the row around it.
 */
function LinkChip({
  label,
  anchor,
  onPress,
  c,
  children,
}: {
  label: string;
  anchor: object;
  onPress: () => void;
  c: Colors;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const focus = useFocusVisible();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      hitSlop={touchSlop(cardRow.tile)}
      {...anchor}
      onPress={(event?: { stopPropagation?: () => void }) => {
        event?.stopPropagation?.();
        onPress();
      }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={focus.onFocus}
      onBlur={focus.onBlur}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.xxs,
        paddingHorizontal: space.xs,
        paddingVertical: space.xxs / 2,
        borderRadius: radius.control,
        backgroundColor: roles(c).raised,
        ...noOutline(),
      }}
    >
      <StateWash c={c} hovered={hovered} />
      {children}
      <FocusRing c={c} visible={focus.visible} />
    </Pressable>
  );
}
/** The theme colour for a badge tone; neutral keeps the muted badge. */
function toneColor(tone: BadgeTone, c: Colors) {
  return tone === "danger"
    ? c.statusDanger
    : tone === "success"
      ? c.statusSuccess
      : tone === "warning"
        ? c.statusWarning
        : tone === "accent"
          ? c.accent
          : null;
}
/** A card badge: toned badges carry their colour on text and outline over the usual surface. */
export function Badge({
  label,
  tone,
  c,
  bold = false,
  a11y,
}: {
  label: string;
  tone: BadgeTone;
  c: Colors;
  bold?: boolean;
  a11y?: string;
}) {
  const color = toneColor(tone, c);
  // A toned badge reads by its tinted fill and coloured text, with no outline (nucleus#1540).
  return (
    <View
      accessible={Boolean(a11y)}
      accessibilityLabel={a11y ? plainCardText(a11y) : undefined}
      style={{
        maxWidth: "100%",
        paddingHorizontal: space.xs,
        paddingVertical: space.xxs / 2,
        borderRadius: radius.control,
        backgroundColor: color ? toneSurface(color, roles(c).raised) : roles(c).raised,
      }}
    >
      <Text
        numberOfLines={1}
        ellipsizeMode="tail"
        style={{
          ...muted(c),
          fontSize: typeScale.metadata.fontSize,
          ...(color ? { color } : {}),
          ...(bold ? { fontWeight: "600" as const } : {}),
        }}
      >
        {plainCardText(label)}
      </Text>
    </View>
  );
}
export function RecordChips({ chips, c }: { chips: string[]; c: Colors }) {
  if (!chips.length) return null;
  return (
    <View style={{ ...row, gap: space.xs, flexWrap: "wrap" }}>
      {chips.map((chip) => (
        <Badge key={chip} label={chip} tone={recordBadgeTone(chip)} c={c} />
      ))}
    </View>
  );
}
export function StopBadge({
  task,
  c,
}: {
  task: Pick<TaskSummary, "stop">;
  c: Colors;
}) {
  const label = stopBadgeLabel(task.stop);
  if (!label || !task.stop) return null;
  return (
    <Badge
      label={label}
      tone={stopBadgeTone(task.stop)}
      c={c}
      a11y={`Stop: ${label}`}
    />
  );
}
export function BudgetBadge({
  task,
  c,
}: {
  task: Pick<TaskSummary, "budget">;
  c: Colors;
}) {
  if (!task.budget) return null;
  const exhausted = budgetFields(task.budget).exhausted;
  const label = `Budget ${budgetSummary(task.budget)}`;
  return (
    <Badge
      label={label}
      tone={exhausted ? "warning" : "neutral"}
      c={c}
      a11y={exhausted ? `${label}, reached` : label}
    />
  );
}
export function InteractiveBadge({
  task,
  c,
}: {
  task: Pick<TaskSummary, "interactive" | "stopRecord" | "phase">;
  c: Colors;
}) {
  const label = interactiveBadgeLabel(task);
  return label ? (
    <Badge
      label={label}
      tone={task.stopRecord?.reason === "interactive" ? "warning" : "accent"}
      c={c}
      a11y={label}
    />
  ) : null;
}
export function HeavyRunStatus({
  run,
  c,
  detail = false,
}: {
  run: HeavyRunView;
  c: Colors;
  detail?: boolean;
}) {
  useTick(30_000);
  return (
    <View style={{ gap: space.xxs / 2 }}>
      <Text
        numberOfLines={1}
        accessibilityLabel={detail ? "Heavy run status" : undefined}
        style={{
          color: c.statusWarning,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
          fontWeight: "600",
        }}
      >
        {run.state === "queued"
          ? `Waiting for QA capacity · position ${run.position ?? "—"}`
          : `Testing: ${run.selector} · ${elapsedRun(run.launchedAt ?? run.submittedAt)}`}
        {run.holder ? ` · behind ${run.holder}` : ""}
      </Text>
      {!detail && (
        <Text
          numberOfLines={1}
          style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
        >
          {run.selector}
        </Text>
      )}
    </View>
  );
}
