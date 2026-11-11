import { CHECKPOINT_BUDGET, blockingHoldKind, type CheckpointState, type Task } from './contracts';
import type { HoldKind } from './contracts';
type HoldView = { dispatch?: unknown; merge?: unknown };

const labels:Record<Task['phase'],string>={
  queued:'Queued',dispatching:'Dispatching',working:'Working',awaiting_review:'Review',report_ready:'Planner',blocked:'Blocked',error:'Error',needs_attention:'Attention',
  cancelled:'Cancelled',reviewing:'Reviewing',changes_requested:'Changes',verifying:'Verifying',merging:'Merging',syncing:'Syncing',closing:'Closing',done:'Done',
};

type StateTask={held:boolean;phase:Task['phase'];holdKind?:HoldKind;holds?:HoldView;hold?:{owner?:string;reason?:string};holdOwner?:string|null;waitState?:{owner:string;state?:string};waitingOn?:string|null;disposition?:{status:string;kind:string}|null};

/** Which holds a task carries, from the per-kind fences or the legacy single kind. */
function holdsOn(task:StateTask){
  const dispatch=Boolean(task.holds?.dispatch)||task.holdKind==='dispatch';
  const merge=Boolean(task.holds?.merge)||task.holdKind==='merge';
  return {dispatch,merge,any:task.held||dispatch||merge};
}
/**
 * The hold that is what the task is waiting on right now, if any. A dispatch hold
 * blocks a task that has not started; a merge hold blocks only a task ready to
 * merge (the same phases as the `merge_hold` wait state). Any other held task is
 * still doing its own work, so its phase is its state.
 */
export function blockingHold(task:StateTask):'dispatch'|'merge'|'both'|'held'|null{
  const {dispatch,merge,any}=holdsOn(task);
  if(!any)return null;
  return blockingHoldKind(task.phase, dispatch, merge) ?? (task.held&&!dispatch&&!merge?'held':null);
}
/**
 * The dispatch fence a task is waiting on, when it blocks dispatch now (`dispatch`
 * or `both`). The card and detail show its live reason in place of the stored
 * `reason`, which can keep an obsolete message after its cause has cleared.
 */
export function dispatchWaitFence<F>(task:StateTask&{holds?:{dispatch?:F}}):F|null{
  const blocking=blockingHold(task);
  return blocking==='dispatch'||blocking==='both' ? task.holds?.dispatch??null : null;
}
/** The phase alone, without the hold or wait that may also stand on it: the board card's "what is happening" line. */
export function phaseStateLabel(task:StateTask){
  if(task.disposition&&task.disposition.status!=='complete')return 'Cancelling';
  if(task.phase==='cancelled'&&task.disposition?.kind==='supersede')return 'Superseded';
  return labels[task.phase];
}
function heldLabel(task:StateTask, blocking:'dispatch'|'merge'|'both'|'held'){
  const fence=blocking==='merge'?task.holds?.merge:task.holds?.dispatch;
  const owner=fence&&typeof fence==='object'&&'owner'in fence?String((fence as {owner:unknown}).owner):task.hold?.owner??task.holdOwner??'';
  const operator=owner.toLowerCase()==='operator'||owner.toLowerCase()==='tom';
  if(task.waitingOn)return `Waiting on ${task.waitingOn}`;
  if((task.phase==='blocked'||task.phase==='needs_attention')&&operator)return 'Waiting on Tom';
  if(blocking==='merge')return `Merge held by ${operator?'Tom':'planner'}`;
  if(operator)return 'Waiting on Tom';
  return 'Held by planner';
}
/** Lower-case hold names a non-blocking hold adds after the phase. */
function holdNames(task:StateTask){
  const {dispatch,merge}=holdsOn(task);
  return dispatch&&merge?'dispatch and merge held':dispatch?'dispatch held':merge?'merge held':'held';
}
function waitLabel(task:StateTask):string|null{
  if(!task.waitState||!['queued','blocked','error','needs_attention','verifying','merging'].includes(task.phase))return null;
  if(task.waitingOn)return `Waiting on ${task.waitingOn}`;
  if(task.waitState.owner.toLowerCase()==='operator'||task.waitState.owner.toLowerCase()==='tom')return 'Waiting on Tom';
  if(task.waitState.state==='waiting_prerequisite')return 'Waiting for prerequisite';
  if(task.waitState.state==='waiting_capacity')return 'Waiting for capacity';
  if(task.waitState.state==='needs_source_rights')return 'Waiting for source rights';
  return null;
}

/**
 * The full state: the hold when it is what the task waits on, otherwise the
 * phase with any hold named after it (`Working · merge held`).
 */
export function taskStateLabel(task:StateTask){
  const blocking=blockingHold(task);
  if(blocking)return heldLabel(task,blocking);
  const wait=waitLabel(task);
  if(wait)return wait;
  const phase=phaseStateLabel(task);
  return holdsOn(task).any&&!['done','cancelled'].includes(task.phase)?`${phase} · ${holdNames(task)}`:phase;
}
/** The compact state for a Paseo workspace title, including an explicit wait owner or target. */
export function taskTitleStateLabel(task:StateTask){
  if (task.phase === 'done' || task.phase === 'cancelled') return phaseStateLabel(task);
  const blocking=blockingHold(task);
  if(blocking)return heldLabel(task,blocking);
  const wait=waitLabel(task);
  if(wait)return wait;
  const phase=phaseStateLabel(task);
  return holdsOn(task).any&&!['done','cancelled'].includes(task.phase)?`${phase}*`:phase;
}
/** Compact bounded-checkpoint ordinal, budget and continuation state for task detail. */
export function checkpointStateLabel(checkpoints: CheckpointState){
  const { records, intent } = checkpoints;
  const ordinal = `${records.length}/${CHECKPOINT_BUDGET}`;
  if (intent?.status === 'pending') return `Checkpoints ${ordinal} · continuation pending`;
  if (intent?.status === 'uncertain') return `Checkpoints ${ordinal} · continuation needs attention`;
  if (intent) return `Checkpoints ${ordinal} · continued: ${intent.summary}`;
  const last = records.at(-1);
  return last ? `Checkpoints ${ordinal} · last: ${last.summary}` : `Checkpoints ${ordinal}`;
}
