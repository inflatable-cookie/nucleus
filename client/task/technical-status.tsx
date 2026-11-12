import { Text, View } from "react-native";
import { useRpc, Icon } from "../shell";
import { ActionButton, Button, DetailSection, Field, muted, row, type Colors } from "../controls";
import * as api from "../../shared/contracts";
import { type Task, holdsOf } from "../../shared/contracts";
import { operationStateLabel, type QueueOperation } from "../../shared/operations";
import { HeavyRunStatus } from "../board/badges";
import { budgetSummary } from "../board/text";
import { decisionAge } from "../../shared/pipeline-board";
import { useTaskDraft, type TaskDrafts } from "./drafts";
import { type BoardAct } from "./parts";
import type { BoardNavigation } from "../shell/types";
import type { TaskDetailRead } from "./task-dialog";
import { space, type as typeScale } from "../design";

function OperationState({ operations, c }: { operations: QueueOperation[]; c: Colors }) {
  if (!operations.length) return null;
  return <View style={{ gap: space.xxs }}>
    {operations.slice(0, 4).map(operation => {
      const attention = operation.state === "needs_attention" || operation.state === "failed";
      const color = attention ? c.statusWarning : operation.state === "succeeded" ? c.foregroundMuted : c.accent;
      return <View key={operation.id} style={{ ...row, flexWrap: "nowrap", gap: space.xs }}>
        <Icon name={attention ? "TriangleAlert" : operation.state === "succeeded" ? "Check" : "LoaderCircle"} size={12} color={color} />
        <Text numberOfLines={2} selectable accessibilityLabel={operationStateLabel(operation)} style={{ color, fontSize: typeScale.metadata.fontSize, flex: 1, minWidth: 0 }}>
          {operationStateLabel(operation)}{operation.diagnostic ? ` · ${operation.diagnostic}` : ""}
        </Text>
      </View>;
    })}
  </View>;
}

export function TechnicalStatus({ task, taskOperations, drafts, pendingOperation, busy, act, navigation, onClose, c }: {
  task: TaskDetailRead["task"];
  taskOperations: QueueOperation[];
  drafts: TaskDrafts;
  pendingOperation: boolean;
  busy: boolean;
  act: BoardAct;
  navigation?: BoardNavigation;
  onClose: () => void;
  c: Colors;
}) {
  const setTask = useRpc(api.taskControl), removeTask = useRpc(api.removeTask);
  const [holdReason, setHoldReason] = useTaskDraft(drafts, "holdReason", "");
  const stalledIncident = task.resolution.incident?.cause === "stalled_turn" && task.resolution.incident.status !== "resolved"
    ? task.resolution.incident : null;
  const stalledTurnStop = task.resolution.stalledTurnStop ?? null;
  return <>
    <DetailSection c={c}>
      {task.heavyRun && <HeavyRunStatus run={task.heavyRun} c={c} detail />}
      {task.budget && (
        <Text
          accessibilityLabel={`Budget: ${budgetSummary(task.budget)}${task.budget.exhausted ? `; reached on ${task.budget.exhausted === "wall_time" ? "wall time" : "effective tokens"}` : ""}`}
          style={{
            color: task.budget.exhausted ? c.statusWarning : c.foregroundMuted,
            fontSize: typeScale.metadata.fontSize,
            lineHeight: typeScale.metadata.lineHeight,
          }}
        >
          Budget · {budgetSummary(task.budget)}
          {task.budget.exhausted ? ` · reached on ${task.budget.exhausted === "wall_time" ? "wall time" : "effective tokens"}` : ""}
        </Text>
      )}
      {(task.originError || task.originLookupError) && (
        <Text style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}>
          Origin routing:{" "}
          {task.originError || task.originLookupError}
        </Text>
      )}
      {stalledIncident && (
        <DetailSection title="Stalled turn" c={c}>
          <Text
            selectable
            style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
          >
            Run {stalledIncident.runId} · detected turn{" "}
            {stalledIncident.turnId ?? "unknown"}
            {stalledTurnStop
              ? ` · stop ${stalledTurnStop.status} for turn ${stalledTurnStop.turnId}`
              : " · the run still owns its task"}
          </Text>
          {stalledTurnStop && (
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
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            Use restart in Next to stop the exact turn and
            continue the run; Nucleus waits for observed
            inactivity first.
          </Text>
        </DetailSection>
      )}
      {(() => {
        const fences = holdsOf(task);
        return (
          <>
            {fences.dispatch && (
              <Text
                accessibilityLabel="Dispatch hold owner and reason"
                style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}
              >
                Dispatch held by{" "}
                {api.holdOwnerOf(task, fences.dispatch.owner)} ·{" "}
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
                Merge held by{" "}
                {api.holdOwnerOf(task, fences.merge.owner)} ·{" "}
                {fences.merge.reason} ·{" "}
                {fences.merge.at
                  ? decisionAge(fences.merge.at)
                  : "age not recorded"}
              </Text>
            )}
          </>
        );
      })()}
      {task.phase === "queued" && !holdsOf(task).dispatch && (
        <Field
          c={c}
          label="Hold reason (required to hold)"
          value={holdReason}
          onChange={setHoldReason}
        />
      )}
      <OperationState operations={taskOperations} c={c} />
      <View style={row}>
        {task.agentId && navigation?.openAgent && (
          <Button
            small
            c={c}
            text="Open worker"
            onPress={() =>
              navigation.openAgent({ agentId: task.agentId! })
            }
          />
        )}
        {task.workspaceId && navigation?.openWorkspace && (
          <Button
            small
            c={c}
            text="Open workspace"
            onPress={() =>
              navigation.openWorkspace({
                workspaceId: task.workspaceId!,
              })
            }
          />
        )}
        {!task.removedAt &&
          [
            "queued",
            "blocked",
            "error",
            "needs_attention",
            "cancelled",
            "done",
          ].includes(task.phase) && (
            <ActionButton
              c={c}
              action="remove"
              label="Remove task from queue"
              disabled={busy || pendingOperation}
              onPress={() =>
                void act(async () => {
                  const result = await removeTask({
                    taskId: task.id,
                    version: task.version,
                  });
                  // A slow removal returns its accepted operation instead of the task: keep the detail open so the
                  // pending removal stays visible in the operation state above. Only a settled removed task closes it.
                  if ("accepted" in result) return;
                  // Saturation accepts nothing: surface the reason and retry delay instead of silently keeping the
                  // task, so the operator knows to retry once the queue drains. The detail stays open.
                  if ("backpressured" in result)
                    throw new Error(
                      `Removal backpressured, nothing was removed: ${result.reason} Retry in about ${Math.max(1, Math.round(result.retryAfterMs / 1000))}s.`,
                    );
                  if (result.removedAt) onClose();
                })
              }
            />
          )}
        {holdsOf(task).merge &&
          task.phase !== "queued" &&
          [
            "working",
            "awaiting_review",
            "reviewing",
            "changes_requested",
            "verifying",
            "merging",
          ].includes(task.phase) &&
          !task.resolution.mergeIntent && (
            <Button
              small
              c={c}
              disabled={busy}
              text="Release hold"
              onPress={() =>
                void act(() =>
                  setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "release",
                    kind: "merge",
                  }),
                )
              }
            />
          )}
        {task.phase === "queued" && (
          <>
            <ActionButton
              c={c}
              action={holdsOf(task).dispatch ? "resume" : "pause"}
              disabled={
                busy ||
                (Boolean(holdsOf(task).dispatch)
                  ? false
                  : !holdReason.trim())
              }
              label={
                holdsOf(task).dispatch
                  ? "Release task"
                  : "Hold task"
              }
              tip={holdsOf(task).dispatch || holdReason.trim() ? undefined : "Hold task: give a hold reason first"}
              onPress={() =>
                void act(async () => {
                  const dispatch = holdsOf(task).dispatch;
                  await setTask(
                    dispatch
                      ? {
                          taskId: task.id,
                          version: task.version,
                          action: "release",
                          kind: "dispatch",
                        }
                      : {
                          taskId: task.id,
                          version: task.version,
                          action: "hold",
                          kind: "dispatch",
                          reason: holdReason.trim(),
                        },
                  );
                  setHoldReason("");
                })
              }
            />
            {holdsOf(task).merge && (
              <Button
                small
                c={c}
                disabled={busy}
                text="Release merge hold"
                onPress={() =>
                  void act(() =>
                    setTask({
                      taskId: task.id,
                      version: task.version,
                      action: "release",
                      kind: "merge",
                    }),
                  )
                }
              />
            )}
            <Button
              small
              c={c}
              disabled={busy}
              icon="ArrowUpToLine"
              text="Promote in project"
              onPress={() =>
                void act(() =>
                  setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "promote",
                  }),
                )
              }
            />
            <Button
              small
              c={c}
              disabled={busy}
              text="Cancel task"
              onPress={() =>
                void act(() =>
                  setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "cancel",
                  }),
                )
              }
            />
          </>
        )}
      </View>
    </DetailSection>
  </>;
}
