import { budgetOutageIntervals } from "../scheduling/host-outage";
import { OPERATOR_BOARD_CALLER, type Task, type TaskControlInput } from "../../shared/contracts";
import { taskBudget } from "../../shared/task-budget";
import type { Engine } from "../engine";

/**
 * `extend_budget` (Spec 058, Tom 2026-11-03): one authorized increment applies
 * to an exhausted task budget, including past 2x. The acceptance needs the
 * operator at the board, a relayed operator authorization note with its caller,
 * or structured delegated budget authority; anything else is refused, and an
 * extension that is no longer needed is refused rather than recorded.
 */
export function applyBudgetExtension(engine: Engine, input: TaskControlInput, operated: <T>(result: T) => T): Task {
  const current = engine.store.task(input.taskId);
  const events = engine.store.eventsAll(current.id);
  if (!taskBudget(current, engine.store.runs(current.id), Date.now(), events,
    engine.store.canonicalRepository(current.repoPath, current.repository), budgetOutageIntervals(engine.store, current.hostId)).exhausted)
    throw Error("Budget extension applies only while the task budget is exhausted");
  const authorizedBoard = input.caller === OPERATOR_BOARD_CALLER;
  const authorizedRelay = input.relayed === true && Boolean(input.caller) && Boolean(input.note?.trim());
  // Spec 058, Tom 2026-11-03: delegated answers may extend budgets, including past 2x.
  const authorizedDelegate = input.delegated === true && Boolean(input.caller)
    && input.budgetAuthority === 'approve_by_default';
  if (!authorizedBoard && !authorizedRelay && !authorizedDelegate)
    throw Error("Budget extension needs the operator at the board or a relayed operator authorization note, or structured delegated budget authority");
  const updated = engine.resolution.extendTaskBudget(input.taskId,
    `${input.caller}: ${input.delegated ? input.note : input.relayed ? input.note : input.reason}`.slice(0, 4000));
  if (!updated) throw Error("Task budget is no longer exhausted");
  return operated(updated);
}
