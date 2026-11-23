import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Colors } from "../controls";
import { errorText } from "../error-text";
import type { TaskNext, UiQueueState } from "../../shared/contracts";
import { decisionAge } from "../../shared/pipeline-board";
import { clipText, latestTaskReport } from "../../shared/task-detail-summary";
import {
  taskParticipants,
  taskProgressSteps,
  taskReviewFindings,
  taskStatTiles,
  type ReviewFindingItem,
  type TaskHappening,
} from "../../shared/task-detail-view";
import { HappeningCard } from "./happening-card";
import { OperationState } from "./operation-state";
import { ProgressStrip } from "./progress-strip";
import { detailToneColor } from "./task-header";
import type { TaskDetailRead } from "./task-dialog";
import {
  cardRow,
  radius,
  roles,
  space,
  taskDetail,
  toneSurface,
  touchSlop,
  type as typeScale,
} from "../design";

function SectionHeading({
  title,
  right,
  c,
}: {
  title: string;
  right?: React.ReactNode;
  c: Colors;
}) {
  const r = roles(c);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: space.xs,
        marginBottom: space.xs,
      }}
    >
      <Text
        style={{
          color: r.foreground,
          fontSize: typeScale.body.fontSize,
          lineHeight: typeScale.body.lineHeight,
          fontWeight: "600",
        }}
      >
        {title}
      </Text>
      {right}
    </View>
  );
}

function SeverityPill({
  severity,
  c,
}: {
  severity: ReviewFindingItem["severity"];
  c: Colors;
}) {
  const r = roles(c);
  const color =
    severity === "P1" || severity === "Fail"
      ? r.danger
      : severity === "P2" || severity === "Gap"
        ? r.warning
        : severity === "OK" || severity === "Pass"
          ? r.success
          : r.muted;
  const bg =
    color === r.muted
      ? r.raised
      : toneSurface(color, r.raised, taskDetail.severityAlpha);
  return (
    <View
      style={{
        width: taskDetail.severityWidth,
        height: taskDetail.severityHeight,
        borderRadius: radius.control,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Text
        style={{
          color,
          fontSize: typeScale.metadata.fontSize,
          fontWeight: "600",
        }}
      >
        {severity}
      </Text>
    </View>
  );
}

/**
 * The redesigned Overview tab (nucleus#1537):
 * 1. What's happening card (with explicit commands & More ▾)
 * 2. Progress strip (for every task)
 * 3. Latest report (with "Read full")
 * 4. Review findings (when there is a review)
 * 5. Who's on it (Worker, Reviewer, Coordinator cards)
 * 6. Time and budget (4 stat tiles)
 */
export function OverviewTab({
  task,
  happening,
  detailQuery,
  nextQuery,
  state,
  compact,
  busy,
  pendingOperation,
  c,
}: {
  task: TaskDetailRead["task"];
  happening: TaskHappening;
  detailQuery: UseQueryResult<TaskDetailRead>;
  nextQuery: UseQueryResult<TaskNext>;
  state: UiQueueState | undefined;
  compact: boolean;
  busy: boolean;
  pendingOperation: boolean;
  c: Colors;
}) {
  const r = roles(c);
  const [reportOpen, setReportOpen] = useState(false);

  const runs = detailQuery.data?.runs ?? [];
  const next = nextQuery.data ?? null;
  const telemetry = detailQuery.data?.telemetry ?? null;

  const steps = taskProgressSteps({ task, next, runs, telemetry });
  const report = latestTaskReport(task, runs);
  const findings = taskReviewFindings(task, next, runs);
  const people = taskParticipants(task, next, runs);
  const stats = taskStatTiles({ task, next, runs, telemetry, state });

  const reportHasMore = Boolean(
    report && report.fullText.trim() !== report.headline.trim(),
  );
  const reportExcerpt = report
    ? clipText(report.fullText.replace(/\s+/g, " ").trim(), 220)
    : "";

  return (
    <View style={{ gap: space.lg }}>
      {/* 1. What's happening */}
      <HappeningCard
        key={task.id}
        taskId={task.id}
        happening={happening}
        next={next}
        nextLoading={nextQuery.isFetching}
        nextError={nextQuery.error ? errorText(nextQuery.error) : null}
        onRetryNext={() => {
          void nextQuery.refetch();
        }}
        state={state}
        busy={busy || pendingOperation}
        c={c}
      />

      <OperationState operations={detailQuery.data?.operations ?? []} c={c} />

      {/* 2. Progress strip for every task */}
      <ProgressStrip steps={steps} compact={compact} c={c} />

      {/* 3. Latest report */}
      {report && (
        <View>
          <SectionHeading
            title="Latest report"
            c={c}
            right={
              reportHasMore ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    reportOpen ? "Hide full report" : "Read full report"
                  }
                  hitSlop={touchSlop(typeScale.metadata.lineHeight)}
                  onPress={() => setReportOpen(!reportOpen)}
                >
                  <Text
                    style={{
                      color: r.accent,
                      fontSize: typeScale.metadata.fontSize,
                      fontWeight: "500",
                    }}
                  >
                    {reportOpen ? "Hide full" : "Read full"}
                  </Text>
                </Pressable>
              ) : undefined
            }
          />
          <View
            style={{
              backgroundColor: r.section,
              borderRadius: radius.panel,
              padding: space.sm,
              gap: space.xxs,
            }}
          >
            <Text
              accessibilityLabel={`Latest report: ${report.headline}`}
              style={{
                color: r.foreground,
                fontSize: typeScale.body.fontSize,
                lineHeight: typeScale.body.lineHeight,
                fontWeight: "600",
              }}
            >
              {report.headline}
            </Text>
            {reportHasMore && (
              <Text
                selectable={reportOpen}
                style={{
                  color: r.muted,
                  fontSize: typeScale.body.fontSize,
                  lineHeight: typeScale.body.lineHeight,
                }}
              >
                {reportOpen ? report.fullText : reportExcerpt}
              </Text>
            )}
            <Text
              style={{
                color: r.muted,
                fontSize: typeScale.metadata.fontSize,
                lineHeight: typeScale.metadata.lineHeight,
                marginTop: space.xxs,
              }}
            >
              {report.role.charAt(0).toUpperCase() + report.role.slice(1)}
              {report.author ? ` · ${report.author}` : ""}
              {report.at ? ` · ${decisionAge(report.at)}` : ""}
            </Text>
          </View>
        </View>
      )}

      {/* 4. Review findings */}
      {findings && (
        <View>
          <SectionHeading
            title="Review"
            c={c}
            right={
              <Text
                style={{
                  color: r.muted,
                  fontSize: typeScale.metadata.fontSize,
                }}
              >
                {findings.roundLabel}
              </Text>
            }
          />
          <View
            style={{
              backgroundColor: r.section,
              borderRadius: radius.panel,
              paddingHorizontal: space.sm,
              paddingVertical: space.xs,
            }}
          >
            {findings.items.map((item, idx) => (
              <View
                key={item.id}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: space.sm,
                  paddingVertical: space.xs,
                  borderTopWidth: idx === 0 ? 0 : 1,
                  borderTopColor: r.border,
                }}
              >
                <SeverityPill severity={item.severity} c={c} />
                <View style={{ flex: 1, minWidth: 0, gap: space.xxs / 2 }}>
                  <Text
                    style={{
                      color: r.foreground,
                      fontSize: typeScale.body.fontSize,
                      lineHeight: typeScale.body.lineHeight,
                    }}
                  >
                    {item.text}
                  </Text>
                  <Text
                    style={{
                      color: r.muted,
                      fontSize: typeScale.metadata.fontSize,
                      lineHeight: typeScale.metadata.lineHeight,
                    }}
                  >
                    {item.status}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* 5. Who's on it */}
      <View>
        <SectionHeading title="Who’s on it" c={c} />
        <View
          style={{
            flexDirection: compact ? "column" : "row",
            flexWrap: "wrap",
            gap: space.xs,
          }}
        >
          {people.map((person) => {
            const dotColor = detailToneColor(person.tone, c);
            return (
              <View
                key={person.role}
                accessibilityLabel={`${person.role}: ${person.name}, ${person.status}`}
                style={{
                  flex: compact ? undefined : 1,
                  minWidth: compact ? undefined : 160,
                  backgroundColor: r.section,
                  borderRadius: radius.panel,
                  padding: space.sm,
                  gap: space.xxs,
                }}
              >
                <Text
                  style={{
                    color: r.muted,
                    fontSize: typeScale.metadata.fontSize,
                    letterSpacing: taskDetail.eyebrowTracking,
                    textTransform: "uppercase",
                  }}
                >
                  {person.role}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{
                    color: r.foreground,
                    fontSize: typeScale.body.fontSize,
                    lineHeight: typeScale.body.lineHeight,
                    fontWeight: "600",
                  }}
                >
                  {person.name}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{
                    color: r.muted,
                    fontSize: typeScale.metadata.fontSize,
                    lineHeight: typeScale.metadata.lineHeight,
                  }}
                >
                  {person.model}
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.xs,
                    marginTop: space.xxs,
                  }}
                >
                  <View
                    style={{
                      width: cardRow.dot,
                      height: cardRow.dot,
                      borderRadius: radius.full,
                      backgroundColor: dotColor,
                    }}
                  />
                  <Text
                    numberOfLines={1}
                    style={{
                      color: r.muted,
                      fontSize: typeScale.metadata.fontSize,
                      lineHeight: typeScale.metadata.lineHeight,
                      flexShrink: 1,
                    }}
                  >
                    {person.status}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      </View>

      {/* 6. Time and budget */}
      <View>
        <SectionHeading title="Time and budget" c={c} />
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: space.xs,
          }}
        >
          {stats.map((stat) => (
            <View
              key={stat.label}
              accessibilityLabel={`${stat.label}: ${stat.value}`}
              style={{
                flexGrow: 1,
                flexBasis: compact ? "45%" : "22%",
                minWidth: 120,
                backgroundColor: r.section,
                borderRadius: radius.panel,
                padding: space.sm,
                gap: space.xxs,
              }}
            >
              <Text
                style={{
                  color: r.muted,
                  fontSize: typeScale.metadata.fontSize,
                  lineHeight: typeScale.metadata.lineHeight,
                }}
              >
                {stat.label}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  color: r.foreground,
                  fontSize: typeScale.section.fontSize,
                  lineHeight: typeScale.section.lineHeight,
                  fontWeight: "600",
                }}
              >
                {stat.value}
              </Text>
              {stat.barRatio !== undefined && (
                <View
                  style={{
                    height: taskDetail.budgetBarHeight,
                    borderRadius: radius.control,
                    backgroundColor: r.raised,
                    overflow: "hidden",
                    marginTop: space.xxs,
                  }}
                >
                  <View
                    style={{
                      width: `${Math.round(Math.min(1, Math.max(0, stat.barRatio)) * 100)}%`,
                      height: taskDetail.budgetBarHeight,
                      backgroundColor: stat.barWarning ? r.warning : r.accent,
                    }}
                  />
                </View>
              )}
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
