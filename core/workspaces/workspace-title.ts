import {formatTaskNumber,MAX_TITLE_LENGTH,type HoldKind,type Task} from '../../shared/contracts';
import {taskTitleStateLabel} from '../../shared/task-state';
import {PREREQUISITE_WAIT_PREFIX} from '../../shared/wait-state';

export { capPaseoTitle } from '../../shared/paseo-title';

/** `Working*: 012 Title` while a hold is in place but not what the task waits on. */
type WorkspaceTitleTask=Pick<Task,'held'|'phase'|'title'|'number'>&Partial<Pick<Task,'holds'|'disposition'|'holdOwner'|'holdReason'|'reason'|'holdUntil'|'dependsOn'>>&{holdKind?:HoldKind;waitState?:{owner:string;state?:string}};

/**
 * The reference a title names for one task: a finished task names none, and a recorded
 * reference outranks its number. Reading one candidate at a time keeps a title sync from
 * materialising every task's label.
 */
export const taskReferenceLabel = (task: Pick<Task, 'phase' | 'number' | 'reference'>): string =>
  task.phase === 'done' ? '' : task.reference || (task.number ? `#${formatTaskNumber(task.number)}` : '');

/** Reference labels by task id, or the one-task reader a caller builds so only named ids are read. */
export type TitleReferenceLookup = ReadonlyMap<string, string> | ((taskId: string) => string | undefined);

/**
 * How a title names the task's number. Paseo and T3 keep the padded `029`; BB thread
 * titles name the full Nucleus task reference instead (`poodle-lab#29`), because a task
 * can run against a repository its planner's project does not name (nucleus#1313, Tom
 * 2026-11-17: "Use one task-number style everywhere ... in thread titles and container
 * rows"). One style everywhere: `#29`, never `029`.
 */
export function taskWorkspaceTitle(task:WorkspaceTitleTask, references:TitleReferenceLookup=new Map(), referenceLabel?:string){
  const reference = typeof references === 'function' ? references : (taskId: string) => references.get(taskId);
  const until=task.holdUntil?.kind==='task'?reference(task.holdUntil.taskId):undefined;
  const fences=[task.holds?.dispatch,task.holds?.merge].filter((fence):fence is NonNullable<typeof fence>=>Boolean(fence));
  const fenceUntil=fences.map(fence=>fence.until?.kind==='task'?reference(fence.until.taskId):undefined).find(Boolean);
  const reasons=[...fences.map(fence=>fence.reason),task.holdReason,task.reason].filter((reason):reason is string=>typeof reason==='string');
  // Bounded reference tokens: an unbounded `[\w.-]+` scan backtracks
  // quadratically over a long reason and stalls the title derivation. Both
  // probes are linear, so a long reason costs one plain scan, never the regex.
  const referenced=reasons.filter(reason=>reason.includes("#")||/longhorn\d{0,9}/i.test(reason))
    .map(reason=>reason.match(/(?:[\w.-]{1,40}#\d{1,9}|#\d{1,9}|\bLonghorn\d{1,9}\b)/i)?.[0]).find(Boolean);
  const dependency=task.reason?.startsWith(PREREQUISITE_WAIT_PREFIX)?task.dependsOn?.map(id=>reference(id)).find(Boolean):undefined;
  const normalizedReference=referenced&&/^Longhorn\d+$/i.test(referenced)?'Longhorn release':referenced;
  const waitingOn=until??fenceUntil??normalizedReference??dependency??null;
  const currentFence=task.phase==='blocked'||task.phase==='needs_attention'
    ? task.holds?.dispatch??task.holds?.merge
    : undefined;
  const owner=currentFence?.owner??task.holdOwner;
  const titleState=taskTitleStateLabel({...task,waitingOn,hold:owner?{owner}:undefined});
  const numberToken=referenceLabel&&referenceLabel.trim()?referenceLabel.trim():task.number?formatTaskNumber(task.number):null;
  return `${titleState}: ${numberToken ? `${numberToken} ` : ''}${task.title.replace(/\s+worker$/i,'')}`;
}
