import { retainedReviewHeads } from '../review/retained-work';
/** The retained author's authenticated results, read from their receipts. */
import type { Run, Task } from '../../shared/contracts';
import { digest, type Store } from '../store/store';


/** The current retained author's authenticated non-ready result, regardless of storage form. */
export function retainedProgressRun(store: Store, task: Task): Pick<Run, 'id' | 'head' | 'completion'> | null {
  if (!task.agentId || !task.workspaceId) return null;
  const runs = store.runs(task.id);
  // Only revisions of this author can supersede its initial task-row result. A
  // live revision owns the retained author until it settles.
  const run = runs.filter(item => item.role === 'revision' && item.agentId === task.agentId).at(-1);
  if (run && !run.released) return null;
  // A revision that reported is the author's latest result. One that ended
  // without a report leaves the authenticated task-row result standing: the
  // initial worker lives on the task row, never as a Run (effigy#512).
  const reported = run?.completion ? run : null;
  const initial = !reported && task.runId && !runs.some(item => item.id === task.runId) ? task.completion : null;
  const completion = reported?.completion ?? initial;
  const id = reported?.id ?? task.runId;
  if (reported && (reported.status !== 'finished' || reported.taskId !== task.id || reported.workspaceId !== task.workspaceId)) return null;
  if (!id || !completion || completion.taskId !== task.id || completion.runId !== id || !['blocked','error'].includes(completion.status)) return null;
  // An unbound PR on a blocked report is still useful continuation evidence.
  // Compare identities only after the task has bound one.
  const boundPr = task.reviewEntry?.prNumber ?? task.resumePrNumber ?? task.completion?.prNumber;
  if (completion.prNumber !== undefined && boundPr && completion.prNumber !== boundPr) return null;
  const receipt = store.db.prepare('SELECT hash FROM receipts WHERE id=? AND task=? AND run=?').get(completion.eventId, task.id, id) as {hash:string} | undefined;
  return receipt?.hash === digest(JSON.stringify(completion)) ? {id, head: reported?.head ?? completion.head ?? task.planningBase, completion} : null;
}
function retainedWorkHeads(store:Store, task:Task, runs:Run[]): string[] {
  const completions = [task.completion, ...runs.filter(run => run.role === 'revision' && run.workspaceId === task.workspaceId).map(run => run.completion)];
  const heads = completions.flatMap(completion => {
    if (!completion?.head || completion.taskId !== task.id) return [];
    const receipt = store.db.prepare('SELECT hash FROM receipts WHERE id=? AND task=? AND run=?').get(completion.eventId,task.id,completion.runId) as {hash:string}|undefined;
    return receipt?.hash === digest(JSON.stringify(completion)) ? [completion.head] : [];
  });
  const reviewHeads = retainedReviewHeads(store, task, runs);
  return [...heads,...reviewHeads,...task.checkpoints.records.map(record => record.head)];
}

export { retainedWorkHeads };
