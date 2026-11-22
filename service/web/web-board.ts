/**
 * Local web board server (service-boundary contract, "Local web board").
 *
 * The standalone service serves the board to a browser on this machine. It binds
 * 127.0.0.1 on a configured port (or an ephemeral fallback), refuses any Host or
 * Origin that does not name that loopback address, and pairs a one-time bearer
 * with an owner-only cookie session.
 * The RPC route runs the shared catalogue with `via: "web"`, so it passes through
 * the same validation and dispatch as the socket. The live channel is a
 * server-sent event stream that pushes each board revision as the executor
 * publishes it, with the same unchanged-counter acknowledgement the plugin reads.
 *
 * Link tokens are minted by the owner socket (`service.ui-link`, `nucleus ui`)
 * and live only in memory as SHA-256 digests. Pairing consumes one token and
 * persists only the cookie digest and rolling expiry under the work root.
 *
 * This stops other websites and DNS-rebinding pages. It does not stop a process
 * running as the same user that reads a link the owner issued.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { z, ZodError } from "zod";
import { isUnchangedBoard, type UiBoard } from "../../shared/contracts";
import { formatSchemaRefusal } from "../../shared/schema-refusal";
import {
  SETTINGS_SURFACE_HEADER,
  webSettingsRefusal,
} from "../../shared/web-surface";
import {
  CapacityWriteRefusalError,
  MethodNotServedError,
  SurfaceRefusalError,
} from "../transport/dispatch";
import { ExecutorError } from "../executor/executor";
import {
  MAX_FRAME_BYTES,
  METHOD_PATTERN,
  ProtocolError,
} from "../../shared/service/protocol";
import { sourcePathFromModule } from "../../shared/service/build";

const LOOPBACK = "127.0.0.1";
/** The board bundle directory, relative to the checkout root, served when present. */
export const WEB_BUNDLE_DIR = join("web", "dist");
export const WEB_TOKEN_DEFAULT_MINUTES = 8 * 60;
export const WEB_TOKEN_MAX_MINUTES = 24 * 60;
export const WEB_BOARD_DEFAULT_PORT = 4318;
export const WEB_SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "nucleus_session";
/** Refresh rolling sessions at most about once a day. */
const WEB_SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Outstanding tokens are bounded; the oldest is evicted first. */
const MAX_OUTSTANDING_TOKENS = 16;
const MAX_STREAMS = 8;
const STREAM_KEEPALIVE_MS = 15_000;
/**
 * A stream whose socket holds more unsent bytes than this gets no further frames until
 * it drains, so a client that stops reading cannot grow service memory (nucleus#1542).
 * A frame written while under the bound may leave the buffer one frame past it.
 */
const STREAM_BUFFER_LIMIT_BYTES = 256 * 1024;
/** A backlogged stream still undrained after this long is closed, which frees its slot. */
const STREAM_STALL_MS = 30_000;
/** How often open streams refresh and re-check their paired session. */
const STREAM_TOKEN_CHECK_MS = 30_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The fields an unchanged-board acknowledgement carries, so the live channel matches the plugin's poll. */
const COUNTER_FIELDS = [
  "connected",
  "paused",
  "dispatchHeld",
  "drained",
  "boundRuns",
  "quiet",
  "activeWorkers",
  "unsettled",
  "occupiedSlots",
  "error",
  "stoppedThreads",
  "resumedThreads",
] as const;

/**
 * The board surface a link was minted for. The T3 pane's link carries `t3code`, so its
 * session may receive the generated project badges (nucleus#1450). A link without one
 * (`nucleus ui`, a browser) is the standalone board and never does.
 */
export const BOARD_SURFACE_T3 = "t3code";
export type BoardSurface = typeof BOARD_SURFACE_T3;

/** The owner socket's `service.ui-link` input: mint a link, or revoke every outstanding token. */
export const uiLinkInputSchema = z
  .object({
    action: z.enum(["issue", "revoke"]).default("issue"),
    surface: z.enum([BOARD_SURFACE_T3]).optional(),
    ttlMinutes: z
      .number()
      .int()
      .min(5)
      .max(WEB_TOKEN_MAX_MINUTES)
      .default(WEB_TOKEN_DEFAULT_MINUTES),
  })
  .strict();
export type UiLinkInput = z.infer<typeof uiLinkInputSchema>;

const rpcBodySchema = z
  .object({
    method: z.string().regex(METHOD_PATTERN),
    input: z.unknown().optional(),
  })
  .strict();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * The board a session may see. Generated project badges belong to the T3 surface;
 * every other surface gets the board without them (nucleus#1450). Acknowledgements and
 * anything that is not a board pass through unchanged.
 */
export function boardForSurface<T>(board: T, t3: boolean): T {
  if (
    t3 ||
    !board ||
    typeof board !== "object" ||
    Array.isArray(board) ||
    "unchanged" in board
  )
    return board;
  const {
    projectBadges: _badges,
    repositoryBadges: _repoBadges,
    ...rest
  } = board as Record<string, unknown>;
  return rest as T;
}

/** In-memory token table: digests only, bounded, expiring, revocable. */
export class WebTokens {
  private readonly live = new Map<
    string,
    { expiresAt: number; surface: BoardSurface | null }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /** Mint a token that lives for `ttlMs`, for the board surface it was minted for. The table keeps only its digest. */
  issue(
    ttlMs: number,
    surface: BoardSurface | null = null,
  ): { token: string; expiresAt: number } {
    this.prune();
    while (this.live.size >= MAX_OUTSTANDING_TOKENS) {
      const oldest = this.live.keys().next().value;
      if (oldest === undefined) break;
      this.live.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + ttlMs;
    this.live.set(digest(token), { expiresAt, surface });
    return { token, expiresAt };
  }

  /** The digest of a presented token that is live, or null for a missing, malformed, unknown, expired or revoked one. */
  admit(token: string | undefined): string | null {
    if (!token || !TOKEN_PATTERN.test(token)) return null;
    const key = digest(token);
    return this.isLive(key) ? key : null;
  }

  /** Consume a valid one-time link token during browser pairing; the session key and the surface it names. */
  consume(
    token: string | undefined,
  ): { key: string; surface: BoardSurface | null } | null {
    const key = this.admit(token);
    if (!key) return null;
    const { surface } = this.live.get(key)!;
    this.live.delete(key);
    return { key, surface };
  }

  isLive(key: string): boolean {
    const entry = this.live.get(key);
    return entry !== undefined && entry.expiresAt > this.now();
  }

  /** Revoke every outstanding token; returns how many were live. */
  revokeAll(): number {
    this.prune();
    const revoked = this.live.size;
    this.live.clear();
    return revoked;
  }

  private prune() {
    for (const [key, entry] of this.live)
      if (entry.expiresAt <= this.now()) this.live.delete(key);
  }
}

export interface WebBoardHost {
  /** One catalogue call with `via: "web"`, validated and dispatched as the socket's is. */
  call(method: string, input: unknown): Promise<unknown>;
  /** The latest published board projection, or null before the first publication. */
  board(): UiBoard | null;
  /** Why the board cannot be served right now, or null. */
  unavailable(): string | null;
  /** Subscribe to executor publications; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Whether a catalogue call changes Queue state; cookie writes require exact Origin. */
  isMutating?(method: string): boolean;
}

export interface WebBoardOptions {
  host: WebBoardHost;
  /** A built bundle to serve; null serves the minimal "not built yet" page. */
  bundleDir?: string | null;
  /** Fixture clock for token expiry; production reads the wall clock. */
  now?: () => number;
  /** Preferred loopback port. A busy configured port falls back to an ephemeral port. */
  port?: number;
  /** Owner-only file in the data home that holds session digests. */
  sessionFile?: string;
  /** Fixture knob for the per-stream buffer bound; production uses the default. */
  streamBufferLimitBytes?: number;
  /** Fixture knob for the stall timeout; production uses the default. */
  streamStallMs?: number;
}

interface Stream {
  response: ServerResponse;
  /** Digest of the session that opened the stream; the stream closes when it stops being live. */
  key: string;
  /** Whether the session is the T3 board surface, which alone receives project badges. */
  t3: boolean;
  sentRevision: number;
  sentCounters: string;
  sentUnavailable: string | null;
  keepalive: NodeJS.Timeout;
  /** Armed while the stream is backlogged; closes the stream if it does not drain in time. */
  stallTimer: NodeJS.Timeout | null;
}

class BodyTooLarge extends Error {}

export class WebBoard {
  readonly tokens: WebTokens;
  private server: Server | null = null;
  private boundPort = 0;
  private readonly streams = new Set<Stream>();
  private unsubscribe: (() => void) | null = null;
  private tokenTimer: NodeJS.Timeout | null = null;
  private readonly sessions = new Map<string, number>();
  /** The surface each paired session was minted for; absent is the standalone board. */
  private readonly surfaces = new Map<string, BoardSurface>();
  private readonly now: () => number;
  private portFallback = false;
  private sessionWrites: Promise<void> = Promise.resolve();
  private readonly bufferLimit: number;
  private readonly stallMs: number;

  constructor(private readonly options: WebBoardOptions) {
    this.tokens = new WebTokens(options.now);
    this.now = options.now ?? Date.now;
    this.bufferLimit =
      options.streamBufferLimitBytes ?? STREAM_BUFFER_LIMIT_BYTES;
    this.stallMs = options.streamStallMs ?? STREAM_STALL_MS;
  }

  /** The loopback address the server listens on, or null when it is not listening. */
  get address(): { host: string; port: number } | null {
    return this.server ? { host: LOOPBACK, port: this.boundPort } : null;
  }

  /** Bind the configured loopback port, falling back to a random free port if occupied. */
  async listen(): Promise<number> {
    await this.loadSessions();
    const server = createServer((request, response) =>
      this.handle(request, response),
    );
    try {
      await bind(server, this.options.port ?? WEB_BOARD_DEFAULT_PORT);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      this.portFallback = true;
      await bind(server, 0);
    }
    const address = server.address();
    if (
      typeof address !== "object" ||
      address === null ||
      address.address !== LOOPBACK
    ) {
      server.close();
      throw new Error(
        `The board server bound ${JSON.stringify(address)} instead of ${LOOPBACK}`,
      );
    }
    this.server = server;
    this.boundPort = address.port;
    this.unsubscribe = this.options.host.subscribe(() => this.publish());
    this.tokenTimer = setInterval(
      () => this.dropRevokedStreams(),
      STREAM_TOKEN_CHECK_MS,
    );
    this.tokenTimer.unref?.();
    return this.boundPort;
  }

  /** Whether the preferred port was occupied and the board selected an ephemeral one. */
  get usedFallbackPort(): boolean {
    return this.portFallback;
  }

  /** Mint a link: the board URL with a fresh token in its fragment, for one board surface. */
  issueLink(
    ttlMinutes: number,
    surface: BoardSurface | null = null,
  ): {
    url: string;
    expiresAt: string;
    ttlMinutes: number;
  } {
    const { token, expiresAt } = this.tokens.issue(
      ttlMinutes * 60_000,
      surface,
    );
    return {
      url: `http://${LOOPBACK}:${this.boundPort}/#token=${token}&expiresAt=${expiresAt}`,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlMinutes,
    };
  }

  /** Revoke every link token and paired session, persist the empty set and close streams. */
  async revokeAll(): Promise<number> {
    this.pruneSessions();
    const revoked = this.sessions.size + this.tokens.revokeAll();
    this.sessions.clear();
    this.surfaces.clear();
    this.dropRevokedStreams();
    await this.saveSessions();
    return revoked;
  }

  /** Stop publishing, end live streams and release the port. */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    this.tokenTimer = null;
    for (const stream of [...this.streams]) stream.response.end();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections?.();
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    this.route(request, response).catch((error) => {
      if (!response.headersSent)
        sendJson(response, 500, refusal("internal", messageOf(error)));
      else response.end();
    });
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = parseTarget(request.url);
    if (!url) {
      sendJson(
        response,
        400,
        refusal("invalid_input", "The request path is not valid."),
      );
      return;
    }
    // A foreign Host is how a page on another domain reaches a loopback server
    // through DNS rebinding, so the name must be this board's own address.
    if (!this.hostAllowed(request.headers.host)) {
      sendJson(
        response,
        403,
        refusal(
          "host",
          "The Host header must name this board's localhost address.",
        ),
      );
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !this.originAllowed(origin)) {
      sendJson(
        response,
        403,
        refusal(
          "origin",
          "Cross-origin requests are not served; open the board from its own link.",
        ),
      );
      return;
    }
    if (url.pathname === "/api/pair") return this.pair(request, response);
    if (url.pathname === "/api/session") return this.session(request, response);
    if (url.pathname === "/api/rpc") return this.rpc(request, response);
    if (url.pathname === "/api/events") return this.events(request, response);
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, refusal("not_found", "No such board route."));
      return;
    }
    if (request.method !== "GET") {
      sendJson(
        response,
        405,
        refusal("method", "The board serves GET for pages and assets."),
      );
      return;
    }
    return this.serveStatic(response, url.pathname);
  }

  private async serveStatic(
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const root = this.options.bundleDir
      ? resolve(this.options.bundleDir)
      : null;
    if (path === "/" || path === "/ui") {
      const index = root
        ? await readFile(join(root, "index.html")).catch(() => null)
        : null;
      if (index)
        sendBytes(response, 200, "text/html; charset=utf-8", index, true);
      else
        sendBytes(
          response,
          200,
          "text/html; charset=utf-8",
          Buffer.from(FALLBACK_PAGE),
          true,
        );
      return;
    }
    if (!root) {
      sendJson(response, 404, refusal("not_found", "No such board asset."));
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(path.slice(1));
    } catch {
      sendJson(
        response,
        400,
        refusal("invalid_input", "The asset path is not valid."),
      );
      return;
    }
    const file = resolve(root, relative);
    const bytes = file.startsWith(root + sep)
      ? await readFile(file).catch(() => null)
      : null;
    if (!bytes) {
      sendJson(response, 404, refusal("not_found", "No such board asset."));
      return;
    }
    sendBytes(
      response,
      200,
      contentType(file),
      bytes,
      extname(file) === ".html",
    );
  }

  private async pair(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      sendJson(response, 405, refusal("method", "POST to pair this browser."));
      return;
    }
    const token = bearerToken(request);
    const consumed = this.tokens.consume(token);
    if (!consumed) {
      sendJson(
        response,
        401,
        refusal(
          "unauthenticated",
          "A valid, unexpired one-time board link is required to pair this browser.",
        ),
        { "www-authenticate": 'Bearer realm="nucleus-board"' },
      );
      return;
    }
    const cookie = randomBytes(32).toString("base64url");
    const sessionKey = digest(cookie);
    this.pruneSessions();
    while (this.sessions.size >= MAX_OUTSTANDING_TOKENS) {
      const oldest = this.sessions.keys().next().value!;
      this.sessions.delete(oldest);
      this.surfaces.delete(oldest);
    }
    this.sessions.set(sessionKey, this.now() + WEB_SESSION_IDLE_MS);
    if (consumed.surface) this.surfaces.set(sessionKey, consumed.surface);
    await this.saveSessions();
    sendJson(
      response,
      200,
      { paired: true },
      {
        "set-cookie": sessionCookie(cookie),
      },
    );
  }

  private async session(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET") {
      sendJson(
        response,
        405,
        refusal("method", "GET to check the paired board session."),
      );
      return;
    }
    if (!(await this.authorize(request, response))) return;
    sendJson(response, 200, { paired: true });
  }

  private async authorize(
    request: IncomingMessage,
    response: ServerResponse,
    write = false,
  ): Promise<string | null> {
    const key = this.cookieSession(request);
    if (!key) {
      this.refuseUnauthorized(response);
      return null;
    }
    if (write && !this.originAllowed(request.headers.origin)) {
      sendJson(
        response,
        403,
        refusal(
          "origin",
          "Cookie-authenticated writes require this board's exact Origin.",
        ),
      );
      return null;
    }
    const expiry = this.sessions.get(key)!;
    if (expiry <= this.now() + WEB_SESSION_IDLE_MS - WEB_SESSION_REFRESH_MS) {
      this.sessions.set(key, this.now() + WEB_SESSION_IDLE_MS);
      response.setHeader(
        "set-cookie",
        sessionCookie(sessionCookieValue(request)!),
      );
      await this.saveSessions();
    }
    return key;
  }

  private cookieSession(request: IncomingMessage): string | null {
    const cookie = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    const value = cookie?.slice(SESSION_COOKIE.length + 1);
    if (!value || !TOKEN_PATTERN.test(value)) return null;
    const key = digest(value);
    const expiry = this.sessions.get(key);
    if (expiry === undefined || expiry <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return key;
  }

  private pruneSessions(): void {
    for (const [key, expiry] of this.sessions) {
      if (expiry > this.now()) continue;
      this.sessions.delete(key);
      this.surfaces.delete(key);
    }
  }

  private async loadSessions(): Promise<void> {
    if (!this.options.sessionFile) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.options.sessionFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { sessions?: unknown }).sessions)
    )
      throw new Error("The web session file is invalid");
    for (const entry of (parsed as { sessions: unknown[] }).sessions) {
      if (!entry || typeof entry !== "object") continue;
      const {
        digest: key,
        expiresAt,
        surface,
      } = entry as { digest?: unknown; expiresAt?: unknown; surface?: unknown };
      if (
        typeof key === "string" &&
        /^[a-f0-9]{64}$/.test(key) &&
        typeof expiresAt === "number" &&
        Number.isFinite(expiresAt) &&
        expiresAt > this.now()
      ) {
        this.sessions.set(key, expiresAt);
        if (surface === BOARD_SURFACE_T3)
          this.surfaces.set(key, BOARD_SURFACE_T3);
      }
    }
  }

  private saveSessions(): Promise<void> {
    if (!this.options.sessionFile) return Promise.resolve();
    const file = this.options.sessionFile;
    const rows = [...this.sessions].map(([digest, expiresAt]) => {
      const surface = this.surfaces.get(digest);
      return surface ? { digest, expiresAt, surface } : { digest, expiresAt };
    });
    const save = async () => {
      await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, sessions: rows }),
        { mode: 0o600 },
      );
      await chmod(temporary, 0o600);
      await rename(temporary, file);
      await chmod(file, 0o600);
    };
    this.sessionWrites = this.sessionWrites.then(save);
    return this.sessionWrites;
  }

  private refuseUnauthorized(response: ServerResponse): void {
    sendJson(
      response,
      401,
      refusal(
        "unauthenticated",
        "A valid paired board session is required. Open a fresh link from `nucleus ui`; missing, unknown, expired and revoked sessions are refused alike.",
      ),
      {
        "www-authenticate": 'Bearer realm="nucleus-board"',
        "set-cookie": clearSessionCookie(),
      },
    );
  }

  private async rpc(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      sendJson(
        response,
        405,
        refusal("method", "POST one catalogue call to /api/rpc."),
      );
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request, MAX_FRAME_BYTES));
    } catch (error) {
      if (error instanceof BodyTooLarge)
        sendJson(
          response,
          413,
          refusal(
            "oversize",
            `The request body is over the ${MAX_FRAME_BYTES}-byte bound.`,
          ),
          { connection: "close" },
        );
      else
        sendJson(
          response,
          400,
          refusal("invalid_input", "The request body is not JSON."),
        );
      return;
    }
    const call = rpcBodySchema.safeParse(body);
    if (!call.success) {
      if (!response.headersSent)
        sendJson(
          response,
          400,
          refusal("invalid_input", formatSchemaRefusal(call.error)),
        );
      return;
    }
    const catalogue = this.options.host.isMutating?.(call.data.method) ?? false;
    const key = await this.authorize(request, response, catalogue);
    if (!key) return;
    // A Settings write needs the Settings screen's marker on top of the session;
    // the session alone answers like every other refusal here (no mutation, no retry).
    const settingsRefusal = webSettingsRefusal(
      call.data.method,
      request.headers[SETTINGS_SURFACE_HEADER],
    );
    if (settingsRefusal) {
      sendJson(response, 403, refusal("refused", settingsRefusal));
      return;
    }
    try {
      const raw = await this.options.host.call(
        call.data.method,
        call.data.input ?? {},
      );
      const result =
        call.data.method === "queue.ui-snapshot"
          ? boardForSurface(raw, this.surfaces.get(key) === BOARD_SURFACE_T3)
          : raw;
      sendJson(response, 200, { result });
    } catch (error) {
      const mapped = webError(error);
      sendJson(response, mapped.status, refusal(mapped.code, mapped.message));
    }
  }

  private async events(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET") {
      sendJson(
        response,
        405,
        refusal("method", "The live channel is a GET stream."),
      );
      return;
    }
    const key = await this.authorize(request, response);
    if (!key) return this.refuseUnauthorized(response);
    const t3 = this.surfaces.get(key) === BOARD_SURFACE_T3;
    if (this.streams.size >= MAX_STREAMS) {
      sendJson(
        response,
        503,
        refusal(
          "busy",
          `The board already has ${MAX_STREAMS} live streams open; close one and retry.`,
        ),
      );
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    response.write("retry: 3000\n\n");
    const stream: Stream = {
      response,
      key,
      t3,
      sentRevision: -1,
      sentCounters: "",
      sentUnavailable: null,
      keepalive: setInterval(() => {
        if (response.writableEnded) return;
        if (this.backlogged(stream)) this.armStall(stream);
        else {
          this.clearStall(stream);
          response.write(": keepalive\n\n");
        }
      }, STREAM_KEEPALIVE_MS),
      stallTimer: null,
    };
    stream.keepalive.unref?.();
    this.streams.add(stream);
    // A drain means the client has caught up: send it the latest board, which
    // the backlog skipped, and disarm the stall timer.
    response.on("drain", () => {
      this.clearStall(stream);
      this.pushTo(stream);
    });
    response.on("close", () => {
      clearInterval(stream.keepalive);
      this.clearStall(stream);
      this.streams.delete(stream);
    });
    this.pushTo(stream);
  }

  /**
   * Send what this stream has not seen yet: the full board when its revision moved,
   * counters when only they moved. A backlogged stream gets nothing; it is armed to
   * close if it does not drain, and its next frame is the latest board, not the skipped ones.
   */
  private pushTo(stream: Stream): void {
    if (stream.response.writableEnded) return;
    if (!this.backlogged(stream)) this.deliver(stream);
    if (this.backlogged(stream)) this.armStall(stream);
  }

  private deliver(stream: Stream): void {
    const reason = this.options.host.unavailable();
    if (reason) {
      if (stream.sentUnavailable !== reason) {
        writeEvent(stream.response, "unavailable", { message: reason });
        stream.sentUnavailable = reason;
        stream.sentRevision = -1;
      }
      return;
    }
    stream.sentUnavailable = null;
    const published = this.options.host.board();
    if (!published || isUnchangedBoard(published)) return;
    const board = boardForSurface(published, stream.t3);
    const counters = countersOf(board);
    const signature = JSON.stringify(counters);
    if (board.revision !== stream.sentRevision) {
      writeEvent(stream.response, "board", board, board.revision);
      stream.sentRevision = board.revision;
      stream.sentCounters = signature;
      return;
    }
    if (signature !== stream.sentCounters) {
      writeEvent(stream.response, "counters", {
        unchanged: true,
        revision: board.revision,
        ...counters,
      });
      stream.sentCounters = signature;
    }
  }

  private publish(): void {
    for (const stream of [...this.streams]) this.pushTo(stream);
  }

  private dropRevokedStreams(): void {
    for (const stream of [...this.streams]) {
      if (
        !this.sessions.has(stream.key) ||
        this.sessions.get(stream.key)! <= this.now()
      )
        this.endStream(stream);
    }
  }

  /** End a stream. A backlogged one is destroyed: its queued bytes would hold the slot until the client reads. */
  private endStream(stream: Stream): void {
    if (this.backlogged(stream)) stream.response.destroy();
    else stream.response.end();
  }

  /** Whether a stream's socket still holds more unsent bytes than the bound allows. */
  private backlogged(stream: Stream): boolean {
    return stream.response.writableLength > this.bufferLimit;
  }

  /** Start the stall timer for a backlogged stream; it closes the stream unless the stream drains first. */
  private armStall(stream: Stream): void {
    if (stream.stallTimer) return;
    stream.stallTimer = setTimeout(() => {
      stream.stallTimer = null;
      stream.response.destroy();
    }, this.stallMs);
    stream.stallTimer.unref?.();
  }

  private clearStall(stream: Stream): void {
    if (!stream.stallTimer) return;
    clearTimeout(stream.stallTimer);
    stream.stallTimer = null;
  }

  /** Each live stream's unsent bytes and whether its stall timer is armed, for diagnostics and tests. */
  liveStreamBacklog(): { bufferedBytes: number; stalled: boolean }[] {
    return [...this.streams].map((stream) => ({
      bufferedBytes: stream.response.writableLength,
      stalled: stream.stallTimer !== null,
    }));
  }

  private hostAllowed(host: string | undefined): boolean {
    return (
      host === `${LOOPBACK}:${this.boundPort}` ||
      host === `localhost:${this.boundPort}`
    );
  }

  private originAllowed(origin: string | undefined): boolean {
    return (
      origin === `http://${LOOPBACK}:${this.boundPort}` ||
      origin === `http://localhost:${this.boundPort}`
    );
  }
}

function sessionCookieValue(request: IncomingMessage): string | null {
  const cookie = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const value = cookie?.slice(SESSION_COOKIE.length + 1);
  return value && TOKEN_PATTERN.test(value) ? value : null;
}

function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Max-Age=${WEB_SESSION_IDLE_MS / 1000}; HttpOnly; SameSite=Strict; Path=/`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return typeof header === "string"
    ? /^Bearer (\S+)$/.exec(header)?.[1]
    : undefined;
}

async function bind(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: LOOPBACK, port, exclusive: true });
  });
}

function countersOf(
  board: Exclude<UiBoard, { unchanged: true }>,
): Record<string, unknown> {
  const counters: Record<string, unknown> = {};
  for (const field of COUNTER_FIELDS)
    counters[field] = (board as unknown as Record<string, unknown>)[field];
  return counters;
}

function writeEvent(
  response: ServerResponse,
  event: string,
  data: unknown,
  id?: number,
): void {
  if (response.writableEnded) return;
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  response.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Map a thrown catalogue error to the HTTP status and typed code the web board answers with. */
export function webError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof MethodNotServedError)
    return { status: 404, code: "method_unknown", message: error.message };
  if (error instanceof ZodError)
    return {
      status: 400,
      code: "invalid_input",
      message: formatSchemaRefusal(error),
    };
  if (
    error instanceof CapacityWriteRefusalError ||
    error instanceof SurfaceRefusalError
  )
    return { status: 403, code: "refused", message: error.message };
  if (error instanceof ProtocolError)
    return {
      status: statusFor(error.code),
      code: error.code,
      message: error.message,
    };
  if (error instanceof ExecutorError)
    return {
      status: statusFor(error.code),
      code: error.code,
      message: error.message,
    };
  return { status: 500, code: "internal", message: messageOf(error) };
}

function statusFor(code: string): number {
  switch (code) {
    case "invalid_input":
      return 400;
    case "method_unknown":
      return 404;
    case "refused":
      return 403;
    case "unauthenticated":
      return 401;
    case "oversize":
      return 413;
    case "busy":
    case "timeout":
    case "unavailable":
    case "draining":
      return 503;
    default:
      return 500;
  }
}

function refusal(code: string, message: string) {
  return { error: { code, message } };
}

function parseTarget(target: string | undefined): URL | null {
  try {
    return new URL(target ?? "/", `http://${LOOPBACK}`);
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) return;
  const text = JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
    sendJson(
      response,
      413,
      refusal(
        "oversize",
        `The response is over the ${MAX_FRAME_BYTES}-byte bound.`,
      ),
    );
    return;
  }
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(text);
}

function sendBytes(
  response: ServerResponse,
  status: number,
  type: string,
  bytes: Buffer,
  page: boolean,
): void {
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": type,
    ...(page
      ? {
          "content-security-policy":
            "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        }
      : {}),
  });
  response.end(bytes);
}

function securityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function contentType(file: string): string {
  return (
    CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream"
  );
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        rejectBody(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    });
  });
}

/** The built board bundle when one is present in the checkout, else null. */
export function defaultWebBundleDir(): string | null {
  try {
    const dir = join(sourcePathFromModule(), WEB_BUNDLE_DIR);
    return existsFile(join(dir, "index.html")) ? dir : null;
  } catch {
    return null;
  }
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const FALLBACK_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nucleus board</title>
<h1>Nucleus board</h1>
<p>The web board isn't built yet. The service is running. Its board API is at <code>/api/rpc</code> and its live channel at <code>/api/events</code>, both available after pairing a link from <code>nucleus ui</code>.</p>
`;
