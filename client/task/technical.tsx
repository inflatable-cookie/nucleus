import { View } from "react-native";
import type { UseQueryResult } from "@tanstack/react-query";
import type { TaskNext, UiQueueState } from "../../shared/contracts";
import type { QueueOperation } from "../../shared/operations";
import type { Colors } from "../controls";
import type { BoardAct } from "./parts";
import type { BoardNavigation } from "../shell/types";
import { TechnicalIdentity } from "./technical-identity";
import { TechnicalStatus } from "./technical-status";
import { TechnicalRouting } from "./technical-routing";
import { TechnicalTelemetry } from "./technical-telemetry";
import { TechnicalDisposition } from "./technical-disposition";
import type { TaskDrafts } from "./drafts";
import type { TaskDetailRead, TaskQaRun } from "./task-dialog";

/** The Technical tab composes task identity, status, routing, telemetry and disposition sections. */
export function TechnicalTab({ task, drafts, detailQuery, nextQuery, state, qaRun: taskQaRun, pendingOperation, compact, busy, act, navigation, onClose, c }: { task: TaskDetailRead["task"]; detailQuery: UseQueryResult<TaskDetailRead>; nextQuery: UseQueryResult<TaskNext>; state: UiQueueState | undefined; qaRun: TaskQaRun | undefined; pendingOperation: boolean; compact: boolean; busy: boolean; act: BoardAct; drafts: TaskDrafts; navigation?: BoardNavigation; onClose: () => void; c: Colors }) {
  const taskOperations: QueueOperation[] = detailQuery.data?.operations ?? [];
  return <View style={{ gap: 12 }}>
    <TechnicalIdentity task={task} detailQuery={detailQuery} nextQuery={nextQuery} state={state} compact={compact} c={c} />
    <TechnicalStatus task={task} taskOperations={taskOperations} drafts={drafts} pendingOperation={pendingOperation} busy={busy} act={act} navigation={navigation} onClose={onClose} c={c} />
    <TechnicalRouting task={task} state={state} drafts={drafts} busy={busy} act={act} c={c} />
    <TechnicalTelemetry task={task} detailQuery={detailQuery} taskQaRun={taskQaRun} c={c} />
    <TechnicalDisposition task={task} drafts={drafts} busy={busy} pendingOperation={pendingOperation} act={act} c={c} />
  </View>;
}
