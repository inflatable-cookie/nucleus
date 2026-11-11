import { pidAlive, processCommandLine, processCommandLineAsync } from "./process-identity";
import { RecordedIdentityProofs, readHostRunStartIdentity, HOST_RUN_IDENTITY_PROOF_CACHE_MS, type RecordedIdentityProofOptions } from "./start-identity";

export interface SupervisorLiveness { state: "live" | "dead" | "unknown"; reason: string }

/** The host probes liveness uses; tests inject them to pin the unreadable and mismatched cases. */
export interface SupervisorLivenessProbes {
  alive?(pid: number): boolean;
  command?(pid: number): string | null;
}

/**
 * Decide whether the live process at `pid` is this run's supervisor. The pid is
 * trusted only together with the run's identity token, which the supervisor
 * carries in its argv: a recycled pid cannot have it, whatever the clock
 * resolution. A pid that is gone, or that now runs a different command line, is
 * proven dead; a pid whose command line cannot be read stays unknown, never
 * dead, so a transient read failure can never make the service reap a live run.
 */
export function supervisorLiveness(pid: number, identityToken: string, probes: SupervisorLivenessProbes = {}): SupervisorLiveness {
  const alive = probes.alive ?? pidAlive;
  const command = probes.command ?? processCommandLine;
  if (!alive(pid)) return { state: "dead", reason: `the supervisor process ${pid} is gone` };
  const line = command(pid);
  if (!line) return { state: "unknown", reason: `the command line of process ${pid} could not be read` };
  if (!line.includes(identityToken)) return { state: "dead", reason: `process ${pid} now belongs to another process` };
  return { state: "live", reason: "the supervisor is alive with this run's identity" };
}

/** Service-side polling yields during ps; unreadable identities remain unknown. */
export async function supervisorLivenessAsync(pid: number, identityToken: string,
  probes: { alive?: (pid: number) => boolean; command?: (pid: number) => Promise<string | null> } = {},
): Promise<SupervisorLiveness> {
  const alive = probes.alive ?? pidAlive;
  if (!alive(pid)) return supervisorLiveness(pid, identityToken, { alive });
  const line = await (probes.command ?? processCommandLineAsync)(pid);
  // Recheck existence after the OS read before using its command line.
  return supervisorLiveness(pid, identityToken, { alive, command: () => line });
}

/** Positive observations bind both the OS identity and the unique command token. */
export class SupervisorLivenessReader {
  private readonly proofs: RecordedIdentityProofs;
  private readonly tokenProofs = new Map<string, number>();
  private readonly options: RecordedIdentityProofOptions & { command: (pid: number) => Promise<string | null> };
  constructor(options: Partial<RecordedIdentityProofOptions> & { command?: (pid: number) => Promise<string | null> } = {}) {
    this.options = { read: readHostRunStartIdentity, alive: pidAlive, command: processCommandLineAsync,
      now: Date.now, cacheMs: HOST_RUN_IDENTITY_PROOF_CACHE_MS, ...options };
    this.proofs = new RecordedIdentityProofs(this.options);
  }
  async read(pid: number, token: string, startIdentity?: string, fresh = false): Promise<SupervisorLiveness> {
    const probes = { alive: this.options.alive, command: this.options.command };
    if (!startIdentity || startIdentity.endsWith("@unknown") || !startIdentity.startsWith(pid + "@"))
      return supervisorLivenessAsync(pid, token, probes);
    const key = JSON.stringify([pid, startIdentity, token]);
    const proof = await this.proofs.check(pid, startIdentity, fresh);
    if (proof !== true) {
      this.tokenProofs.delete(key);
      return proof === false ? { state: "dead", reason: "the supervisor process ended or changed identity" }
        : { state: "unknown", reason: "the supervisor start identity could not be read" };
    }
    const provenAt = this.tokenProofs.get(key);
    if (!fresh && provenAt !== undefined && this.options.now() - provenAt <= this.options.cacheMs && this.options.alive(pid))
      return { state: "live", reason: "the supervisor retains its recorded identity and command token" };
    // Start times can collide on macOS. A fresh identity decision always needs the token too.
    const liveness = await supervisorLivenessAsync(pid, token, probes);
    if (liveness.state === "live") {
      if (this.tokenProofs.size >= 4096) this.tokenProofs.clear();
      this.tokenProofs.set(key, this.options.now());
    } else this.tokenProofs.delete(key);
    return liveness;
  }
}
