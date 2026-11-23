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
 * answering agent records; the owner's own verbs still override it. A control that
 * starts an author round there with that authority records the acceptance the
 * launch gate reads, before the control applies; a coordinator is refused, so it
 * gets a clear answer instead of a held launch.
 */
export function assertAuthorRevisionAllowance(engine: Engine, input: TaskControlInput, task: Task): void {
  if (!startsAuthorRound(engine, input, task)) return;
  // One condition for the cap everywhere (papercut 677c378d): the launch gate, the
  // run.start warning, the activity reading and this rule read the same allowance.
  if (!revisionAllowanceExhausted(task, engine.store.runs(task.id), engine.store.eventsAll(task.id))) return;
  if (engine.coordinatorActionRunId.getStore())
    throw Error('The author revision allowance is exhausted; the project planner decides the next approach through the blocker ladder (Spec 058), and the owner\'s own verbs still override it');
  // Spec 058 slice 17: the ladder's delegated answer to the cap escalation is
  // the planner's disposition; it applies with the delegated authority its
  // answering agent records, and the owner's own verbs still override it.
  if (input.delegated) engine.assertDelegatedAuthority(input.caller, input.note, 'Exhausted author revision disposition');
  else engine.assertOwnerAuthority(input.caller, input.relayed, input.note, 'Exhausted author revision disposition');
  engine.store.event(task.id, REVISION_CAP_ACCEPTED_EVENT,
    `${input.action}${input.action === 'move' ? ` to=${input.to}` : input.role ? ` role=${input.role}` : ''} by ${input.delegated ? 'delegated ' : ''}${input.caller ?? 'the owner'}: ${input.reason ?? ''}`.slice(0, 2000));
}
