import { parseAgentId, sameCallerIdentity } from '../../shared/agent-identity';
import type { IdentitySource } from '../../shared/host-kind';

/** Ten minutes after the last host closes (Tom, 2026-11-08, `vision.md` "Split
 * details"). Active host runs keep the daemon alive; a reconnect or a new
 * presence within the grace cancels the shutdown. */
export const HOST_IDLE_GRACE_MS = 10 * 60_000;

/** Live host sessions are separate from the durable catalogue. A disconnect never
 * removes a known identity or proves anything about its outstanding effects. */
export interface KnownHost { id: string; endpoint: string }
export interface HostRegistryStore {
  read(): readonly KnownHost[];
  write(hosts: readonly KnownHost[]): void;
  transaction<T>(fn: () => T): T;
  readDisconnectedAt?(): number | null;
  /** The last host close, so a restart resumes the same grace instead of
   * granting a new one. */
  writeDisconnectedAt?(at: number | null): void;
}

/**
 * One host's answer about an identity. `mine` is a positive read, `not-mine` is
 * authoritative absence from a complete inventory, and `unknown` is a read that
 * proved nothing (transport failure, incomplete inventory, no such capability).
 * A host that cannot tell absence from a failed read never answers `not-mine`.
 */
export type OriginLookup = 'mine' | 'not-mine' | 'unknown';

/**
 * The caller's identity source named the host it belongs to (the caller
 * resolution in `shared/caller.mjs` proves it from a ticket or the host's own
 * fallback). It is evidence about the identity's own host, never another
 * thread's.
 */
export interface OriginHostEvidence { hostId: string; source: string }

/**
 * The caller's identity source as evidence for one origin identity. It applies
 * only when it names the same thread: the same native ID, compared as a thread
 * and not as a string, so a bare recorded author (Paseo's, per the historical
 * caller-field rule) matches the host-qualified caller that the same thread
 * resolved to. The source's own host must agree with any qualification it
 * carries, and that host must be registered. Anything else is no evidence.
 */
export function identitySourceHostEvidence(agentId: string, identitySource: IdentitySource | undefined,
  knownHostIds: readonly string[]): OriginHostEvidence | undefined {
  if (!identitySource) return undefined;
  try {
    const qualified = parseAgentId(identitySource.agent);
    if (qualified && qualified.hostId !== identitySource.hostId) return undefined;
    if (!sameCallerIdentity(identitySource.agent, agentId, identitySource.hostId)) return undefined;
  } catch { return undefined; }
  return knownHostIds.includes(identitySource.hostId) ? { hostId: identitySource.hostId, source: 'caller identity source' } : undefined;
}

const answered = (value: unknown): OriginLookup => value === 'unknown' ? 'unknown'
  : value === 'mine' ? 'mine'
  : value === 'not-mine' || value === null || value === undefined ? 'not-mine'
  : value ? 'mine' : 'not-mine';

/**
 * A partial or ambiguous inventory is not evidence of the origin's host.
 *
 * Exactly one host must say `mine` and every host that could be asked must rule
 * itself out. An offline host cannot rule itself out, so it leaves the answer
 * unknown — unless the identity's own source names its host: that evidence rules
 * every other host out, and a claim from anywhere else is a conflict, not a
 * resolution. Two claimants are always a refusal.
 */
export async function resolveOriginHost<T>(registry: HostRegistry<T>, agentId: string,
  lookup: (host: T, id: string) => Promise<OriginLookup | unknown | null>,
  evidence?: OriginHostEvidence): Promise<string | undefined> {
  const online = registry.onlineIds(), known = registry.known().map(entry => entry.id);
  // Stale evidence (a host this registry never knew) decides nothing.
  const named = evidence && known.includes(evidence.hostId) ? evidence.hostId : undefined;
  if (online.length === 1 && known.length === 1) return online[0];
  const claimants: string[] = [];
  let undecided = false;
  for (const id of online) {
    const host = registry.get(id);
    if (!host) { undecided = true; continue; }
    let answer: OriginLookup;
    try { answer = answered(await lookup(host, agentId)); }
    catch { undecided = true; continue; }
    if (answer === 'unknown') undecided = true;
    else if (answer === 'mine') claimants.push(id);
  }
  if (claimants.length !== 1) return undefined;
  const claimant = claimants[0];
  // The caller's identity source is decisive: it names the host the identity
  // belongs to, so a claimant elsewhere contradicts it.
  if (named) return named === claimant ? claimant : undefined;
  // Without that evidence an offline or undecided host leaves the answer unknown.
  if (undecided || online.length !== known.length) return undefined;
  return claimant;
}

export class HostRegistry<T> {
  private readonly sessions = new Map<string, { endpoint: string; token: object; host: T }>();
  private readonly resources = new Map<string, unknown>();
  private lastDisconnect: number | null = null;
  private readonly graceMs: number;
  constructor(private readonly store: HostRegistryStore, private readonly now: () => number = Date.now, graceMs: number = HOST_IDLE_GRACE_MS) {
    this.graceMs = graceMs;
    // A stored host with no recorded close (an older store) starts the grace
    // here rather than shutting the daemon down on a guess. No stored host at
    // all means no host has ever left, so there is no clock yet.
    this.lastDisconnect = store.readDisconnectedAt?.() ?? (store.read().length ? this.now() : null);
  }

  /** A connection must already have proved its identity on the endpoint. */
  connect(id: string, endpoint: string, host: T, beforeCommit?: () => void): object {
    if (!id || !endpoint) throw new Error('Host identity and endpoint are required');
    if (this.sessions.has(id)) throw new Error('Host identity already has a live claim');
    this.store.transaction(() => {
      const known = this.store.read();
      const existing = known.find(entry => entry.id === id);
      if (known.some(entry => entry.endpoint === endpoint && entry.id !== id)) throw new Error('Host endpoint returned a different identity');
      if (existing && existing.endpoint && existing.endpoint !== endpoint) throw new Error('Host identity conflicts with its registered endpoint');
      beforeCommit?.();
      if (!existing) this.store.write([...known, { id, endpoint }]);
      else if (!existing.endpoint) this.store.write(known.map(entry => entry.id === id ? { id, endpoint } : entry));
      this.store.writeDisconnectedAt?.(null);
    });
    const token = {};
    this.sessions.set(id, { endpoint, token, host });
    this.lastDisconnect = null;
    return token;
  }

  /** A stale close from a replaced connection must not close its successor. */
  disconnect(id: string, token: object): void {
    if (this.sessions.get(id)?.token !== token) return;
    this.sessions.delete(id);
    if (!this.sessions.size) {
      this.lastDisconnect = this.now();
      this.store.writeDisconnectedAt?.(this.lastDisconnect);
    }
  }

  /** Admission and breaker state belongs to an identity, surviving reconnects. */
  resource<R>(id: string, create: () => R): R {
    if (!this.resources.has(id)) {
      const value = create();
      if ([...this.resources.values()].some(existing => existing === value)) throw new Error('Host resource belongs to another identity');
      this.resources.set(id, value);
    }
    return this.resources.get(id) as R;
  }

  restartGrace(): void {
    if (this.sessions.size) return;
    this.lastDisconnect = this.now();
    this.store.writeDisconnectedAt?.(this.lastDisconnect);
  }

  get(id: string): T | undefined { return this.sessions.get(id)?.host; }
  onlineIds(): string[] { return [...this.sessions.keys()]; }
  known(): readonly KnownHost[] { return this.store.read(); }
  /** The last host close this registry knows about, or null before any host left. */
  disconnectedAt(): number | null { return this.lastDisconnect; }
  /** The instant the idle grace runs out, or null while a host is connected. */
  shutdownDueAt(): number | null { return this.lastDisconnect === null ? null : this.lastDisconnect + this.graceMs; }
  /** Unknown active-run state is conservatively treated as in use. */
  shouldShutdown(activeRuns: number | null): boolean {
    const dueAt = this.shutdownDueAt();
    return this.sessions.size === 0 && dueAt !== null && activeRuns === 0 && this.now() >= dueAt;
  }
}
