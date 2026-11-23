import { activityStatus, StatusLine } from "../board/cards";
import {
  NativeQuestionAnswer,
  useTaskQuestionRequests,
} from "../native-questions";
import { formatAgentId } from "../../shared/agent-identity";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { DetailSection, muted, row, type Colors } from "../controls";
import type { Run, TaskDetail, TaskNext } from "../../shared/contracts";
import { decisionAge } from "../../shared/pipeline-board";
import { hostDisplayLabel } from "../../shared/host-outage";
import {
  budgetBars,
  budgetNeedsAttention,
  checkTicks,
  latestTaskReport,
  taskHoldRows,
  taskOverviewWait,
  taskReviewProgress,
  type CheckTick,
  type LatestReport,
} from "../../shared/task-detail-summary";
import type { TaskBudgetView } from "../../shared/task-budget";
import { radius, space, type as typeScale } from "../design";

/**
 * The task detail's first read, in one owner: the current wait or stop and who
 * owns it, the holds in force, review progress, the latest checks, the newest
 * report's headline, and the operator question the task waits on. Every fact is
 * derived from the task's recorded wait, `task.next` and its own records by
 * `shared/task-detail-summary.ts`; this module only lays them out.
 */

/** Spec 058's budget as two bars: tokens and wall time against their limits. */
function BudgetBars({ budget, c }: { budget: TaskBudgetView; c: Colors }) {
  return (
    <View style={{ gap: space.xs }}>
      {budgetBars(budget).map((bar) => (
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
/** The latest check results as short ticks: a pass, a failure, or still pending. */
const tickMark: Record<CheckTick["state"], string> = {
  pass: "✓",
  fail: "✗",
  pending: "·",
  info: "·",
};
function CheckTickRow({ ticks, c }: { ticks: CheckTick[]; c: Colors }) {
  if (!ticks.length) return null;
  return (
    <View style={{ ...row, gap: space.md, flexWrap: "wrap" }}>
      {ticks.map((tick) => (
        <Text
          key={tick.label}
          accessibilityLabel={`${tick.label}: ${tick.state}`}
          style={{
            color:
              tick.state === "fail"
                ? c.statusWarning
                : tick.state === "pass"
                  ? c.foreground
                  : c.foregroundMuted,
            fontSize: typeScale.metadata.fontSize,
          }}
        >
          {tickMark[tick.state]} {tick.label}
        </Text>
      ))}
    </View>
  );
}
/** The newest report's headline; the full text is the one press behind "Read full". */
function LatestReportRow({ report, c }: { report: LatestReport; c: Colors }) {
  const [open, setOpen] = useState(false);
  const more = report.fullText.trim() !== report.headline.trim();
  return (
    <View style={{ gap: space.xxs }}>
      <Text
        accessibilityLabel={`Latest report: ${report.headline}`}
        style={{
          color: c.foreground,
          fontWeight: "600",
          fontSize: typeScale.body.fontSize,
          lineHeight: typeScale.body.lineHeight,
        }}
      >
        {report.headline}
      </Text>
      <View style={{ ...row, gap: space.sm, flexWrap: "wrap" }}>
        <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
          {report.role}
          {report.author ? ` · ${report.author}` : ""}
          {report.at ? ` · ${decisionAge(report.at)}` : ""}
        </Text>
        {more && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={open ? "Hide full report" : "Read full report"}
            onPress={() => setOpen(!open)}
            style={{ minHeight: 24, justifyContent: "center" }}
          >
            <Text
              style={{
                color: c.accent,
                fontSize: typeScale.metadata.fontSize,
                fontWeight: "600",
              }}
            >
              {open ? "Hide full" : "Read full"}
            </Text>
          </Pressable>
        )}
      </View>
      {open && (
        <Text
          selectable
          style={{
            color: c.foregroundMuted,
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          {report.fullText}
        </Text>
      )}
    </View>
  );
}
/**
 * The Overview's first read: the current wait or stop, who owns it and the next
 * action it names. Then the holds in force, review progress, the latest checks
 * and the newest report's headline. Every fact here is derived from the task's
 * recorded wait, `task.next` and its own records; a superseded reason cannot
 * linger, because the wait comes from the current state. The budget shows only
 * when it is spent or near its limit.
 */
export function TaskSummaryBlock({
  task,
  next,
  runs,
  c,
}: {
  task: TaskDetail;
  next: TaskNext | null;
  runs: readonly Run[];
  c: Colors;
}) {
  const wait = taskOverviewWait(task.waitState, next, task.reason);
  const activity = next?.activity ?? task.activity;
  const holds = taskHoldRows(next);
  const progress = taskReviewProgress(next?.outcome);
  const report = latestTaskReport(task, runs);
  const ticks = checkTicks({
    validation: task.resolution.projectValidation ?? null,
    // A verdict at an older head, or one the task superseded, is history: it is not a current tick.
    verdict:
      next?.outcome.accepted &&
      next.outcome.accepted.currentHead &&
      !next.outcome.accepted.superseded
        ? next.outcome.accepted.status
        : null,
  });
  return (
    <DetailSection c={c}>
      {task.hostSelection && (
        <Text
          accessibilityLabel={`${next?.hostPreference ? "Host preference" : "Host selection"}: ${task.hostSelection.basis}${task.hostSelection.reason ? `; ${task.hostSelection.reason}` : ""}`}
          style={{
            ...muted(c),
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          {next?.hostPreference ? "Host preference" : "Host"} ·{" "}
          {task.hostSelection.basis.replaceAll("_", " ")}
          {task.hostSelection.reason ? ` · ${task.hostSelection.reason}` : ""}
        </Text>
      )}
      <View style={{ gap: space.xxs }}>
        {activity ? (
          <StatusLine
            c={c}
            status={{
              ...activityStatus(activity),
              a11y: `Wait: ${activity.detail}; owner ${wait.owner || "none"}; next ${wait.nextAction || "none"}`,
            }}
          />
        ) : (
          <Text
            accessibilityLabel={`Wait: ${wait.state}; owner ${wait.owner || "none"}; next ${wait.nextAction || "none"}`}
            style={{
              color: c.foreground,
              fontSize: typeScale.body.fontSize,
              fontWeight: "600",
              lineHeight: typeScale.body.lineHeight,
            }}
          >
            {wait.state}
          </Text>
        )}
        {!activity && Boolean(wait.actor) && (
          <Text
            accessibilityLabel={`Working: ${wait.actor}`}
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              lineHeight: typeScale.metadata.lineHeight,
            }}
          >
            {wait.actor}
          </Text>
        )}
        {Boolean(wait.owner) && (
          <Text
            accessibilityLabel={`Owner: ${wait.owner}`}
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              lineHeight: typeScale.metadata.lineHeight,
            }}
          >
            Owner · {wait.owner}
          </Text>
        )}
        {Boolean(wait.nextAction) && (
          <Text
            accessibilityLabel={`Next action: ${wait.nextAction}`}
            style={{
              color: c.foreground,
              fontSize: typeScale.metadata.fontSize,
              lineHeight: typeScale.metadata.lineHeight,
            }}
          >
            Next · {wait.nextAction}
          </Text>
        )}
        {Boolean(wait.detail) &&
          (wait.stop ? (
            <Text
              accessibilityLabel={`Stop: ${wait.stop.kind}; ${wait.stop.reason}; ${wait.stop.detail}`}
              selectable
              style={{
                ...muted(c),
                fontSize: typeScale.metadata.fontSize,
                lineHeight: typeScale.metadata.lineHeight,
              }}
            >
              {wait.detail} · {decisionAge(wait.stop.since)}
            </Text>
          ) : (
            <Text
              selectable
              style={{
                ...muted(c),
                fontSize: typeScale.metadata.fontSize,
                lineHeight: typeScale.metadata.lineHeight,
              }}
            >
              {wait.detail}
            </Text>
          ))}
      </View>
      {/* A host outage the engine records beside an owner-facing stop (core/engine.ts):
          the row shows only "on the host", so the detail names the host and since when. */}
      {task.resolution.hostWait && wait.stop?.reason !== "host_unavailable" && (
        <Text
          accessibilityLabel={`Host wait: waiting on ${hostDisplayLabel(task.resolution.hostWait.hostId)} since ${task.resolution.hostWait.since}`}
          style={{
            color: c.foreground,
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          Waiting on {hostDisplayLabel(task.resolution.hostWait.hostId)} ·{" "}
          {decisionAge(task.resolution.hostWait.since)}
        </Text>
      )}
      {holds.map((hold) => (
        <Text
          key={hold.kind}
          accessibilityLabel={`${hold.kind} hold: ${hold.holder}, ${hold.reason}`}
          style={{
            color: c.foregroundMuted,
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          {hold.kind === "dispatch" ? "Dispatch" : "Merge"} held by{" "}
          {hold.holder} · {hold.reason} ·{" "}
          {hold.since ? decisionAge(hold.since) : "age not recorded"}
        </Text>
      ))}
      {task.budget && budgetNeedsAttention(task.budget) && (
        <BudgetBars budget={task.budget} c={c} />
      )}
      {(progress.round || progress.verdict) && (
        <View style={{ gap: space.xxs / 2 }}>
          {progress.round && (
            <Text
              style={{
                color: c.foreground,
                fontSize: typeScale.metadata.fontSize,
                fontWeight: "600",
              }}
            >
              {progress.round}
            </Text>
          )}
          {progress.verdict && (
            <Text
              accessibilityLabel={`Latest verdict: ${progress.verdict}`}
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              {progress.verdict}
            </Text>
          )}
        </View>
      )}
      <CheckTickRow ticks={ticks} c={c} />
      {report && (
        <View
          style={{
            gap: space.xxs,
            paddingTop: space.xs,
          }}
        >
          <Text
            style={{
              ...muted(c),
              fontSize: typeScale.metadata.fontSize,
              textTransform: "uppercase",
            }}
          >
            Latest
          </Text>
          <LatestReportRow report={report} c={c} />
        </View>
      )}
    </DetailSection>
  );
}
/**
 * Task 538: the native operator question a task is waiting on, with its answer
 * controls, beside the summary. It is the same request the question pill mirrors,
 * so an answer here or on the thread resolves it once and Queue observes the same
 * resolution; the operator no longer has to find a thread's pill to unblock a task
 * that is waiting on their answer.
 */
export function PendingQuestions({
  agentId,
  hostId,
  runs,
  onAnswered,
  c,
}: {
  agentId: string | null;
  hostId: string;
  runs: readonly Run[];
  onAnswered: () => void;
  c: Colors;
}) {
  // A live reviewer asks on its own thread; a retained worker asks on the task row.
  const ids = [
    ...new Set(
      [
        agentId,
        ...runs
          .filter((run) => !run.released && run.role === "reviewer")
          .map((run) => run.agentId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const requests = useTaskQuestionRequests(
    ids,
    hostId ? ids.map((id) => formatAgentId(hostId, id)) : [],
  );
  if (!requests.length) return null;
  const asker = (id: string) => {
    const native =
      ids.find(
        (candidate) => hostId && formatAgentId(hostId, candidate) === id,
      ) ?? id;
    const run = runs.find((item) => item.agentId === native && !item.released);
    if (run)
      return `${run.role}${run.profile?.name ? ` · ${run.profile.name}` : ""}`;
    return native === agentId ? "worker" : "thread";
  };
  return (
    <DetailSection title="Waiting for your answer" c={c}>
      <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
        Answer here or in the question pill on the thread; both resolve the same
        native question.
      </Text>
      {requests.map(({ agentId: askerId, request }) => (
        <View key={`${askerId}:${request.id}`} style={{ gap: space.xs }}>
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            {asker(askerId)} asked
          </Text>
          <NativeQuestionAnswer
            agentId={askerId}
            request={request}
            onAnswered={onAnswered}
            c={c}
          />
        </View>
      ))}
    </DetailSection>
  );
}
