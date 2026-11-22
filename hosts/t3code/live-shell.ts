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

/** A tail quiet for this long no longer proves the copy current: it is re-read. */
export const LIVE_SHELL_QUIET_BOUND_MS = 5 * 60_000;
/** A subscription this old is replaced by a fresh one, whatever its tail did. */
export const LIVE_SHELL_MAX_AGE_MS = 15 * 60_000;
/** The longest a background reopen waits after failed opens. */
const BACKGROUND_OPEN_BACKOFF_MAX_MS = 60_000;

/** One copy of T3's shell: its rows, projects and the sequence it reached. */
interface ShellCopy {
  schemaVersion: number;
  sequence: number;
  active: Map<string, ShellRow>;
  archived: Map<string, ShellRow>;
  projects: Map<string, ShellProject>;
}
const emptyCopy = (): ShellCopy => ({
  schemaVersion: 1,
  sequence: 0,
  active: new Map(),
  archived: new Map(),
  projects: new Map(),
});

/**
 * One held `orchestration.subscribeShell` subscription per host connection
 * (Spec 069 batch 5). The nightly answers the subscription with one
 * authoritative snapshot, a `synchronized` marker, and then a live tail of
 * `thread.updated`, `thread.removed`, `project.updated` and `project.removed`
 * items. This owner applies that tail to the snapshot it holds, so every reader
 * on the host — the host pass, the board, Settings, an exact lookup — answers
 * from memory instead of asking T3 for the whole shell again.
 *
 * The rows are T3's own: nothing is inferred. A thread the live shell does not
 * list is not live (T3 lists every active, non-archived thread).
 *
 * Freshness is bounded. The copy is live only while its subscription is open, its
 * tail has said something within `quietBoundMs`, and the subscription is younger
 * than `maxAgeMs`. Past either bound, or when the stream ends for any reason (a
 * disconnect, a remote exit, `snapshot-required`, an item this client does not
 * know), a reader that needs a current answer opens a new subscription, which
 * takes exactly one fresh snapshot. The previous copy is kept, so a reader that
 * may show a dated answer (`currentOrLast`) is served at once while the new one
 * opens.
 */
export class T3LiveShell {
  private subscription: { close(): void } | null = null;
  private opening: Promise<void> | null = null;
  private synchronized = false;
  private copy: ShellCopy | null = null;
  private copyReadAt = 0;
  private openedAt = 0;
  private lastItemAt = 0;
  private built: LiveShellSnapshot | null = null;
  private generation = 0;
  private openFailures = 0;
  private nextBackgroundOpenAt = 0;
  private readonly listeners = new Set<(threadId: string | null) => void>();
  /** Authoritative snapshots taken on this host: one per (re)subscription. */
  snapshotsTaken = 0;
  /** Freshness bounds; adjustable for tests. */
  quietBoundMs = LIVE_SHELL_QUIET_BOUND_MS;
  maxAgeMs = LIVE_SHELL_MAX_AGE_MS;

  constructor(
    private readonly rpc: T3RpcClient,
    private readonly openTimeoutMs = OPEN_TIMEOUT_MS,
  ) {}

  /** Whether the held copy is synchronized with T3 and inside its freshness bounds. */
  get live(): boolean {
    if (!this.synchronized || this.subscription === null || !this.copy)
      return false;
    const now = Date.now();
    return (
      now - this.lastItemAt <= this.quietBoundMs &&
      now - this.openedAt <= this.maxAgeMs
    );
  }

  /** When the held copy was last confirmed by T3 (an item or the snapshot), or null. */
  get readAt(): string | null {
    return this.copy ? new Date(this.copyReadAt).toISOString() : null;
  }

  /**
   * Called with a thread id when T3 changed that row (from the tail, or between
   * two snapshots), or `null` when the copy was discarded.
   */
  onChange(listener: (threadId: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The current shell. A live copy answers at once; otherwise one subscription
   * opens (shared by every concurrent caller) and answers once T3 says it is
   * synchronized.
   */
  async current(): Promise<LiveShellSnapshot> {
    if (this.live) {
      await liveShellTestBarrier();
      if (this.live) return this.snapshot();
    }
    await this.open();
    return this.snapshot();
  }

  /**
   * The current shell when it is live, or else the last copy this connection
   * held, at once, while a fresh one opens in the background (with backoff after
   * failed opens). For readers that show a dated list — the board's and Settings'
   * live agents — never for a decision. With no copy at all it waits like
   * `current`.
   */
  async currentOrLast(): Promise<LiveShellSnapshot> {
    if (this.live || !this.copy) return this.current();
    if (Date.now() >= this.nextBackgroundOpenAt)
      void this.open().catch(() => undefined);
    return this.snapshot();
  }

  /** One row of the held copy, active or archived. */
  row(threadId: string): ShellRow | undefined {
    return this.copy?.active.get(threadId) ?? this.copy?.archived.get(threadId);
  }

  /** Drop the copy and the subscription; the next reader takes a fresh snapshot. */
  close(): void {
    this.generation++;
    const subscription = this.subscription;
    this.subscription = null;
    subscription?.close();
    this.synchronized = false;
    this.copy = null;
    this.built = null;
    this.openFailures = 0;
    this.nextBackgroundOpenAt = 0;
    this.notify(null);
  }

  private snapshot(): LiveShellSnapshot {
    const copy = this.copy ?? emptyCopy();
    if (!this.built)
      this.built = {
        schemaVersion: copy.schemaVersion,
        snapshotSequence: copy.sequence,
        projects: [...copy.projects.values()],
        threads: [...copy.active.values()],
        archivedThreads: [...copy.archived.values()],
      };
    return this.built;
  }

  /** The stream stopped proving the copy current; the copy stays as the last one held. */
  private lapse(): void {
    this.synchronized = false;
    const subscription = this.subscription;
    this.subscription = null;
    subscription?.close();
  }

  private noteOpenFailure(): void {
    this.openFailures++;
    this.nextBackgroundOpenAt =
      Date.now() +
      Math.min(
        BACKGROUND_OPEN_BACKOFF_MAX_MS,
        1_000 * 2 ** Math.min(this.openFailures - 1, 6),
      );
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

  /** Replace the held copy with a fresh one, telling listeners which rows moved between them. */
  private swap(next: ShellCopy): void {
    const previous = this.copy;
    this.copy = next;
    this.built = null;
    if (!previous) return;
    const key = (row: ShellRow | undefined) =>
      row === undefined ? "" : JSON.stringify(row);
    const ids = new Set([
      ...previous.active.keys(),
      ...previous.archived.keys(),
      ...next.active.keys(),
      ...next.archived.keys(),
    ]);
    for (const id of ids) {
      const before = previous.active.get(id) ?? previous.archived.get(id);
      const after = next.active.get(id) ?? next.archived.get(id);
      if (key(before) !== key(after)) this.notify(id);
    }
  }

  private open(): Promise<void> {
    if (this.opening) return this.opening;
    const generation = ++this.generation;
    this.lapse();
    this.opening = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) {
          this.openFailures = 0;
          this.nextBackgroundOpenAt = 0;
          resolve();
        } else {
          this.noteOpenFailure();
          reject(error);
        }
      };
      const fail = (error: unknown) => {
        if (generation !== this.generation) return;
        // Later values of the same chunk belong to the abandoned subscription.
        this.generation++;
        this.lapse();
        finish(error);
      };
      const timer = setTimeout(
        () =>
          fail(
            new T3CompatibilityError("subscribeShell: no synchronized snapshot"),
          ),
        this.openTimeoutMs,
      );
      timer.unref?.();
      let next: ShellCopy | null = null;
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
                if (next)
                  throw new T3CompatibilityError(
                    "subscribeShell: duplicate authoritative snapshot",
                  );
                next = copyOf(
                  decode(shellSnapshot, item.snapshot, "subscribeShell.snapshot"),
                );
                this.snapshotsTaken++;
              } else if (item.kind === "synchronized") {
                if (!next)
                  throw new T3CompatibilityError(
                    "subscribeShell.snapshot missing",
                  );
                this.swap(next);
                this.synchronized = true;
                this.openedAt = this.lastItemAt = this.copyReadAt = Date.now();
                finish();
              } else
                throw new T3CompatibilityError(
                  "subscribeShell: state changed during snapshot",
                );
              return;
            }
            this.apply(item);
            this.lastItemAt = this.copyReadAt = Date.now();
          } catch (error) {
            fail(error);
          }
        },
        (error) => {
          if (generation !== this.generation) return;
          this.generation++;
          this.synchronized = false;
          this.subscription = null;
          finish(error ?? new T3CompatibilityError("subscribeShell ended"));
        },
      );
    }).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /** One live-tail item, applied to the held copy; anything unknown lapses the copy. */
  private apply(item: z.infer<typeof streamItem>): void {
    const copy = this.copy!;
    switch (item.kind) {
      case "thread.updated": {
        const update = decode(threadUpdated, item, "subscribeShell.thread");
        const id = update.thread.id;
        if (update.location === "active") {
          copy.active.set(id, update.thread);
          copy.archived.delete(id);
        } else {
          copy.archived.set(id, update.thread);
          copy.active.delete(id);
        }
        this.advance(update.sequence);
        this.notify(id);
        return;
      }
      case "thread.removed": {
        const removal = decode(threadRemoved, item, "subscribeShell.thread");
        (removal.location === "active" ? copy.active : copy.archived).delete(
          removal.threadId,
        );
        this.advance(removal.sequence);
        this.notify(removal.threadId);
        return;
      }
      case "project.updated": {
        const update = decode(projectUpdated, item, "subscribeShell.project");
        copy.projects.set(update.project.id, update.project);
        this.advance(update.sequence);
        return;
      }
      case "project.removed": {
        const removal = decode(projectRemoved, item, "subscribeShell.project");
        copy.projects.delete(removal.projectId);
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
        // no longer be proved current, so the next reader re-reads it once.
        throw new Error(`subscribeShell: ${item.kind.slice(0, 40)}`);
    }
  }

  private advance(sequence: number): void {
    if (this.copy && sequence > this.copy.sequence) this.copy.sequence = sequence;
    this.built = null;
  }
}

function copyOf(snapshot: LiveShellSnapshot): ShellCopy {
  return {
    schemaVersion: snapshot.schemaVersion,
    sequence: snapshot.snapshotSequence,
    active: new Map(snapshot.threads.map((row) => [row.id, row])),
    archived: new Map(snapshot.archivedThreads.map((row) => [row.id, row])),
    projects: new Map(snapshot.projects.map((entry) => [entry.id, entry])),
  };
}
