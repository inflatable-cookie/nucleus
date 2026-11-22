import { z } from "zod";
import type { T3RpcClient } from "./rpc";
import {
  decode,
  project,
  shellSnapshot,
  shellThread,
  T3CompatibilityError,
} from "./contracts";

type ShellRow = z.infer<typeof shellThread>;
type ShellProject = z.infer<typeof project>;
export type LiveShellSnapshot = z.infer<typeof shellSnapshot>;

/**
 * Test seam: the T3 test transport registers barriers here that resolve once every
 * shell delta it sent has been acknowledged, so a test that edits its fixture and
 * reads at once sees the edit. Nothing registers one in the service, where the
 * stream's own latency is the answer's age.
 */
async function liveShellTestBarrier(): Promise<void> {
  const barriers = (globalThis as Record<string, unknown>)[
    "__t3LiveShellBarriers"
  ] as Set<() => Promise<void>> | undefined;
  if (!barriers?.size) return;
  for (const barrier of [...barriers]) await barrier();
}

/** How long the opening snapshot may take before the subscription is abandoned. */
const OPEN_TIMEOUT_MS = 30_000;

const streamItem = z.object({ kind: z.string() }).passthrough();
const threadUpdated = z.object({
  kind: z.literal("thread.updated"),
  sequence: z.number().int().nonnegative(),
  location: z.enum(["active", "archive"]),
  thread: shellThread,
});
const threadRemoved = z.object({
  kind: z.literal("thread.removed"),
  sequence: z.number().int().nonnegative(),
  location: z.enum(["active", "archive"]),
  threadId: z.string().min(1),
});
const projectUpdated = z.object({
  kind: z.literal("project.updated"),
  sequence: z.number().int().nonnegative(),
  project,
});
const projectRemoved = z.object({
  kind: z.literal("project.removed"),
  sequence: z.number().int().nonnegative(),
  projectId: z.string().min(1),
});

/**
 * One held `orchestration.subscribeShell` subscription per host connection
 * (Spec 069 batch 5). The nightly answers the subscription with one
 * authoritative snapshot, a `synchronized` marker, and then a live tail of
 * `thread.updated`, `thread.removed`, `project.updated` and `project.removed`
 * items. This owner applies that tail to the snapshot it holds, so every reader
 * on the host — the host pass, the board, Settings, `next`, an exact lookup —
 * answers from memory instead of asking T3 for the whole shell again.
 *
 * The rows are T3's own: nothing is inferred. A thread the live shell does not
 * list is not live (T3 lists every active, non-archived thread). When the
 * stream ends for any reason — a disconnect, a remote exit, `snapshot-required`,
 * an item this client does not know — the copy is dropped and the next reader
 * opens a new subscription, which takes exactly one fresh snapshot.
 */
export class T3LiveShell {
  private subscription: { close(): void } | null = null;
  private opening: Promise<void> | null = null;
  private synchronized = false;
  private schemaVersion = 1;
  private sequence = 0;
  private readonly active = new Map<string, ShellRow>();
  private readonly archived = new Map<string, ShellRow>();
  private readonly projectsById = new Map<string, ShellProject>();
  private built: LiveShellSnapshot | null = null;
  private generation = 0;
  private readonly listeners = new Set<(threadId: string | null) => void>();
  /** Authoritative snapshots taken on this host: one per (re)subscription. */
  snapshotsTaken = 0;

  constructor(
    private readonly rpc: T3RpcClient,
    private readonly openTimeoutMs = OPEN_TIMEOUT_MS,
  ) {}

  /** Whether the held copy is synchronized with T3 right now. */
  get live(): boolean {
    return this.synchronized && this.subscription !== null;
  }

  /** Called with a thread id when T3 changed that row, or `null` when the whole copy was dropped. */
  onChange(listener: (threadId: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The current shell. A live copy answers at once, after letting any delta
   * already on the socket land; otherwise one subscription opens (shared by
   * every concurrent caller) and answers once T3 says it is synchronized.
   */
  async current(): Promise<LiveShellSnapshot> {
    if (this.live) {
      await liveShellTestBarrier();
      if (this.live) return this.snapshot();
    }
    await this.open();
    return this.snapshot();
  }

  /** One row of the held copy, active or archived; only meaningful while live. */
  row(threadId: string): ShellRow | undefined {
    return this.active.get(threadId) ?? this.archived.get(threadId);
  }

  /** Drop the copy and the subscription; the next reader takes a fresh snapshot. */
  close(): void {
    const subscription = this.subscription;
    this.subscription = null;
    subscription?.close();
    this.drop();
  }

  private snapshot(): LiveShellSnapshot {
    if (!this.built)
      this.built = {
        schemaVersion: this.schemaVersion,
        snapshotSequence: this.sequence,
        projects: [...this.projectsById.values()],
        threads: [...this.active.values()],
        archivedThreads: [...this.archived.values()],
      };
    return this.built;
  }

  private drop(): void {
    this.synchronized = false;
    this.active.clear();
    this.archived.clear();
    this.projectsById.clear();
    this.built = null;
    this.notify(null);
  }

  private notify(threadId: string | null): void {
    for (const listener of this.listeners) {
      try {
        listener(threadId);
      } catch {
        /* a listener's fault never stops the stream */
      }
    }
  }

  private open(): Promise<void> {
    if (this.opening) return this.opening;
    const generation = ++this.generation;
    this.subscription?.close();
    this.subscription = null;
    this.drop();
    this.opening = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(() => {
        if (generation !== this.generation) return;
        const subscription = this.subscription;
        this.subscription = null;
        subscription?.close();
        this.drop();
        finish(
          new T3CompatibilityError("subscribeShell: no synchronized snapshot"),
        );
      }, this.openTimeoutMs);
      timer.unref?.();
      let snapshotSeen = false;
      const fail = (error: unknown) => {
        if (generation !== this.generation) return;
        // Later values of the same chunk belong to the abandoned subscription.
        this.generation++;
        const subscription = this.subscription;
        this.subscription = null;
        subscription?.close();
        this.drop();
        finish(error);
      };
      this.subscription = this.rpc.subscribe(
        "orchestration.subscribeShell",
        { requestCompletionMarker: true },
        (value) => {
          if (generation !== this.generation) return;
          try {
            const item = decode(streamItem, value, "subscribeShell");
            if (!this.synchronized) {
              if (item.kind === "snapshot") {
                if ("resolvedRepositoryIdentityRoots" in item) return;
                if (snapshotSeen)
                  throw new T3CompatibilityError(
                    "subscribeShell: duplicate authoritative snapshot",
                  );
                snapshotSeen = true;
                this.load(
                  decode(shellSnapshot, item.snapshot, "subscribeShell.snapshot"),
                );
                this.snapshotsTaken++;
              } else if (item.kind === "synchronized") {
                if (!snapshotSeen)
                  throw new T3CompatibilityError(
                    "subscribeShell.snapshot missing",
                  );
                this.synchronized = true;
                this.built = null;
                finish();
              } else
                throw new T3CompatibilityError(
                  "subscribeShell: state changed during snapshot",
                );
              return;
            }
            this.apply(item);
          } catch (error) {
            fail(error);
          }
        },
        (error) => {
          if (generation !== this.generation) return;
          this.subscription = null;
          this.drop();
          finish(error ?? new T3CompatibilityError("subscribeShell ended"));
        },
      );
    }).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private load(snapshot: LiveShellSnapshot): void {
    this.schemaVersion = snapshot.schemaVersion;
    this.sequence = snapshot.snapshotSequence;
    for (const row of snapshot.threads) this.active.set(row.id, row);
    for (const row of snapshot.archivedThreads) this.archived.set(row.id, row);
    for (const entry of snapshot.projects)
      this.projectsById.set(entry.id, entry);
    this.built = null;
  }

  /** One live-tail item, applied to the held copy; anything unknown drops the copy. */
  private apply(item: z.infer<typeof streamItem>): void {
    switch (item.kind) {
      case "thread.updated": {
        const update = decode(threadUpdated, item, "subscribeShell.thread");
        const id = update.thread.id;
        if (update.location === "active") {
          this.active.set(id, update.thread);
          this.archived.delete(id);
        } else {
          this.archived.set(id, update.thread);
          this.active.delete(id);
        }
        this.advance(update.sequence);
        this.notify(id);
        return;
      }
      case "thread.removed": {
        const removal = decode(threadRemoved, item, "subscribeShell.thread");
        (removal.location === "active" ? this.active : this.archived).delete(
          removal.threadId,
        );
        this.advance(removal.sequence);
        this.notify(removal.threadId);
        return;
      }
      case "project.updated": {
        const update = decode(projectUpdated, item, "subscribeShell.project");
        this.projectsById.set(update.project.id, update.project);
        this.advance(update.sequence);
        return;
      }
      case "project.removed": {
        const removal = decode(projectRemoved, item, "subscribeShell.project");
        this.projectsById.delete(removal.projectId);
        this.advance(removal.sequence);
        return;
      }
      case "snapshot":
        // An enrichment refresh names repository identities only; it never
        // replaces the rows this copy holds.
        if ("resolvedRepositoryIdentityRoots" in item) return;
        throw new T3CompatibilityError(
          "subscribeShell: authoritative snapshot after synchronization",
        );
      case "synchronized":
        return;
      default:
        // `snapshot-required`, or an item this client does not know: the copy can
        // no longer be proved current, so it is dropped and re-read once.
        throw new Error(`subscribeShell: ${item.kind.slice(0, 40)}`);
    }
  }

  private advance(sequence: number): void {
    if (sequence > this.sequence) this.sequence = sequence;
    this.built = null;
  }
}
