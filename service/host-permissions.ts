import { HostFacade } from '../core/host/host-facade';
import { HostUnknownDeliveryError, ProvenPreSendRefusalError, sanitizeHostDeliveryDiagnostic, type Adapter } from '../core/host';
import type { HostRegistry } from '../core/host/host-registry';
import type { HostPermissionAnswerInput } from '../shared/rpc/questions';
import type { Store } from '../core/store/store';
import type { Task } from '../shared/contracts';

/** Runtime policy is supplied by the owner; a native-only proof has no task store. */
export interface HostPermissionOwnership {
  store: Pick<Store, 'tasks' | 'runs' | 'task' | 'transaction' | 'event' | 'eventsAll'>;
  attention(task: Task, reason: string): void;
}

function active(task: Task): boolean {
  return !task.removedAt && !task.finishedAt && !task.disposition && !['done', 'cancelled'].includes(task.phase);
}

/** Titles, labels, origins and a caller-supplied task ID never establish ownership. */
function ownerOf(context: HostPermissionOwnership, input: HostPermissionAnswerInput): Task | null {
  const owners = context.store.tasks().filter(task => active(task) && task.hostId === input.hostId && (
    task.agentId === input.agentId && task.workspaceId === input.workspaceId
    || context.store.runs(task.id).some(run => !run.released && run.hostId === input.hostId
      && run.agentId === input.agentId && run.workspaceId === input.workspaceId)
  ));
  if (owners.length > 1) throw new ProvenPreSendRefusalError('Native permission thread ownership is ambiguous; no response was sent');
  return owners[0] ?? null;
}

function reportUnknown(context: HostPermissionOwnership, owner: Task, input: HostPermissionAnswerInput, error: HostUnknownDeliveryError) {
  // The neutral error already restricts these names; validate again at the
  // durable attention boundary instead of persisting any remote error body.
  const { command, field, reason, guidance } = sanitizeHostDeliveryDiagnostic(error.diagnostic);
  const attention = `Native permission response delivery is unknown${command ? `; command ${command}` : ''}${field ? `; field ${field}` : ''}${reason ? `; reason ${reason}` : ''}${guidance ? `; guidance ${guidance}` : ''}; inspect the original request; no response was resent`;
  const detail = JSON.stringify({ hostId: input.hostId, agentId: input.agentId, workspaceId: input.workspaceId, requestId: input.requestId,
    delivery: 'unknown', ...(command ? { command } : {}), ...(field ? { field } : {}), ...(reason ? { reason } : {}), ...(guidance ? { guidance } : {}) });
  context.store.transaction(() => {
    let current: Task;
    try { current = context.store.task(owner.id); } catch { return; }
    if (!context.store.eventsAll(owner.id).some(event => event.kind === 'host_permission_delivery_unknown' && event.detail === detail))
      context.store.event(owner.id, 'host_permission_delivery_unknown', detail);
    // A role move or disposition during the send cannot redirect attention to
    // a new owner. The original task retains the historical delivery evidence.
    let stillOwned: Task | null = null;
    try { stillOwned = ownerOf(context, input); } catch { /* ambiguity is not authority to alter either task */ }
    if (active(current) && stillOwned?.id === owner.id) context.attention(current, attention);
  });
}

/** The authenticated service chooses only the explicitly addressed registered host. */
export async function answerHostPermission(
  registry: Pick<HostRegistry<{ adapter: Adapter }>, 'get'>,
  input: HostPermissionAnswerInput,
  ownership?: HostPermissionOwnership,
): Promise<{ ok: true }> {
  const selected = registry.get(input.hostId);
  if (!selected) throw new Error(`Waiting for registered host ${input.hostId}`);
  const owner = ownership ? ownerOf(ownership, input) : null;
  try {
    await new HostFacade(selected).answerNativePermission(input.agentId, input.workspaceId, input.requestId, input.decision, input.intentId);
  } catch (error) {
    if (ownership && owner && error instanceof HostUnknownDeliveryError) reportUnknown(ownership, owner, input, error);
    throw error;
  }
  return { ok: true };
}
