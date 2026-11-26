import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  Button,
  Disclosure,
  SurfacePress,
  muted,
  row,
  useCardFill,
  type Colors,
} from "../controls";
import * as api from "../../shared/contracts";
import type { Run, Task } from "../../shared/contracts";
import {
  eventActorFact,
  eventDetailSummary,
  eventKindLabel,
} from "../../shared/task-events";
import {
  radius,
  roles,
  space,
  taskDetail,
  touchTarget,
  type as typeScale,
} from "../design";
import { launchThinkingLevel } from "../../shared/profile-vocabulary";
import { hostKindOf } from "../../shared/host-kind";
import { HOST_VOCABULARIES } from "../../hosts/vocabularies";

import type { BudgetBar } from "../../shared/task-detail-summary";

export function BudgetBars({ bars, c }: { bars: readonly BudgetBar[]; c: Colors }) {
  return (
    <View style={{ gap: space.xs }}>
      {bars.map((bar) => (
        <View key={bar.key} style={{ gap: space.xxs }}>
          <View
            style={{
              ...row,
              flexWrap: "nowrap",
              justifyContent: "space-between",
              gap: space.sm,
            }}
          >
            <Text
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              {bar.label}
            </Text>
            <Text
              accessibilityLabel={`${bar.label} budget ${bar.text}`}
              style={{
                color: bar.ratio >= 1 ? c.statusWarning : c.foregroundMuted,
                fontSize: typeScale.metadata.fontSize,
              }}
            >
              {bar.text}
            </Text>
          </View>
          <View
            style={{
              height: 5,
              borderRadius: radius.control,
              backgroundColor: c.surface2,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${Math.round(bar.ratio * 100)}%`,
                height: 5,
                borderRadius: radius.control,
                backgroundColor: bar.ratio >= 1 ? c.statusWarning : c.accent,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Task 538 (papercut 90104e7f): one collapsed group in the task detail. The
 * rest of the dialog is one press away and nothing is deleted.
 */
export function CollapsibleSection({
  title,
  hint,
  open,
  onToggle,
  c,
  children,
}: {
  title: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  c: Colors;
  children: React.ReactNode;
}) {
  const fill = useCardFill(c);
  return (
    <View
      style={{
        borderRadius: radius.control,
        backgroundColor: fill,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: space.sm,
        }}
      >
        <Disclosure
          c={c}
          label={title}
          accessibilityLabel={`${title}, ${open ? "expanded" : "collapsed"}`}
          expanded={open}
          onToggle={onToggle}
        />
        {hint && (
          <Text
            numberOfLines={1}
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              flexShrink: 1,
            }}
          >
            {hint}
          </Text>
        )}
      </View>
      {open && (
        <View
          style={{
            gap: space.sm,
            paddingHorizontal: space.sm,
            paddingBottom: space.sm,
          }}
        >
          {children}
        </View>
      )}
    </View>
  );
}
/** One row of task identity. Raw rows (IDs, commits, host) sit behind a disclosure; the rest are facts an operator reads. */
type IdentityField = { label: string; value: string; raw: boolean };
/**
 * The canonical level a task's routing snapshot launches with, read back through
 * its host's table (nucleus#1365): T3 carries Pi's level as its `thinking` option
 * and Claude's `ultra` as `ultrathink`, so the snapshot's own spelling is not what
 * the operator chose.
 */
function profileThinking(task: Task): string {
  const profile = task.profile!;
  const vocabulary = HOST_VOCABULARIES[hostKindOf(task.hostId)];
  return (
    (vocabulary ? launchThinkingLevel(vocabulary, profile) : null) ??
    profile.thinkingOptionId ??
    "provider default"
  );
}
export function taskIdentityFields(task: Task): IdentityField[] {
  const fields: IdentityField[] = [
    { label: "Repository", value: task.repoPath, raw: false },
    {
      label: "Lanes",
      value: task.laneContext.length
        ? task.laneContext
            .map((context) => `${context.title} (${context.key})`)
            .join(", ")
        : "None",
      raw: false,
    },
    {
      label: "Project queue",
      value: task.queuePriority ? "Promoted" : "Normal order",
      raw: false,
    },
    { label: "Branch", value: task.branch, raw: false },
    {
      label: "Profile",
      value: task.profile
        ? `${task.profile.name} · ${profileThinking(task)}`
        : "Not assigned",
      raw: false,
    },
    {
      label: "Worker request",
      value: task.profileRequests?.worker
        ? `${task.profileRequests.worker.profileId} · ${task.profileRequests.worker.reason}`
        : "Automatic",
      raw: false,
    },
    {
      label: "Reviewer request",
      value: task.profileRequests?.reviewer
        ? `${task.profileRequests.reviewer.profileId} · ${task.profileRequests.reviewer.reason}`
        : "Automatic",
      raw: false,
    },
    { label: "Pull request", value: task.prUrl ?? "Not created", raw: false },
    {
      label: "PR review",
      value: task.skipPRReview
        ? "Skipped at submission · merge on completion"
        : "Required",
      raw: false,
    },
  ];
  if (task.proofReceiptAcceptance) {
    const acceptance = task.proofReceiptAcceptance;
    fields.push({
      label: "Receipt accepted",
      value: `${acceptance.acceptedBy} · ${acceptance.reason} · receipt ${acceptance.runId}\nOriginal failed qualification and reviewer verdict: ${acceptance.originalResult.evidence}`,
      raw: false,
    });
  }
  if (task.resolution.ownerAcceptances?.length)
    fields.push({
      label: "Owner acceptance",
      value: ownerAcceptanceLabel(task.resolution.ownerAcceptances.at(-1)!),
      raw: false,
    });
  if (task.resolution.ownerSettlements.length)
    fields.push({
      label: "Owner settled",
      value: task.resolution.ownerSettlements
        .map(
          (item) =>
            `${item.effect} · ${item.caller} (${item.source.replaceAll("_", " ")}) · ${item.reason}`,
        )
        .join("\n"),
      raw: false,
    });
  const raw: IdentityField[] = [
    { label: "Created by", value: task.originAgentId, raw: true },
    { label: "Host", value: task.hostId, raw: true },
    { label: "Planning commit", value: task.planningCommit, raw: true },
    task.briefVersions.length
      ? {
          label: "Brief",
          value: `Nucleus-held · version ${task.briefVersions.at(-1)!.version} · ${task.briefVersions.at(-1)!.digest.slice(0, 19)}`,
          raw: true,
        }
      : { label: "Handoff", value: task.handoffPath, raw: true },
    { label: "Worker", value: task.agentId ?? "Not assigned", raw: true },
  ];
  return [...fields, ...raw];
}

/** A chronological event summary with its complete, original audit row available on demand. */
export function EventRow({
  event,
  c,
}: {
  event: {
    id?: number;
    taskId?: string;
    at: string;
    kind: string;
    detail: string;
  };
  c: Colors;
}) {
  const kind = eventKindLabel(event.kind);
  const actorFact = eventActorFact(event.detail);
  const actor = actorFact.kind === "named" ? actorFact.actor : "Not recorded";
  const when = new Date(event.at).toLocaleString();
  return (
    <View
      accessibilityLabel={`${kind}, actor ${actor}, ${when}`}
      style={{
        gap: space.xxs,
        paddingBottom: space.xs,
      }}
    >
      <Text
        style={{
          color: c.foreground,
          fontSize: typeScale.body.fontSize,
          fontWeight: "600",
        }}
      >
        {kind}
      </Text>
      <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
        {actor} · {when}
      </Text>
      <Text
        selectable
        style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
      >
        {eventDetailSummary(event.detail) || kind}
      </Text>
      <RawRecords
        label={`Original event${event.id === undefined ? "" : ` ${event.id}`}`}
        c={c}
      >
        <Text
          selectable
          accessibilityLabel="Original event kind"
          style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
        >
          {event.kind}
        </Text>
        <Text
          selectable
          accessibilityLabel="Original event actor"
          style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
        >
          Actor · {actor}
        </Text>
        <Text
          selectable
          accessibilityLabel="Original event time"
          style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
        >
          {event.at}
        </Text>
        {event.id !== undefined && (
          <Text
            selectable
            accessibilityLabel="Original event ID"
            style={{
              color: c.foreground,
              fontSize: typeScale.metadata.fontSize,
            }}
          >
            Event ID · {event.id}
          </Text>
        )}
        {event.taskId && (
          <Text
            selectable
            accessibilityLabel="Original event task ID"
            style={{
              color: c.foreground,
              fontSize: typeScale.metadata.fontSize,
            }}
          >
            Task ID · {event.taskId}
          </Text>
        )}
        <Text
          selectable
          accessibilityLabel="Complete original event detail"
          style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
        >
          {event.detail || "No detail recorded"}
        </Text>
      </RawRecords>
    </View>
  );
}

export type TaskDetailTab = "overview" | "activity" | "details";
const taskDetailTabLabels: ReadonlyArray<readonly [TaskDetailTab, string]> = [
  ["overview", "Overview"],
  ["activity", "Activity"],
  ["details", "Details"],
];

export function TaskDetailTabs({
  tab,
  onSelect,
  activityCount = 0,
  compact,
  c,
}: {
  tab: TaskDetailTab;
  onSelect: (tab: TaskDetailTab) => void;
  activityCount?: number;
  compact: boolean;
  c: Colors;
}) {
  const r = roles(c);
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="Task detail sections"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: space.xxs,
        paddingHorizontal: compact ? space.md : space.lg,
      }}
    >
      {taskDetailTabLabels.map(([value, label]) => {
        const selected = tab === value;
        const count =
          value === "activity" && activityCount > 0 ? activityCount : null;
        return (
          <SurfacePress
            key={value}
            role="tab"
            label={label}
            selected={selected}
            onPress={() => onSelect(value)}
            c={c}
            corner={radius.control}
            style={{
              minHeight: touchTarget,
              flexDirection: "row",
              alignItems: "center",
              gap: space.xxs,
              paddingHorizontal: space.sm,
            }}
          >
            <Text
              style={{
                color: selected ? r.foreground : r.muted,
                fontSize: typeScale.body.fontSize,
                fontWeight: selected ? "600" : "400",
              }}
            >
              {label}
            </Text>
            {count !== null && (
              <Text
                style={{
                  color: r.muted,
                  fontSize: typeScale.metadata.fontSize,
                }}
              >
                {count}
              </Text>
            )}
          </SurfacePress>
        );
      })}
    </View>
  );
}

export function TechnicalActivityEvents({
  events,
  c,
}: {
  events: Array<{ id: number; at: string; kind: string; detail: string }>;
  c: Colors;
}) {
  const [open, setOpen] = useState(false);
  if (!events.length) return null;
  return (
    <CollapsibleSection
      title={`Show technical events (${events.length})`}
      hint="Stage and setup details"
      open={open}
      onToggle={() => setOpen((value) => !value)}
      c={c}
    >
      {events.map((event) => (
        <EventRow key={event.id} event={event} c={c} />
      ))}
    </CollapsibleSection>
  );
}

/** One run: its role, state and result, with its thread when the host can open it. */
export function RunRow({
  run,
  c,
  openThread,
}: {
  run: Run;
  c: Colors;
  openThread?: () => void;
}) {
  return (
    <View style={{ ...row, justifyContent: "space-between" }}>
      <Text
        selectable
        style={{
          ...muted(c),
          fontSize: typeScale.metadata.fontSize,
          flexShrink: 1,
        }}
      >
        {run.role} · {run.status} · {run.profile?.name ?? "Assigned thread"} ·{" "}
        {run.completion?.status ??
          (run.idleSince && !run.released
            ? "Missing result"
            : "Awaiting result")}
      </Text>
      {openThread && (
        <Button
          small
          c={c}
          text="Open thread"
          label={`Open ${run.role} thread`}
          onPress={openThread}
        />
      )}
    </View>
  );
}
/** One task message: who it went to or came from, its plain delivery state and its text. */
export function MessageRow({
  message,
  taskId,
  c,
}: {
  message: api.AgentMessageRecord;
  taskId: string;
  c: Colors;
}) {
  const sent = message.fromTaskId === taskId;
  const counterpart = sent
    ? (message.toReference ?? message.toTaskId)
    : (message.fromReference ?? message.fromTaskId);
  // Queued is pending and expired is a failed delivery. A message is never unknown, so no retry advice applies here.
  const statusColor =
    message.status === "delivered"
      ? c.statusSuccess
      : message.status === "expired"
        ? c.statusDanger
        : c.statusWarning;
  const deliveryLabel =
    message.status === "delivered"
      ? "Delivered"
      : message.status === "expired"
        ? "Not delivered · expired before delivery"
        : message.status === "uncertain"
          ? "Delivery unknown · awaiting review"
          : "Queued · waiting for the recipient\u2019s next turn";
  return (
    <View
      style={{
        gap: space.xxs,
        paddingBottom: space.xs,
      }}
    >
      <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
        {new Date(message.createdAt).toLocaleString()} ·{" "}
        {sent ? "sent to" : "received from"} {counterpart} (
        {sent ? message.toRole : message.fromRole})
        {message.fromProject ? ` · ${message.fromProject}` : ""}
      </Text>
      <Text
        accessibilityLabel={`Delivery ${deliveryLabel}`}
        style={{
          ...muted(c),
          fontSize: typeScale.metadata.fontSize,
          color: statusColor,
        }}
      >
        {deliveryLabel}
        {message.error ? ` · last note: ${message.error}` : ""}
      </Text>
      <Text
        selectable
        style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
      >
        {message.text}
      </Text>
    </View>
  );
}

/** Raw records behind one labelled disclosure: collapsed until asked for, never deleted. */
export function RawRecords({
  label,
  c,
  children,
}: {
  label: string;
  c: Colors;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: space.xs }}>
      <Disclosure
        c={c}
        label={label}
        expanded={open}
        onToggle={() => setOpen((value) => !value)}
      />
      {open && children}
    </View>
  );
}

export function DetailField({
  label,
  value,
  c,
  compact,
}: {
  label: string;
  value: string;
  c: Colors;
  compact: boolean;
}) {
  return (
    <View
      style={{
        gap: space.xxs / 2,
        minWidth: 0,
        flexGrow: 1,
        flexBasis: compact ? "100%" : 250,
      }}
    >
      <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
        {label}
      </Text>
      <Text
        selectable
        style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
      >
        {value}
      </Text>
    </View>
  );
}
/** A record dialog's last action result. */
export type RecordNoticeValue = { kind: "ok" | "error"; text: string };
/** The board's action runner: refreshes the board and the open records; a failure lands on the board or, with "record", the open record's notice. */
export type BoardAct = (
  fn: () => Promise<unknown>,
  into?: "board" | "record",
) => Promise<void>;
export function RecordNotice({
  notice,
  c,
}: {
  notice: RecordNoticeValue | null;
  c: Colors;
}) {
  if (!notice) return null;
  return (
    <Text
      accessibilityRole={notice.kind === "error" ? "alert" : undefined}
      accessibilityLabel={
        notice.kind === "error" ? "Record action error" : "Record action result"
      }
      style={{
        color: notice.kind === "error" ? c.statusDanger : c.foreground,
        fontSize: typeScale.metadata.fontSize,
      }}
    >
      {notice.text}
    </Text>
  );
}
/** One-line truth for the task identity row: the recorded owner acceptance beside the reviewer verdict it kept. */
function ownerAcceptanceLabel(
  record: NonNullable<Task["resolution"]["ownerAcceptances"]>[number],
): string {
  const who =
    record.actor.role === "operator"
      ? "operator"
      : record.actor.role === "authorized_relay"
        ? `relayed by ${record.actor.agentId}`
        : record.actor.role === "delegated"
          ? `delegated to ${record.actor.agentId}`
          : record.actor.agentId;
  if (record.kind === "external_merge_source")
    return `${record.actor.role === "planner" ? `Planner ${who}` : "Operator"} accepted external merge · head ${record.head.slice(0, 12)} · ${record.missingEvidence}`;
  // A source acceptance is accepted risk, not verified review: the board names what was missing.
  const kind =
    record.kind === "operator_source"
      ? `Source acceptance · no review evidence (${record.missingEvidence ?? "unrecorded"}) · `
      : "";
  return `${kind}${record.actor.role === "project_owner" ? "Project owner" : record.actor.role === "operator" ? "Operator" : "Relayed acceptance"} · ${who} · head ${record.head.slice(0, 12)} · ${record.qualification.slice(0, 160)}${record.qualification.length > 160 ? "…" : ""}`;
}
