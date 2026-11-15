import { useRpc } from "../shell";
import { useTaskDraft, type TaskDrafts } from "./drafts";
import { Text, View } from "react-native";
import { type UseQueryResult } from "@tanstack/react-query";
import * as api from "../../shared/contracts";
import { isTerminalPhase } from "../../shared/task-state";
import { Button, DetailSection, Field, muted, row, type Colors } from "../controls";
import type { TaskDetailRead } from "./task-dialog";
import type { BoardNavigation } from "../shell/types";
import type { BoardAct } from "./parts";
import { space, type as typeScale } from "../design";

/**
 * The Runs tab's Coordination section: the worker exclusions in force and the
 * reason field that adds one, the workers this task replaced, the blocked
 * pre-PR note, and the recorded revision instruction. It owns its exclusion
 * reason, and reads the terminal phase from its one shared owner.
 */
export function RunsCoordination({ task, drafts, detailQuery, pendingOperation, busy, act, navigation, c }: { task: TaskDetailRead["task"]; drafts: TaskDrafts; detailQuery: UseQueryResult<TaskDetailRead>; pendingOperation: boolean; busy: boolean; act: BoardAct; navigation?: BoardNavigation; c: Colors }) {
  const setTask = useRpc(api.taskControl);
  const [workerExclusionReason, setWorkerExclusionReason] = useTaskDraft(drafts, "workerExclusionReason", "");
  // One exclusion request: the button names the agent or the profile, and the
  // request itself is written once.
  const excludeWorker = (workerExclusion: { agentId: string } | { profileId: string }) => void act(async () => {
    await setTask({ taskId: task.id, version: task.version, action: "exclude_worker", workerExclusion, reason: workerExclusionReason.trim() });
    setWorkerExclusionReason("");
  });
  return <DetailSection title="Coordination" c={c}>
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
      !isTerminalPhase(task.phase) &&
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
                onPress={() => excludeWorker({ agentId: task.agentId! })}
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
                onPress={() => excludeWorker({ profileId: task.profile!.id })}
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
  </DetailSection>;
}
