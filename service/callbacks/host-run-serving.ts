import {
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import {
  basename,
  join,
} from "node:path";
import {
  HOST_RUN_AUTHORITY_FORMAT,
  assertOwnedRunDirectory,
  hostRunSocketIsOwnerOnly,
  removeOwnedSocketAt,
  uidOf,
  writeVerifiedOwnedFile,
  type HostRunAuthorityFile,
} from "../../core/host-runs/host-run-files";
import {
  HostRunFront,
  type HostRunFrontState,
} from "../executor/host-run-front";
import {
  HOST_RUN_SOCKET_LEAF,
  hostRunInnerSocketOwnerPid,
  hostRunInnerSocketPath,
  isHostRunInnerSocketLeaf,
} from "../../core/host-runs/host-run-paths";
import type { HostRunScheduler } from "../../core/host-runs/host-run-scheduler";
import {
  pidAlive,
} from "../../core/machine/process-identity";
import {
  hostRunOwnStartIdentity,
} from "../../core/machine/start-identity";

interface HostRunServingContext {
  scheduler: HostRunScheduler;
  socketPath: string;
  stateDir: string;
  nowMs: () => number;
  stopping: boolean;
  onConnection: (socket: Socket) => void;
}

export class HostRunServing {
  constructor(private readonly context: HostRunServingContext, adoptedFront?: HostRunFront) { this.adoptedFront = adoptedFront; }

  /** Contract-010 answer evidence: the front's first client since each bind. */
  wireFront(front: HostRunFront): void {
    front.onAccepted(() => {
      if (this.answeredSinceBind) return;
      this.answeredSinceBind = true;
      this.context.scheduler.recordEndpointEvent("endpoint_answered");
    });
  }

  /** True while this endpoint holds a bound, intact socket and a live listener. */
  serving(): boolean {
    if (!this.server) return false;
    if (this.front) {
      // The public path must name the front's listening inode. An accepting front
      // alone is not health: without this runtime's socket it cannot
      // serve a request, so it never answers for one.
      const ino = this.front.state().ino;
      if (ino === null || this.innerIno === null) return false;
      try { return lstatSync(this.context.socketPath).ino === ino; } catch { return false; }
    }
    if (this.boundIno === null) return false;
    try { return lstatSync(this.context.socketPath).ino === this.boundIno; } catch { return false; }
  }

  /**
   * Own the acceptance boundary in a front worker thread: the worker binds and
   * swaps the contract socket (or continues a warm standby's swap), this thread
   * binds its inner socket, and clients move between them. A stall here
   * delays replies; it cannot fill the kernel's accept queue.
   */
  async ensureServingThroughFront(): Promise<boolean> {
    if (this.binding) return false;
    this.binding = true;
    try {
      if (!this.front || this.front.dead()) {
        const adopted = this.adoptedFront && !this.adoptedFront.dead() ? this.adoptedFront : undefined;
        this.front = adopted ?? await HostRunFront.start({ stateDir: this.context.stateDir, socketPath: this.context.socketPath });
        this.wireFront(this.front);
        this.answeredSinceBind = adopted !== undefined;
        this.journalFrontBind(this.front.state(), adopted !== undefined);
      }
      const front = this.front!;
      this.removeStaleInnerSockets();
      if (!this.server) await this.listenInner(front.innerSocketPath());
      const state = await front.ensure();
      this.boundIno = state.ino;
      if (!state.serving) {
        this.serveError = state.error ?? `Host-run socket is not on the live path: ${this.context.socketPath}`;
        return false;
      }
      this.serveError = null;
      this.writeAuthority();
      if (this.everBound) console.error(`Host-run socket ${this.context.socketPath} was unbound; bound`);
      this.everBound = true;
      return true;
    } catch (error) {
      this.serveError = error instanceof Error ? error.message : String(error);
      console.error("Host-run socket bind failed:", this.serveError);
      return false;
    } finally { this.binding = false; }
  }

  /** Journal the front's contract-010 evidence: its bind, and a standby's swap. */
  journalFrontBind(state: HostRunFrontState, adopted: boolean): void {
    const boundAt = state.boundAt ?? new Date(this.context.nowMs()).toISOString();
    this.context.scheduler.recordEndpointEvent("endpoint_bound", boundAt);
    if (!adopted) return;
    this.context.scheduler.recordEndpointEvent("endpoint_answered", state.answeredAt ?? boundAt);
    this.context.scheduler.recordEndpointEvent("endpoint_handoff", state.swappedAt ?? boundAt, {
      boundAt, answeredAt: state.answeredAt ?? boundAt, swappedAt: state.swappedAt ?? boundAt,
    });
  }

  /** lstat-verify the owned directory holding the socket; a symlinked or swapped component refuses. */
  assertRunDirectoryVerified(): void {
    if (!this.context.socketPath.endsWith(`/run/${HOST_RUN_SOCKET_LEAF}`)) throw new Error("Host-run socket path is not the contract socket");
    assertOwnedRunDirectory(this.context.stateDir);
  }

  /** Best-effort cleanup that never unlinks through an unverified path or another holder's socket. */
  removeSocketVerified(): void {
    try { this.assertRunDirectoryVerified(); } catch { return; }
    try {
      const info = lstatSync(this.context.socketPath);
      if (this.boundIno === null || info.ino !== this.boundIno) return;
      if (info.isSocket() && !info.isSymbolicLink() && (uidOf() < 0 || info.uid === uidOf())) unlinkSync(this.context.socketPath);
    } catch { /* already gone */ }
    this.boundIno = null;
  }

  /** Remove this runtime's socket, only while the path still names our inode. */
  removeInnerSocketVerified(): void {
    const ino = this.innerIno;
    this.innerIno = null;
    if (ino === null) return;
    try {
      this.assertRunDirectoryVerified();
      const path = this.innerSocketPath;
      const info = lstatSync(path);
      if (info.ino !== ino || !info.isSocket() || info.isSymbolicLink()) return;
      if (uidOf() >= 0 && info.uid !== uidOf()) return;
      unlinkSync(path);
    } catch { /* already gone */ }
  }

  /** This process's runtime socket; every endpoint instance mints its own. */
  get innerSocketPath(): string {
    this.innerToken ??= `${process.pid}-${randomBytes(4).toString("hex")}`;
    return hostRunInnerSocketPath(this.context.stateDir, this.innerToken);
  }

  /**
   * Remove sockets a dead process left behind. The leaf names the pid
   * that minted it, so a name whose pid is gone has no live owner: a recycled
   * pid cannot reach a name it never bound. Bounded, and only through the
   * verified chain, like every other unlink here.
   */
  removeStaleInnerSockets(): void {
    let entries: string[];
    try { entries = readdirSync(join(this.context.stateDir, "run")); } catch { return; }
    let checked = 0;
    for (const leaf of entries) {
      if (checked++ >= 64) return;
      const owner = hostRunInnerSocketOwnerPid(leaf);
      if (owner === null || owner === process.pid || pidAlive(owner)) continue;
      try {
        this.assertRunDirectoryVerified();
        removeOwnedSocketAt(join(this.context.stateDir, "run", leaf));
      } catch { /* another owner's or an unverified path is left alone */ }
    }
  }

  /**
   * Maintenance self-heal: if the socket this endpoint bound is gone from its path,
   * bind again so clients stop failing with ENOENT. A path now answered by another
   * live holder is left alone (fail closed).
   */
  /**
   * Front-mode self-heal: the worker re-asserts a live path that lost our inode,
   * and refuses a path a live holder owns. Returns true only when it rebound.
   */
  async rebindIfLost(): Promise<boolean> {
    if (this.context.stopping || this.rebinding || !this.front || !this.server) return false;
    this.rebinding = true;
    try {
      const state = await this.front.ensure();
      this.boundIno = state.ino;
      if (!state.serving) {
        this.serveError = state.error ?? `Host-run socket is not on the live path: ${this.context.socketPath}`;
        return false;
      }
      if (!state.rebound) return false;
      this.serveError = null;
      // A rebound listener answers its next client as the fresh bind's evidence.
      this.answeredSinceBind = false;
      this.context.scheduler.recordEndpointEvent("endpoint_bound", state.boundAt ?? new Date(this.context.nowMs()).toISOString());
      this.writeAuthority();
      console.error(`Host-run socket ${this.context.socketPath} was missing; rebound`);
      return true;
    } catch (error) {
      this.serveError = error instanceof Error ? error.message : String(error);
      console.error("Host-run socket rebind failed:", this.serveError);
      return false;
    } finally { this.rebinding = false; }
  }

  /**
   * Bind this runtime's socket. Only the front worker of this process
   * connects to it, so it is bound under its own name (never renamed over a
   * shared one) and carries the same owner-only chain checks as the contract
   * path. It is not a client-visible endpoint and is never published.
   */
  listenInner(innerPath: string): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      let server: Server;
      const leaf = basename(innerPath);
      try {
        this.assertRunDirectoryVerified();
        if (!isHostRunInnerSocketLeaf(leaf)) throw new Error(`Host-run private socket path is not a private socket: ${innerPath}`);
        removeOwnedSocketAt(innerPath);
        server = createServer({ allowHalfOpen: false });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      server.on("connection", socket => this.context.onConnection(socket));
      const fail = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)));
      server.once("error", fail);
      server.listen(innerPath, () => {
        server.removeListener("error", fail);
        try {
          chmodSync(innerPath, 0o600);
          if (!hostRunSocketIsOwnerOnly(this.context.stateDir, leaf)) throw new Error("Private host-run socket failed the verified chain check after bind");
          this.assertRunDirectoryVerified();
        } catch (error) {
          try { server.close(); } catch { /* not listening */ }
          try { unlinkSync(innerPath); } catch { /* best effort */ }
          fail(error);
          return;
        }
        this.server = server;
        this.innerIno = lstatSync(innerPath).ino;
        resolvePromise();
      });
    });
  }

  writeAuthority(): void {
    const authority = this.context.scheduler.authority();
    const file: HostRunAuthorityFile = {
      format: HOST_RUN_AUTHORITY_FORMAT, version: 1, holder: "queue", endpoint: this.context.socketPath,
      epoch: authority.epoch, pid: process.pid, startIdentity: hostRunOwnStartIdentity(),
    };
    writeVerifiedOwnedFile(this.context.stateDir, ["authority.json"], JSON.stringify(file), 0o600);
    this.context.scheduler.store.setMeta("hostRunAuthority", { holder: "queue", epoch: authority.epoch, endpoint: this.context.socketPath });
  }

  /** The pre-started front a warm standby bound before this runtime existed. */
  readonly adoptedFront: HostRunFront | undefined;

  /** The front worker that owns the public socket, when this endpoint does not bind it itself. */
  front: HostRunFront | null = null;

  server: Server | null = null;

  /** Inode of the socket this endpoint bound; cleanup and self-heal act only on it. */
  boundIno: number | null = null;

  /** Inode of this runtime's socket, removed by this endpoint on stop. */
  innerIno: number | null = null;

  /** Suffix naming this endpoint instance's socket; minted on first use. */
  innerToken: string | null = null;

  rebinding = false;

  /** Set while `ensureServing` is binding, so maintenance passes do not race each other. */
  binding = false;

  /** True once this endpoint has bound its own socket, so a heal is distinguishable from startup. */
  everBound = false;

  /** True once a client has reached the socket since the last bind (contract-010 answer evidence). */
  answeredSinceBind = false;

  /** Why this endpoint is not serving the socket; null while it serves. */
  serveError: string | null = null;
}
