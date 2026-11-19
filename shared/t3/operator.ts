/**
 * What `nucleus t3 install` / `status` / `uninstall` reads from T3 and reports
 * (nucleus#1330).
 *
 * Three rules decide every refusal, and they are the same rules BB's install
 * route uses (`bin/bb-plugin.ts`):
 *
 * - the route touches only the provider instance named `nucleus`. Another
 *   instance, another driver, or a `commandPath` that is not this package's
 *   installed `nucleus-acp` is refused by name, never overwritten and never
 *   removed. "Ours" is the driver plus the command path, not the instance id,
 *   which a namesake shares;
 * - the two bearers are split by scope. The bearer the service keeps may read
 *   and operate threads and nothing else; the bearer that registers a provider
 *   is minted for that one call and revoked immediately;
 * - a report never carries a secret. The bearer is a value this module receives
 *   and decides about; no function here returns it, and the status projection
 *   carries scopes, expiry and validity instead.
 *
 * The nightly's own shapes are the authority: a provider mutation's operations
 * are `create`, `upsert` and `remove`, and a mutation with an empty patch
 * requires `providers:manage` (see the spec's "Operator install route").
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_THREAD_RETENTION_DAYS } from "../contracts";
import type { T3ConnectionSettings } from "./settings";

/** The one provider instance this route owns, and the label its sessions carry. */
export const T3_PROVIDER_ID = "nucleus";
export const T3_PROVIDER_DISPLAY_NAME = "Nucleus";
export const T3_SESSION_SUBJECT = "nucleus";
export const T3_SESSION_LABEL = "nucleus";
/** The service's bearer: read and operate threads, nothing that writes settings. */
export const T3_RUNTIME_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
] as const;
/**
 * The install bearer's scope. The nightly derives the required scope from the
 * payload, and a provider mutation with an empty patch *replaces* the settings
 * scopes with `providers:manage`; `settings:write` alone would be refused.
 */
export const T3_INSTALL_SCOPES = [
  "providers:manage",
  "orchestration:read",
] as const;
export const T3_RUNTIME_TTL = "365d";
export const T3_INSTALL_TTL = "10m";
/** Warn while the service's bearer is this close to expiry. */
export const T3_BEARER_NEAR_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** The marker the installer writes into the `nucleus-acp` launcher it owns. */
export const NUCLEUS_ACP_COMMAND_MARKER = "nucleus-owned-command-v1";
export const NUCLEUS_ACP_COMMAND = "nucleus-acp";

// --- discovery -------------------------------------------------------------

export interface CommandLookup {
  /** The absolute command path, when one was found. */
  path: string | null;
  /** Every path that was tried, so a refusal names them instead of guessing. */
  tried: string[];
}

/** The T3 command shims an installed app writes, in the order an operator finds them. */
export function t3CliCandidates(home = homedir()): string[] {
  return [
    join(home, ".t3", "bin", "t3"),
    "/opt/homebrew/bin/t3",
    "/usr/local/bin/t3",
  ];
}

function onPath(name: string, env: NodeJS.ProcessEnv): string[] {
  return `${env.PATH ?? ""}`
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, name));
}

/** Find the installed `t3` command (session minting and revocation). */
export function findT3Cli(
  options: {
    explicit?: string | null;
    home?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): CommandLookup {
  const env = options.env ?? process.env;
  if (options.explicit)
    return {
      path: isAbsolute(options.explicit)
        ? options.explicit
        : resolve(options.explicit),
      tried: [options.explicit],
    };
  const candidates = [
    ...t3CliCandidates(options.home ?? homedir()),
    ...onPath("t3", env),
  ];
  return {
    path: candidates.find((candidate) => existsSync(candidate)) ?? null,
    tried: candidates,
  };
}

/** Find the installed `nucleus-acp` command this package registers as a provider. */
export function findAcpCommand(
  options: {
    explicit?: string | null;
    home?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): CommandLookup {
  const env = options.env ?? process.env;
  if (options.explicit)
    return {
      path: isAbsolute(options.explicit)
        ? options.explicit
        : resolve(options.explicit),
      tried: [options.explicit],
    };
  const home = options.home ?? homedir();
  const candidates = [
    join(home, ".local", "bin", NUCLEUS_ACP_COMMAND),
    ...onPath(NUCLEUS_ACP_COMMAND, env),
  ];
  const found = candidates.find((candidate) => existsSync(candidate)) ?? null;
  return { path: found ? resolve(found) : null, tried: candidates };
}

/**
 * Whether a command path is one this package installed: the path we resolved,
 * or a launcher carrying the installer's ownership marker. A namesake's command
 * is neither, and this is what "ours" means for a provider instance.
 */
export function isNucleusAcpCommand(path: string): boolean {
  const candidate = resolve(path);
  try {
    if (!statSync(candidate).isFile()) return false;
    const text = readFileSync(candidate, "utf8");
    return (
      text.includes(NUCLEUS_ACP_COMMAND_MARKER) &&
      /^exec [^\n]*[\/ ]bin\/nucleus-acp\.mjs["\x27]? "\$@"\s*$/m.test(text)
    );
  } catch {
    return false;
  }
}

// --- the running server ----------------------------------------------------

/** `server.getConfig` as far as this route reads it (the nightly's stored shapes). */
export const t3ServerConfigSchema = z
  .object({
    environment: z
      .object({
        environmentId: z.string().min(1),
        serverVersion: z.string().min(1),
      })
      .passthrough(),
    providers: z
      .array(
        z
          .object({
            instanceId: z.string().min(1),
            driver: z.string().optional(),
            displayName: z.string().optional(),
            enabled: z.boolean(),
            status: z.string(),
            /** The provider's own readiness note (the nightly's `message`), when it sent one. */
            message: z.string().optional(),
            models: z
              .array(z.object({ slug: z.string().min(1) }).passthrough())
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
    settings: z
      .object({
        providerInstances: z
          .record(
            z.string(),
            z
              .object({
                driver: z.string().optional(),
                displayName: z.string().optional(),
                enabled: z.boolean().optional(),
                config: z.record(z.string(), z.unknown()).optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type T3ServerConfig = z.infer<typeof t3ServerConfigSchema>;

/** One stored provider instance (`settings.providerInstances[id]`). */
export interface T3StoredInstance {
  driver: string;
  displayName?: string;
  enabled?: boolean;
  config: Record<string, unknown>;
}

/** The stored `nucleus` instance, whatever it is, or null when there is none. */
export function storedInstance(
  config: T3ServerConfig,
): T3StoredInstance | null {
  const instance = config.settings?.providerInstances?.[T3_PROVIDER_ID];
  if (!instance) return null;
  return {
    driver: instance.driver ?? "",
    ...(instance.displayName ? { displayName: instance.displayName } : {}),
    ...(instance.enabled === undefined ? {} : { enabled: instance.enabled }),
    config: instance.config ?? {},
  };
}

export function commandPathOf(
  instance: T3StoredInstance | null,
): string | null {
  const value = instance?.config.commandPath;
  return typeof value === "string" && value ? value : null;
}

/**
 * Is the stored instance this install's? The driver must be the ACP driver, the
 * source local, and the command this package's own `nucleus-acp`.
 */
export function instanceIsOurs(
  instance: T3StoredInstance | null,
  acpCommand: string | null,
): boolean {
  if (!instance || instance.driver !== "acpRegistry") return false;
  if (instance.config.source !== "local") return false;
  const command = commandPathOf(instance);
  return Boolean(
    command &&
      isNucleusAcpCommand(command) &&
      (!acpCommand ||
        (isNucleusAcpCommand(acpCommand) &&
          resolve(command) === resolve(acpCommand))),
  );
}

/** The provider payload one registration sends (the nightly's `ProviderInstanceConfig`). */
export function providerInstance(commandPath: string): T3StoredInstance {
  return {
    driver: "acpRegistry",
    displayName: T3_PROVIDER_DISPLAY_NAME,
    enabled: true,
    config: { source: "local", commandPath },
  };
}

/** What status says about the provider: registered, ours, enabled, ready, matching. */
export interface T3ProviderFacts {
  registered: boolean | null;
  ours: boolean;
  driver: string | null;
  displayName: string | null;
  enabled: boolean;
  ready: boolean;
  /**
   * Registered, ours, enabled, command-matching, and T3 has not reported a
   * hard failure. A warning is installed but unready; the probe's status and
   * message are reported separately.
   */
  usable: boolean;
  status: string;
  /** T3's own note about the provider's state, verbatim (never a credential). */
  probeMessage: string;
  commandPath: string | null;
  commandMatchesInstalled: boolean;
  models: string[];
  problem: string;
}

export function observeProvider(
  config: T3ServerConfig,
  acpCommand: string | null,
): T3ProviderFacts {
  const instance = storedInstance(config);
  const row =
    config.providers.find(
      (candidate) => candidate.instanceId === T3_PROVIDER_ID,
    ) ?? null;
  const registered = instance !== null || row !== null;
  const driver = instance?.driver ?? row?.driver ?? null;
  const commandPath = commandPathOf(instance);
  const ours = instanceIsOurs(instance, acpCommand);
  const enabled = (row?.enabled ?? true) && instance?.enabled !== false;
  const status = row?.status ?? (registered ? "unknown" : "absent");
  const ready = status === "ready";
  const matches = Boolean(
    commandPath && acpCommand && resolve(commandPath) === resolve(acpCommand),
  );
  const probeMessage = row?.message ?? "";
  const usable =
    registered &&
    ours &&
    enabled &&
    matches &&
    status !== "error" &&
    status !== "disabled";
  let problem = "";
  if (!registered)
    problem = `no T3Code provider instance named ${T3_PROVIDER_ID} is registered`;
  else if (!ours)
    problem = `the ${T3_PROVIDER_ID} instance is not this install's (driver ${driver || "unknown"}, commandPath ${commandPath || "none"}); refusing to change it`;
  else if (!enabled) problem = `the ${T3_PROVIDER_ID} instance is disabled`;
  else if (!matches)
    problem = `the ${T3_PROVIDER_ID} instance runs ${commandPath || "no command"}, this install's command is ${acpCommand || "unknown"}`;
  else if (!usable)
    problem = `the ${T3_PROVIDER_ID} instance is ${status}${probeMessage ? `: ${probeMessage}` : ""}`;
  else if (!ready)
    problem = `the ${T3_PROVIDER_ID} instance is ${status}${probeMessage ? `: ${probeMessage}` : ""}`;
  return {
    registered,
    ours,
    driver,
    displayName: instance?.displayName ?? row?.displayName ?? null,
    enabled,
    ready,
    usable,
    status,
    probeMessage,
    commandPath,
    commandMatchesInstalled: matches,
    models: (row?.models ?? []).map((model) => model.slug),
    problem,
  };
}

// --- bearers ---------------------------------------------------------------

/** One session as `t3 auth session list --json` reports it (never its token). */
export interface T3SessionSummary {
  sessionId: string;
  scopes: string[];
  subject: string | null;
  expiresAt: string;
}

export interface T3BearerFacts {
  present: boolean;
  /** Null when the server could not be asked, so absence of proof is not proof of absence. */
  valid: boolean | null;
  scopes: string[];
  expiresAt: string | null;
  expiresInDays: number | null;
  nearExpiry: boolean;
  problem: string;
}

/**
 * What the stored bearer is: its scopes and expiry from the server's own session
 * list, and whether T3 accepted it for a read this run. `valid` is null when the
 * server was not reachable, so a report never invents a verdict.
 */
export function observeBearer(
  connection: T3ConnectionSettings | null,
  sessions: T3SessionSummary[] | null,
  accepted: boolean | null,
  now = Date.now(),
): T3BearerFacts {
  if (!connection)
    return {
      present: false,
      valid: null,
      scopes: [],
      expiresAt: null,
      expiresInDays: null,
      nearExpiry: false,
      problem: "no T3Code connection is stored; run `nucleus t3 install`",
    };
  const listedSession = connection.sessionId
    ? (sessions?.find(
        (candidate) => candidate.sessionId === connection.sessionId,
      ) ?? null)
    : null;
  const session = accepted === true ? listedSession : null;
  const expiresAt = session?.expiresAt ?? null;
  const expiresInMs = expiresAt ? Date.parse(expiresAt) - now : null;
  const expiresInDays =
    expiresInMs === null || Number.isNaN(expiresInMs)
      ? null
      : Math.floor(expiresInMs / (24 * 60 * 60 * 1000));
  const nearExpiry =
    expiresInMs !== null &&
    !Number.isNaN(expiresInMs) &&
    expiresInMs < T3_BEARER_NEAR_EXPIRY_MS;
  const scopes = session?.scopes ?? [];
  let problem = "";
  if (accepted === false)
    problem =
      "T3Code refused the stored bearer; run `nucleus t3 install` to mint a new one";
  else if (sessions && connection.sessionId && !listedSession)
    problem =
      "the stored bearer is not an active T3Code session; run `nucleus t3 install` to mint a new one";
  else if (nearExpiry)
    problem = `the stored bearer expires in ${expiresInDays ?? 0} day(s); run \`nucleus t3 install\` to rotate it`;
  else if (
    session &&
    session.scopes.some(
      (scope) => scope === "settings:write" || scope === "providers:manage",
    )
  )
    problem =
      "the stored bearer carries a settings scope; the service needs only the orchestration scopes";
  return {
    present: true,
    valid:
      sessions && connection.sessionId && !listedSession ? false : accepted,
    scopes,
    expiresAt,
    expiresInDays,
    nearExpiry,
    problem,
  };
}

// --- status ----------------------------------------------------------------

/** The service's own facts, read from `service.health`; null when it is not running. */
export interface T3ServiceFacts {
  available: boolean;
  connected: boolean;
  hostId: string | null;
  error: string;
  nativeParenting: string;
  supportThreads: string;
}

export interface T3StatusInput {
  endpoint: string;
  acpCommand: string | null;
  connection: T3ConnectionSettings | null;
  config: T3ServerConfig | null;
  server?: { environmentId: string; serverVersion: string } | null;
  serverError: string;
  sessions: T3SessionSummary[] | null;
  bearerAccepted: boolean | null;
  service: T3ServiceFacts | null;
  projects: Array<{ name: string; hostKind: string }> | null;
  /** `service.health`'s retention record, when the service answered. */
  retention?: {
    days: number;
    hosts: Array<{ hostId: string; supported: boolean; at: string | null; deleted: number; remaining: number; error: string }>;
  } | null;
  now?: number;
}

/**
 * Orchestration contract, "Archived thread retention": the window in force and
 * this host's last pass, as `service.health` reports them. A host whose adapter
 * cannot remove a thread says so instead of reading as a clean zero.
 */
export interface T3RetentionFacts {
  days: number;
  supported: boolean;
  lastRunAt: string | null;
  deleted: number;
  remaining: number;
  error: string;
}

export interface T3StatusReport {
  ok: boolean;
  problems: string[];
  server: {
    endpoint: string;
    reachable: boolean;
    version: string;
    environmentId: string;
    hostId: string;
    problem: string;
  };
  bearer: T3BearerFacts;
  provider: T3ProviderFacts;
  service: T3ServiceFacts;
  /** The repositories whose stored host kind is T3Code; empty when none opted in. */
  projects: Array<{ name: string }>;
  acp: { commandPath: string | null; owned: boolean };
  /** Archived thread retention: one Nucleus-scheduled pass, per host. */
  retention: T3RetentionFacts;
}

/**
 * This host's retention facts from `service.health`. Nothing is inferred: a
 * service that is not running, or one that has not run a pass yet, says which of
 * the two it is, and a host the pass could not reach keeps its last real run.
 */
export function retentionFacts(
  health: {
    days: number;
    hosts: Array<{ hostId: string; supported: boolean; at: string | null; deleted: number; remaining: number; error: string }>;
  } | null | undefined,
  hostId: string | null,
): T3RetentionFacts {
  const fact = hostId ? health?.hosts.find((entry) => entry.hostId === hostId) : undefined;
  return {
    days: health?.days ?? DEFAULT_THREAD_RETENTION_DAYS,
    supported: fact?.supported ?? false,
    lastRunAt: fact?.at ?? null,
    deleted: fact?.deleted ?? 0,
    remaining: fact?.remaining ?? 0,
    error: fact?.error
      ?? (health
        ? (hostId ? "no retention pass has recorded this host yet" : "the service reports no T3Code host")
        : "the Nucleus service is not running"),
  };
}

/** Assemble the report once every fact is read; no I/O and no secret here. */
export function t3StatusReport(input: T3StatusInput): T3StatusReport {
  const reachable = input.server != null || input.config !== null;
  const environmentId =
    input.server?.environmentId ??
    input.config?.environment.environmentId ??
    "";
  const hostId = environmentId ? `t3code:${environmentId}` : "";
  const serverProblem = reachable
    ? ""
    : input.serverError || "the T3Code server is unreachable";
  const provider = input.config
    ? observeProvider(input.config, input.acpCommand)
    : {
        registered: null,
        ours: false,
        driver: null,
        displayName: null,
        enabled: false,
        ready: false,
        usable: false,
        status: "unknown",
        probeMessage: "",
        commandPath: null,
        commandMatchesInstalled: false,
        models: [],
        problem:
          input.serverError ||
          "provider cannot be verified without a connection",
      };
  const bearer = observeBearer(
    input.connection,
    input.sessions,
    input.bearerAccepted,
    input.now ?? Date.now(),
  );
  const service: T3ServiceFacts = input.service ?? {
    available: false,
    connected: false,
    hostId: null,
    error: "the Nucleus service is not running",
    nativeParenting: "",
    supportThreads: "",
  };
  const problems = [
    serverProblem,
    bearer.problem,
    provider.problem,
    service.available ? "" : service.error,
    input.acpCommand === null
      ? `no installed ${NUCLEUS_ACP_COMMAND} command was found`
      : "",
  ].filter(Boolean);
  return {
    ok:
      reachable && bearer.present && bearer.valid !== false && provider.usable,
    problems,
    server: {
      endpoint: input.endpoint,
      reachable,
      version:
        input.server?.serverVersion ??
        input.config?.environment.serverVersion ??
        "",
      environmentId,
      hostId,
      problem: serverProblem,
    },
    bearer,
    provider,
    service,
    projects: (input.projects ?? [])
      .filter((project) => project.hostKind === "t3code")
      .map((project) => ({ name: project.name })),
    acp: {
      commandPath: input.acpCommand,
      owned: input.acpCommand !== null && isNucleusAcpCommand(input.acpCommand),
    },
    retention: retentionFacts(input.retention, service.hostId),
  };
}

// --- uninstall -------------------------------------------------------------

/**
 * The refusal `nucleus t3 uninstall` makes while tasks are live on this host:
 * it names them, and only an explicit `--live-tasks` sends it ahead. The tasks
 * keep their T3 threads either way — this command never touches a thread or a
 * project registration.
 */
export function liveTaskNames(
  dependents: Array<{ kind: string; label?: string; names: string[] }>,
): string[] {
  return dependents
    .filter((dependent) => dependent.kind === "task")
    .flatMap((dependent) => dependent.names);
}

export function liveTaskRefusal(
  hostId: string,
  tasks: string[],
  force: boolean,
): string | null {
  if (!tasks.length || force) return null;
  return `T3Code host ${hostId} still has live tasks: ${tasks.join(", ")}. Removing the provider and the bearer now leaves them running with no Nucleus connection. Pass --live-tasks to remove anyway.`;
}

// --- the T3 CLI ------------------------------------------------------------

/** One minted session: the one place the bearer is handled as a value. */
export interface T3IssuedSession {
  sessionId: string;
  token: string;
  scopes: string[];
  expiresAt: string;
}

/** The session verbs, so a test can serve them in process and production spawns the CLI. */
export interface T3SessionCli {
  issue(input: {
    scopes: readonly string[];
    label: string;
    subject: string;
    ttl: string;
  }): T3IssuedSession;
  list(): T3SessionSummary[];
  revoke(sessionId: string): void;
}

export interface T3CliOptions {
  cli: string;
  baseDir: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function runT3(options: T3CliOptions, args: string[]): string {
  const result = spawnSync(
    options.cli,
    [...args, "--base-dir", options.baseDir],
    {
      encoding: "utf8",
      env: options.env ?? process.env,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error)
    throw new Error(`Could not run ${options.cli}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}`
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-2)
      .join(" ");
    throw new Error(
      `T3Code command failed (${options.cli} ${args[0]} ${args[1] ?? ""}, exit ${result.status}): ${detail || "no output"}`,
    );
  }
  return `${result.stdout ?? ""}`.trim();
}

/**
 * The installed T3 CLI's own session verbs. `issue --json` is used rather than
 * `--token-only` so one call carries the session id and expiry status needs;
 * the token stays in this process and is never printed.
 */
export function spawnT3SessionCli(options: T3CliOptions): T3SessionCli {
  const issueShape = z
    .object({
      sessionId: z.string().min(1),
      token: z.string().min(1),
      scopes: z.array(z.string()),
      expiresAt: z.string().min(1),
    })
    .passthrough();
  return {
    issue(input) {
      const args = [
        "auth",
        "session",
        "issue",
        "--label",
        input.label,
        "--subject",
        input.subject,
        "--ttl",
        input.ttl,
        "--json",
      ];
      for (const scope of input.scopes) args.push("--scope", scope);
      const parsed = issueShape.safeParse(JSON.parse(runT3(options, args)));
      if (!parsed.success)
        throw new Error(
          "T3Code returned an unexpected session shape; nothing was recorded",
        );
      return {
        sessionId: parsed.data.sessionId,
        token: parsed.data.token,
        scopes: parsed.data.scopes,
        expiresAt: parsed.data.expiresAt,
      };
    },
    list() {
      const rows = z
        .array(
          z
            .object({
              sessionId: z.string().min(1),
              scopes: z.array(z.string()),
              subject: z.string().nullable().optional(),
              expiresAt: z.string().min(1),
            })
            .passthrough(),
        )
        .safeParse(
          JSON.parse(runT3(options, ["auth", "session", "list", "--json"])),
        );
      if (!rows.success)
        throw new Error(
          "T3Code returned an unexpected session list; no session was revoked",
        );
      return rows.data.map((row) => ({
        sessionId: row.sessionId,
        scopes: row.scopes,
        subject: row.subject ?? null,
        expiresAt: row.expiresAt,
      }));
    },
    revoke(sessionId) {
      // The installed CLI takes the id as its one positional argument.
      runT3(options, ["auth", "session", "revoke", sessionId]);
    },
  };
}
