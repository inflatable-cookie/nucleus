import { useState } from "react";
import { Text, View } from "react-native";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  Button,
  DetailSection,
  muted,
  row,
  TextLink,
  type Colors,
} from "../controls";
import { Icon } from "../shell";
import * as api from "../../shared/contracts";
import {
  holdsOf,
  type TaskNext,
  type UiQueueState,
} from "../../shared/contracts";
import { buildOutputDisclosure } from "../../shared/build-output-disclosure";
import { hostDisplayLabel } from "../../shared/host-outage";
import {
  operationOccurrenceSettlement,
  operationStateLabel,
  type QueueOperation,
} from "../../shared/operations";
import { decisionAge } from "../../shared/pipeline-board";
import { checkpointStateLabel } from "../../shared/task-state";
import { HeavyRunStatus } from "../board/badges";
import { budgetSummary, phaseLabel } from "../board/text";
import {
  CompactTelemetrySummary,
  ProjectValidationSection,
} from "../telemetry-parts";
import { RoutingPolicyLines, VerbReference } from "./next-section";
import {
  CollapsibleSection,
  RawRecords,
  RunRow,
  taskIdentityFields,
} from "./parts";
import { PrerequisiteList } from "./dependencies";
import { RunsCloseout } from "./runs-closeout";
import { buildOutputCleanupSubject, taskRunPartition } from "./runs-view";
import type { TaskDetailRead } from "./task-dialog";
import type { BoardNavigation } from "../shell/types";
import { radius, roles, space, taskDetail, type as typeScale } from "../design";

function KvRow({
  label,
  value,
  compact,
  c,
}: {
  label: string;
  value: string;
  compact: boolean;
  c: Colors;
}) {
  const r = roles(c);
  return (
    <View
      style={{
        flexDirection: compact ? "column" : "row",
        gap: compact ? space.xxs / 2 : space.md,
        paddingVertical: space.xxs,
      }}
    >
      <Text
        style={{
          color: r.muted,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
          width: compact ? undefined : taskDetail.kvLabelWidth,
          flexShrink: 0,
        }}
      >
        {label}
      </Text>
      <Text
        selectable
        style={{
          color: r.foreground,
          fontSize: typeScale.metadata.fontSize,
          lineHeight: typeScale.metadata.lineHeight,
          flex: 1,
          minWidth: 0,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function OperationsList({
  operations,
  c,
}: {
  operations: QueueOperation[];
  c: Colors;
}) {
  const r = roles(c);
  if (!operations.length) return null;
  return (
    <View style={{ gap: space.xxs }}>
      {operations.slice(0, 6).map((operation) => {
        const settled = Boolean(operationOccurrenceSettlement(operation));
        const attention =
          !settled &&
          (operation.state === "needs_attention" ||
            operation.state === "failed");
        const color = attention
          ? r.warning
          : settled || operation.state === "succeeded"
            ? r.muted
            : r.accent;
        return (
          <View
            key={operation.id}
            style={{ ...row, flexWrap: "nowrap", gap: space.xs }}
          >
            <Icon
              name={
                attention
                  ? "TriangleAlert"
                  : settled || operation.state === "succeeded"
                    ? "Check"
                    : "LoaderCircle"
              }
              size={12}
              color={color}
            />
            <Text
              numberOfLines={2}
              selectable
              accessibilityLabel={operationStateLabel(operation)}
              style={{
                color,
                fontSize: typeScale.metadata.fontSize,
                flex: 1,
                minWidth: 0,
              }}
            >
              {operationStateLabel(operation)}
              {!settled && operation.diagnostic
                ? ` · ${operation.diagnostic}`
                : ""}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * The redesigned Details tab (nucleus#1537):
 * Everything technical and deep lives here so nothing from today's 5 tabs is lost:
 * - Key-value list (repository, branch, lanes, host & why, profiles & requests, PR & head, origin, task ID)
 * - Routing and timing (phase timings, interventions, usage, validation, budget)
 * - All owner verbs with availability & refusals
 * - Raw stop detail, holds, operations, hooks, review entry, disposition
 * - Prerequisites, worker exclusions, retired workers, completion cohort, closeout
 * - Runs and delivery records
 * - Build-output records
 * - Raw IDs and records.
 */
export function DetailsTab({
  task,
  detailQuery,
  nextQuery,
  state,
  compact,
  navigation,
  onSelectTask,
  c,
}: {
  task: TaskDetailRead["task"];
  detailQuery: UseQueryResult<TaskDetailRead>;
  nextQuery: UseQueryResult<TaskNext>;
  state: UiQueueState | undefined;
  compact: boolean;
  navigation?: BoardNavigation;
  onSelectTask: (id: string) => void;
  c: Colors;
}) {
  const r = roles(c);
  const [verbsOpen, setVerbsOpen] = useState(
    (nextQuery.data?.verbs.length ?? 0) <= 6,
  );
  const [runsOpen, setRunsOpen] = useState(true);
  const [buildOutputOpen, setBuildOutputOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  const runs = detailQuery.data?.runs ?? [];
  const { live, earlier } = taskRunPartition(runs);
  const operations: QueueOperation[] = detailQuery.data?.operations ?? [];
  const next = nextQuery.data ?? null;
  const fences = holdsOf(task);
  // The raw stop the Overview's plain copy came from: next's live stop first, then the stored one.
  const taskSummaryStop =
    next?.stop ??
    state?.tasks.find((item) => item.id === task.id)?.stopRecord ??
    task.resolution.stop;
  const runBoundCleanup = buildOutputDisclosure(
    task.resolution.buildOutputCleanups,
    buildOutputCleanupSubject(task),
  );
  const stalledIncident =
    task.resolution.incident?.cause === "stalled_turn" &&
    task.resolution.incident.status !== "resolved"
      ? task.resolution.incident
      : null;
  const stalledTurnStop = task.resolution.stalledTurnStop ?? null;

  const identity = taskIdentityFields(task);
  const nonRawIdentity = identity.filter((f) => !f.raw);
  const rawIdentity = identity.filter((f) => f.raw);

  const hostWhy = task.hostSelection
    ? `${hostDisplayLabel(task.hostSelection.hostId)} (${task.hostSelection.basis.replaceAll("_", " ")}${task.hostSelection.reason ? ` · ${task.hostSelection.reason}` : ""})`
    : task.hostId
      ? hostDisplayLabel(task.hostId)
      : "Not assigned";

  const kvEntries: Array<{ label: string; value: string }> = [
    ...nonRawIdentity.map((f) => ({ label: f.label, value: f.value })),
    {
      label: next?.hostPreference ? "Host preference" : "Host",
      value: hostWhy,
    },
    ...(task.prHead ? [{ label: "PR head", value: task.prHead }] : []),
    { label: "Origin", value: task.originAgentId },
    { label: "Task ID", value: task.id },
  ];

  return (
    <View style={{ gap: space.md }}>
      {/* 1. Key-value list */}
      <View
        accessibilityLabel="Task details"
        style={{
          backgroundColor: r.section,
          borderRadius: radius.panel,
          padding: space.sm,
        }}
      >
        {kvEntries.map((entry) => (
          <KvRow
            key={entry.label}
            label={entry.label}
            value={entry.value}
            compact={compact}
            c={c}
          />
        ))}
      </View>

      {/* 2. Routing and timing */}
      <DetailSection title="Routing and timing" c={c}>
        {next?.workerDemandStep && (
          <Text
            accessibilityLabel={`Worker demand ${next.workerDemandStep}`}
            style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
          >
            Worker demand · {next.workerDemandStep}
          </Text>
        )}
        {next && <RoutingPolicyLines policy={next.routingPolicy} c={c} />}
        {task.budget && (
          <Text
            accessibilityLabel={`Budget: ${budgetSummary(task.budget)}${task.budget.exhausted ? `; reached on ${task.budget.exhausted === "wall_time" ? "wall time" : "effective tokens"}` : ""}`}
            style={{
              color: task.budget.exhausted ? r.warning : r.muted,
              fontSize: typeScale.metadata.fontSize,
            }}
          >
            Budget · {budgetSummary(task.budget)}
            {task.budget.exhausted
              ? ` · reached on ${task.budget.exhausted === "wall_time" ? "wall time" : "effective tokens"}`
              : ""}
          </Text>
        )}
        {task.heavyRun && <HeavyRunStatus run={task.heavyRun} c={c} detail />}
        {detailQuery.data?.telemetry && (
          <CompactTelemetrySummary
            telemetry={detailQuery.data.telemetry}
            c={c}
          />
        )}
        {task.resolution.projectValidation && (
          <ProjectValidationSection task={task} c={c} />
        )}
      </DetailSection>

      {/* 3. All owner verbs with availability & refusals */}
      {next && next.verbs.length > 0 && (
        <CollapsibleSection
          title={`All owner verbs (${next.verbs.length})`}
          hint={`${next.verbs.filter((v) => v.available).length} available`}
          open={verbsOpen}
          onToggle={() => setVerbsOpen((v) => !v)}
          c={c}
        >
          <VerbReference verbs={next.verbs} c={c} />
        </CollapsibleSection>
      )}

      {/* 4. Raw stop detail, holds, host wait, operations, disposition */}
      {(taskSummaryStop ||
        next?.stop ||
        task.resolution.hostWait ||
        fences.dispatch ||
        fences.merge ||
        stalledIncident ||
        task.originError ||
        task.originLookupError ||
        operations.length > 0 ||
        task.disposition) && (
        <DetailSection title="Raw stop and status records" c={c}>
          {taskSummaryStop && (
            <View style={{ gap: space.xxs }}>
              <Text
                accessibilityLabel={`Stop category ${taskSummaryStop.reason}`}
                selectable
                style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
              >
                Stop category · {taskSummaryStop.reason} ·{" "}
                {decisionAge(taskSummaryStop.since)}
              </Text>
              <Text
                selectable
                style={{
                  color: r.foreground,
                  fontSize: typeScale.metadata.fontSize,
                }}
              >
                {taskSummaryStop.detail}
              </Text>
              {taskSummaryStop.suggestedVerbs.length > 0 && (
                <Text
                  accessibilityLabel={`Suggested owner verbs ${taskSummaryStop.suggestedVerbs.join(", ")}`}
                  selectable
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  Suggested owner verbs ·{" "}
                  {taskSummaryStop.suggestedVerbs.join(", ")}
                </Text>
              )}
            </View>
          )}
          {task.resolution.hostWait && (
            <Text
              accessibilityLabel={`Host wait: waiting on ${hostDisplayLabel(task.resolution.hostWait.hostId)} since ${task.resolution.hostWait.since}`}
              selectable
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              Host wait · {hostDisplayLabel(task.resolution.hostWait.hostId)} ·{" "}
              {decisionAge(task.resolution.hostWait.since)}
            </Text>
          )}
          {fences.dispatch && (
            <Text
              accessibilityLabel="Dispatch hold owner and reason"
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              Dispatch held by {api.holdOwnerOf(task, fences.dispatch.owner)} ·{" "}
              {fences.dispatch.reason} ·{" "}
              {fences.dispatch.at
                ? decisionAge(fences.dispatch.at)
                : "age not recorded"}
            </Text>
          )}
          {fences.merge && (
            <Text
              accessibilityLabel="Merge hold owner and reason"
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              Merge held by {api.holdOwnerOf(task, fences.merge.owner)} ·{" "}
              {fences.merge.reason} ·{" "}
              {fences.merge.at
                ? decisionAge(fences.merge.at)
                : "age not recorded"}
            </Text>
          )}
          {(task.originError || task.originLookupError) && (
            <Text
              style={{
                color: r.warning,
                fontSize: typeScale.metadata.fontSize,
              }}
            >
              Origin routing: {task.originError || task.originLookupError}
            </Text>
          )}
          {stalledIncident && (
            <Text
              selectable
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              Stalled turn · run {stalledIncident.runId} · turn{" "}
              {stalledIncident.turnId ?? "unknown"}
              {stalledTurnStop
                ? ` · stop ${stalledTurnStop.status} for turn ${stalledTurnStop.turnId}`
                : " · the run still owns its task"}
            </Text>
          )}
          {stalledIncident && stalledTurnStop && (
            <Text
              selectable
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              {stalledTurnStop.detail ||
                (stalledTurnStop.status === "sent"
                  ? "Waiting for Nucleus to observe inactivity; the run lease stays held and no replacement starts automatically."
                  : "")}
            </Text>
          )}
          {task.disposition && (
            <View style={{ gap: space.xxs }}>
              <Text
                style={{
                  color: r.foreground,
                  fontSize: typeScale.metadata.fontSize,
                  fontWeight: "600",
                }}
              >
                Disposition · {task.disposition.kind} ({task.disposition.status}
                )
              </Text>
              <Text
                selectable
                style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
              >
                {task.disposition.reason} · requested by{" "}
                {task.disposition.requestedBy}
                {task.disposition.completedAt
                  ? ` · completed ${task.disposition.completedAt}`
                  : ""}
              </Text>
              {task.disposition.replacementTaskId && (
                <Text
                  selectable
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  Replacement: {task.disposition.replacementTaskId}
                  {task.disposition.replacementBranch
                    ? ` · branch ${task.disposition.replacementBranch}`
                    : ""}
                </Text>
              )}
              <Text
                selectable
                style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
              >
                Work: {task.disposition.workDisposition.replaceAll("_", " ")} ·{" "}
                {task.disposition.workspaceArchived
                  ? `workspace ${task.disposition.workspaceId} archived`
                  : task.disposition.workspaceEvidence ||
                    "preservation pending"}
              </Text>
              {task.disposition.attention && (
                <Text
                  style={{
                    color: r.warning,
                    fontSize: typeScale.metadata.fontSize,
                  }}
                >
                  {task.disposition.attention}
                </Text>
              )}
              {task.disposition.status === "draining" && (
                <Text
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  The worker turn was interrupted and is still stopping.
                </Text>
              )}
              {task.disposition.postDispositionRefs.length > 0 && (
                <Text
                  selectable
                  style={{
                    color: r.warning,
                    fontSize: typeScale.metadata.fontSize,
                  }}
                >
                  Refs pushed after disposition:{" "}
                  {task.disposition.postDispositionRefs
                    .map((item) => `${item.ref} ${item.sha.slice(0, 12)}`)
                    .join("; ")}
                </Text>
              )}
              {task.disposition.effects.length > 0 && (
                <Text
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  {
                    task.disposition.effects.filter((effect) => effect.result)
                      .length
                  }
                  /{task.disposition.effects.length} recorded effects reconciled
                </Text>
              )}
            </View>
          )}
          <OperationsList operations={operations} c={c} />
        </DetailSection>
      )}

      {/* 5. Prerequisites */}
      {Boolean(detailQuery.data?.dependencies.length) && (
        <PrerequisiteList
          c={c}
          items={(detailQuery.data?.dependencies ?? []).map((dependency) => ({
            key: dependency.id,
            text: `${dependency.title} · ${dependency.phase === "done" ? "complete" : dependency.removedAt ? "removed before completion" : phaseLabel(dependency)}${dependency.purgedAt ? " · history purged" : ""}`,
            onPress: () => {
              if (!dependency.purgedAt) onSelectTask(dependency.id);
            },
          }))}
        />
      )}

      {/* 6. Runs and delivery */}
      <CollapsibleSection
        title={`Runs and delivery (${runs.length})`}
        hint={live.length ? `${live.length} live` : "none live"}
        open={runsOpen}
        onToggle={() => setRunsOpen((v) => !v)}
        c={c}
      >
        {Boolean(
          task.checkpoints.records.length || task.checkpoints.intent,
        ) && (
          <Text
            selectable
            accessibilityLabel={checkpointStateLabel(task.checkpoints)}
            style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
          >
            {checkpointStateLabel(task.checkpoints)}
          </Text>
        )}
        {detailQuery.data?.missingResult && (
          <Text
            selectable
            accessibilityLabel={`Missing result for ${detailQuery.data.missingResult.role} run ${detailQuery.data.missingResult.runId}`}
            style={{
              color: r.warning,
              fontSize: typeScale.metadata.fontSize,
            }}
          >
            {`Missing result · ${detailQuery.data.missingResult.role} run ${detailQuery.data.missingResult.runId}${detailQuery.data.missingResult.prUrl ? ` · ${detailQuery.data.missingResult.prUrl}` : ""}`}
          </Text>
        )}
        {runs.length ? (
          <>
            {live.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                c={c}
                openThread={
                  run.agentId && navigation?.openAgent
                    ? () => navigation.openAgent({ agentId: run.agentId! })
                    : undefined
                }
              />
            ))}
            {!live.length && (
              <Text style={muted(c)}>
                No run is live. Earlier runs are below.
              </Text>
            )}
            {Boolean(earlier.length) && (
              <RawRecords
                label={`Earlier runs (${earlier.length}${runs.length >= 200 ? ", of the latest 200 runs" : ""})`}
                c={c}
              >
                {earlier.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    c={c}
                    openThread={
                      run.agentId && navigation?.openAgent
                        ? () => navigation.openAgent({ agentId: run.agentId! })
                        : undefined
                    }
                  />
                ))}
              </RawRecords>
            )}
          </>
        ) : (
          <Text style={muted(c)}>No runs yet</Text>
        )}
        {task.workerExclusions.length > 0 && (
          <Text
            selectable
            style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
          >
            Worker exclusions ·{" "}
            {task.workerExclusions
              .map(
                (exclusion) =>
                  `${exclusion.agentId ? `agent ${exclusion.agentId}` : `profile ${exclusion.profileId}`}: ${exclusion.reason}`,
              )
              .join("; ")}
          </Text>
        )}
        {task.retiredWorkers.map((w) => (
          <View
            key={w.runId}
            style={{ ...row, justifyContent: "space-between" }}
          >
            <Text
              style={{
                ...muted(c),
                fontSize: typeScale.metadata.fontSize,
                flexShrink: 1,
              }}
            >
              Replaced worker · {w.profile.name} · {w.reason}
            </Text>
            {navigation?.openAgent && (
              <Button
                small
                c={c}
                text="Open previous"
                label="Open previous worker"
                onPress={() => navigation.openAgent({ agentId: w.agentId })}
              />
            )}
          </View>
        ))}
        {task.resolution.revisionInstruction && (
          <View style={{ gap: space.xxs }}>
            <Text
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              Recorded revision instruction
              {task.resolution.revisionInstruction.runId
                ? ` · bound to run ${task.resolution.revisionInstruction.runId}`
                : " · pending the next revision run"}
            </Text>
            <Text
              selectable
              style={{
                color: r.foreground,
                fontSize: typeScale.metadata.fontSize,
              }}
            >
              {task.resolution.revisionInstruction.text}
            </Text>
          </View>
        )}
      </CollapsibleSection>

      {/* 7. Build-output records */}
      {runBoundCleanup && (
        <CollapsibleSection
          title="Run-bound build output"
          open={buildOutputOpen}
          onToggle={() => setBuildOutputOpen((v) => !v)}
          c={c}
        >
          <Text
            selectable
            accessibilityLabel="Run-bound build output cleanup"
            style={{
              color: r.foreground,
              fontSize: typeScale.metadata.fontSize,
            }}
          >
            {runBoundCleanup.text}
          </Text>
        </CollapsibleSection>
      )}

      {/* 8. Repository hooks & review entry */}
      {Boolean(detailQuery.data?.hooks.length) && (
        <DetailSection title="Repository hooks" c={c}>
          {detailQuery.data?.hooks.map((hook) => (
            <View
              key={hook.id}
              style={{
                gap: space.xxs,
                paddingBottom: space.xs,
              }}
            >
              <Text
                style={{
                  color: ["blocked", "failed", "uncertain"].includes(hook.state)
                    ? r.warning
                    : r.foreground,
                  fontSize: typeScale.metadata.fontSize,
                  fontWeight: "600",
                }}
              >
                {hook.hookId} · {hook.event} · {hook.state}
              </Text>
              {hook.target === "reviewed_head" && (
                <Text
                  selectable
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  Reviewed-head target · exact head{" "}
                  {hook.baseCommit.slice(0, 12)}
                </Text>
              )}
              <RawRecords
                label={`Replay, commit and program evidence for ${hook.hookId}`}
                c={c}
              >
                {hook.replay && (
                  <Text
                    selectable
                    style={{
                      ...muted(c),
                      fontSize: typeScale.metadata.fontSize,
                    }}
                  >
                    Automatic replay {hook.replay.ordinal} of 2 · occurrence{" "}
                    {hook.replay.fromOccurrence} → {hook.occurrence} · base{" "}
                    {hook.replay.baseCommit.slice(0, 12)} · from{" "}
                    {hook.replay.fromEventId}
                  </Text>
                )}
                {hook.replayIntent && !hook.replay && (
                  <Text
                    selectable
                    style={{
                      ...muted(c),
                      fontSize: typeScale.metadata.fontSize,
                    }}
                  >
                    Automatic replay {hook.replayIntent.ordinal} of 2 recorded
                    at base {hook.replayIntent.baseCommit.slice(0, 12)}
                    {hook.state === "blocked"
                      ? " · awaiting the fresh occurrence"
                      : " · superseded by the fresh occurrence"}
                  </Text>
                )}
                {hook.target === "prospective_merge" && (
                  <Text
                    selectable
                    style={{
                      ...muted(c),
                      fontSize: typeScale.metadata.fontSize,
                    }}
                  >
                    Prospective merge target · base{" "}
                    {hook.mergeCandidate?.integrationBase.slice(0, 12) ??
                      "unpinned"}{" "}
                    · reviewed head{" "}
                    {hook.mergeCandidate?.reviewedHead.slice(0, 12) ??
                      "unpinned"}{" "}
                    · candidate{" "}
                    {hook.mergeCandidate?.commit.slice(0, 12) ?? "unpinned"}
                  </Text>
                )}
                <Text
                  selectable
                  style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
                >
                  {hook.program.kind === "trusted_runner"
                    ? `Trusted runner ${hook.program.runner} · revision ${hook.program.revision} · ${hook.program.digest} · ${hook.program.hostId} · ${hook.program.versionLabel || "no version label"} · ${hook.program.os}/${hook.program.architecture}`
                    : hook.program.kind === "tool"
                      ? `Tool ${hook.program.name} · ${hook.program.path} · ${hook.program.digest}`
                      : hook.program.kind === "unavailable_tool"
                        ? `Tool ${hook.program.name} · ${hook.program.error}`
                        : hook.program.kind === "repository"
                          ? `Repository program ${hook.program.executable.path}@${hook.program.executable.digest}`
                          : `Trusted runner ${hook.program.runner} · unavailable before spawn`}
                </Text>
              </RawRecords>
              {(hook.error || hook.summary) && (
                <Text
                  selectable
                  style={{
                    color: hook.error ? r.warning : r.muted,
                    fontSize: typeScale.metadata.fontSize,
                  }}
                >
                  {hook.error || hook.summary}
                </Text>
              )}
            </View>
          ))}
        </DetailSection>
      )}

      {task.reviewEntry && (
        <DetailSection title="Review entry" c={c}>
          <Text
            selectable
            style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
          >
            External PR #{task.reviewEntry.prNumber} · head{" "}
            {task.reviewEntry.verifiedHead} · base{" "}
            {task.reviewEntry.verifiedBase}
          </Text>
          <Text
            selectable
            style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
          >
            Declared authors:{" "}
            {task.reviewEntry.authorDeclaration.models.join(", ")} · GitHub{" "}
            {task.reviewEntry.authorDeclaration.githubAuthor} ·{" "}
            {task.reviewEntry.authorDeclaration.authoringSystem}
          </Text>
          <Text
            selectable
            style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
          >
            Attested by {task.reviewEntry.authorDeclaration.attestedBy} ·{" "}
            {task.reviewEntry.authorDeclaration.provenance}
          </Text>
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            {task.reviewEntry.preserveWorkspace
              ? "External workspace is preserved for operator cleanup."
              : "Intake-created workspace is archived after successful closeout; cancellation preserves it."}
          </Text>
        </DetailSection>
      )}

      {(task.proofFiles ?? []).length > 0 && (
        <DetailSection title="Proof files" c={c}>
          {(task.proofFiles ?? []).map((file) => (
            <Text
              key={`${file.eventId}:${file.head}:${file.name}`}
              selectable
              style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
            >
              {file.label} · head {file.head.slice(0, 7)} · {file.name} ·{" "}
              {file.bytes} bytes · sha256 {file.sha256}
              {`\n${file.path}`}
            </Text>
          ))}
        </DetailSection>
      )}

      {/* 9. Completion cohort & closeout */}
      <RunsCloseout task={task} detailQuery={detailQuery} c={c} />

      {/* 10. Raw IDs and records */}
      <CollapsibleSection
        title="Raw IDs and records"
        open={rawOpen}
        onToggle={() => setRawOpen((v) => !v)}
        c={c}
      >
        {rawIdentity.map((field) => (
          <KvRow
            key={field.label}
            label={field.label}
            value={field.value}
            compact={compact}
            c={c}
          />
        ))}
        {task.workspaceId && (
          <KvRow
            label="Workspace ID"
            value={task.workspaceId}
            compact={compact}
            c={c}
          />
        )}
      </CollapsibleSection>
    </View>
  );
}
