import type { Run, Task } from '../../shared/contracts';

/** Task execution bindings, including retained history whose tools may still run.
 * Planning and coordination identities do not themselves establish a binding.
 */
export function executionParticipants(task: Task, runs: Run[]): Map<string, string> {
  const participants = new Map<string, string>();
  const add = (agentId: string | null, workspaceId: string | null) => {
    if (!agentId || !workspaceId) throw Error('Participant identity or workspace is unknown');
    const previous = participants.get(agentId);
    if (previous && previous !== workspaceId) throw Error('Participant workspace identity conflicts');
    participants.set(agentId, workspaceId);
  };
  if (task.agentId) add(task.agentId, task.workspaceId);
  for (const worker of task.retiredWorkers) {
    const run = runs.find(item => item.id === worker.runId);
    if (run && (run.taskId !== task.id || run.role !== 'revision' || run.agentId !== worker.agentId))
      throw Error('Retired worker run identity conflicts');
    add(worker.agentId, run?.workspaceId || task.workspaceId);
  }
  for (const run of runs) {
    if (!['revision', 'reviewer', 'executor'].includes(run.role)) continue;
    if (run.taskId !== task.id) throw Error('Participant run belongs to another task');
    if (!run.agentId && run.released && !run.active) continue;
    add(run.agentId, run.workspaceId);
  }
  for (const proof of task.proofExecutions) {
    const run = runs.find(item => item.id === proof.runId);
    if (!run || run.taskId !== task.id || run.role !== 'executor' || run.agentId !== proof.agentId || run.workspaceId !== proof.workspaceId)
      throw Error('Proof executor run identity conflicts');
    add(proof.agentId, proof.workspaceId);
  }
  return participants;
}
