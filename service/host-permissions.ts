import { HostFacade } from '../core/host/host-facade';
import type { Adapter } from '../core/host';
import type { HostRegistry } from '../core/host/host-registry';
import type { HostPermissionAnswerInput } from '../shared/rpc/questions';

/** The authenticated service chooses only the explicitly addressed registered host. */
export async function answerHostPermission(
  registry: Pick<HostRegistry<{ adapter: Adapter }>, 'get'>,
  input: HostPermissionAnswerInput,
): Promise<{ ok: true }> {
  const selected = registry.get(input.hostId);
  if (!selected) throw new Error(`Waiting for registered host ${input.hostId}`);
  await new HostFacade(selected).answerNativePermission(input.agentId, input.workspaceId, input.requestId, input.decision, input.intentId);
  return { ok: true };
}
