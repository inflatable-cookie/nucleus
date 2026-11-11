import {formatTaskNumber,MAX_TITLE_LENGTH,type HoldKind,type Task} from '../../shared/contracts';
import {taskTitleStateLabel} from '../../shared/task-state';
import {PREREQUISITE_WAIT_PREFIX} from '../../shared/wait-state';

export { capPaseoTitle } from '../../shared/paseo-title';

/** `Working*: 012 Title` while a hold is in place but not what the task waits on. */
type WorkspaceTitleTask=Pick<Task,'held'|'phase'|'title'|'number'>&Partial<Pick<Task,'holds'|'disposition'|'holdOwner'|'holdReason'|'reason'|'holdUntil'|'dependsOn'>>&{holdKind?:HoldKind;waitState?:{owner:string;state?:string}};
export function taskWorkspaceTitle(task:WorkspaceTitleTask, references:ReadonlyMap<string,string>=new Map()){
  const until=task.holdUntil?.kind==='task'?references.get(task.holdUntil.taskId):undefined;
  const fences=[task.holds?.dispatch,task.holds?.merge].filter((fence):fence is NonNullable<typeof fence>=>Boolean(fence));
  const fenceUntil=fences.map(fence=>fence.until?.kind==='task'?references.get(fence.until.taskId):undefined).find(Boolean);
  const reasons=[...fences.map(fence=>fence.reason),task.holdReason,task.reason].filter((reason):reason is string=>typeof reason==='string');
  // Bounded reference tokens: an unbounded `[\w.-]+` scan backtracks
  // quadratically over a long reason and stalls the title derivation. Both
  // probes are linear, so a long reason costs one plain scan, never the regex.
  const referenced=reasons.filter(reason=>reason.includes("#")||/longhorn\d{0,9}/i.test(reason))
    .map(reason=>reason.match(/(?:[\w.-]{1,40}#\d{1,9}|#\d{1,9}|\bLonghorn\d{1,9}\b)/i)?.[0]).find(Boolean);
  const dependency=task.reason?.startsWith(PREREQUISITE_WAIT_PREFIX)?task.dependsOn?.map(id=>references.get(id)).find(Boolean):undefined;
  const normalizedReference=referenced&&/^Longhorn\d+$/i.test(referenced)?'Longhorn release':referenced;
  const waitingOn=until??fenceUntil??normalizedReference??dependency??null;
  const currentFence=task.phase==='blocked'||task.phase==='needs_attention'
    ? task.holds?.dispatch??task.holds?.merge
    : undefined;
  const owner=currentFence?.owner??task.holdOwner;
  const titleState=taskTitleStateLabel({...task,waitingOn,hold:owner?{owner}:undefined});
  return `${titleState}: ${task.number ? `${formatTaskNumber(task.number)} ` : ''}${task.title.replace(/\s+worker$/i,'')}`;
}
