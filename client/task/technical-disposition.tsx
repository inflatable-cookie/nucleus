import { Text, View } from "react-native";
import { useRpc } from "../shell";
import { Button, DetailSection, Field, muted, row, type Colors } from "../controls";
import * as api from "../../shared/contracts";
import { useTaskDraft, type TaskDrafts } from "./drafts";
import type { BoardAct } from "./parts";
import type { TaskDetailRead } from "./task-dialog";
import { type as typeScale, space } from "../design";

export function TechnicalDisposition({ task, drafts, busy, pendingOperation, act, c }: {
  task: TaskDetailRead["task"];
  drafts: TaskDrafts;
  busy: boolean;
  pendingOperation: boolean;
  act: BoardAct;
  c: Colors;
}) {
  const setTask = useRpc(api.taskControl);
  const [disposeReason, setDisposeReason] = useTaskDraft(drafts, "disposeReason", "");
  const [withdrawReason, setWithdrawReason] = useTaskDraft(drafts, "withdrawReason", "");
  const [escalationAnswer, setEscalationAnswer] = useTaskDraft(drafts, "escalationAnswer", "");
  const [replacementId, setReplacementId] = useTaskDraft(drafts, "replacementId", "");
  const [workDisposition, setWorkDisposition] = useTaskDraft<"preserve" | "archive_if_empty" | "retained_by_replacement">(drafts, "workDisposition", "archive_if_empty");
  const canWithdrawCancellation = Boolean(task.disposition && task.disposition.kind === "cancel" &&
    ((["intent", "draining"].includes(task.disposition.status) &&
      task.disposition.effects.every(effect => effect.kind === "stop_thread" && effect.result === null && effect.resultAt === null && !effect.uncertain)) ||
      task.disposition.status === "needs_attention"));
  const escalatedEpisode = task.resolution.incident?.status === "escalated" || task.resolution.recovery?.status === "escalated";
  return <>
    {task.disposition && (
      <DetailSection
        title={
          task.disposition.status === "complete"
            ? task.disposition.kind === "supersede"
              ? "Superseded"
              : "Cancelled"
            : "Cancelling"
        }
        c={c}
      >
        <Text style={{ color: c.foreground, fontSize: typeScale.body.fontSize }}>
          {task.disposition.reason}
        </Text>
        <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
          Requested by {task.disposition.requestedBy} ·{" "}
          {task.disposition.kind} · {task.disposition.status}
          {task.disposition.completedAt
            ? ` · completed ${task.disposition.completedAt}`
            : ""}
        </Text>
        {task.disposition.replacementTaskId && (
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            Replacement: {task.disposition.replacementTaskId}
            {task.disposition.replacementBranch
              ? ` · branch ${task.disposition.replacementBranch}`
              : ""}
          </Text>
        )}
        <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
          Work:{" "}
          {task.disposition.workDisposition.replaceAll(
            "_",
            " ",
          )}{" "}
          ·{" "}
          {task.disposition.workspaceArchived
            ? `workspace ${task.disposition.workspaceId} archived`
            : task.disposition.workspaceEvidence ||
              "preservation pending"}
        </Text>
        {task.disposition.attention && (
          <Text
            style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}
          >
            {task.disposition.attention}
          </Text>
        )}
        {task.disposition.status === "draining" && (
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            The worker turn was interrupted and is still
            stopping.
          </Text>
        )}
        {task.disposition.postDispositionRefs.length > 0 && (
          <Text
            style={{ color: c.statusWarning, fontSize: typeScale.metadata.fontSize }}
          >
            Refs pushed after disposition:{" "}
            {task.disposition.postDispositionRefs
              .map(
                (item) =>
                  `${item.ref} ${item.sha.slice(0, 12)}`,
              )
              .join("; ")}
          </Text>
        )}
        {task.disposition.effects.length > 0 && (
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            {
              task.disposition.effects.filter(
                (effect) => effect.result,
              ).length
            }
            /{task.disposition.effects.length} recorded effects
            reconciled
          </Text>
        )}
        {canWithdrawCancellation && (
          <View style={{ gap: space.xs, marginTop: space.xxs }}>
            <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
              You can withdraw this cancellation while
              thread-stop requests are pending, or while its
              disposition is parked in needs attention.
            </Text>
            <Field
              c={c}
              label="Withdrawal reason (required)"
              value={withdrawReason}
              onChange={setWithdrawReason}
              placeholder="Why this cancellation is withdrawn"
            />
            <Button
              small
              c={c}
              text="Withdraw cancellation"
              disabled={
                busy ||
                pendingOperation ||
                !withdrawReason.trim()
              }
              onPress={() =>
                void act(async () => {
                  await setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "withdraw_cancel",
                    reason: withdrawReason.trim(),
                  });
                  setWithdrawReason("");
                })
              }
            />
          </View>
        )}
      </DetailSection>
    )}
    {!task.removedAt &&
      !task.disposition &&
      !["queued", "cancelled", "done"].includes(task.phase) && (
        <DetailSection title="Cancel or supersede" c={c}>
          <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
            One versioned operator action. The fence persists
            before any stop or archive request; ordinary
            recovery and relaunch stop while it is active. Only
            done satisfies dependants.
          </Text>
          <Field
            c={c}
            label="Operator reason (required)"
            value={disposeReason}
            onChange={setDisposeReason}
            placeholder="Why this work ends unfinished"
          />
          <View style={row}>
            {(
              [
                "preserve",
                "archive_if_empty",
                "retained_by_replacement",
              ] as const
            ).map((option) => (
              <Button
                key={option}
                small
                c={c}
                text={option.replaceAll("_", " ")}
                selected={workDisposition === option}
                disabled={busy}
                onPress={() => setWorkDisposition(option)}
              />
            ))}
          </View>
          <Field
            c={c}
            label="Replacement task ID (supersede only)"
            value={replacementId}
            onChange={setReplacementId}
            placeholder="Existing task ID in the same repository"
          />
          <View style={row}>
            <Button
              small
              c={c}
              text="Cancel task"
              disabled={
                busy ||
                pendingOperation ||
                !disposeReason.trim()
              }
              onPress={() =>
                void act(() =>
                  setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "cancel",
                    reason: disposeReason.trim(),
                    workDisposition,
                  }),
                )
              }
            />
            <Button
              small
              c={c}
              text="Supersede task"
              disabled={
                busy ||
                pendingOperation ||
                !disposeReason.trim() ||
                !replacementId.trim()
              }
              onPress={() =>
                void act(() =>
                  setTask({
                    taskId: task.id,
                    version: task.version,
                    action: "supersede",
                    reason: disposeReason.trim(),
                    replacementTaskId: replacementId.trim(),
                    workDisposition,
                  }),
                )
              }
            />
          </View>
        </DetailSection>
      )}
    {escalatedEpisode && task && (
      <DetailSection title="Answered escalation" c={c}>
        <Text style={{ ...muted(c), fontSize: typeScale.metadata.fontSize }}>
          Any owner verb in Next answers the escalation with its
          reason. When nothing else applies, an owner restart
          with the answer as its reason closes it: the escalated
          recovery and incident resolve, and the escalation
          event stays as evidence. Available once no run is
          unreleased and the escalation is not backed by live
          work.
        </Text>
        <Field
          c={c}
          label="Owner reason (required)"
          value={escalationAnswer}
          onChange={setEscalationAnswer}
          placeholder="Who answered the escalation, and why"
        />
        <View style={row}>
          <Button
            small
            c={c}
            text="Answer with restart"
            disabled={
              busy ||
              pendingOperation ||
              !escalationAnswer.trim()
            }
            onPress={() =>
              void act(async () => {
                await setTask({
                  taskId: task.id,
                  version: task.version,
                  action: "restart",
                  reason: escalationAnswer.trim(),
                });
                setEscalationAnswer("");
              })
            }
          />
        </View>
      </DetailSection>
    )}
  </>;
}
