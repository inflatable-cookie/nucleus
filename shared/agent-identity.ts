import { hostKindOf } from './host-kind';

/** Versioned, canonical Nucleus identity. Native IDs remain opaque. */
const PREFIX = 'nucleus-agent:v1:';

export interface QualifiedAgentId { hostId: string; nativeAgentId: string }

export function formatAgentId(hostId: string, nativeAgentId: string): string {
  if (!hostId || !nativeAgentId) throw new Error('Host and native agent identity are required');
  return PREFIX + JSON.stringify([hostId, nativeAgentId]);
}

/** A reserved but malformed identity must never be treated as a legacy ID. */
export function parseAgentId(id: string): QualifiedAgentId | null {
  if (!id.startsWith(PREFIX)) return null;
  let value: unknown;
  try { value = JSON.parse(id.slice(PREFIX.length)); } catch { throw new Error('Malformed qualified agent identity'); }
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !value[0]
    || typeof value[1] !== 'string' || !value[1] || formatAgentId(value[0], value[1]) !== id)
    throw new Error('Malformed qualified agent identity');
  return { hostId: value[0], nativeAgentId: value[1] };
}

/** A legacy field is always native, even if its contents look encoded. */
export function qualifyLegacyAgentId(id: string, provenHostId: string): string {
  return formatAgentId(provenHostId, id);
}

/** Only call on a field explicitly marked as qualified by its schema. */
export function nativeAgentId(id: string, hostId: string): string {
  const parsed = parseAgentId(id);
  if (!parsed) throw new Error('Expected a qualified agent identity');
  if (parsed.hostId !== hostId) throw new Error('Agent identity belongs to a different host');
  return parsed.nativeAgentId;
}

/** Caller fields accept old bare Paseo IDs without changing the stored record. */
export function sameCallerIdentity(left: string | null | undefined, right: string | null | undefined,
  leftHostId?: string | null, rightHostId?: string | null): boolean {
  if (!left || !right) return false;
  const a = parseAgentId(left), b = parseAgentId(right);
  const aHost = a?.hostId ?? leftHostId, bHost = b?.hostId ?? rightHostId;
  if ((a?.nativeAgentId ?? left) !== (b?.nativeAgentId ?? right)) return false;
  if (aHost && bHost) return aHost === bHost;
  // Unqualified historical caller fields belong to Paseo, never a new host.
  return (!aHost || hostKindOf(aHost) === 'paseo') && (!bHost || hostKindOf(bHost) === 'paseo');
}

/** Resolve a caller for a host API; a qualified identity must match that host. */
export function callerNativeId(id: string, hostId: string | null | undefined): string {
  const parsed = parseAgentId(id);
  if (!parsed) return id;
  if (!hostId || parsed.hostId !== hostId) throw new Error('Caller identity belongs to a different or unknown host');
  return parsed.nativeAgentId;
}
