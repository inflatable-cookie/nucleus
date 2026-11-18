/**
 * The operator install route for the T3Code host (nucleus#1330).
 *
 * `nucleus t3 install` connects one T3Code environment to this Nucleus: it finds
 * the running server, mints the two bearers (the service's long-lived
 * orchestration-only one, and a short-lived one used only to register the
 * provider), registers the `nucleus` ACP provider with T3's own
 * `server.updateSettings`, stores the connection owner-only for the service to
 * adopt without a restart, and proves the host comes online. `nucleus t3 status`
 * reports what T3 and Nucleus each say, without a secret. `nucleus t3 uninstall`
 * removes exactly what this route added.
 *
 * The rules are BB's (`bin/bb-plugin.ts`): one instance id, `nucleus`; an
 * instance of that name that is not ours is refused by name, never overwritten
 * or removed; and "ours" is the driver plus this package's installed
 * `nucleus-acp` command path, not the instance id a namesake shares. This file
 * only ever writes the `nucleus` provider instance, never a thread or a project
 * registration, and never prints or logs a bearer.
 *
 * It lives under `bin/` beside the other CLI front doors. It drives T3 through
 * the host's public index (`hosts/t3code`), the same authenticated RPC client the
 * adapter uses, rather than duplicating the nightly's wire client; the
 * folder-import gate records that one edge.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { dataHome } from "../shared/data-home.mjs";
import { localQueueClient } from "../shared/service/local-client";
import {
  T3_INSTALL_SCOPES,
  T3_INSTALL_TTL,
  NUCLEUS_ACP_COMMAND_MARKER,
  T3_PROVIDER_ID,
  T3_RUNTIME_SCOPES,
  T3_RUNTIME_TTL,
  T3_SESSION_LABEL,
  T3_SESSION_SUBJECT,
  findAcpCommand,
  findT3Cli,
  instanceIsOurs,
  isNucleusAcpCommand,
  liveTaskRefusal,
  liveTaskNames,
  observeProvider,
  providerInstance,
  spawnT3SessionCli,
  storedInstance,
  t3ServerConfigSchema,
  t3StatusReport,
  type T3IssuedSession,
  type T3ServerConfig,
  type T3ServiceFacts,
  type T3SessionCli,
  type T3SessionSummary,
  type T3StatusReport,
} from "../shared/t3/operator";
import {
  readT3Connection,
  readT3RuntimeDescriptor,
  t3RuntimeDescriptorPath,
  writeT3Connection,
  type T3ConnectionSettings,
} from "../shared/t3/settings";
import { T3RpcClient } from "../hosts/t3code";

const USAGE = `nucleus t3 install | status | uninstall

  install    Find the running T3Code server, mint this environment's bearer and
             register the \`nucleus\` ACP provider, then prove the host comes online.
  status     Report the server, bearer, provider, native parenting and the projects
             opted into T3Code. --json prints the same report as JSON.
  uninstall  Remove the \`nucleus\` provider instance and this environment's T3Code
             sessions, and clear the stored connection. Threads and project
             registrations are left alone.

Flags (every command):
  --base-dir <path>     T3Code's base directory (default: $T3CODE_HOME or ~/.t3)
  --endpoint <url>      The T3Code server, instead of the running server's descriptor
  --t3 <path>           The installed \`t3\` command (session minting and revocation)
  --acp-command <path>  The installed \`nucleus-acp\` command to register
  --json                Print the result as JSON

uninstall only:
  --live-tasks          Remove even while tasks are live on the T3Code host
`;

interface Options {
  baseDir: string | null;
  endpoint: string | null;
  t3: string | null;
  acpCommand: string | null;
  json: boolean;
  liveTasks: boolean;
  help: boolean;
  ttl: string | null;
}

function parseOptions(args: string[]): Options {
  const options: Options = { baseDir: null, endpoint: null, t3: null, acpCommand: null, json: false, liveTasks: false, help: false, ttl: null };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${argument} needs a value`);
      return next;
    };
    switch (argument) {
      case "--base-dir": options.baseDir = value(); break;
      case "--endpoint": options.endpoint = value(); break;
      case "--t3": options.t3 = value(); break;
      case "--acp-command": options.acpCommand = value(); break;
      case "--ttl": options.ttl = value(); break;
      case "--json": options.json = true; break;
      case "--live-tasks": options.liveTasks = true; break;
      case "--help": case "-h": options.help = true; break;
      default: throw new Error(`Unknown t3 argument ${argument}; run \`nucleus t3 --help\``);
    }
  }
  if (options.json && options.help) options.help = true;
  return options;
}

interface Context {
  options: Options;
  dataDir: string;
  baseDir: string;
  acpCommand: string | null;
  acpTried: string[];
  t3Cli: string | null;
  t3Tried: string[];
  connection: T3ConnectionSettings | null;
}

function contextFor(options: Options): Context {
  const dataDir = dataHome();
  const baseDir = options.baseDir ?? process.env.T3CODE_HOME ?? join(homedir(), ".t3");
  const acp = findAcpCommand({ explicit: options.acpCommand });
  const cli = findT3Cli({ explicit: options.t3 });
  return {
    options,
    dataDir,
    baseDir,
    acpCommand: acp.path,
    acpTried: acp.tried,
    t3Cli: cli.path,
    t3Tried: cli.tried,
    connection: readT3Connection(dataDir),
  };
}

/** One step's result, printed in order and carried in the `--json` answer. */
interface Step {
  step: string;
  detail: string;
  ok: boolean;
}

function humanSteps(steps: Step[]): string {
  return steps.map(entry => `${entry.ok ? "ok" : "!!"}  ${entry.step}: ${entry.detail}`).join("\n");
}

// --- T3 access -------------------------------------------------------------

interface RunnableServer {
  endpoint: string;
  environmentId: string;
  serverVersion: string;
}

/** The environment descriptor an unauthenticated read answers; proves it is a T3 server. */
async function probeServer(endpoint: string): Promise<{ environmentId: string; serverVersion: string }> {
  const url = new URL("/.well-known/t3/environment", endpoint);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    throw new Error(`No T3Code server is answering at ${endpoint} (${error instanceof Error ? error.message : String(error)}); start T3Code, or pass --endpoint`);
  }
  if (!response.ok) throw new Error(`No T3Code server is answering at ${endpoint} (HTTP ${response.status})`);
  const body = await response.json() as { environmentId?: unknown; serverVersion?: unknown };
  if (typeof body.environmentId !== "string" || typeof body.serverVersion !== "string")
    throw new Error(`${endpoint} answered but is not a T3Code server (no environment descriptor)`);
  return { environmentId: body.environmentId, serverVersion: body.serverVersion };
}

/** Find the running server: the explicit endpoint, the descriptor, or the stored connection. */
function resolveEndpoint(context: Context): string {
  const descriptor = readT3RuntimeDescriptor(context.baseDir);
  const endpoint = context.options.endpoint ?? descriptor?.origin ?? context.connection?.endpoint ?? null;
  if (!endpoint)
    throw new Error(`No running T3Code server was found: ${t3RuntimeDescriptorPath(context.baseDir)} does not exist. Start T3Code, or pass --endpoint`);
  return endpoint;
}

interface RpcSession {
  call(method: string, payload: unknown): Promise<unknown>;
  close(): void;
}

async function withRpc<T>(endpoint: string, bearer: string, work: (rpc: RpcSession) => Promise<T>): Promise<T> {
  const rpc = new T3RpcClient({ endpoint, bearer, timeoutMs: 20_000 });
  try {
    await rpc.connect();
  } catch (error) {
    rpc.close();
    throw error;
  }
  try {
    return await work(rpc);
  } finally {
    rpc.close();
  }
}

function decodeConfig(value: unknown): T3ServerConfig {
  const parsed = t3ServerConfigSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`T3Code returned an unexpected server config (${parsed.error.issues[0]?.path.join(".") || "shape"}); check the installed T3Code version`);
  return parsed.data;
}

async function readConfig(rpc: RpcSession): Promise<T3ServerConfig> {
  return decodeConfig(await rpc.call("server.getConfig", {}));
}

/** The nightly's provider mutation (operations `create`, `upsert` and `remove`). */
function providerMutation(operation: "upsert" | "remove", commandPath?: string) {
  return operation === "remove"
    ? { patch: {}, providerInstanceMutation: { operation, instanceId: T3_PROVIDER_ID } }
    : { patch: {}, providerInstanceMutation: { operation, instanceId: T3_PROVIDER_ID, instance: providerInstance(commandPath!) } };
}

// --- the service -----------------------------------------------------------

interface ServiceRead {
  available: boolean;
  t3: (T3ServiceFacts & { id: string | null; version: string }) | null;
  hosts: Array<{ id: string; state: string; dependents: Array<{ kind: string; names: string[] }> }> | null;
  repositories: Array<{ repository: { origin: string | null; path: string }; hostKind: string | null }> | null;
  error: string;
}

/**
 * The Nucleus service's own facts, read over its local socket. A service that is
 * not running is reported, not waited for: this route never starts one and never
 * releases the operator's ten-minute roll budget on a status line.
 */
async function readService(dataDir: string): Promise<ServiceRead> {
  const client = localQueueClient(dataDir, { compatibilityWaitMs: 2_000, onProgress: () => {} });
  try {
    await client.connect();
    const health = await client.request("service.health", {}) as {
      t3code?: { id?: string | null; connected?: boolean; error?: string; version?: string; nativeParenting?: string; supportThreads?: string };
    };
    const hostList = await client.request("host.list", {}).catch(() => null) as { hosts?: ServiceRead["hosts"] } | null;
    const hosts = hostList?.hosts ?? null;
    const repositories = await client.request("repositories", {}).catch(() => null) as ServiceRead["repositories"];
    const t3 = health.t3code;
    return {
      available: true,
      t3: t3 ? {
        available: true,
        connected: t3.connected === true,
        id: t3.id ?? null,
        hostId: t3.id ?? null,
        error: t3.error ?? "",
        version: t3.version ?? "",
        nativeParenting: t3.nativeParenting ?? "",
        supportThreads: t3.supportThreads ?? "",
      } : null,
      hosts, repositories, error: "",
    };
  } catch (error) {
    return { available: false, t3: null, hosts: null, repositories: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.close();
  }
}

const SERVICE_ADOPT_WAIT_MS = 120_000;
const SERVICE_ADOPT_POLL_MS = 2_000;
const PROVIDER_READY_WAIT_MS = 60_000;

const sleep = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function waitForServiceHost(dataDir: string, hostId: string, present: boolean): Promise<ServiceRead> {
  const deadline = Date.now() + SERVICE_ADOPT_WAIT_MS;
  let last = await readService(dataDir);
  // A service that is not running has nothing to adopt: the connection is recorded
  // for its next start, and waiting out the adoption window would prove nothing.
  if (!last.available) return last;
  while (Date.now() < deadline) {
    const connected = last.t3?.connected === true && last.t3.id === hostId;
    if (present ? connected : !last.t3 || last.t3.connected === false) return last;
    await sleep(SERVICE_ADOPT_POLL_MS);
    last = await readService(dataDir);
  }
  return last;
}

// --- sessions --------------------------------------------------------------

function sessionCli(context: Context): T3SessionCli {
  if (!context.t3Cli)
    throw new Error(`No installed \`t3\` command was found. Tried: ${context.t3Tried.join(", ")}. Pass --t3 <path>`);
  return spawnT3SessionCli({ cli: context.t3Cli, baseDir: context.baseDir });
}

function requireAcpCommand(context: Context): string {
  if (!context.acpCommand)
    throw new Error(`No installed \`nucleus-acp\` command was found. Tried: ${context.acpTried.join(", ")}. Pass --acp-command <path>`);
  return context.acpCommand;
}

function revokeStale(context: Context, sessions: T3SessionCli, keep: string | null): string[] {
  const revoked: string[] = [];
  for (const session of sessions.list()) {
    if (session.subject !== T3_SESSION_SUBJECT || session.sessionId === keep) continue;
    sessions.revoke(session.sessionId);
    revoked.push(session.sessionId);
  }
  return revoked;
}

function sessionList(context: Context): T3SessionSummary[] | null {
  try {
    return sessionCli(context).list();
  } catch {
    return null;
  }
}

// --- install ---------------------------------------------------------------

function issuedLabel(session: T3IssuedSession): string {
  return `${session.sessionId} (scopes ${session.scopes.join(", ")}, expires ${session.expiresAt})`;
}

async function install(context: Context): Promise<string | Record<string, unknown>> {
  const steps: Step[] = [];
  const endpoint = resolveEndpoint(context);
  const acpCommand = requireAcpCommand(context);
  if (!existsSync(acpCommand)) throw new Error(`The nucleus-acp command ${acpCommand} does not exist; run \`nucleus install\``);
  if (!isNucleusAcpCommand(acpCommand))
    throw new Error(`${acpCommand} is not a Nucleus-owned command (missing the ${NUCLEUS_ACP_COMMAND_MARKER} marker); pass --acp-command with this install's \`nucleus-acp\``);
  const server = await probeServer(endpoint);
  steps.push({ step: "T3Code server", ok: true, detail: `${endpoint} (server ${server.serverVersion}, environment ${server.environmentId})` });

  const sessions = sessionCli(context);
  // One short-lived bearer does the read and the one write, and is revoked in the
  // finally: it is never stored and never printed.
  const installSession = sessions.issue({ scopes: T3_INSTALL_SCOPES, label: `${T3_SESSION_LABEL}-install`, subject: T3_SESSION_SUBJECT, ttl: T3_INSTALL_TTL });
  let issuedRuntime: T3IssuedSession | null = null;
  let created = false;
  try {
    let registered: T3ServerConfig | null = null;
    await withRpc(endpoint, installSession.token, async rpc => {
      const before = await readConfig(rpc);
      const existing = storedInstance(before);
      if (existing && !instanceIsOurs(existing, acpCommand))
        throw new Error(`T3Code already has a provider instance named ${T3_PROVIDER_ID} that is not this install's (driver ${existing.driver || "unknown"}, commandPath ${String(existing.config.commandPath ?? "none")}); refusing to overwrite it. Remove it yourself if it is stale, then run this again.`);
      created = existing === null;
      await rpc.call("server.updateSettings", providerMutation("upsert", acpCommand));
      // T3 answers with the instance immediately and fills its models in as its own
      // probe settles, so wait for a usable instance with a model and for T3's
      // in-progress note to clear, bounded even if the probe never settles.
      const deadline = Date.now() + PROVIDER_READY_WAIT_MS;
      let config = await readConfig(rpc);
      while (Date.now() < deadline) {
        const provider = observeProvider(config, acpCommand);
        if (provider.usable && provider.models.length > 0 && !provider.probeMessage.includes("Checking ACP authentication, models, and commands in the background")) break;
        await sleep(1_000);
        config = await readConfig(rpc);
      }
      registered = config;
    });
    const provider = observeProvider(registered!, acpCommand);
    if (provider.probeMessage.includes("Checking ACP authentication, models, and commands in the background"))
      steps.push({ step: "Provider probe", ok: false, detail: "T3Code probe did not settle within the wait; install succeeded with a warning" });
    if (!provider.registered || !provider.ours) throw new Error(`T3Code did not record the ${T3_PROVIDER_ID} provider instance: ${provider.problem}`);
    steps.push({
      step: "Provider instance", ok: provider.usable,
      detail: `${created ? "registered" : "updated"} ${T3_PROVIDER_ID} (${provider.driver}), command ${provider.commandPath}, ${provider.enabled ? "enabled" : "disabled"}, ${provider.status}${provider.models.length ? `, models ${provider.models.join(", ")}` : ""}${provider.probeMessage ? ` — ${provider.probeMessage}` : ""}`,
    });
    if (!provider.usable) throw new Error(`The ${T3_PROVIDER_ID} provider instance is not usable: ${provider.problem}`);
    if (!provider.ready) steps.push({
      step: "Provider readiness", ok: true,
      detail: `T3Code reports ${provider.status}${provider.probeMessage ? `: ${provider.probeMessage}` : ""}; native parenting falls back to top-level role threads until T3's own ACP probe succeeds`,
    });

    // The service's bearer, minted only after the write above: a refusal never
    // rotates a bearer that was working.
    issuedRuntime = sessions.issue({ scopes: T3_RUNTIME_SCOPES, label: T3_SESSION_LABEL, subject: T3_SESSION_SUBJECT, ttl: context.options.ttl ?? T3_RUNTIME_TTL });
    writeT3Connection(context.dataDir, {
      endpoint,
      bearer: issuedRuntime.token,
      ...(context.connection?.probeThreadId ? { probeThreadId: context.connection.probeThreadId } : {}),
      sessionId: issuedRuntime.sessionId,
      expiresAt: issuedRuntime.expiresAt,
    });
    steps.push({ step: "Runtime bearer", ok: true, detail: `issued ${issuedLabel(issuedRuntime)}; stored owner-only in ${join(context.dataDir, "settings.json")}` });
  } finally {
    try {
      sessions.revoke(installSession.sessionId);
    } catch (error) {
      steps.push({ step: "Install bearer", ok: false, detail: `could not revoke ${installSession.sessionId}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (!issuedRuntime) throw new Error("No runtime bearer was stored; nothing changed in T3Code");

  const revoked = revokeStale(context, sessions, issuedRuntime.sessionId);
  if (revoked.length) steps.push({ step: "Rotation", ok: true, detail: `revoked ${revoked.length} previous Nucleus session(s)` });

  const service = await waitForServiceHost(context.dataDir, `t3code:${server.environmentId}`, true);
  if (!service.available) steps.push({ step: "Service", ok: true, detail: `not running; ${endpoint} is recorded and adopted at its next start` });
  else if (service.t3?.connected === true && service.t3.id === `t3code:${server.environmentId}`)
    steps.push({ step: "Service", ok: true, detail: `host ${service.t3.id} online (server ${service.t3.version || server.serverVersion})` });
  else {
    steps.push({ step: "Service", ok: false, detail: `the running service did not adopt the connection within ${SERVICE_ADOPT_WAIT_MS / 1000}s${service.t3?.error ? `: ${service.t3.error}` : ""}` });
    throw new Error(`T3Code provider registered, but the Nucleus service did not come online as t3code:${server.environmentId}`);
  }
  const nativeParenting = service.t3?.nativeParenting || "";
  steps.push({ step: "Native parenting", ok: true, detail: nativeParenting || "reported on the next host read" });
  return context.options.json ? { command: "install", endpoint, environmentId: server.environmentId, hostId: `t3code:${server.environmentId}`, acpCommand, steps } : humanSteps(steps);
}

// --- status ----------------------------------------------------------------

async function status(context: Context): Promise<string | Record<string, unknown>> {
  const service = await readService(context.dataDir);
  const endpoint = (() => {
    try { return resolveEndpoint(context); } catch { return context.connection?.endpoint ?? ""; }
  })();
  const sessions = sessionList(context);
  let config: T3ServerConfig | null = null;
  let serverError = "";
  let accepted: boolean | null = null;
  let server: { environmentId: string; serverVersion: string } | null = null;
  if (endpoint) {
    try { server = await probeServer(endpoint); } catch (error) { serverError = error instanceof Error ? error.message : String(error); }
  }
  if (endpoint && context.connection) {
    try {
      await withRpc(endpoint, context.connection.bearer, async rpc => { config = await readConfig(rpc); });
      accepted = true;
    } catch (error) {
      serverError = error instanceof Error ? error.message : String(error);
      if (/T3Code auth/.test(serverError)) accepted = false;
    }
  } else if (endpoint) {
    serverError = "no T3Code connection is stored";
  }
  const report: T3StatusReport = t3StatusReport({
    endpoint,
    acpCommand: context.acpCommand,
    connection: context.connection,
    config,
    server,
    serverError,
    sessions,
    bearerAccepted: accepted,
    service: service.available ? (service.t3 ?? { available: true, connected: false, hostId: null, error: "", nativeParenting: "", supportThreads: "" }) : null,
    projects: service.repositories?.map(row => ({ name: row.repository.origin ?? basename(row.repository.path || ""), hostKind: row.hostKind ?? "paseo" })) ?? null,
  });
  if (context.options.json) return { command: "status", ...report };
  const lines = [
    `${report.ok ? "ok" : "!!"}  T3Code server: ${report.server.reachable ? `${report.server.endpoint} (server ${report.server.version}, environment ${report.server.environmentId})` : `unreachable at ${report.server.endpoint || "(unknown)"}: ${report.server.problem}`}`,
    `${report.bearer.present && report.bearer.valid !== false ? "ok" : "!!"}  Runtime bearer: ${report.bearer.present ? `${report.bearer.valid === null ? "not verified" : report.bearer.valid ? "valid" : "refused"}${report.bearer.scopes.length ? `, scopes ${report.bearer.scopes.join(", ")}` : ""}${report.bearer.expiresAt ? `, expires ${report.bearer.expiresAt}` : ""}` : "absent"}${report.bearer.problem ? ` — ${report.bearer.problem}` : ""}`,
    `${report.provider.usable ? "ok" : "!!"}  Provider instance ${T3_PROVIDER_ID}: ${report.provider.registered ? `${report.provider.ours ? "ours" : "not ours"}, ${report.provider.enabled ? "enabled" : "disabled"}, ${report.provider.status}${report.provider.commandPath ? `, command ${report.provider.commandPath}` : ""}${report.provider.commandMatchesInstalled ? "" : ", command does not match this install"}${report.provider.models.length ? `, models ${report.provider.models.join(", ")}` : ""}` : "not registered"}${report.provider.problem ? ` — ${report.provider.problem}` : ""}`,
    `${report.service.available && report.service.connected ? "ok" : "!!"}  Nucleus service: ${report.service.available ? `${report.service.connected ? `${report.service.hostId} online` : "T3Code host offline"}${report.service.error ? `: ${report.service.error}` : ""}` : `not running: ${report.service.error}`}`,
    `${report.service.nativeParenting ? "  " : ""}Native parenting: ${report.service.nativeParenting || "(service not reporting)"}`,
    `  Projects opted into T3Code: ${report.projects.length ? report.projects.map(project => project.name).join(", ") : "(none)"}`,
  ];
  return lines.join("\n");
}

// --- uninstall -------------------------------------------------------------

async function uninstall(context: Context): Promise<string | Record<string, unknown>> {
  const steps: Step[] = [];
  const sessions = sessionCli(context);
  const endpoint = (() => {
    try { return resolveEndpoint(context); } catch { return context.connection?.endpoint ?? null; }
  })();
  let environmentId = "";
  if (endpoint) {
    try { environmentId = (await probeServer(endpoint)).environmentId; }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}. Uninstall made no changes; the stored runtime bearer remains active. Start T3Code and retry uninstall.`); }
  }
  const hostId = environmentId ? `t3code:${environmentId}` : "";

  const service = await readService(context.dataDir);
  if (service.available && !context.options.liveTasks) {
    const host = service.hosts?.find(candidate => candidate.id === hostId) ?? null;
    const tasks = liveTaskNames(host?.dependents ?? []);
    const refusal = liveTaskRefusal(hostId, tasks, false);
    if (refusal) throw new Error(refusal);
  }
  if (service.available && service.hosts === null)
    throw new Error("The Nucleus service did not report its hosts, so live tasks on the T3Code host cannot be ruled out; retry when it answers, or pass --live-tasks");
  if (!service.available) steps.push({ step: "Live tasks", ok: true, detail: "the Nucleus service is not running, so nothing is live on the T3Code host" });

  if (endpoint) {
    const installSession = sessions.issue({ scopes: T3_INSTALL_SCOPES, label: `${T3_SESSION_LABEL}-uninstall`, subject: T3_SESSION_SUBJECT, ttl: T3_INSTALL_TTL });
    try {
      await withRpc(endpoint, installSession.token, async rpc => {
        const config = await readConfig(rpc);
        const instance = storedInstance(config);
        if (!instance) {
          steps.push({ step: "Provider instance", ok: true, detail: `no ${T3_PROVIDER_ID} instance is registered; nothing to remove` });
          return;
        }
        if (!instanceIsOurs(instance, context.acpCommand))
          throw new Error(`T3Code's ${T3_PROVIDER_ID} provider instance is not this install's (driver ${instance.driver || "unknown"}, commandPath ${String(instance.config.commandPath ?? "none")}); refusing to remove it`);
        await rpc.call("server.updateSettings", providerMutation("remove"));
        const after = await readConfig(rpc);
        if (storedInstance(after)) throw new Error(`T3Code still reports the ${T3_PROVIDER_ID} provider instance after its removal`);
        steps.push({ step: "Provider instance", ok: true, detail: `${T3_PROVIDER_ID} removed` });
      });
    } finally {
      try { sessions.revoke(installSession.sessionId); } catch { /* rotation below prunes it by subject */ }
    }
    const revoked = revokeStale(context, sessions, null);
    steps.push({ step: "Sessions", ok: true, detail: revoked.length ? `revoked ${revoked.length} Nucleus session(s)` : "no Nucleus sessions were active" });
  } else {
    steps.push({ step: "T3Code server", ok: true, detail: "not running; only the stored connection is cleared" });
  }

  writeT3Connection(context.dataDir, null);
  steps.push({ step: "Stored connection", ok: true, detail: `cleared ${join(context.dataDir, "settings.json")} (threads and project registrations untouched)` });
  const after = await waitForServiceHost(context.dataDir, hostId, false);
  steps.push({
    step: "Service", ok: !after.available || after.t3?.connected !== true,
    detail: !after.available ? "not running; it adopts the cleared connection at its next start" : after.t3?.connected === true ? `still reports ${after.t3.id} online` : "T3Code host offline",
  });
  return context.options.json ? { command: "uninstall", hostId, steps } : humanSteps(steps);
}

// --- entry -----------------------------------------------------------------

export async function t3Command(command: string, args: string[]): Promise<string | Record<string, unknown>> {
  const options = parseOptions(args);
  if (options.help) return USAGE;
  if (!["install", "status", "uninstall"].includes(command))
    throw new Error(`Unknown t3 command ${command || "(none)"}; choose install, status or uninstall`);
  const context = contextFor(options);
  if (command === "install") return await install(context);
  if (command === "status") return await status(context);
  return await uninstall(context);
}

/** Exposed for the CLI front door's own help. */
export { USAGE as t3Usage };
