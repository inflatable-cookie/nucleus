import { Text, View } from "react-native";
import { type UseQueryResult } from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import { DetailSection, muted, type Colors } from "../controls";
import type { TaskDetailRead } from "./task-dialog";
import { space, type as typeScale } from "../design";

/**
 * The Runs tab's closeout facts: the completion cohort a finished task notifies,
 * the workspace cleanup record with the retirements that failed, the blocked
 * cancellation cleanup, and the merged commit. Nothing here decides what
 * happens; each line shows a fact the task recorded.
 */
export function RunsCloseout({ task, detailQuery, c }: { task: TaskDetailRead["task"]; detailQuery: UseQueryResult<TaskDetailRead>; c: Colors }) {
  // The cleanup records that name no run and were skipped: one reading, used by
  // the cancelled disposition below.
  const terminalSkippedCleanups = task.resolution.buildOutputCleanups.filter((record) => !record.runId && record.state === "skipped");
  return <>
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
      Boolean(terminalSkippedCleanups.length) && (
        <View style={{ gap: space.xs }}>
          <Text style={muted(c)}>
            Workspace cleanup stayed blocked:{" "}
            {task.resolution.cleanupReason || terminalSkippedCleanups[0].detail}
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
  </>;
}
