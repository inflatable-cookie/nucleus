import { type Task, type TaskControlInput } from "../../shared/contracts";
import { REVISION_CAP_ACCEPTED_EVENT, revisionAllowanceExhausted } from "../../shared/task-activity";
import type { Engine } from "../engine";
import { deriveRestartRole } from "./owner-restart";

/** The controls that would start another author round on the retained worker. */
function startsAuthorRound(engine: Engine, input: TaskControlInput, task: Task): boolean {
  return input.action === 'move' && input.to === 'work'
    || input.action === 'restart' && (input.role ?? deriveRestartRole(task, engine.store.runs(task.id))) === 'worker'
    || input.action === 'route' && input.role === 'worker';
}

/**
 * The author revision allowance (Spec 058). The revision launch gate is the
 * enforcement: a revision launch past the cap holds (`DispatchLaunch.launch`).
 * This rule is the authority over passing it. A task is at the cap only while the
 * cap park is the latest stop and no author round has started or been accepted
 * since; a worker that stops inside an owner-approved round is ordinary recovery,
 * and its next changes_required parks at the cap again. The planner ladder decides
 * the next approach through the blocker ladder, with the delegated authority its
 * answering agent records; the owner's own verbs still override it. A coordinator
 * is refused, so it gets a clear answer instead of a held launch. For any other
 * authorized caller it returns the acceptance the control's own transaction
 * records if the control applies (`recordAcceptedRevisionRound`); null when the
 * control starts no author round or the task is not at the cap.
 */
export function authorRevisionAcceptance(engine: Engine, input: TaskControlInput, task: Task): { taskId: string; detail: string } | null {
  if (!startsAuthorRound(engine, input, task)) return null;
  // One condition for the cap everywhere (papercut 677c378d): the launch gate, the
  // run.start warning, the activity reading and this rule read the same allowance.
  if (!revisionAllowanceExhausted(task, engine.store.runs(task.id), engine.store.eventsAll(task.id))) return null;
  if (engine.coordinatorActionRunId.getStore())
    throw Error('The author revision allowance is exhausted; the project planner decides the next approach through the blocker ladder (Spec 058), and the owner\'s own verbs still override it');
  // Spec 058 slice 17: the ladder's delegated answer to the cap escalation is
  // the planner's disposition; it applies with the delegated authority its
  // answering agent records, and the owner's own verbs still override it.
  if (input.delegated) engine.assertDelegatedAuthority(input.caller, input.note, 'Exhausted author revision disposition');
  else engine.assertOwnerAuthority(input.caller, input.relayed, input.note, 'Exhausted author revision disposition');
  return { taskId: task.id, detail: acceptanceDetail(input) };
}

/** The acceptance a successful forced `move to=work` at the cap records; the force rules already decided who may force. */
export function forcedRevisionAcceptance(engine: Engine, input: TaskControlInput, task: Task): { taskId: string; detail: string } | null {
  if (!(input.action === 'move' && input.to === 'work') || engine.coordinatorActionRunId.getStore()) return null;
  if (!revisionAllowanceExhausted(task, engine.store.runs(task.id), engine.store.eventsAll(task.id))) return null;
  return { taskId: task.id, detail: `force ${acceptanceDetail(input)}` };
}

function acceptanceDetail(input: TaskControlInput): string {
  const verb = input.action === 'move' ? `move to=${input.to}` : `${input.action} role=${'role' in input ? input.role ?? 'worker' : 'worker'}`;
  return `${verb} by ${input.delegated ? 'delegated ' : ''}${input.caller ?? 'the owner'}: ${input.reason ?? ''}`.slice(0, 2000);
}

/**
 * Inside an author-round control's own transaction, at its commit point: records
 * the acceptance its authorized caller carries (`revisionCapAcceptance`), once. A
 * control that refuses later in the same transaction rolls it back with
 * everything else, so a refused attempt grants nothing.
 */
export function recordAcceptedRevisionRound(engine: Pick<Engine, 'store' | 'revisionCapAcceptance'>, taskId: string): void {
  const acceptance = engine.revisionCapAcceptance.getStore();
  if (!acceptance || acceptance.taskId !== taskId) return;
  const store = engine.store;
  const events = store.eventsAll(taskId);
  if (!revisionAllowanceExhausted(store.task(taskId), store.runs(taskId), events)) return;
  store.event(taskId, REVISION_CAP_ACCEPTED_EVENT, acceptance.detail);
}
