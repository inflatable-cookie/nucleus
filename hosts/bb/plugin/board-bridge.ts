/**
 * The board's service bridge inside the BB plugin backend (Spec 062, phase 6).
 *
 * Three things, each forwarding-only, and none of them owns Nucleus state:
 *
 * 1. `boardCall` — the board, its Settings and its pills call the service's RPC
 *    catalogue through this one plugin RPC method, which forwards the exact
 *    catalogue method over the retained host-executor connection with `via: "bb"`
 *    (the Paseo bridge does the same with `via: "paseo"`). The service validates
 *    both ends against the shared contracts and answers; this file never parses a
 *    board shape of its own, so it cannot drift from the catalogue.
 * 2. lifecycle hints — BB's thread events become the existing bounded
 *    `service.lifecycle-signal` hint: the event kind and the thread id, nothing
 *    else. A hint is a scheduling signal, never delivery authority, and an unknown
 *    thread schedules nothing.
 * 3. `bb nucleus terminal` — one thread-scoped terminal in the calling thread
 *    (decision 7). There is no task-directory variant: phase 0 proved a
 *    `host_path` terminal does not appear where an operator looks.
 *
 * What none of it does (phase 6 acceptance): no BB settings write, no thread
 * lifecycle-owner write, and no terminal read, list, write or close.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { serviceStateSchema } from "../../../shared/schema/service";

/** One catalogue name, as Contract 007 bounds it (`queue.ui-snapshot`, `bb.sidebar-groups`). */
const CATALOGUE_METHOD = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

/**
 * Host methods are a reverse control channel, so only the calls the board itself
 * uses may cross it: the QA run/accounting read and its capacity-release action.
 * The service's control frames (`service.*`) and a worker's self-registration
 * remain unavailable to the board.
 */
const REFUSED_PREFIXES = ["service."] as const;
const REFUSED_METHODS = new Set(["task.register"]);
const BOARD_HOST_METHODS = new Set(["host.run.board", "host.run.capacity.release"]);

/** Historical board clients can send this alias; the service catalogue uses a dotted wire name. */
const METHOD_ALIASES: Readonly<Record<string, string>> = { plans: "queue.plans" };

/** The forwarded window: wide enough for the catalogue's slowest compatibility waits. */
export const BOARD_CALL_TIMEOUT_MS = 60_000;

export const boardCallInputSchema = z.object({
  method: z.string().min(1).max(120).refine(method => CATALOGUE_METHOD.test(METHOD_ALIASES[method] ?? method)),
  input: z.unknown(),
}).strict();

/** The plugin's RPC method the board shell calls; its output is the catalogue's own answer. */
export const boardContract = defineRpcContract({
  boardCall: { input: boardCallInputSchema, output: z.unknown() },
});

/** The refusal for a method the board does not forward, or null when it is forwarded. */
export function boardCallRefusal(method: string): string | null {
  const canonical = METHOD_ALIASES[method] ?? method;
  if (!CATALOGUE_METHOD.test(canonical)) return `${method} is not a catalogue method`;
  if (REFUSED_PREFIXES.some(prefix => canonical.startsWith(prefix)) || REFUSED_METHODS.has(canonical)
    || (canonical.startsWith("host.") && !BOARD_HOST_METHODS.has(canonical)))
    return `${method} is not served to the BB board. Nothing changed; do not retry from BB.`;
  return null;
}

/** One bounded service request on the retained connection. */
export interface BoardBridgeSource {
  request(method: string, input: unknown, timeoutMs?: number, via?: "bb"): Promise<unknown>;
  /** `queue.service-state` is a bridge catalogue read, answered from the same health endpoint as Paseo. */
  serviceState?(): Promise<unknown>;
}

/** Adapt the service health control read into the board's bridge-owned typed state contract. */
export async function readBoardServiceState(source: BoardBridgeSource, pluginBuildId: string | null): Promise<unknown> {
  let health: Record<string, unknown> | null = null;
  let state: "running" | "unhealthy" = "running";
  let detail = "";
  try {
    const response = await source.request("service.health", {}, BOARD_CALL_TIMEOUT_MS, "bb");
    if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("The Nucleus service returned an invalid health response");
    health = response as Record<string, unknown>;
  } catch (error) {
    state = "unhealthy";
    detail = error instanceof Error ? error.message : String(error);
  }
  const bootstrap = health?.bootstrap && typeof health.bootstrap === "object" ? health.bootstrap as Record<string, unknown> : {};
  return serviceStateSchema.parse({
    state, detail,
    buildId: typeof health?.buildId === "string" ? health.buildId : null,
    pid: typeof health?.pid === "number" ? health.pid : null,
    startedAt: typeof health?.startedAt === "string" ? health.startedAt : null,
    ready: typeof health?.ready === "boolean" ? health.ready : null,
    paused: typeof health?.paused === "boolean" ? health.paused : null,
    hostId: typeof health?.hostId === "string" ? health.hostId : null,
    error: state === "running" ? typeof health?.startError === "string" ? health.startError : "" : detail,
    bootstrap: { pending: bootstrap.pending === true, startedAt: typeof bootstrap.startedAt === "string" ? bootstrap.startedAt : null },
    pluginBuildId, roll: null,
  });
}

/**
 * The RPC handler. A call that cannot reach the service rejects with that reason:
 * the board shows its own read error, never a guessed answer.
 */
export function createBoardBridge(source: () => BoardBridgeSource | null) {
  return {
    async boardCall(input: z.infer<typeof boardCallInputSchema>): Promise<unknown> {
      const parsed = boardCallInputSchema.parse(input);
      const refusal = boardCallRefusal(parsed.method);
      if (refusal) throw new Error(refusal);
      const method = METHOD_ALIASES[parsed.method] ?? parsed.method;
      const client = source();
      if (!client) throw new Error("The Nucleus service channel is not connected");
      if (method === "queue.service-state") {
        if (!client.serviceState) throw new Error("The Nucleus service state is unavailable through the BB bridge");
        return await client.serviceState();
      }
      return await client.request(method, parsed.input ?? null, BOARD_CALL_TIMEOUT_MS, "bb");
    },
  };
}

/**
 * BB's thread events, as the existing lifecycle hint kinds name them (Contract 007).
 * A thread becoming active starts a turn; idle and failed end one; a pending
 * interaction is a permission or question raised; an archive is an archive.
 */
export const BB_LIFECYCLE_HINTS = {
  "thread.created": "agent.created",
  "thread.active": "agent.turn_started",
  "thread.idle": "agent.turn_ended",
  "thread.failed": "agent.turn_ended",
  "interaction.pending": "agent.permission_requested",
  "thread.archived": "agent.archived",
} as const;

export type BbLifecycleEvent = keyof typeof BB_LIFECYCLE_HINTS;

/** The bounded part of a BB thread event this bridge reads: the thread's id. */
interface ThreadEventPayload { thread?: { id?: unknown } | null }

/**
 * Forward one BB event as a lifecycle hint. Best-effort: no channel, no hint; a
 * failed hint is dropped, because durable facts and the observation sweep stay
 * authoritative. The hint carries the kind, the thread id and the time — never a
 * turn, interaction, timeline or environment payload.
 */
export function forwardLifecycleHint(source: () => BoardBridgeSource | null, event: BbLifecycleEvent, payload: ThreadEventPayload, now: () => Date = () => new Date()): Promise<void> | null {
  const threadId = payload?.thread?.id;
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 160) return null;
  const client = source();
  if (!client) return null;
  return client
    .request("service.lifecycle-signal", { kind: BB_LIFECYCLE_HINTS[event], agentId: threadId, workspaceId: null, at: now().toISOString() }, 5_000)
    .then(() => undefined, () => undefined);
}

/** The terminal surface this bridge uses: create, and nothing else. */
export interface TerminalCreateSdk {
  terminals: {
    create(args: { cols: number; rows: number; scope: { kind: "thread"; threadId: string }; start: { mode: "shell" }; title: string }): Promise<{ id?: unknown }>;
  };
}

export const TERMINAL_COMMAND = {
  name: "terminal",
  summary: "Open a terminal tab in this thread",
  usage: "bb nucleus terminal [task]",
} as const;

const TERMINAL_HELP = `${TERMINAL_COMMAND.usage}\n\n${TERMINAL_COMMAND.summary}. Run it from the thread that should own the tab; a task reference names the tab.\n`;

/**
 * `bb nucleus terminal [task]`: one thread-scoped shell terminal in the calling
 * thread, titled with the task when one is given. It needs the calling thread
 * (`ctx.threadId`), creates exactly one terminal, and reads nothing back.
 */
export async function runTerminalCommand(argv: readonly string[], ctx: { threadId?: string }, sdk: TerminalCreateSdk): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const args = argv[0] === TERMINAL_COMMAND.name ? argv.slice(1) : [...argv];
  if (args.includes("--help") || args.includes("-h")) return { exitCode: 0, stdout: TERMINAL_HELP };
  const unknown = args.find(arg => arg.startsWith("-"));
  if (unknown) return { exitCode: 2, stderr: `Unknown option ${unknown}.\n${TERMINAL_HELP}` };
  if (args.length > 1) return { exitCode: 2, stderr: `One task reference at most.\n${TERMINAL_HELP}` };
  const threadId = ctx.threadId;
  if (!threadId) return { exitCode: 2, stderr: "Run this from a BB thread: the terminal opens in the calling thread.\n" };
  const task = args[0]?.trim();
  const title = (task ? task : "Terminal").slice(0, 120);
  const session = await sdk.terminals.create({ cols: 120, rows: 32, scope: { kind: "thread", threadId }, start: { mode: "shell" }, title });
  const id = typeof session?.id === "string" ? session.id : null;
  return { exitCode: 0, stdout: id ? `Opened terminal ${id} in this thread.\n` : "Opened a terminal in this thread.\n" };
}

/** A CLI registration, as `bb.cli.register` takes it. */
export interface CliRegistration {
  name: string;
  summary: string;
  commands?: Array<{ name: string; summary?: string; usage?: string }>;
  rendersHelp?: boolean;
  run(argv: string[], ctx: { threadId?: string; cwd?: string; projectId?: string; signal?: AbortSignal }): unknown;
}

/**
 * BB takes one CLI registration per plugin. The vendored list registers `prefs`
 * under the plugin id, so the terminal command joins that registration: `terminal`
 * runs here and every other argv goes to the list's own parser, unchanged.
 */
export function withTerminalCommand(vendored: CliRegistration, sdk: () => TerminalCreateSdk): CliRegistration {
  return {
    ...vendored,
    summary: `${vendored.summary}; open a terminal tab in this thread`,
    commands: [...(vendored.commands ?? []), { ...TERMINAL_COMMAND }],
    async run(argv, ctx) {
      if (argv[0] === TERMINAL_COMMAND.name) return await runTerminalCommand(argv, ctx, sdk());
      const answer = await vendored.run(argv, ctx) as { exitCode: number; stdout?: string; stderr?: string };
      // Top-level help is the list's; it names the terminal command too.
      if ((argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") && answer && typeof answer.stdout === "string")
        return { ...answer, stdout: `${answer.stdout.replace(/\n?$/, "\n")}  ${TERMINAL_COMMAND.usage}\t${TERMINAL_COMMAND.summary}\n` };
      return answer;
    },
  };
}
