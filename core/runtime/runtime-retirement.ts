import { spawn } from "node:child_process";
import { steppedDelay } from "../../shared/backoff";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RuntimeRetirement, Task } from "../../shared/contracts";
import { runtimeRetirementFailure, ownerSettlementMatches, runtimeRetirementOccurrence } from "../../shared/contracts";
import { git } from "../git/index";
import { withSpawnSlot } from "../dispatch/spawn-gate";
import { type Store } from "../store/store";

/**
 * Effigy runtime retirement proof for a task workspace archive.
 *
 * Effigy contract 005 gives every scoped checkout (a linked Git worktree or a
 * clone marked `effigy.runtimeScope = ephemeral`) a generation token, a durable
 * record under `~/.effigy/runtime-scopes/` and an idempotent
 * `effigy container retire --scope <token> --yes`. Paseo's `worktree.teardown`
 * hook retires the checkout while it exists; Queue does not replace that hook.
 * Queue captures the token before the archive removes the checkout, persists it
 * with the archive intent, and then proves retirement after the archive from a
 * safe directory. A non-zero exit, a timeout or a spawn failure keeps the tail
 * and retries the same command with backoff, flagging the task's cleanup in the
 * meantime. Nothing here deletes resources directly.
 */

export const SCOPE_QUERY_TIMEOUT_MS = 30_000;
export const RETIRE_TIMEOUT_MS = 120_000;
export const RETIREMENT_TAIL_LIMIT = 4_000;
/** Backoff between automatic retirement retries; the last value repeats. */
export const RETIREMENT_BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];
const SCOPED_FILE = "effigy-runtime-scope";

export interface EffigyAttempt {
  /** Process exit code; null when the process could not start. */
  code: number | null;
  timedOut: boolean;
  /** Set only when the command could not be spawned at all (for example ENOENT). */
  spawnError: string;
  output: string;
}

export type EffigyInvoke = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<EffigyAttempt>;

export interface CapturedScope { kind: "worktree" | "ephemeral-clone"; token: string; }

/** Spawn the Effigy CLI. `EFFIGY_BIN` overrides the executable; tests use it to fake the CLI. */
export function defaultEffigyInvoke(bin = process.env.EFFIGY_BIN || "effigy"): EffigyInvoke {
  return (args, { cwd, timeoutMs }) => withSpawnSlot(() => new Promise<EffigyAttempt>(resolve => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env: { ...process.env, NO_COLOR: "1", CLICOLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, timedOut: false, spawnError: String(error), output: "" });
      return;
    }
    let output = "", settled = false, timedOut = false;
    const finish = (attempt: EffigyAttempt) => { if (!settled) { settled = true; clearTimeout(timer); resolve(attempt); } };
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.stderr?.on("data", chunk => { output += String(chunk); });
    child.on("error", error => finish({ code: null, timedOut, spawnError: String(error), output }));
    child.on("close", code => finish({ code, timedOut, spawnError: "", output }));
  }));
}

const validToken = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 32 && /^[0-9a-fA-F]+$/.test(trimmed) ? trimmed : null;
};

/** Keep the last `RETIREMENT_TAIL_LIMIT` characters of a command's combined output. */
export function outputTail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > RETIREMENT_TAIL_LIMIT ? trimmed.slice(trimmed.length - RETIREMENT_TAIL_LIMIT) : trimmed;
}

/**
 * Parse `effigy container scope --json`. Returns null when the command is not
 * available or did not return the documented shape, so the caller falls back to
 * the Git-private location.
 */
export function parseScopeQuery(stdout: string): { kind: "worktree" | "ephemeral-clone" | "none"; token: string | null } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const root = parsed as { scope?: unknown; data?: unknown; result?: unknown } | null;
  if (!root || typeof root !== "object") return null;
  const container = [root, root.data, root.result].find(candidate => {
    const scope = (candidate as { scope?: unknown } | undefined)?.scope;
    return scope && typeof scope === "object" && typeof (scope as { kind?: unknown }).kind === "string";
  }) as { scope: { kind: string; token?: unknown } } | undefined;
  if (!container) return null;
  const kind = container.scope.kind;
  if (kind === "none" || kind === "primary") return { kind: "none", token: validToken(container.scope.token as string | null) };
  if (kind !== "worktree" && kind !== "ephemeral-clone") return null;
  const token = validToken(container.scope.token as string | null);
  return token ? { kind, token } : null;
}

/** Which Git-private token file a scoped checkout keeps, if it is scoped at all. */
async function scopedTokenFile(directory: string): Promise<{ kind: "worktree" | "ephemeral-clone"; file: string } | null> {
  const gitDir = await git(directory, "rev-parse", "--absolute-git-dir").catch(() => "");
  if (!gitDir) return null;
  const commonDir = await git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir").catch(() => "");
  if (gitDir !== commonDir) return { kind: "worktree", file: join(gitDir, SCOPED_FILE) };
  // A marked ephemeral clone keeps the marker in its own `.git/config` and the
  // token directly inside its `.git`. The marker read is local-only.
  const config = join(directory, ".git", "config");
  if (!existsSync(config)) return null;
  if (!configMarksEphemeral(readFileSync(config, "utf8"))) return null;
  return { kind: "ephemeral-clone", file: join(directory, ".git", SCOPED_FILE) };
}

/** Remove a trailing `#`/`;` comment that is not inside a quoted value. */
function stripConfigComment(line: string): string {
  let inQuotes = false, escaped = false;
  for (let index = 0; index < line.length; index++) {
    const ch = line[index];
    if (ch === '"' && !escaped) inQuotes = !inQuotes;
    else if ((ch === "#" || ch === ";") && !inQuotes) return line.slice(0, index);
    escaped = inQuotes && ch === "\\" && !escaped;
  }
  return line;
}

function unquoteConfigValue(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value;
  const inner = value.slice(1, -1);
  let out = "";
  for (let index = 0; index < inner.length; index++) {
    if (inner[index] === "\\") { out += inner[++index] ?? ""; continue; }
    out += inner[index];
  }
  return out;
}

/**
 * Minimal reader for the checkout's own `effigy.runtimeScope = ephemeral`
 * marker. Includes are treated as data, never followed, and no global or
 * system scope is consulted; a subsectioned `[effigy "x"]` never matches.
 */
export function configMarksEphemeral(raw: string): boolean {
  let inSection = false;
  for (const source of raw.split(/\r?\n/)) {
    const line = stripConfigComment(source).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) { inSection = line.slice(1, -1).trim().toLowerCase() === "effigy"; continue; }
    if (!inSection) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim().toLowerCase() === "runtimescope")
      return unquoteConfigValue(line.slice(separator + 1).trim()) === "ephemeral";
  }
  return false;
}

/**
 * Resolve the checkout's runtime scope before archive. Prefers the
 * policy-independent `effigy container scope --json` when the checkout is
 * scoped at all, and otherwise reads the documented Git-private location. A
 * checkout Effigy never scoped, or one about to disappear with no token file,
 * has no token and nothing to prove.
 */
export async function resolveRuntimeScope(directory: string, invoke: EffigyInvoke): Promise<CapturedScope | null> {
  if (!existsSync(directory)) return null;
  let scoped: { kind: "worktree" | "ephemeral-clone"; file: string } | null = null;
  try { scoped = await scopedTokenFile(directory); } catch { scoped = null; }
  if (!scoped) return null;
  if (isAbsolute(directory)) {
    const attempt = await invoke(["container", "scope", "--json"], { cwd: directory, timeoutMs: SCOPE_QUERY_TIMEOUT_MS }).catch(() => null);
    if (attempt && !attempt.spawnError && !attempt.timedOut && attempt.code === 0) {
      const parsed = parseScopeQuery(attempt.output);
      if (parsed && parsed.kind !== "none" && parsed.token) return { kind: parsed.kind, token: parsed.token };
    }
  }
  return tokenFromFile(scoped);
}

function tokenFromFile(scoped: { kind: "worktree" | "ephemeral-clone"; file: string }): CapturedScope | null {
  try {
    const token = validToken(readFileSync(scoped.file, "utf8"));
    return token ? { kind: scoped.kind, token } : null;
  } catch { return null; }
}

const backoff = (attempts: number) => steppedDelay(RETIREMENT_BACKOFF_MS, attempts - 1);

/** Safe directory to run the post-archive retry from; never the archived checkout. */
const retireCwd = () => {
  const configured = process.env.EFFIGY_RETIRE_CWD;
  if (configured && existsSync(configured) && statSync(configured).isDirectory()) return configured;
  return existsSync(homedir()) ? homedir() : tmpdir();
};

/**
 * Durable capture, proof and retry for one task's archived workspaces.
 *
 * The store is the authority: `capture` persists the token before the archive,
 * the archive-success transaction flips the record to `pending` (via
 * {@link markArchived}), and `prove` runs the scoped retire and records the
 * outcome. `retryDue` is the automatic backoff driver.
 */
export class RuntimeRetirementService {
  private readonly proving = new Set<string>();
  constructor(readonly store: Store, readonly invoke: EffigyInvoke = defaultEffigyInvoke(), readonly clock: () => Date = () => new Date()) {}

  record(task: Task, workspaceId: string): RuntimeRetirement | null {
    return task.resolution.runtimeRetirements.find(entry => entry.workspaceId === workspaceId) ?? null;
  }

  /** Capture the scope and persist it while the checkout still exists. Idempotent per workspace. */
  async capture(taskId: string, workspaceId: string, directory: string): Promise<RuntimeRetirement | null> {
    const task = this.store.task(taskId);
    const existing = this.record(task, workspaceId);
    if (existing) return existing;
    const scope = await resolveRuntimeScope(directory, this.invoke).catch(() => null);
    const entry: RuntimeRetirement = {
      workspaceId, directory,
      scope: scope ? { kind: scope.kind, token: scope.token } : null,
      state: scope ? "captured" : "none",
      capturedAt: this.clock().toISOString(), provedAt: null, attempts: 0, error: "", outputTail: "", nextAttemptAt: null,
    };
    this.write(taskId, [...task.resolution.runtimeRetirements, entry]);
    this.store.event(taskId, "runtime_scope_captured", `${workspaceId}: ${scope ? `${scope.kind} ${scope.token}` : "no runtime scope"}`);
    return entry;
  }

  /** Owe a captured proof or settle a tokenless teardown failure with the archive. */
  markArchived(task: Task, workspaceId: string): RuntimeRetirement[] {
    return task.resolution.runtimeRetirements.map(entry => {
      if (entry.workspaceId !== workspaceId) return entry;
      if (entry.state === "captured") return { ...entry, state: "pending" as const };
      // A prior archive attempt found the checkout still present but had no
      // runtime scope to prove. A later confirmed archive settles that signal.
      if (entry.state === "failed" && !entry.scope)
        return { ...entry, state: "none" as const, error: "", outputTail: "", nextAttemptAt: null };
      return entry;
    });
  }

  /** Mark a confirmed archive and run the proof now. */
  async archived(taskId: string, workspaceId: string): Promise<void> {
    const task = this.store.task(taskId);
    const record = this.record(task, workspaceId);
    if (!record || record.state === "retired") return;
    if (record.state === "failed" && !record.scope) {
      this.write(taskId, this.markArchived(task, workspaceId));
      return;
    }
    if (record.state === "none" || !record.scope) return;
    if (record.state === "captured") this.write(taskId, this.markArchived(task, workspaceId));
    await this.prove(taskId, workspaceId);
  }

  /**
   * Run `effigy container retire --scope <token> --yes` once. Exit 0 proves
   * retirement; anything else keeps the durable record, its output tail and a
   * backoff retry, and flags the task's cleanup.
   */
  async prove(taskId: string, workspaceId: string): Promise<void> {
    const key = `${taskId}\u0000${workspaceId}`;
    if (this.proving.has(key)) return;
    const record = this.record(this.store.task(taskId), workspaceId);
    if (!record?.scope || record.state === "retired") return;
    this.proving.add(key);
    try {
      const attempts = record.attempts + 1;
      const attempt = await this.invoke(["container", "retire", "--scope", record.scope.token, "--yes"], { cwd: retireCwd(), timeoutMs: RETIRE_TIMEOUT_MS })
        .catch(error => ({ code: null, timedOut: false, spawnError: String(error), output: "" }) as EffigyAttempt);
      const tail = outputTail(attempt.output);
      if (attempt.code === 0 && !attempt.timedOut && !attempt.spawnError) {
        this.update(taskId, workspaceId, { state: "retired", provedAt: this.clock().toISOString(), attempts, error: "", outputTail: tail, nextAttemptAt: null });
        this.store.event(taskId, "runtime_retirement_retired", `${workspaceId}: ${record.scope.token}${tail ? `; ${tail}` : ""}`);
        return;
      }
      const reason = attempt.timedOut ? "runtime retire timed out" : attempt.spawnError ? `runtime retire could not run: ${attempt.spawnError}` : `runtime retire exited ${attempt.code}`;
      const error = `runtime retirement failed: ${reason}`;
      this.update(taskId, workspaceId, { state: "failed", attempts, error, outputTail: tail, nextAttemptAt: new Date(this.clock().getTime() + backoff(attempts)).toISOString() });
      this.store.event(taskId, "runtime_retirement_failed", `${workspaceId}: ${reason}${tail ? `; ${tail}` : ""}`);
    } finally {
      this.proving.delete(key);
    }
  }

  /**
   * Automatic backoff driver. Proves one pending or due failed record per
   * workspace; the durable record survives a restart between archive and proof.
   */
  async retryDue(taskId?: string): Promise<void> {
    if (this.store.getMeta("paused") === true) return;
    const at = this.clock().getTime();
    for (const task of this.store.retirementTasks(taskId)) {
      for (const record of task.resolution.runtimeRetirements) {
        if (ownerSettlementMatches(task, `runtime_retirement.${record.workspaceId}`, runtimeRetirementOccurrence(record))) continue;
        if (record.state !== "pending" && record.state !== "failed") continue;
        if (record.state === "failed" && !record.scope) continue;
        if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > at) continue;
        try { await this.prove(task.id, record.workspaceId); }
        catch { /* prove records its own fault on the durable record */ }
      }
    }
  }

  /** True when a captured scope exists for this workspace. */
  hasScope(taskId: string, workspaceId: string): boolean {
    return Boolean(this.record(this.store.task(taskId), workspaceId)?.scope);
  }

  /**
   * A teardown Paseo reported as failed is not a clean archive either. The
   * archive stays retryable, and the failure keeps its path and any captured
   * token so an operator can retry the relevant cleanup.
   */
  flagArchiveFailure(taskId: string, workspaceId: string, detail: string): void {
    const record = this.record(this.store.task(taskId), workspaceId);
    if (!record) return;
    const attempts = record.attempts + 1;
    this.update(taskId, workspaceId, { state: "failed", attempts, error: `runtime retirement failed: ${detail}`, outputTail: outputTail(detail), nextAttemptAt: new Date(this.clock().getTime() + backoff(attempts)).toISOString() });
    this.store.event(taskId, "runtime_retirement_failed", `${workspaceId}: teardown reported failure; ${detail}`);
  }

  /** Operator request: clear the backoff on failed scoped records and prove now. */
  async retryNow(taskId: string): Promise<void> {
    const task = this.store.task(taskId);
    for (const record of task.resolution.runtimeRetirements) {
      if (ownerSettlementMatches(task, `runtime_retirement.${record.workspaceId}`, runtimeRetirementOccurrence(record))) continue;
      if (record.state !== "failed") continue;
      this.update(taskId, record.workspaceId, { nextAttemptAt: null });
    }
    await this.retryDue(taskId);
  }

  /** The task's cleanup flag, recomputed from its durable records. */
  flag(task: Task): string { return runtimeRetirementFailure(task); }

  private write(taskId: string, records: RuntimeRetirement[]) {
    this.store.setRuntimeRetirements(taskId, records);
  }

  private update(taskId: string, workspaceId: string, patch: Partial<RuntimeRetirement>) {
    const task = this.store.task(taskId);
    const records = task.resolution.runtimeRetirements.map(entry => entry.workspaceId === workspaceId ? { ...entry, ...patch } : entry);
    this.write(taskId, records);
  }
}
