/**
 * The socket-free report relay (nucleus#1315).
 *
 * A BB provider runs a role thread inside its own OS sandbox. Claude Code's
 * sandbox leaves loopback reachable but refuses every Unix socket, so the
 * packaged report helper cannot open the Nucleus callback socket from inside a
 * sandboxed thread (measured: `EPERM` on `~/.nucleus/callback.sock`). The BB
 * backend runs in the BB server process, outside that sandbox, and already
 * speaks to the same Nucleus data home over the host channel. This module is
 * the one route that lets a sandboxed thread hand its report to that process:
 * the helper POSTs the exact payload it would have sent to the socket, and the
 * backend forwards it to the run's own callback socket with the run's own
 * ticket token.
 *
 * The ticket is the authority and this route holds no authority of its own:
 *
 * - the ticket is located by run id under this data home's `tickets/`, never by
 *   a path the caller supplies (a path argument would name the invoking
 *   machine's disk, not the server's);
 * - it must be a regular owner-only file, and the caller must present the exact
 *   token it carries for the exact task and run it names;
 * - only the callback routes a helper may use are forwarded, and only to this
 *   data home's own `callback.sock`;
 * - the forwarded body is the caller's own payload, and the answer is the
 *   service's own answer. The token is never logged or echoed.
 *
 * This file imports Node builtins only: the plugin package builds from its own
 * directory with no dependency tree, exactly like `operations.ts`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { request } from "node:http";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** The plugin HTTP path a sandboxed helper posts to (`/api/v1/plugins/nucleus/http/report`). */
export const REPORT_RELAY_PATH = "/report";

/** The callback routes a packaged helper uses; anything else is refused before a ticket is read. */
export const REPORT_RELAY_ROUTES = ["/complete", "/ask", "/message", "/answer", "/task-next", "/run-context"] as const;
export type ReportRelayRoute = (typeof REPORT_RELAY_ROUTES)[number];

/** The largest body this route accepts: the callback `/complete` bound plus its envelope. */
export const REPORT_RELAY_MAX_BYTES = 8 * 1024 * 1024;

/** The socket's own budget, so a relayed wait is not cut short by the relay. */
const RELAY_TIMEOUT_MS = 60_000;

const RUN_ID = /^[A-Za-z0-9_-]{1,160}$/;

export interface RelayTicket {
  socketPath: string;
  taskId: string;
  runId: string;
  token: string;
}

export interface RelayRequest {
  route: ReportRelayRoute;
  taskId?: string;
  runId?: string;
  token: string;
  payload: Record<string, unknown>;
}

export interface RelayAnswer {
  status: number;
  body: string;
}

/** A refusal that proved nothing was forwarded. */
export class ReportRelayRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportRelayRefusal";
  }
}

const tokenMatches = (given: string, expected: string): boolean => {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
};

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolve a data home to its real path, so no component can be redirected. */
async function realDataHome(dataDir: string): Promise<string> {
  if (!isAbsolute(dataDir)) throw new ReportRelayRefusal("The Nucleus data home is not an absolute path");
  try {
    return await realpath(dataDir);
  } catch {
    throw new ReportRelayRefusal("The Nucleus data home is unreadable");
  }
}

/**
 * Read and prove the ticket for one run. The file is looked up by run id, so a
 * caller can never name another machine's path or another run's ticket.
 */
export async function readRelayTicket(dataHome: string, runId: string): Promise<RelayTicket> {
  if (!RUN_ID.test(runId)) throw new ReportRelayRefusal("The run id is not a ticket name");
  const directory = join(dataHome, "tickets");
  const path = join(directory, `${runId}.json`);
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    throw new ReportRelayRefusal(`No run ticket is recorded for ${runId}`);
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new ReportRelayRefusal("The run ticket is not a regular file");
  if ((entry.mode & 0o077) !== 0) throw new ReportRelayRefusal("The run ticket is readable by another user");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ReportRelayRefusal("The run ticket is unreadable");
  }
  if (!plainObject(parsed)) throw new ReportRelayRefusal("The run ticket has no readable shape");
  const { socketPath, taskId, runId: ticketRun, token } = parsed as Record<string, unknown>;
  if (typeof socketPath !== "string" || typeof taskId !== "string" || typeof ticketRun !== "string" || typeof token !== "string")

    throw new ReportRelayRefusal("The run ticket is incomplete");
  if (!token) throw new ReportRelayRefusal("The run ticket carries no credential");
  if (ticketRun !== runId) throw new ReportRelayRefusal("The run ticket names another run");
  return { socketPath, taskId, runId, token };
}

/** The one socket this route may forward to: this data home's own callback socket. */
function callbackSocketFor(dataHome: string, ticket: RelayTicket): string {
  const expected = join(dataHome, "callback.sock");
  const observed = resolve(ticket.socketPath);
  if (basename(observed) !== "callback.sock" || resolve(dirname(observed)) !== resolve(dataHome))
    throw new ReportRelayRefusal("The run ticket names another callback socket");
  return expected;
}

/** Validate one relay body against the ticket it claims. Nothing is forwarded before this passes. */
export function relayRequest(body: unknown, ticket: RelayTicket): RelayRequest {
  if (!plainObject(body)) throw new ReportRelayRefusal("The relay body is not an object");
  const { route, taskId, runId, token, payload } = body;
  if (typeof route !== "string" || !(REPORT_RELAY_ROUTES as readonly string[]).includes(route))
    throw new ReportRelayRefusal("The relay route is not a callback route a run may use");
  if (typeof token !== "string" || !token) throw new ReportRelayRefusal("The relay body carries no credential");
  if (!tokenMatches(token, ticket.token)) throw new ReportRelayRefusal("The relay credential does not match this run's ticket");
  if (taskId !== undefined && taskId !== ticket.taskId) throw new ReportRelayRefusal("The relay names another task");
  if (runId !== undefined && runId !== ticket.runId) throw new ReportRelayRefusal("The relay names another run");
  if (!plainObject(payload)) throw new ReportRelayRefusal("The relay payload is not an object");
  if (route === "/task-next" || route === "/run-context") {
    if (payload.callerTaskId !== ticket.taskId || payload.callerRunId !== ticket.runId)
      throw new ReportRelayRefusal("The relay names another caller");
  } else if (payload.taskId !== ticket.taskId || payload.runId !== ticket.runId) {
    throw new ReportRelayRefusal("The relay payload names another task or run");
  }
  return { route: route as ReportRelayRoute, token: ticket.token, payload };
}

/** One bounded POST to the owner-only callback socket. */
export function postToCallbackSocket(socketPath: string, token: string, route: string, payload: unknown, timeoutMs = RELAY_TIMEOUT_MS): Promise<RelayAnswer> {
  const body = JSON.stringify(payload);
  return new Promise((settle, fail) => {
    const pending = request({
      socketPath,
      path: route,
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => settle({ status: response.statusCode ?? 0, body: text }));
      response.on("error", error => fail(new Error(`The callback socket failed while answering: ${error.message}`)));
    });
    pending.setTimeout(timeoutMs, () => pending.destroy(new Error("The callback socket did not answer inside its budget")));
    pending.on("error", error => fail(new Error(`The callback socket could not be reached: ${error.message}`)));
    pending.end(body);
  });
}

export interface ReportRelayDeps {
  /** Read the ticket; replaced by a fixture. */
  readTicket?: (dataHome: string, runId: string) => Promise<RelayTicket>;
  /** Forward the request; replaced by a fixture. */
  post?: (socketPath: string, token: string, route: string, payload: unknown) => Promise<RelayAnswer>;
}

/**
 * The route the plugin's backend registers. A refusal is answered before
 * anything is forwarded; a forwarded request answers with the service's own
 * status and body, so the helper keeps its existing refusal semantics.
 */
export async function relayRunReport(input: { dataDir: string | null; body: unknown; deps?: ReportRelayDeps }): Promise<RelayAnswer> {
  if (!input.dataDir) throw new ReportRelayRefusal("The Nucleus data directory is not configured; install or configure the plugin first");
  const dataHome = await realDataHome(input.dataDir);
  if (!plainObject(input.body)) throw new ReportRelayRefusal("The relay body is not an object");
  const runId = input.body.runId;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new ReportRelayRefusal("The relay body names no run");
  const ticket = await (input.deps?.readTicket ?? readRelayTicket)(dataHome, runId);
  const request = relayRequest(input.body, ticket);
  const socketPath = callbackSocketFor(dataHome, ticket);
  const post = input.deps?.post ?? postToCallbackSocket;
  return await post(socketPath, request.token, request.route, request.payload);
}
