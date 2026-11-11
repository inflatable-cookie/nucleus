import { Text, View } from "react-native";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRpc } from "../shell";
import { DetailSection, muted, type Colors } from "../controls";
import { errorText } from "../error-text";
import * as api from "../../shared/contracts";
import { type TaskControlInput, type TaskNext, type UiQueueState } from "../../shared/contracts";
import { TaskSummaryBlock, type TaskDetailTab } from "./parts";
import { NORMAL_USAGE, NextSection } from "./next-section";
import type { TaskDetailRead, TaskQaRun } from "./task-dialog";

/** The Overview's summary: the task's current wait, holds, review and checks. Stays mounted so tab switches keep its place. */
export function OverviewSummary({ task, detailTab, nextQuery, detailQuery, qaRun: taskQaRun, c }: { task: TaskDetailRead["task"]; detailTab: TaskDetailTab; nextQuery: UseQueryResult<TaskNext>; detailQuery: UseQueryResult<TaskDetailRead>; qaRun: TaskQaRun | undefined; c: Colors }) {
  return <View style={{ gap: 12, display: detailTab === "overview" ? "flex" : "none" }}>
    <TaskSummaryBlock
      task={task}
      next={nextQuery.data ?? null}
      runs={detailQuery.data?.runs ?? []}
      qaRun={taskQaRun ?? null}
      c={c}
    />
  </View>;
}

/**
 * The Overview's Next section and accepted receipt. It sits after the pending questions,
 * which show on every tab, and stays mounted so a half-filled verb form survives a tab switch.
 */
export function OverviewNext({ task, detailTab, nextQuery, state, busy, pendingOperation, c }: { task: TaskDetailRead["task"]; detailTab: TaskDetailTab; nextQuery: UseQueryResult<TaskNext>; state: UiQueueState | undefined; busy: boolean; pendingOperation: boolean; c: Colors }) {
  const queryClient = useQueryClient();
  const setTask = useRpc(api.taskControl);
  return <View style={{ gap: 12, display: detailTab === "overview" ? "flex" : "none" }}>
    <NextSection
      key={task.id}
      c={c}
      busy={busy || pendingOperation}
      next={nextQuery.data ?? null}
      loading={nextQuery.isFetching}
      error={nextQuery.error ? (errorText(nextQuery.error)) : null}
      onRetry={() => { void nextQuery.refetch(); }}
      pool={state?.pool ?? []}
      profiles={state?.profiles ?? []}
      usage={state?.usage ?? NORMAL_USAGE}
      availability={state?.availability ?? []}
      onSubmit={async (verb, values) => {
        const result = await setTask({
          ...verb.args,
          ...Object.fromEntries(
            Object.entries(values).map(([field, value]) => [
              field,
              field === "dependsOn" ? value.split(/[,\s]+/).filter(Boolean) : value.trim(),
            ]),
          ),
          caller: "operator (board)",
        } as TaskControlInput);
        await queryClient.refetchQueries({
          queryKey: ["nucleus", "state"],
          exact: true,
        });
        await queryClient.invalidateQueries({
          queryKey: ["nucleus", "detail", task.id],
          exact: true,
        });
        await queryClient.invalidateQueries({
          queryKey: ["nucleus", "next", task.id],
          exact: true,
        });
        return result;
      }}
    />
    {task.proofReceiptAcceptance && <DetailSection title="Receipt accepted" c={c}>
      <Text selectable style={{ ...muted(c), fontSize: 12 }}>Operator {task.proofReceiptAcceptance.acceptedBy} accepted receipt {task.proofReceiptAcceptance.runId} as release evidence: {task.proofReceiptAcceptance.reason}</Text>
      <Text selectable style={{ ...muted(c), fontSize: 12 }}>Original failed qualification and reviewer verdict: {task.proofReceiptAcceptance.originalResult.evidence}</Text>
    </DetailSection>}
  </View>;
}
