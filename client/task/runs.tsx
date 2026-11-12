import { useTaskDraft, type TaskDrafts } from "./drafts";
import { Text, View } from "react-native";
import { type UseQueryResult } from "@tanstack/react-query";
import { useRpc } from "../shell";
import { Button, DetailSection, Field, muted, row, TextLink, type Colors } from "../controls";
import * as api from "../../shared/contracts";
import { type UiQueueState } from "../../shared/contracts";
import { checkpointStateLabel } from "../../shared/task-state";
import { buildOutputDisclosure } from "../../shared/build-output-disclosure";
import { phaseLabel } from "../board/text";
import { RunRow, RawRecords, type BoardAct } from "./parts";
import type { TaskDetailRead } from "./task-dialog";
import type { BoardNavigation } from "../shell/types";
import { space, type as typeScale } from "../design";

/** The Runs tab: prerequisites, runs, worker exclusions, hooks and cleanup. It owns its exclusion reason. */
export function RunsTab({ task, drafts, detailQuery, state, pendingOperation, compact, busy, act, navigation, onSelectTask, c }: { task: TaskDetailRead["task"]; detailQuery: UseQueryResult<TaskDetailRead>; state: UiQueueState | undefined; pendingOperation: boolean; compact: boolean; busy: boolean; act: BoardAct; drafts: TaskDrafts; navigation?: BoardNavigation; onSelectTask: (id: string) => void; c: Colors }) {
  const setTask = useRpc(api.taskControl);
  const [workerExclusionReason, setWorkerExclusionReason] = useTaskDraft(drafts, "workerExclusionReason", "");
  // Queue #395: the task detail quotes the recorded run-bound build output
  // cleanup before anyone reuses artifacts. Terminal tasks settle their
  // workspace cleanup, so they read the records without a missing-run line.
  const runBoundCleanup = buildOutputDisclosure(task.resolution.buildOutputCleanups, {
    workspaceId: task.workspaceId,
    runId: ["done", "cancelled"].includes(task.phase) ? null : task.completion?.runId ?? null,
  });
  return <View style={{ gap: space.sm }}>
    {Boolean(detailQuery.data?.dependencies.length) && (
      <DetailSection title="Prerequisites" c={c}>
        {detailQuery.data?.dependencies.map((dependency) => (
          <TextLink
            key={dependency.id}
            c={c}
            text={`${dependency.title} · ${dependency.phase === "done" ? "complete" : dependency.removedAt ? "removed before completion" : phaseLabel(dependency)}${dependency.purgedAt ? " · history purged" : ""}`}
            onPress={() => {
              if (!dependency.purgedAt)
                onSelectTask(dependency.id);
            }}
          />
        ))}
      </DetailSection>
    )}
    {runBoundCleanup && (
      <DetailSection title="Run-bound build output" c={c}>
        <Text
          selectable
          accessibilityLabel="Run-bound build output cleanup"
          style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
        >
          {runBoundCleanup.text}
        </Text>
      </DetailSection>
    )}
    <DetailSection title="Coordination" c={c}>
      {task.workerExclusions.length > 0 && (
        <Text selectable style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
          Worker exclusions ·{" "}
          {task.workerExclusions
            .map(
              (exclusion) =>
                `${exclusion.agentId ? `agent ${exclusion.agentId}` : `profile ${exclusion.profileId}`}: ${exclusion.reason}`,
            )
            .join("; ")}
        </Text>
      )}
      {task.agentId &&
        task.profile &&
        !task.removedAt &&
        !["done", "cancelled"].includes(task.phase) &&
        !task.resolution.mergeIntent &&
        !task.resolution.mergedCommit && (
          <View style={{ gap: space.xs }}>
            <Field
              c={c}
              label="Worker exclusion reason"
              value={workerExclusionReason}
              onChange={setWorkerExclusionReason}
              placeholder="Why this worker should get no further turns"
            />
            <View style={row}>
              {!task.workerExclusions.some(
                (exclusion) =>
                  exclusion.agentId === task.agentId,
              ) && (
                <Button
                  small
                  c={c}
                  text="Exclude current agent"
                  disabled={
                    busy ||
                    pendingOperation ||
                    !workerExclusionReason.trim()
                  }
                  onPress={() =>
                    void act(async () => {
                      await setTask({
                        taskId: task.id,
                        version: task.version,
                        action: "exclude_worker",
                        workerExclusion: {
                          agentId: task.agentId!,
                        },
                        reason: workerExclusionReason.trim(),
                      });
                      setWorkerExclusionReason("");
                    })
                  }
                />
              )}
              {!task.workerExclusions.some(
                (exclusion) =>
                  exclusion.profileId === task.profile!.id,
              ) && (
                <Button
                  small
                  c={c}
                  text="Exclude current profile"
                  disabled={
                    busy ||
                    pendingOperation ||
                    !workerExclusionReason.trim()
                  }
                  onPress={() =>
                    void act(async () => {
                      await setTask({
                        taskId: task.id,
                        version: task.version,
                        action: "exclude_worker",
                        workerExclusion: {
                          profileId: task.profile!.id,
                        },
                        reason: workerExclusionReason.trim(),
                      });
                      setWorkerExclusionReason("");
                    })
                  }
                />
              )}
            </View>
          </View>
        )}
      {task.retiredWorkers.map((w) => (
        <View
          key={w.runId}
          style={{ ...row, justifyContent: "space-between" }}
        >
          <Text
            style={{ ...muted(c), fontSize: typeScale.metadata.fontSize, flexShrink: 1 }}
          >
            Replaced worker · {w.profile.name} · {w.reason}
          </Text>
          {navigation?.openAgent && (
            <Button
              small
              c={c}
              text="Open previous"
              label="Open previous worker"
              onPress={() =>
                navigation.openAgent({ agentId: w.agentId })
              }
            />
          )}
        </View>
      ))}
      {["blocked", "error"].includes(task.phase) &&
        Boolean(task.agentId) &&
        !task.prUrl && (
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            A blocked pre-PR worker resumes through restart in
            Next, with an explicit bounded instruction.
          </Text>
        )}
      {task.prUrl &&
        !task.resolution.mergeIntent &&
        !task.resolution.mergedCommit &&
        detailQuery.data?.runs.every((r) => r.released) && (
          <View style={{ gap: space.xs }}>
            {task.resolution.revisionInstruction && (
              <View style={{ gap: space.xxs }}>
                <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
                  Recorded revision instruction
                  {task.resolution.revisionInstruction.runId
                    ? ` \u00b7 bound to run ${task.resolution.revisionInstruction.runId}`
                    : " \u00b7 pending the next revision run"}
                </Text>
                <Text
                  selectable
                  style={{ color: c.foreground, fontSize: typeScale.metadata.fontSize }}
                >
                  {task.resolution.revisionInstruction.text}
                </Text>
              </View>
            )}
          </View>
        )}
    </DetailSection>
    <DetailSection title="Runs and delivery" c={c}>
      {Boolean(
        task.checkpoints.records.length ||
          task.checkpoints.intent,
      ) && (
        <Text
          selectable
          accessibilityLabel={checkpointStateLabel(
            task.checkpoints,
          )}
          style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
        >
          {checkpointStateLabel(task.checkpoints)}
        </Text>
      )}
      {detailQuery.data?.missingResult && (
        <Text
          selectable
          accessibilityLabel={`Missing result for ${detailQuery.data.missingResult.role} run ${detailQuery.data.missingResult.runId}`}
          style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}
        >{`Missing result · ${detailQuery.data.missingResult.role} run ${detailQuery.data.missingResult.runId}${detailQuery.data.missingResult.prUrl ? ` · ${detailQuery.data.missingResult.prUrl}` : ""}`}</Text>
      )}
      {detailQuery.data?.runs.length ? (
        <>
          {detailQuery.data?.runs.filter((r) => !r.released).map((r) => (
            <RunRow key={r.id} run={r} c={c} openThread={r.agentId && navigation?.openAgent ? () => navigation?.openAgent?.({ agentId: r.agentId! }) : undefined} />
          ))}
          {!detailQuery.data?.runs.some((r) => !r.released) && <Text style={muted(c)}>No run is live. Earlier runs are below.</Text>}
          {detailQuery.data?.runs.some((r) => r.released) && (
            <RawRecords label={`Earlier runs (${detailQuery.data?.runs.filter((r) => r.released).length ?? 0}${(detailQuery.data?.runs.length ?? 0) >= 200 ? ", of the latest 200 runs" : ""})`} c={c}>
              {detailQuery.data?.runs.filter((r) => r.released).map((r) => (
                <RunRow key={r.id} run={r} c={c} openThread={r.agentId && navigation?.openAgent ? () => navigation?.openAgent?.({ agentId: r.agentId! }) : undefined} />
              ))}
            </RawRecords>
          )}
        </>
      ) : (
        <Text style={muted(c)}>No runs yet</Text>
      )}
    </DetailSection>
    <DetailSection title="Completion cohort" c={c}>
      {!task.notifyOriginOnCloseout &&
        !task.creatorCompletionRecipients.length &&
        !task.completionSubscriptionOverrides.some(
          (entry) => entry.subscribed,
        ) && (
          <Text style={muted(c)}>
            Quiet by default · no completion recipients
          </Text>
        )}
      {task.notifyOriginOnCloseout && (
        <Text selectable style={muted(c)}>
          {task.originAgentId} · origin opt-in · workspace{" "}
          {task.originWorkspaceId ?? "unresolved"}
        </Text>
      )}
      {task.creatorCompletionRecipients.map((entry) => (
        <Text
          key={`creator-${entry.agentId}`}
          selectable
          style={muted(c)}
        >
          {entry.agentId} · creator-nominated · workspace{" "}
          {entry.workspaceId}
        </Text>
      ))}
      {task.completionSubscriptionOverrides.map((entry) => (
        <Text
          key={`self-${entry.agentId}`}
          selectable
          style={muted(c)}
        >
          {entry.agentId} · self-
          {entry.subscribed ? "subscribed" : "unsubscribed"} ·
          workspace {entry.workspaceId}
        </Text>
      ))}
      {task.completionNotificationCohort?.map((entry) => (
        <Text
          key={`frozen-${entry.agentId}`}
          selectable
          style={muted(c)}
        >
          {entry.agentId} · frozen: {entry.sources.join(" + ")}{" "}
          · workspace {entry.workspaceId}
        </Text>
      ))}
      {detailQuery.data?.notices.map((n) => (
        <Text key={n.id} selectable style={muted(c)}>
          {n.kind === "completion"
            ? `Completion → ${n.recipientAgentId || n.agentId}`
            : "Attention notification"}
          : {n.status}
          {n.error ? ` · ${n.error}` : ""}
        </Text>
      ))}
    </DetailSection>
    {task.phase === "done" && (
      <View style={{ gap: space.xs }}>
        <Text style={muted(c)}>
          Workspace cleanup:{" "}
          {api.runtimeRetirementFailure(task) ||
            task.resolution.cleanupReason ||
            (task.resolution.externalWorkspaceArchives.some(
              (record) => record.state === "archived",
            )
              ? "Paseo sidebar entry archived; folder state recorded per entry"
              : task.reviewEntry?.preserveWorkspace
                ? "External workspace retained for operator cleanup"
                : task.resolution.archivedWorkspaceIds.length
                  ? `${task.resolution.archivedWorkspaceIds.length} archived`
                  : "pending")}
        </Text>
        {task.resolution.externalWorkspaceArchives
          .filter((record) => record.state === "archived")
          .map((record) => (
            <Text
              key={`catalog-archive-${record.workspaceId}`}
              selectable
              style={muted(c)}
            >
              Sidebar entry archived ·{" "}
              {record.folderPresent === false
                ? record.folderRemovalAuthorized
                  ? "Paseo removed the clean, published worktree folder"
                  : "folder observed absent"
                : `folder kept at ${record.directory}`}
              {record.folderRemovedBy
                ? ` (removed by ${record.folderRemovedBy})`
                : ""}
              {record.native?.archivedAt
                ? ` · ${new Date(record.native.archivedAt).toLocaleString()}`
                : ""}
            </Text>
          ))}
        {task.resolution.runtimeRetirements
          .filter((record) => record.state === "failed")
          .map((record) => (
            <Text
              key={`retire-${record.workspaceId}`}
              selectable
              accessibilityLabel={record.error}
              style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}
            >
              {record.error} · attempts {record.attempts}
              {record.nextAttemptAt
                ? ` · next retry ${new Date(record.nextAttemptAt).toLocaleString()}`
                : ""}
              {record.outputTail
                ? ` · ${record.outputTail}`
                : ""}
            </Text>
          ))}
      </View>
    )}
    {task.phase === "cancelled" &&
      task.disposition?.status === "complete" &&
      task.disposition.workDisposition === "archive_if_empty" &&
      !task.disposition.workspaceArchived &&
      task.resolution.buildOutputCleanups.some(
        (record) => !record.runId && record.state === "skipped",
      ) && (
        <View style={{ gap: space.xs }}>
          <Text style={muted(c)}>
            Workspace cleanup stayed blocked:{" "}
            {task.resolution.cleanupReason ||
              task.resolution.buildOutputCleanups.find(
                (record) =>
                  !record.runId && record.state === "skipped",
              )?.detail}
          </Text>
        </View>
      )}
    {task.resolution.mergedCommit && (
      <Text selectable style={muted(c)}>
        {task.resolution.externalMerge
          ? "External merge"
          : "Merged commit"}
        : {task.resolution.mergedCommit}
      </Text>
    )}
  </View>;
}
