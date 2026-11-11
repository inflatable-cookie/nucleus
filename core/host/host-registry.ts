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

/** A partial or ambiguous inventory is not evidence of the origin's host. */
export async function resolveOriginHost<T>(registry: HostRegistry<T>, agentId: string, lookup: (host: T, id: string) => Promise<unknown | null>): Promise<string | undefined> {
  const online = registry.onlineIds(), known = registry.known();
  if (online.length === 1 && known.length === 1) return online[0];
  if (online.length !== known.length) return undefined;
  const matches: string[] = [];
  for (const id of online) {
    const host = registry.get(id);
    if (!host) return undefined;
    try { if (await lookup(host, agentId)) matches.push(id); }
    catch { return undefined; }
  }
  return matches.length === 1 ? matches[0] : undefined;
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
