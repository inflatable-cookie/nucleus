import { hostKindOf, type HostKind } from '../../shared/host-kind';
import type { HostSelection } from '../../shared/host-selection';

export function resolveIngressHost(input: {
  explicit?: string;
  hostKind: HostKind;
  registered: readonly string[];
  online: readonly string[];
}): { hostId: string; selection: HostSelection } {
  if (input.explicit) {
    if (!input.registered.includes(input.explicit)) throw new Error('Selected host is not registered');
    return { hostId: input.explicit, selection: { hostId: input.explicit, basis: 'explicit' } };
  }
  const matching = input.online.filter(id => hostKindOf(id) === input.hostKind);
  if (matching.length === 1) {
    const hostId = matching[0]!;
    return { hostId, selection: { hostId, basis: 'repository_host', reason: `Repository hostKind ${input.hostKind}` } };
  }
  if (matching.length === 0) {
    throw new Error(input.hostKind === 't3code'
      ? 'T3Code host is not online; opt the repository back to paseo or start T3'
      : 'Paseo host is not online');
  }
  throw new Error(`Multiple ${input.hostKind} hosts are online; name one explicitly`);
}
