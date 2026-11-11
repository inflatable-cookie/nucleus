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
