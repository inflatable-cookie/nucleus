/**
 * The BB host-operation executor (Spec 062, phase 0).
 *
 * One operation is one bounded step over `bb.sdk`; the answer is a projection of
 * exactly the fields the service validates, never a raw SDK row. The executor owns
 * three rules the later phases depend on:
 *
 * - a workspace step creates no thread: `workspace.create` registers the project and
 *   mints Nucleus's own handle, and reports how many `threads.spawn` calls it made
 *   (always zero) instead of asking a reader to believe it;
 * - an archive is preceded by its own cascade read inside the executor, and an
 *   archive whose cascade names a thread the caller did not already accept is
 *   refused, with the thread left unarchived;
 * - every SDK call is counted, because "zero spawns" and "one archive" are evidence.
 *
 * This file imports nothing but Node builtins so the plugin package builds from its
 * own directory with no dependency tree.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/** The operations this plugin executes. `test/bb-plugin-operations.test.ts` pins it to the shared list. */
export const HOST_OPERATIONS = [
  "identity.probe",
  "workspace.create",
  "workspace.inspect",
  "run.attach",
  "thread.observe",
  "thread.stop",
  "thread.cascade",
  "thread.archive",
  "thread.inventory",
  "environment.list",
  "terminal.create",
  "terminal.list",
  "terminal.close",
  "call.counters",
] as const;

export type HostOperationName = (typeof HOST_OPERATIONS)[number];

/**
 * Every code this executor may answer with. Kept identical to the service's list by
 * `test/bb-plugin-protocol.test.ts`.
 */
export const HOST_OPERATION_ERROR_CODES = ["invalid_input", "refused", "unavailable", "internal"] as const;

export type HostOperationErrorCode = (typeof HOST_OPERATION_ERROR_CODES)[number];

/**
 * The codes that prove nothing was written. `refused` is only ever raised before a
 * write (a policy answer such as a cascade that names a thread this task does not
 * own). A failure that can follow a committed call — a spawn whose environment id
 * did not arrive, a read that failed after an archive — must answer `unavailable`
 * or `internal`, because those are unknown delivery and are never resent.
 */
export const HOST_OPERATION_NON_DELIVERY_CODES = ["invalid_input", "refused"] as const;

export class HostOperationError extends Error {
  constructor(readonly code: HostOperationErrorCode, message: string) {
    super(message);
    this.name = "HostOperationError";
  }
}

export interface TerminalScope {
  kind: "thread" | "environment" | "host_path";
  threadId?: string;
  environmentId?: string;
  hostId?: string;
  cwd?: string;
}

export interface ThreadRow {
  id: string;
  title?: string | null;
  status?: string;
  environmentId?: string | null;
  parentThreadId?: string | null;
  parentNotifications?: string | null;
  pluginMetadata?: unknown;
  archivedAt?: number | null;
  originPluginId?: string | null;
  hasPendingInteraction?: boolean;
  queuedWork?: unknown;
  displayStatus?: string;
  runtime?: { displayStatus?: string };
  createdAt?: number;
}

export interface TerminalSessionRow {
  id: string;
  threadId?: string | null;
  environmentId?: string | null;
  hostId?: string | null;
  initialCwd?: string | null;
  status?: string;
  closeReason?: string | null;
}

export interface EnvironmentRow {
  id: string;
  path?: string | null;
  isWorktree?: boolean;
  status?: string;
  managed?: boolean;
}

export interface ProjectRow {
  id: string;
  sources?: Array<{ type?: string; path?: string }>;
}

/** The slice of `bb.sdk` this executor uses. The plugin binds the real SDK to it once. */
export interface BbHostSdk {
  system: { version(): Promise<{ currentVersion?: string | null }> };
  /** The BB server's own status (Spec 062, "Identity": the probe reads it). */
  status: { get(args?: { threadId?: string; projectId?: string }): Promise<unknown> };
  hosts: { list(): Promise<Array<{ id: string; status?: string }>> };
  projects: {
    list(): Promise<ProjectRow[]>;
    create(args: { name: string; source: { type: "local_path"; hostId: string; path: string } }): Promise<ProjectRow>;
  };
  threads: {
    spawn(args: {
      projectId: string;
      providerId?: string;
      model?: string;
      title?: string;
      input?: Array<{ type: "text"; text: string }>;
      prompt?: string;
      environment: { type: "host"; hostId: string; workspace: { type: "unmanaged"; path: string } };
      parentThreadId?: string;
      parentNotifications?: "auto" | "stuck" | "off";
      origin?: "plugin";
      originPluginId?: string;
      pluginMetadata?: Record<string, unknown>;
    }): Promise<ThreadRow>;
    get(args: { threadId: string }): Promise<ThreadRow>;
    stop(args: { threadId: string }): Promise<unknown>;
    archive(args: { threadId: string }): Promise<unknown>;
    list(args: { originPluginId?: string; projectId?: string; includeHidden?: boolean; archived?: boolean; limit?: number }): Promise<ThreadRow[]>;
    experimental_listCascade(args: { threadIds: string[]; action: "archive" }): Promise<{ threads?: Array<{ threadId: string; cascadeThreadIds?: string[] }> }>;
    experimental_listPluginMetadata(args: { pluginId: string; threadIds: string[] }): Promise<{ threads?: Array<{ threadId: string; metadata?: unknown }> }>;
  };
  environments: { list(): Promise<EnvironmentRow[]> };
  terminals: {
    create(args: { cols: number; rows: number; scope: TerminalScope; start?: { mode: "shell" }; title: string }): Promise<TerminalSessionRow>;
    list(args: { scope: TerminalScope }): Promise<{ sessions?: TerminalSessionRow[] }>;
    close(args: { terminalId: string; mode: "force" | "if-clean" }): Promise<TerminalSessionRow>;
  };
}

export interface HostOperationsOptions {
  sdk: BbHostSdk;
  /** The BB plugin id this executor acts as; spawns carry it as their plugin origin. */
  pluginId: string;
  /** The plugin SDK version this build was written against, a diagnostic only. */
  sdkVersion: string;
  /** The BB server's data directory, read lazily by `identity.probe`. */
  dataDir: () => string;
  now?: () => number;
  /** How long an attach waits for BB to record the environment (tests shorten it). */
  attachWaitMs?: number;
}

/** The workspace handle shape decision 2 mints, derived exactly as the service derives it. */
export function workspaceHandleForPath(directory: string): string {
  let real = directory.replace(/\/+$/, "") || "/";
  try { real = realpathSync(directory); } catch { /* a path that does not exist still names its own handle */ }
  return `bb-worktree-${createHash("sha256").update(real).digest("hex").slice(0, 40)}`;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HostOperationError("invalid_input", `${field} must be a non-empty string of at most ${max} characters`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, field, max);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) throw new HostOperationError("invalid_input", `${field} must be one of ${values.join(", ")}`);
  return value as T;
}

function terminalScope(value: unknown): TerminalScope {
  if (typeof value !== "object" || value === null) throw new HostOperationError("invalid_input", "scope must be an object");
  const scope = value as Record<string, unknown>;
  const kind = scope.kind;
  if (kind === "thread") return { kind, threadId: text(scope.threadId, "scope.threadId", 128) };
  if (kind === "environment") return { kind, environmentId: text(scope.environmentId, "scope.environmentId", 128) };
  if (kind === "host_path") {
    const hostId = text(scope.hostId, "scope.hostId", 128);
    // The list query reads `cwd` as a filter, not a default: an absent cwd must stay
    // absent, because a null would filter for terminals whose cwd is null.
    return typeof scope.cwd === "string" ? { kind, hostId, cwd: scope.cwd } : { kind, hostId };
  }
  throw new HostOperationError("invalid_input", "scope.kind must be thread, environment or host_path");
}

function projectMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HostOperationError("invalid_input", "pluginMetadata must be an object");
  return value as Record<string, unknown>;
}

function metadataOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  return typeof metadata === "object" && metadata !== null ? metadata as Record<string, unknown> : null;
}

function threadProjection(row: ThreadRow, pluginMetadata: Record<string, unknown> | null) {
  return {
    threadId: row.id,
    title: row.title ?? null,
    status: row.status ?? "unknown",
    displayStatus: row.runtime?.displayStatus ?? row.displayStatus ?? row.status ?? "unknown",
    environmentId: row.environmentId ?? null,
    parentThreadId: row.parentThreadId ?? null,
    parentNotifications: row.parentNotifications ?? "auto",
    pluginMetadata,
    archivedAt: row.archivedAt ?? null,
    queuedWork: typeof row.queuedWork === "string" ? row.queuedWork : null,
  };
}

function terminalProjection(row: TerminalSessionRow) {
  return {
    id: row.id,
    threadId: row.threadId ?? null,
    environmentId: row.environmentId ?? null,
    hostId: row.hostId ?? null,
    initialCwd: row.initialCwd ?? null,
    status: row.status ?? "unknown",
    closeReason: row.closeReason ?? null,
  };
}

/** How long one attach waits for BB to record the environment it is provisioning. */
const ATTACH_WAIT_MS = 15_000;
const ATTACH_POLL_MS = 200;

export interface HostOperations {
  execute(op: HostOperationName, input: unknown): Promise<{ operation: HostOperationName; at: string; calls: Record<string, number>; value: unknown }>;
  counters(): { counters: Record<string, number>; loadedAt: number };
}

export function createHostOperations(options: HostOperationsOptions): HostOperations {
  const { sdk, pluginId, sdkVersion } = options;
  const now = options.now ?? Date.now;
  const loadedAt = now();
  const counters: Record<string, number> = {};
  let spawnCalls = 0;

  async function call<T>(name: string, run: () => Promise<T>): Promise<T> {
    counters[name] = (counters[name] ?? 0) + 1;
    return await run();
  }

  async function primaryHostId(): Promise<string> {
    const hosts = await call("hosts.list", () => sdk.hosts.list());
    const host = hosts.find(candidate => candidate.status === undefined || candidate.status === "connected") ?? hosts[0];
    if (!host) throw new HostOperationError("unavailable", "This BB server reports no host to run the work on");
    return host.id;
  }

  async function cascadeFor(threadId: string): Promise<string[]> {
    const read = await call("threads.experimental_listCascade", () => sdk.threads.experimental_listCascade({ threadIds: [threadId], action: "archive" }));
    const row = (read?.threads ?? []).find(candidate => candidate.threadId === threadId);
    if (!row) throw new HostOperationError("unavailable", `The cascade read did not answer for ${threadId}, so no archive can be proven`);
    return row.cascadeThreadIds ?? [];
  }

  /**
   * A thread's plugin metadata is its own read, not a row field: `threads.get` never
   * carries it. A thread with none answers null rather than failing the observation.
   */
  async function threadMetadata(threadId: string): Promise<Record<string, unknown> | null> {
    try {
      const read = await call("threads.experimental_listPluginMetadata", () => sdk.threads.experimental_listPluginMetadata({ pluginId, threadIds: [threadId] }));
      const row = (read?.threads ?? []).find(candidate => candidate.threadId === threadId);
      return metadataOf(row);
    } catch {
      return null;
    }
  }

  async function execute(op: HostOperationName, raw: unknown): Promise<unknown> {
    const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    switch (op) {
      case "identity.probe": {
        // The read-only identity probe: the three reads Spec 062 names — the server's
        // own status, its version and one bounded thread list — plus the host list the
        // projection reports. Every one of them is a read; none of them writes.
        const status = await call("status.get", () => sdk.status.get({}));
        if (typeof status !== "object" || status === null) throw new HostOperationError("unavailable", "status.get answered no status for this BB server");
        const version = await call("system.version", () => sdk.system.version());
        const threads = await call("threads.list", () => sdk.threads.list({ limit: 1 }));
        if (!Array.isArray(threads)) throw new HostOperationError("unavailable", "threads.list answered no rows for this BB server");
        const hosts = await call("hosts.list", () => sdk.hosts.list());
        return {
          dataDir: options.dataDir(),
          bbVersion: String(version.currentVersion ?? "unknown"),
          sdkVersion,
          hostIds: hosts.map(host => host.id),
        };
      }
      case "workspace.create": {
        const repositoryRoot = text(input.repositoryRoot, "repositoryRoot", 4_096);
        const workspacePath = input.workspacePath === undefined ? repositoryRoot : text(input.workspacePath, "workspacePath", 4_096);
        const name = text(input.name, "name", 120);
        const spawnsBefore = spawnCalls;
        const hostId = await primaryHostId();
        const projects = await call("projects.list", () => sdk.projects.list());
        const existing = projects.find(project => (project.sources ?? []).some(source => source.type === "local_path" && typeof source.path === "string" && samePath(source.path, repositoryRoot)));
        let projectId: string;
        let projectCreated = false;
        if (existing) projectId = existing.id;
        else {
          const created = await call("projects.create", () => sdk.projects.create({ name, source: { type: "local_path", hostId, path: repositoryRoot } }));
          projectId = created.id;
          projectCreated = true;
        }
        return {
          projectId,
          projectCreated,
          projectCount: projectCreated ? projects.length + 1 : projects.length,
          handle: workspaceHandleForPath(workspacePath),
          path: workspacePath,
          // The whole point of the step: no thread exists before a run does.
          spawned: spawnCalls - spawnsBefore,
        };
      }
      case "workspace.inspect": {
        const repositoryRoot = text(input.repositoryRoot, "repositoryRoot", 4_096);
        const requestedProjectId = optionalText(input.projectId, "projectId", 128);
        const projects = await call("projects.list", () => sdk.projects.list());
        const project = projects.find(candidate => (!requestedProjectId || candidate.id === requestedProjectId) && (candidate.sources ?? []).some(source => source.type === "local_path" && typeof source.path === "string" && samePath(source.path, repositoryRoot)));
        return { projectId: project?.id ?? null, projectFound: Boolean(project), path: project ? repositoryRoot : null };
      }
      case "run.attach": {
        const projectId = text(input.projectId, "projectId", 128);
        const title = text(input.title, "title", 200);
        const environmentPath = text(input.environmentPath, "environmentPath", 4_096);
        const prompt = text(input.prompt, "prompt", 20_000);
        const parentThreadId = optionalText(input.parentThreadId, "parentThreadId", 128);
        const parentNotifications = oneOf(input.parentNotifications, ["auto", "stuck", "off"] as const, "parentNotifications") ?? "off";
        const providerId = optionalText(input.providerId, "providerId", 64);
        const model = optionalText(input.model, "model", 200);
        const pluginMetadata = projectMetadata(input.pluginMetadata);
        const hostId = await primaryHostId();
        const spawnsBefore = spawnCalls;
        const thread = await call("threads.spawn", () => sdk.threads.spawn({
          projectId,
          ...(providerId ? { providerId } : {}),
          ...(model ? { model } : {}),
          title,
          input: [{ type: "text", text: prompt }],
          environment: { type: "host", hostId, workspace: { type: "unmanaged", path: environmentPath } },
          ...(parentThreadId ? { parentThreadId } : {}),
          parentNotifications,
          origin: "plugin",
          originPluginId: pluginId,
          ...(pluginMetadata ? { pluginMetadata } : {}),
        }));
        spawnCalls += 1;
        // `threads.spawn` returns when the row is committed, not when the worktree is
        // attached: a fresh unmanaged path is provisioned after the row lands. The run
        // does not count as created until the environment id is recorded, so wait for
        // that bounded window rather than reporting a half-attached run.
        let row = thread;
        const deadline = now() + (options.attachWaitMs ?? ATTACH_WAIT_MS);
        while (!row.environmentId && now() < deadline) {
          await sleep(ATTACH_POLL_MS);
          try {
            row = await call("threads.get", () => sdk.threads.get({ threadId: thread.id }));
          } catch (error) {
            if (error instanceof HostOperationError) throw error;
            throw new HostOperationError("unavailable", `threads.get failed while waiting for the environment: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (!row.environmentId) {
          // The thread exists; only the environment is late. That is unknown
          // delivery, never a refusal: resending the spawn would duplicate it.
          throw new HostOperationError("unavailable", `BB committed thread ${thread.id} but did not record an environment within ${options.attachWaitMs ?? ATTACH_WAIT_MS} ms; the spawn landed and is not retryable, adopt thread ${thread.id}`);
        }
        return {
          threadId: row.id,
          environmentId: row.environmentId,
          status: row.status ?? "unknown",
          parentThreadId: row.parentThreadId ?? null,
          parentNotifications: row.parentNotifications ?? parentNotifications,
          pluginMetadata,
          createdAt: Number(row.createdAt ?? thread.createdAt ?? now()),
          spawned: spawnCalls - spawnsBefore,
        };
      }
      case "thread.observe": {
        const threadId = text(input.threadId, "threadId", 128);
        const row = await call("threads.get", () => sdk.threads.get({ threadId }));
        return threadProjection(row, await threadMetadata(threadId));
      }
      case "thread.stop": {
        const threadId = text(input.threadId, "threadId", 128);
        await call("threads.stop", () => sdk.threads.stop({ threadId }));
        const row = await call("threads.get", () => sdk.threads.get({ threadId }));
        return { threadId, status: row.status ?? "unknown", displayStatus: row.runtime?.displayStatus ?? row.status ?? "unknown" };
      }
      case "thread.cascade": {
        const threadId = text(input.threadId, "threadId", 128);
        if (input.action !== "archive") throw new HostOperationError("invalid_input", 'action must be "archive"');
        const cascadeThreadIds = await cascadeFor(threadId);
        return { threadId, action: "archive" as const, cascadeThreadIds };
      }
      case "thread.archive": {
        const threadId = text(input.threadId, "threadId", 128);
        const expected = Array.isArray(input.expectedCascadeThreadIds) ? input.expectedCascadeThreadIds.map(value => text(value, "expectedCascadeThreadIds[]", 128)) : null;
        if (!expected) throw new HostOperationError("invalid_input", "expectedCascadeThreadIds must be an array");
        const cascadeThreadIds = await cascadeFor(threadId);
        const unaccepted = cascadeThreadIds.filter(id => !expected.includes(id));
        if (unaccepted.length > 0) throw new HostOperationError("refused", `Archive refused: the cascade for ${threadId} would also archive ${unaccepted.join(", ")}, which this task does not own`);
        await call("threads.archive", () => sdk.threads.archive({ threadId }));
        const row = await call("threads.get", () => sdk.threads.get({ threadId }));
        return { threadId, archivedAt: Number(row.archivedAt ?? now()), cascadeThreadIds };
      }
      case "thread.inventory": {
        const originPluginId = optionalText(input.originPluginId, "originPluginId", 128);
        const projectId = optionalText(input.projectId, "projectId", 128);
        const rows = await call("threads.list", () => sdk.threads.list({
          ...(originPluginId ? { originPluginId } : {}),
          ...(projectId ? { projectId } : {}),
          includeHidden: input.includeHidden === true,
          archived: input.archived === true,
        }));
        return {
          complete: true,
          rows: rows.map(row => ({
            threadId: row.id,
            status: row.status ?? "unknown",
            environmentId: row.environmentId ?? null,
            parentThreadId: row.parentThreadId ?? null,
            originPluginId: row.originPluginId ?? null,
            archivedAt: row.archivedAt ?? null,
            hasPendingInteraction: row.hasPendingInteraction === true,
          })),
        };
      }
      case "environment.list": {
        const rows = await call("environments.list", () => sdk.environments.list());
        return {
          environments: rows.map(row => ({
            environmentId: row.id,
            path: row.path ?? "",
            isWorktree: row.isWorktree === true,
            status: row.status ?? "unknown",
            managed: row.managed === true,
          })),
        };
      }
      case "terminal.create": {
        const session = await call("terminals.create", () => sdk.terminals.create({
          cols: typeof input.cols === "number" ? input.cols : 80,
          rows: typeof input.rows === "number" ? input.rows : 24,
          scope: terminalScope(input.scope),
          start: { mode: "shell" },
          title: text(input.title, "title", 200),
        }));
        return { session: terminalProjection(session) };
      }
      case "terminal.list": {
        const listed = await call("terminals.list", () => sdk.terminals.list({ scope: terminalScope(input.scope) }));
        return { sessions: (listed.sessions ?? []).map(terminalProjection) };
      }
      case "terminal.close": {
        const mode = oneOf(input.mode, ["force", "if-clean"] as const, "mode") ?? "force";
        const session = await call("terminals.close", () => sdk.terminals.close({ terminalId: text(input.terminalId, "terminalId", 128), mode }));
        return { session: terminalProjection(session) };
      }
      case "call.counters": return { counters: { ...counters }, loadedAt };
      default: throw new HostOperationError("invalid_input", `Unknown host operation ${String(op)}`);
    }
  }

  return {
    async execute(op, input) {
      if (!HOST_OPERATIONS.includes(op)) throw new HostOperationError("invalid_input", `Unknown host operation ${String(op)}`);
      const value = await execute(op, input);
      return { operation: op, at: new Date(now()).toISOString(), calls: { ...counters }, value };
    },
    counters() { return { counters: { ...counters }, loadedAt }; },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => { const timer = setTimeout(resolveSleep, ms); timer.unref?.(); });
}

function samePath(left: string, right: string): boolean {
  const canonical = (value: string) => { try { return realpathSync(value); } catch { return value.replace(/\/+$/, ""); } };
  return canonical(left) === canonical(right);
}
