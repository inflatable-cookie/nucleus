import { hostKindOf, type HostKind } from '../../shared/host-kind';
import type { HostSelection } from '../../shared/host-selection';

function chooseKind(kind: HostKind, ids: readonly string[], basis: HostSelection['basis'], reason: string): HostSelection | undefined {
  const matching = ids.filter(id => hostKindOf(id) === kind);
  if (matching.length > 1) throw new Error(`Multiple ${kind} hosts are registered; name one explicitly`);
  return matching.length === 1 ? { hostId: matching[0]!, basis, reason } : undefined;
}

export function resolveIngressHost(input: {
  explicit?: string;
  repositoryHostKind?: HostKind | null;
  operatorDefaultHostKind?: HostKind | null;
  plannerHostId?: string;
  registered: readonly string[];
  online: readonly string[];
}): { hostId: string; selection: HostSelection } {
  if (input.explicit) {
    if (!input.registered.includes(input.explicit)) throw new Error('Selected host is not registered');
    return { hostId: input.explicit, selection: { hostId: input.explicit, basis: 'explicit' } };
  }

  if (input.repositoryHostKind) {
    const selected = chooseKind(input.repositoryHostKind, input.online, 'repository_override', `Repository host override ${input.repositoryHostKind}`);
    if (selected) return { hostId: selected.hostId, selection: selected };
    const offline = chooseKind(input.repositoryHostKind, input.registered, 'repository_override', `Repository host override ${input.repositoryHostKind} is offline`);
    if (offline) return { hostId: offline.hostId, selection: offline };
    throw new Error(`${input.repositoryHostKind} host is not registered; repository host override cannot be satisfied`);
  }

  if (input.operatorDefaultHostKind) {
    const selected = chooseKind(input.operatorDefaultHostKind, input.online, 'operator_default', `Operator default host ${input.operatorDefaultHostKind}`);
    if (selected) return { hostId: selected.hostId, selection: selected };
    const offlineReason = `Operator default host ${input.operatorDefaultHostKind} is offline`;
    if (input.plannerHostId && input.registered.includes(input.plannerHostId)) {
      const plannerOnline = input.online.includes(input.plannerHostId);
      return { hostId: input.plannerHostId, selection: { hostId: input.plannerHostId, basis: 'planner_host', reason: plannerOnline ? offlineReason : `${offlineReason}; planner host ${input.plannerHostId} is also offline` } };
    }
    const offline = chooseKind(input.operatorDefaultHostKind, input.registered, 'operator_default', offlineReason);
    if (offline) return { hostId: offline.hostId, selection: offline };
    throw new Error(`${offlineReason}; no registered planner host is available`);
  }

  if (input.plannerHostId && input.registered.includes(input.plannerHostId)) {
    return { hostId: input.plannerHostId, selection: { hostId: input.plannerHostId, basis: 'planner_host', reason: input.online.includes(input.plannerHostId) ? 'Planner host' : `Planner host ${input.plannerHostId} is offline` } };
  }
  throw new Error('Planner host is unknown or not registered');
}
