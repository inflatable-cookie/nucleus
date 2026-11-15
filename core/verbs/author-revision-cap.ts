import { REVISION_BUDGET, type Task, type TaskControlInput } from "../../shared/contracts";
import type { Engine } from "../engine";
import { deriveRestartRole } from "./owner-restart";

/** The controls that would start another author round on the retained worker. */
function startsAuthorRound(engine: Engine, input: TaskControlInput, task: Task): boolean {
  return input.action === 'move' && input.to === 'work'
    || input.action === 'restart' && (input.role ?? deriveRestartRole(task, engine.store.runs(task.id))) === 'worker'
    || input.action === 'route' && input.role === 'worker';
}

/**
 * The author revision allowance (Spec 058). Only a task parked at the cap is
 * the owner's disposition: no author round has started since the cap last
 * stopped it. A worker that stops inside an owner-approved round is ordinary
 * recovery, and its next changes_required parks at the cap again, so the cap
 * stop is the latest recorded one — an older park the owner already answered
 * with a round is history. The planner ladder decides the next approach through
 * the blocker ladder, with the delegated authority its answering agent records;
 * the owner's own verbs still override it.
 */
export function assertAuthorRevisionAllowance(engine: Engine, input: TaskControlInput, task: Task): void {
  if (!startsAuthorRound(engine, input, task)) return;
  if (task.resolution.revisionRuns < REVISION_BUDGET) return;
  const capAt = engine.store.events(task.id).find(event => event.kind === 'revision_budget_exhausted')?.at;
  if (!capAt) return;
  const lastRound = engine.store.runs(task.id).filter(run => run.role === 'revision').map(run => run.createdAt).sort().at(-1);
  if (lastRound && lastRound >= capAt) return;
  if (engine.coordinatorActionRunId.getStore())
    throw Error('The author revision allowance is exhausted; the project planner decides the next approach through the blocker ladder (Spec 058), and the owner\'s own verbs still override it');
  // Spec 058 slice 17: the ladder's delegated answer to the cap escalation is
  // the planner's disposition; it applies with the delegated authority its
  // answering agent records, and the owner's own verbs still override it.
  if (input.delegated) engine.assertDelegatedAuthority(input.caller, input.note, 'Exhausted author revision disposition');
  else engine.assertOwnerAuthority(input.caller, input.relayed, input.note, 'Exhausted author revision disposition');
}
