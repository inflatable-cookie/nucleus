import { parseAgentId, sameCallerIdentity } from '../../../shared/agent-identity';
import { hostKindOf } from '../../../shared/host-kind';
import type { Run, Task } from '../../../shared/contracts';
import type { Adapter } from '../../host/adapter';

/** The phases the pipeline advances through, in order. */
export const stages = ['awaiting_review', 'reviewing', 'changes_requested', 'verifying', 'merging', 'syncing', 'closing', 'done'];
/** The phases a revision may start from. */
export const revisionPhases: Task['phase'][] = ['awaiting_review', 'report_ready', 'reviewing', 'changes_requested', 'blocked', 'error', 'needs_attention', 'verifying'];
// A lane that is still advancing. An escalation on one of these phases is not
// answerable evidence yet, whatever the incident record says (Spec 016 rule 6).
export const workingLanes = new Set<Task['phase']>(['dispatching', 'working', 'awaiting_review', 'reviewing', 'changes_requested', 'verifying', 'merging', 'syncing', 'closing']);
